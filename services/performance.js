import { db } from '../db/index.js';
import { formatDateKey } from './parser.js';

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
export function computePerformanceFromRecords(records) {
  const weights = getSystemWeights();

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
    if (r.order) {
      if (r.dt) {
        if (!orderEventsMap.has(r.order)) {
          orderEventsMap.set(r.order, []);
        }
        orderEventsMap.get(r.order).push(r);
      }
    }

    if (r.added) {
      const key = `${r.order}|${r.name}`;
      if (!addedDedup.has(key)) {
        addedDedup.add(key);
        uniqueAddedOrders.add(r.order);
        addedByEmp.set(r.name, (addedByEmp.get(r.name) || 0) + 1);
        if (r.isCS) {
          addedByEmpCS.set(r.name, (addedByEmpCS.get(r.name) || 0) + 1);
        } else {
          addedByEmpNonCS.set(r.name, (addedByEmpNonCS.get(r.name) || 0) + 1);
        }
      }
    }

    if (r.alt) {
      const key = `${r.order}|${r.name}`;
      if (!altGroups.has(key)) altGroups.set(key, []);
      altGroups.get(key).push(r.dt || 0);
    }

    if (r.st) {
      rawStatusCount++;
      if (r.isCS) {
        const key = `${r.order}|${r.name}|${r.st}`;
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
  const topAddedCS = Array.from(addedByEmpCS.entries())
    .map(([name, value]) => ({ name, value, is_cs: true }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 15);

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
    addedOrders: {
      totalAdded: uniqueAddedOrders.size,
      totalAddedCS,
      totalAddedNonCS,
      topCSContributors: topAddedCS,
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
  });

  tx();
}

export const savePerformanceSnapshot = savePerformanceSnapshotToDB;
