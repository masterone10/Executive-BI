import { db } from '../db/index.js';
import { formatDateKey, isCSName, normalizeEmployeeName, matchEmployeeInMaster } from './parser.js';

export function getSystemWeights() {
  const rows = db.prepare('SELECT key, value FROM system_configs').all();
  const configs = {};
  for (const r of rows) {
    configs[r.key] = parseFloat(r.value);
  }
  return {
    w_prod: configs.weight_productivity ?? 0.30,
    w_print: configs.weight_printed ?? 0.25,
    w_pend: configs.weight_pending_control ?? 0.15,
    w_canc: configs.weight_cancel_control ?? 0.20,
    w_proc: configs.weight_processing ?? 0.10,
    min_actions: configs.min_actions_threshold ?? 50,
  };
}

/**
 * Deduplicate and compute metrics from parsed records.
 */
export function computePerformanceFromRecords(records, dbEmployeesMap = null) {
  const weights = getSystemWeights();

  // Canonical employee display names map: normalized -> display name
  const empDisplayNames = new Map();

  function getCanonicalEmpName(rawName) {
    if (!rawName) return '';
    const norm = normalizeEmployeeName(rawName);
    if (empDisplayNames.has(norm)) {
      return empDisplayNames.get(norm);
    }
    const match = matchEmployeeInMaster(rawName, dbEmployeesMap);
    const displayName = match ? match.name : String(rawName).trim();
    empDisplayNames.set(norm, displayName);
    return displayName;
  }

  // 1. Group status actions for deduplication: (order + employee + status) within 2 min
  const statusGroups = new Map();
  // 2. Alt phone groups: (order + employee) within 2 min
  const altGroups = new Map();
  // 3. Added order dedup: set of (order + employee)
  const addedDedup = new Set();
  const addedByEmp = new Map();
  const addedByEmpCS = new Map();
  const addedByEmpNonCS = new Map();
  const uniqueAddedOrders = new Set();

  // All events by order for determining order-level metrics (latest status, etc.)
  const orderEventsMap = new Map();

  let rawStatusCount = 0;

  for (const r of records) {
    const canonicalName = getCanonicalEmpName(r.name);
    const isCS = r.isCS !== undefined ? r.isCS : isCSName(r.name, dbEmployeesMap);

    if (r.order) {
      if (r.dt) {
        if (!orderEventsMap.has(r.order)) {
          orderEventsMap.set(r.order, []);
        }
        orderEventsMap.get(r.order).push(r);
      }
    }

    if (r.added) {
      const key = `${r.order}|${canonicalName}`;
      if (!addedDedup.has(key)) {
        addedDedup.add(key);
        uniqueAddedOrders.add(r.order);
        addedByEmp.set(canonicalName, (addedByEmp.get(canonicalName) || 0) + 1);
        if (isCS) {
          addedByEmpCS.set(canonicalName, (addedByEmpCS.get(canonicalName) || 0) + 1);
        } else {
          addedByEmpNonCS.set(canonicalName, (addedByEmpNonCS.get(canonicalName) || 0) + 1);
        }
      }
    }

    if (r.alt) {
      const key = `${r.order}|${canonicalName}`;
      if (!altGroups.has(key)) altGroups.set(key, []);
      altGroups.get(key).push(r.dt || 0);
    }

    if (r.st) {
      rawStatusCount++;
      if (isCS) {
        const key = `${r.order}|${canonicalName}|${r.st}`;
        if (!statusGroups.has(key)) statusGroups.set(key, []);
        statusGroups.get(key).push({ dt: r.dt || 0, r });
      }
    }
  }

  // Deduplicate CS Status Events (2-minute window)
  const dedupedCSActions = [];
  const empActionsMap = new Map();
  const empStatusMap = new Map(); // emp -> { printed, pending, processing, cancelled }

  for (const [key, items] of statusGroups.entries()) {
    items.sort((a, b) => a.dt - b.dt);
    let lastTs = -Infinity;
    for (const item of items) {
      if (item.dt - lastTs > 120000) {
        dedupedCSActions.push(item.r);
        lastTs = item.dt;

        const emp = item.r.name;
        empActionsMap.set(emp, (empActionsMap.get(emp) || 0) + 1);

        if (!empStatusMap.has(emp)) {
          empStatusMap.set(emp, { printed: 0, pending: 0, processing: 0, cancelled: 0 });
        }
        const counts = empStatusMap.get(emp);
        const st = item.r.st;
        if (st === 'Printed') counts.printed++;
        else if (st === 'Pending') counts.pending++;
        else if (st === 'Processing') counts.processing++;
        else if (st === 'Cancelled') counts.cancelled++;
      }
    }
  }

  // Deduplicate Alt Phones (2-minute window)
  const empAltMap = new Map();
  let totalAltPhones = 0;
  for (const [key, timestamps] of altGroups.entries()) {
    timestamps.sort((a, b) => a - b);
    let lastTs = -Infinity;
    const empName = key.split('|')[1];
    for (const ts of timestamps) {
      if (ts - lastTs > 120000) {
        empAltMap.set(empName, (empAltMap.get(empName) || 0) + 1);
        totalAltPhones++;
        lastTs = ts;
      }
    }
  }

  // Order-Level Metrics across the dataset
  const uniquePrintedOrders = new Set();
  const uniqueCancelledOrders = new Set();
  let currentPendingBacklog = 0;
  let processingOrders = 0;

  for (const [orderCode, events] of orderEventsMap.entries()) {
    events.sort((a, b) => (a.dt || 0) - (b.dt || 0));

    let reachedPrinted = false;
    let reachedCancelled = false;

    for (const ev of events) {
      if (ev.st === 'Printed') reachedPrinted = true;
      if (ev.st === 'Cancelled') reachedCancelled = true;
    }
    if (reachedPrinted) uniquePrintedOrders.add(orderCode);
    if (reachedCancelled) uniqueCancelledOrders.add(orderCode);

    // Latest status
    const latestEventWithStatus = [...events].reverse().find(e => e.st);
    if (latestEventWithStatus) {
      if (latestEventWithStatus.st === 'Pending') {
        currentPendingBacklog++;
      } else if (latestEventWithStatus.st === 'Processing') {
        processingOrders++;
      }
    }
  }

  // Aggregate Totals
  const totalActions = dedupedCSActions.length;
  let totalPrintedActions = 0;
  let totalPendingActions = 0;
  let totalProcessingActions = 0;
  let totalCancelledActions = 0;

  for (const counts of empStatusMap.values()) {
    totalPrintedActions += counts.printed;
    totalPendingActions += counts.pending;
    totalProcessingActions += counts.processing;
    totalCancelledActions += counts.cancelled;
  }

  const teamCancelRate = totalActions > 0 ? (totalCancelledActions / totalActions) * 100 : 0;
  const maxActions = Math.max(...Array.from(empActionsMap.values()), 1);

  // Compute Per-Employee Metrics & Scores
  const employees = [];
  const allEmpNames = new Set([...empActionsMap.keys(), ...empAltMap.keys(), ...addedByEmpCS.keys()]);

  for (const name of allEmpNames) {
    const counts = empStatusMap.get(name) || { printed: 0, pending: 0, processing: 0, cancelled: 0 };
    const actions = (counts.printed + counts.pending + counts.processing + counts.cancelled);
    const alt = empAltMap.get(name) || 0;
    const added = addedByEmpCS.get(name) || 0;

    const own_printed_rate = actions > 0 ? Math.round((counts.printed / actions) * 1000) / 10 : 0;
    const own_pending_rate = actions > 0 ? Math.round((counts.pending / actions) * 1000) / 10 : 0;
    const own_cancel_rate = actions > 0 ? Math.round((counts.cancelled / actions) * 1000) / 10 : 0;
    const own_proc_rate = actions > 0 ? Math.round((counts.processing / actions) * 1000) / 10 : 0;
    const own_alt_rate = actions > 0 ? Math.round((alt / actions) * 1000) / 10 : 0;

    const contribution_pct = totalActions > 0 ? Math.round((actions / totalActions) * 1000) / 10 : 0;
    const efficiency_score = actions > 0 ? Math.round(((counts.printed + counts.processing) / actions) * 1000) / 10 : 0;
    const activity_score = Math.round(Math.min((actions / maxActions) * 100, 100) * 10) / 10;

    // Component scores
    const print_score = Math.min(own_printed_rate, 100);
    const pending_control_score = Math.max(0, 100 - own_pending_rate);
    const cancel_control_score = Math.max(0, 100 - (own_cancel_rate * 2.5));
    const proc_score = Math.min(own_proc_rate * 10, 100);

    let rawScore = (
      weights.w_prod * activity_score +
      weights.w_print * print_score +
      weights.w_pend * pending_control_score +
      weights.w_canc * cancel_control_score +
      weights.w_proc * proc_score
    );

    // Cancel risk & Low Volume handling
    let cancel_risk = 'Normal';
    if (actions < weights.min_actions) {
      cancel_risk = 'Low Volume';
      // Confidence scaling to prevent 1-action agents from dominating ranking
      const confidence = actions / weights.min_actions;
      rawScore = rawScore * (0.3 + 0.7 * confidence);
    } else {
      if (own_cancel_rate >= 1.5 * teamCancelRate) {
        cancel_risk = 'High';
      } else if (own_cancel_rate >= 1.15 * teamCancelRate) {
        cancel_risk = 'Elevated';
      }
    }

    const performance_score = Math.round(rawScore * 10) / 10;

    employees.push({
      name,
      printed: counts.printed,
      pending: counts.pending,
      processing: counts.processing,
      cancelled: counts.cancelled,
      alt,
      added,
      actions,
      contribution_pct,
      own_printed_rate,
      own_pending_rate,
      own_cancel_rate,
      own_proc_rate,
      own_alt_rate,
      activity_score,
      efficiency_score,
      performance_score,
      cancel_risk,
    });
  }

  // Sort strictly by PERFORMANCE SCORE for Rank, Grade, Segment (Part 9, 31, 32)
  employees.sort((a, b) => b.performance_score - a.performance_score || b.actions - a.actions);

  const totalEmps = employees.length;
  employees.forEach((emp, i) => {
    emp.rank = i + 1;
    emp.pctile = totalEmps > 1 ? Math.round(((totalEmps - i) / totalEmps) * 1000) / 10 : 100;

    // Grade
    if (emp.pctile >= 90) emp.grade = 'A+';
    else if (emp.pctile >= 80) emp.grade = 'A';
    else if (emp.pctile >= 70) emp.grade = 'B+';
    else if (emp.pctile >= 60) emp.grade = 'B';
    else if (emp.pctile >= 45) emp.grade = 'C+';
    else if (emp.pctile >= 30) emp.grade = 'C';
    else emp.grade = 'D';

    // Segment
    if (emp.performance_score >= 75) emp.segment = 'Top Performer';
    else if (emp.performance_score >= 50) emp.segment = 'Core Contributor';
    else if (emp.performance_score >= 30) emp.segment = 'Developing';
    else emp.segment = 'Needs Attention';
  });

  // Top 10 Performers (strictly by performance score)
  const top10Performers = employees.slice(0, 10);

  // Most Active Agents (strictly by actions)
  const mostActive = [...employees].sort((a, b) => b.actions - a.actions).slice(0, 10);

  // Added Orders - CS ONLY for Top Contributors (Part 33, 34, 60, 85)
  const allCSContributors = Array.from(addedByEmpCS.entries())
    .map(([name, value]) => ({
      name,
      employee: name,
      value,
      count: value,
      is_cs: true,
    }))
    .sort((a, b) => b.value - a.value);

  const topAddedCS = allCSContributors.slice(0, 15);
  const topCSContributor = topAddedCS[0] ? {
    employee: topAddedCS[0].employee,
    name: topAddedCS[0].name,
    count: topAddedCS[0].count,
    value: topAddedCS[0].value,
  } : null;

  let totalAddedCS = 0;
  for (const val of addedByEmpCS.values()) totalAddedCS += val;
  let totalAddedNonCS = 0;
  for (const val of addedByEmpNonCS.values()) totalAddedNonCS += val;

  // Daily Trend aggregation from timestamps
  const dayMap = new Map();
  for (const r of records) {
    if (!r.dt) continue;
    const dKey = formatDateKey(r.dt);
    if (!dayMap.has(dKey)) {
      dayMap.set(dKey, { date: dKey, new_orders: 0, printed: 0, cancelled: 0, pending: 0 });
    }
  }

  // Populate daily actions
  for (const a of dedupedCSActions) {
    if (!a.dt) continue;
    const dKey = formatDateKey(a.dt);
    const day = dayMap.get(dKey);
    if (day) {
      if (a.st === 'Printed') day.printed++;
      else if (a.st === 'Cancelled') day.cancelled++;
      else if (a.st === 'Pending') day.pending++;
    }
  }

  // Populate daily added orders
  for (const r of records) {
    if (r.added && r.dt) {
      const dKey = formatDateKey(r.dt);
      const day = dayMap.get(dKey);
      if (day) day.new_orders++;
    }
  }

  const dailyTrend = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  return {
    summary: {
      rawStatusCount,
      dedupedCSActionsCount: totalActions,
      duplicatesRemovedPct: rawStatusCount > 0 ? Math.round(((rawStatusCount - totalActions) / rawStatusCount) * 1000) / 10 : 0,
      totalNewOrders: uniqueAddedOrders.size,
      uniquePrintedOrders: uniquePrintedOrders.size,
      currentPendingBacklog,
      uniqueCancelledOrders: uniqueCancelledOrders.size,
      processingOrders,
      totalAltPhones,
      totalRealActions: totalActions,
      printedActions: totalPrintedActions,
      pendingActions: totalPendingActions,
      processingActions: totalProcessingActions,
      cancelledActions: totalCancelledActions,
      teamCancelRate: Math.round(teamCancelRate * 10) / 10,
    },
    employees,
    top10Performers,
    mostActive,
    topCSContributors: topAddedCS,
    topCSContributor,
    allCSContributors,
    addedOrders: {
      totalAdded: uniqueAddedOrders.size,
      totalAddedCS,
      totalAddedNonCS,
      fromCS: totalAddedCS,
      fromOtherDepartments: totalAddedNonCS,
      topCSContributor,
      topCSContributors: topAddedCS,
      allCSContributors,
    },
    dailyTrend,
  };
}

/**
 * Save daily performance snapshot to SQLite database
 */
export function savePerformanceSnapshotToDB(date, metrics, sourceFileId = null) {
  const insertSnapshot = db.prepare(`
    INSERT INTO performance_snapshots (
      date, employee_id, employee_name, real_actions,
      new_orders, printed_orders, pending_backlog, cancelled_orders,
      processing_orders, alt_phones, added_orders,
      printed_actions, pending_actions, processing_actions, cancelled_actions,
      own_printed_rate, own_pending_rate, own_cancel_rate, own_proc_rate, own_alt_rate,
      activity_score, efficiency_score, performance_score, contribution_pct,
      rate, grade, segment, cancel_risk, source_file_id
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )
    ON CONFLICT(date, employee_name) DO UPDATE SET
      employee_id = excluded.employee_id,
      real_actions = excluded.real_actions,
      new_orders = excluded.new_orders,
      printed_orders = excluded.printed_orders,
      pending_backlog = excluded.pending_backlog,
      cancelled_orders = excluded.cancelled_orders,
      processing_orders = excluded.processing_orders,
      alt_phones = excluded.alt_phones,
      added_orders = excluded.added_orders,
      printed_actions = excluded.printed_actions,
      pending_actions = excluded.pending_actions,
      processing_actions = excluded.processing_actions,
      cancelled_actions = excluded.cancelled_actions,
      own_printed_rate = excluded.own_printed_rate,
      own_pending_rate = excluded.own_pending_rate,
      own_cancel_rate = excluded.own_cancel_rate,
      own_proc_rate = excluded.own_proc_rate,
      own_alt_rate = excluded.own_alt_rate,
      activity_score = excluded.activity_score,
      efficiency_score = excluded.efficiency_score,
      performance_score = excluded.performance_score,
      contribution_pct = excluded.contribution_pct,
      rate = excluded.rate,
      grade = excluded.grade,
      segment = excluded.segment,
      cancel_risk = excluded.cancel_risk,
      source_file_id = excluded.source_file_id,
      created_at = datetime('now')
  `);

  // STRICT REQUIREMENT: NEVER auto-create employees from Excel files.
  // Employee Master is entered manually by the user.
  const findEmp = db.prepare('SELECT id FROM employees WHERE name = ? COLLATE NOCASE');

  const tx = db.transaction(() => {
    for (const emp of metrics.employees) {
      const empRow = findEmp.get(emp.name);
      const empId = empRow ? empRow.id : null;

      insertSnapshot.run(
        date,
        empId,
        emp.name,
        emp.actions,
        emp.added,
        emp.printed,
        emp.pending,
        emp.cancelled,
        emp.processing,
        emp.alt,
        emp.added,
        emp.printed,
        emp.pending,
        emp.processing,
        emp.cancelled,
        emp.own_printed_rate,
        emp.own_pending_rate,
        emp.own_cancel_rate,
        emp.own_proc_rate,
        emp.own_alt_rate,
        emp.activity_score ?? 0,
        emp.efficiency_score ?? 0,
        emp.performance_score ?? emp.score ?? 0,
        emp.contribution_pct ?? 0,
        emp.rate ?? emp.efficiency_score ?? 0,
        emp.grade ?? 'B',
        emp.segment ?? 'Core Contributor',
        emp.cancel_risk ?? 'Normal',
        sourceFileId
      );
    }

    // Also persist complete daily metrics snapshot for global date navigation
    try {
      db.prepare(`
        INSERT INTO daily_metrics_snapshots (work_date, source_file_id, metrics_json, created_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(work_date) DO UPDATE SET
          source_file_id = excluded.source_file_id,
          metrics_json = excluded.metrics_json,
          created_at = datetime('now')
      `).run(date, sourceFileId, JSON.stringify(metrics));
    } catch (snapErr) {
      console.warn('Could not update daily_metrics_snapshots:', snapErr.message);
    }
  });

  tx();
}

export const savePerformanceSnapshot = savePerformanceSnapshotToDB;

/**
 * Computes deep forensic productivity metrics directly from raw log records:
 * - Unique valid orders worked (excluding Canceled!)
 * - Deduplicated real actions (120s window)
 * - Robust typical rate: Orders / 10 min (median of active 10-minute tumbling windows)
 * - Orders / hour
 * - Consistency score (based on 10-min window variance)
 * - Confidence level ('HIGH', 'MEDIUM', 'LOW') based on sample size
 */
export function computeForensicProductivityFromLogs(asOfDate = null) {
  let query = `
    SELECT employee_name, order_code, status, action, event_datetime, work_date
    FROM raw_log_records
    WHERE is_cs = 1
      AND (status IS NULL OR (LOWER(status) NOT LIKE '%cancel%'))
      AND (action IS NULL OR (LOWER(action) NOT LIKE '%cancel%'))
  `;
  const params = [];
  if (asOfDate) {
    query += ' AND work_date <= ? ';
    params.push(asOfDate);
  }
  query += ' ORDER BY employee_name, event_datetime ASC ';

  let rows = [];
  try {
    rows = db.prepare(query).all(...params);
  } catch (_) {
    return new Map();
  }

  const byEmp = new Map();
  for (const r of rows) {
    const norm = normalizeEmployeeName(r.employee_name);
    if (!byEmp.has(norm)) byEmp.set(norm, []);
    byEmp.get(norm).push(r);
  }

  const map = new Map();
  for (const [norm, recs] of byEmp.entries()) {
    const uniqueOrders = new Set(recs.map(r => r.order_code));
    const dates = new Set(recs.map(r => r.work_date));

    // 120s deduplication (Valid Non-Canceled actions only)
    const deduped = [];
    const prevTimeMap = new Map();
    for (const r of recs) {
      if (!r.event_datetime) continue;
      const ts = new Date(r.event_datetime.replace(' ', 'T')).getTime();
      if (isNaN(ts)) continue;
      const key = r.order_code + '::' + (r.status || r.action || '');
      const prevTs = prevTimeMap.get(key) || 0;
      if (ts - prevTs > 120000) {
        deduped.push({ ...r, ts });
        prevTimeMap.set(key, ts);
      }
    }

    // 10-minute tumbling active windows
    const windows10m = new Map();
    for (const d of deduped) {
      const winKey = Math.floor(d.ts / (10 * 60 * 1000));
      if (!windows10m.has(winKey)) windows10m.set(winKey, new Set());
      windows10m.get(winKey).add(d.order_code);
    }

    const windowEntries = Array.from(windows10m.entries()).sort((a, b) => a[0] - b[0]);
    const windowRates = windowEntries.map(e => e[1].size);
    const sortedRates = [...windowRates].sort((a, b) => a - b);
    const windowCount = sortedRates.length;

    let typical10m = 0;
    let consistency = 0;
    let recent10m = 0;

    if (windowCount > 0) {
      // Robust typical rate: median (avoids abnormal burst distortion)
      typical10m = sortedRates[Math.floor(windowCount / 2)];
      const mean = sortedRates.reduce((a, b) => a + b, 0) / windowCount;
      const variance = sortedRates.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / windowCount;
      const stdDev = Math.sqrt(variance);
      consistency = +(Math.max(0, 1 - (stdDev / (mean || 1)))).toFixed(2);

      // Meaningful recent periods from actual dated log evidence (Section 25 & 45)
      const maxTs = Math.max(...deduped.map(d => d.ts));
      const recentWindowCutoff = maxTs - (7 * 24 * 60 * 60 * 1000); // within recent 7 days
      const recentWindows = windowEntries.filter(e => {
        const winTs = e[0] * (10 * 60 * 1000);
        return winTs >= recentWindowCutoff;
      });

      let recentRates = recentWindows.map(e => e[1].size).sort((a, b) => a - b);
      if (recentRates.length === 0 || recentRates.length < 3) {
        // If single day or few windows, use the latter half of chronological active windows
        const halfIndex = Math.max(0, Math.floor(windowEntries.length / 2));
        const recentHalf = windowEntries.slice(halfIndex);
        recentRates = recentHalf.map(e => e[1].size).sort((a, b) => a - b);
      }

      if (recentRates.length > 0) {
        recent10m = recentRates[Math.floor(recentRates.length / 2)];
      } else {
        recent10m = typical10m;
      }
    }

    const sampleSize = uniqueOrders.size;
    let confidence = 'LOW';
    if (sampleSize >= 50 && windowCount >= 10) confidence = 'HIGH';
    else if (sampleSize >= 20 || windowCount >= 5) confidence = 'MEDIUM';

    map.set(norm, {
      sampleSize,
      daysActive: dates.size,
      windowCount,
      dedupedActions: deduped.length,
      typicalOrdersPer10Min: typical10m,
      typicalOrdersPerHour: +(typical10m * 6).toFixed(1),
      recentOrdersPer10Min: recent10m,
      longTermOrdersPer10Min: typical10m,
      consistency,
      confidence
    });
  }

  return map;
}

/**
 * Builds real historical employee performance & capacity profiles from logs & snapshots
 *
 * Factors extracted from REAL historical logs:
 * - Completed orders (printed_orders / unique orders worked)
 * - Deduplicated real actions (2-minute window)
 * - Historical KPI performance score
 * - Speed / completion rate index (Orders / 10 min)
 * - Dynamic estimated daily capacity & remaining capacity derived strictly from productivity
 * - Consistency and confidence metrics
 */
export function getEmployeePerformanceProfiles(asOfDate = null) {
  const employees = db.prepare('SELECT id, name, department, team_membership, notes FROM employees WHERE active = 1').all();

  let snapQuery = `
    SELECT employee_name,
           AVG(performance_score) as avg_score,
           AVG(rate) as avg_rate,
           AVG(printed_orders) as avg_printed_orders,
           AVG(real_actions) as avg_real_actions,
           MAX(performance_score) as max_score,
           COUNT(DISTINCT date) as days_active
    FROM performance_snapshots
  `;
  const params = [];
  if (asOfDate) {
    snapQuery += ' WHERE date <= ? ';
    params.push(asOfDate);
  }
  snapQuery += ' GROUP BY employee_name ';

  let snapshotRows = [];
  try {
    snapshotRows = db.prepare(snapQuery).all(...params);
  } catch (e) {
    // fallback if table empty
  }

  const snapMap = new Map();
  for (const s of snapshotRows) {
    snapMap.set(normalizeEmployeeName(s.employee_name), s);
  }

  // Also query raw_log_records for real historical action counts
  let rawQuery = `
    SELECT employee_name,
           COUNT(DISTINCT order_code) as total_unique_orders,
           COUNT(*) as total_actions,
           COUNT(DISTINCT work_date) as active_days
    FROM raw_log_records
    WHERE is_cs = 1
  `;
  const rawParams = [];
  if (asOfDate) {
    rawQuery += ' AND work_date <= ? ';
    rawParams.push(asOfDate);
  }
  rawQuery += ' GROUP BY employee_name ';

  let rawRows = [];
  try {
    rawRows = db.prepare(rawQuery).all(...rawParams);
  } catch (e) {
    // fallback
  }

  const rawMap = new Map();
  for (const r of rawRows) {
    rawMap.set(normalizeEmployeeName(r.employee_name), r);
  }

  // Compute deep forensic productivity directly from logs
  const forensicMap = computeForensicProductivityFromLogs(asOfDate);

  // Fetch capacity and scoring configurations from system_configs
  let defaultCapacity = 80;
  let expectedWorkingMinutes = 360;
  let capacitySafetyFactor = 0.85;
  let minCapacityFloor = 30;
  let maxCapacityCeiling = 150;
  let recencyWeight = 0.40;
  let productivityWeight = 0.40;

  try {
    const cfgs = db.prepare("SELECT key, value FROM system_configs").all();
    for (const c of cfgs) {
      const val = parseFloat(c.value);
      if (!isNaN(val)) {
        if (c.key === 'max_single_employee_capacity') defaultCapacity = val;
        if (c.key === 'expected_working_minutes') expectedWorkingMinutes = val;
        if (c.key === 'capacity_safety_factor') capacitySafetyFactor = val;
        if (c.key === 'min_capacity_floor') minCapacityFloor = val;
        if (c.key === 'max_capacity_ceiling') maxCapacityCeiling = val;
        if (c.key === 'recency_weight') recencyWeight = val;
        if (c.key === 'productivity_weight') productivityWeight = val;
      }
    }
  } catch (e) {
    // fallback
  }

  const profiles = new Map();
  for (const emp of employees) {
    const norm = normalizeEmployeeName(emp.name);
    const snap = snapMap.get(norm);
    const raw = rawMap.get(norm);
    const forensic = forensicMap.get(norm);

    let historicalScore = 70; // baseline if no history
    let historicalRate = 1.0;
    let avgDailyOrders = 0;
    let daysActive = 0;

    if (snap) {
      avgDailyOrders = snap.avg_printed_orders || 0;
      daysActive = snap.days_active || 0;
    } else if (raw && raw.active_days > 0) {
      avgDailyOrders = Math.round(raw.total_unique_orders / raw.active_days);
      daysActive = raw.active_days;
    }

    const typicalOrders10m = forensic?.typicalOrdersPer10Min || (avgDailyOrders > 0 ? Math.max(1, Math.round(avgDailyOrders / 20)) : 2);
    const typicalOrdersHour = forensic?.typicalOrdersPerHour || +(typicalOrders10m * 6).toFixed(1);
    const recentOrders10m = forensic?.recentOrdersPer10Min || typicalOrders10m;
    const consistency = forensic ? forensic.consistency : 0.40;
    const sampleSize = forensic ? forensic.sampleSize : (avgDailyOrders > 0 ? avgDailyOrders : daysActive * 30);
    const confidence = forensic ? forensic.confidence : (daysActive >= 2 ? 'HIGH' : (sampleSize >= 20 ? 'MEDIUM' : 'LOW'));

    // 1. Authoritative Historical Rate from Real Logs (Sections 2, 3, 35)
    // Baseline typical rate is 2 orders / 10 minutes (12 orders/hour = 1.0x rate)
    // Fast agents with 4 orders/10m = 2.0x rate; Slower agents with 1 order/10m = 0.5x rate
    if (forensic && forensic.windowCount > 0) {
      historicalRate = +(typicalOrders10m / 2.0).toFixed(2);
    } else if (snap && snap.avg_rate) {
      historicalRate = snap.avg_rate;
    }

    // 2. Dynamic Capacity derived strictly from Productivity (Section 5, 23):
    // Conceptual model:
    // Historical Typical Rate (orders/min) × Expected Available Working Time × Safety Factor = Estimated Capacity
    // MIN CAPACITY FLOOR is a planning baseline only for unmeasured agents, NEVER creating fake operational capacity
    let estimatedDailyCapacity = defaultCapacity;
    if (forensic && forensic.windowCount > 0 && typicalOrders10m > 0) {
      const blended10m = (typicalOrders10m * (1 - recencyWeight)) + (recentOrders10m * recencyWeight);
      const ratePerMinute = blended10m / 10;
      const rawCapacity = ratePerMinute * expectedWorkingMinutes * capacitySafetyFactor;

      // Real evidence scaling: high confidence uses 100% of derived capacity; lower confidence scales conservatively
      const confidenceMultiplier = confidence === 'HIGH' ? 1.0 : (confidence === 'MEDIUM' ? 0.90 : 0.80);
      const calculatedCap = Math.round(rawCapacity * confidenceMultiplier);
      // Cap at safety ceiling; preserve actual observed low capacity without inflating to floor
      estimatedDailyCapacity = Math.min(maxCapacityCeiling, Math.max(1, calculatedCap));
    } else if (avgDailyOrders > 0) {
      estimatedDailyCapacity = Math.min(maxCapacityCeiling, Math.max(1, Math.round(avgDailyOrders * 1.1)));
    } else {
      estimatedDailyCapacity = minCapacityFloor;
    }

    // 3. Real-log Driven Historical Score (Sections 2, 35):
    // Real log throughput drives the productivity base score
    if (forensic && forensic.windowCount > 0) {
      const blended10m = (typicalOrders10m * (1 - recencyWeight)) + (recentOrders10m * recencyWeight);
      const baseProdScore = Math.min(100, Math.max(20, blended10m * 22.5));
      const consistencyFactor = 0.85 + (consistency * 0.25);
      const confFactor = confidence === 'HIGH' ? 1.0 : (confidence === 'MEDIUM' ? 0.90 : 0.75);
      const logProdScore = Math.min(100, Math.max(20, baseProdScore * consistencyFactor * confFactor));

      if (snap && snap.avg_score) {
        // Blend real log throughput (70%) with quality KPI from snapshot (30%)
        historicalScore = Math.round(((logProdScore * 0.70) + (snap.avg_score * 0.30)) * 10) / 10;
      } else {
        historicalScore = Math.round(logProdScore * 10) / 10;
      }
    } else if (snap && snap.avg_score) {
      historicalScore = Math.round(snap.avg_score * 10) / 10;
    } else {
      historicalScore = 70;
    }

    profiles.set(emp.id, {
      employee_id: emp.id,
      employee_name: emp.name,
      historical_score: Math.round(historicalScore * 10) / 10,
      historical_rate: Math.round(historicalRate * 100) / 100,
      average_daily_orders: Math.round(avgDailyOrders),
      days_active: daysActive,
      estimated_daily_capacity: estimatedDailyCapacity,
      typical_orders_10m: typicalOrders10m,
      typical_orders_hour: typicalOrdersHour,
      recent_orders_10m: recentOrders10m,
      long_term_orders_10m: typicalOrders10m,
      consistency: consistency,
      sample_size: sampleSize,
      confidence: confidence,
      valid_unique_orders: forensic ? forensic.sampleSize : (avgDailyOrders * daysActive),
      deduped_actions: forensic ? forensic.dedupedActions : 0
    });
  }

  return profiles;
}

/**
 * Calculates a transparent, explainable Smart Allocation Score for an employee
 * taking into account:
 * - Real-log historical productivity score & rate
 * - Current available capacity (estimated capacity - current assigned orders)
 * - Workload fairness (number of accounts and orders assigned)
 */
export function calculateSmartAllocationScore(employeeId, profile, currentWorkload, weights = null) {
  const wPerf = weights?.weight_performance ?? 0.40;
  const wCap = weights?.weight_capacity ?? 0.35;
  const wFair = weights?.weight_workload_balance ?? 0.25;

  const histScore = profile ? profile.historical_score : 70;
  const estCapacity = profile ? profile.estimated_daily_capacity : 80;
  const histRate = profile ? profile.historical_rate : 1.0;
  const typical10m = profile ? profile.typical_orders_10m : 2;
  const recent10m = profile ? profile.recent_orders_10m : typical10m;
  const consistency = profile ? profile.consistency : 0.40;
  const confidence = profile ? profile.confidence : 'LOW';

  const assignedOrders = currentWorkload ? (currentWorkload.ordersCount || 0) : 0;
  const assignedAccounts = currentWorkload ? (currentWorkload.accountsCount || 0) : 0;

  const remainingCapacity = Math.max(0, estCapacity - assignedOrders);

  // Normalized components (0 to 100 scale):
  // 1. Productivity & Performance component: KPI score (0-100) multiplied by rate factor
  const rateFactor = Math.min(1.4, Math.max(0.6, histRate));
  const perfNorm = Math.min(100, Math.max(0, histScore * rateFactor));

  // 2. Capacity component: Remaining capacity ratio
  const capNorm = estCapacity > 0
    ? Math.min(100, Math.max(0, (remainingCapacity / estCapacity) * 100))
    : 0;

  // 3. Workload Fairness component: Decreases as accounts/orders increase
  const fairNorm = Math.max(0, 100 - (assignedAccounts * 15 + (estCapacity > 0 ? (assignedOrders / estCapacity) * 50 : 50)));

  const compositeScore = (perfNorm * wPerf) + (capNorm * wCap) + (fairNorm * wFair);

  return {
    employee_id: employeeId,
    composite_score: Math.round(compositeScore * 100) / 100,
    historical_score: histScore,
    historical_rate: histRate,
    typical_orders_10m: typical10m,
    recent_orders_10m: recent10m,
    consistency: consistency,
    confidence: confidence,
    estimated_daily_capacity: estCapacity,
    assigned_orders: assignedOrders,
    assigned_accounts: assignedAccounts,
    remaining_capacity: remainingCapacity,
    perf_component: Math.round(perfNorm * 10) / 10,
    cap_component: Math.round(capNorm * 10) / 10,
    fair_component: Math.round(fairNorm * 10) / 10
  };
}
