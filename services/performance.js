import { db } from '../db/index.js';
import { formatDateKey, isCSName, isCsEmployee, isHistoricalCsName, normalizeEmployeeName, matchEmployeeInMaster, parseDate, KNOWN_STATUSES, STATUS_RE, ALT_RE, ADDED_RE } from './parser.js';
import { extractCanonicalStatus } from './vendoor/actions.js';

import { getCairoBusinessDate } from './time_utils.js';

export { isCsEmployee };

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

  let targetWorkDate = null;
  if (typeof dbEmployeesMap === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dbEmployeesMap)) {
    targetWorkDate = dbEmployeesMap;
    dbEmployeesMap = null;
  }
  if (!targetWorkDate && records && records.length > 0) {
    const firstRec = records.find(r => r.work_date || r.event_datetime);
    if (firstRec) {
      if (firstRec.work_date) targetWorkDate = String(firstRec.work_date).slice(0, 10);
      else if (firstRec.event_datetime) targetWorkDate = String(firstRec.event_datetime).slice(0, 10);
    }
  }

  if (!dbEmployeesMap) {
    try {
      dbEmployeesMap = db.prepare('SELECT id, name, department, active, status, team_membership FROM employees').all();
    } catch (_) {}
  }

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

  // Uniform record normalization: handles both parser records and raw_log_records database rows
  const normalizedRecords = (records || []).map(r => {
    const rawName = r.name || r.employee_name || '';
    const orderCode = r.order || r.order_code || '';
    const actionText = r.act || r.action || '';
    let statusText = r.st || r.status || null;

    let dt = r.dt;
    if (!dt && r.event_datetime) {
      dt = parseDate(r.event_datetime);
    }

    const isNote = /ملاحظ/i.test(actionText) || /note/i.test(actionText);
    const isAddressEdit = /عدل.*العنوان|تعديل.*العنوان/i.test(actionText);
    const isClientEdit = /عدل.*اسم.*العميل|تعديل.*اسم.*العميل/i.test(actionText);
    const isAlt = !isNote && !isAddressEdit && !isClientEdit && (r.alt !== undefined ? Boolean(r.alt) : ALT_RE.test(actionText));
    const isAdded = !isNote && !isAddressEdit && !isClientEdit && (r.added !== undefined ? Boolean(r.added) : ADDED_RE.test(actionText));

    if (isNote || isAddressEdit || isClientEdit) {
      statusText = null;
    } else if (r.st && KNOWN_STATUSES.has(r.st === 'Canceled' ? 'Cancelled' : r.st)) {
      statusText = r.st === 'Canceled' ? 'Cancelled' : r.st;
    } else if (!isAlt && !isAdded) {
      const m = STATUS_RE.exec(actionText);
      if (m) {
        const candidate = m[1].trim() === 'Canceled' ? 'Cancelled' : m[1].trim();
        if (KNOWN_STATUSES.has(candidate)) {
          statusText = candidate;
        } else {
          statusText = null;
        }
      } else if (r.status && KNOWN_STATUSES.has(r.status === 'Canceled' ? 'Cancelled' : r.status)) {
        statusText = r.status === 'Canceled' ? 'Cancelled' : r.status;
      } else {
        const canonical = extractCanonicalStatus(actionText, r.status);
        if (KNOWN_STATUSES.has(canonical)) {
          statusText = canonical;
        } else {
          statusText = null;
        }
      }
    } else {
      statusText = null;
    }

    // Canonical CS verification: check Employee Master first, then historical CS name detection
    let isCS = isCsEmployee({ name: rawName, employee_name: rawName, department: r.department }, dbEmployeesMap);
    if (!isCS && (r.is_cs === 1 || r.is_cs === true || r.isCS === true)) {
      isCS = isHistoricalCsName(rawName);
    }

    return {
      order: orderCode,
      name: rawName,
      act: actionText,
      st: statusText,
      dt,
      alt: isAlt,
      added: isAdded,
      isCS
    };
  });

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

  // Orders touched across the dataset for order-level metrics (Printed, Cancelled, Backlog)
  const orderEventsMap = new Map();
  // Orders touched by CS actors strictly for CS order-level metrics
  const csOrderEventsMap = new Map();

  let rawStatusCount = 0;

  for (const r of normalizedRecords) {
    const canonicalName = getCanonicalEmpName(r.name);
    const isCS = r.isCS;

    if (r.order && r.dt) {
      if (!orderEventsMap.has(r.order)) {
        orderEventsMap.set(r.order, []);
      }
      orderEventsMap.get(r.order).push(r);

      if (isCS) {
        if (!csOrderEventsMap.has(r.order)) {
          csOrderEventsMap.set(r.order, []);
        }
        csOrderEventsMap.get(r.order).push(r);
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
      const key = `${r.order}|${canonicalName}|${isCS ? '1' : '0'}`;
      if (!altGroups.has(key)) altGroups.set(key, []);
      altGroups.get(key).push(r.dt || 0);
    }

    if (r.st && isCS) {
      rawStatusCount++;
      const key = `${r.order}|${canonicalName}|${r.st}`;
      if (!statusGroups.has(key)) statusGroups.set(key, []);
      statusGroups.get(key).push({ dt: r.dt || 0, r });
    }
  }

  // Deduplicate CS Status Events (2-minute window)
  const dedupedCSActions = [];
  const empActionsMap = new Map();
  const empStatusMap = new Map(); // emp -> { printed, pending, processing, cancelled }

  // Per-Employee Unique Order Tracking
  const empUniquePrinted = new Map(); // emp -> Set<orderCode>
  const empUniquePending = new Map(); // emp -> Set<orderCode>
  const empUniqueProcessing = new Map(); // emp -> Set<orderCode>
  const empUniqueCancelled = new Map(); // emp -> Set<orderCode>
  const empUniqueOrdersTouched = new Map(); // emp -> Set<orderCode>

  for (const [key, items] of statusGroups.entries()) {
    items.sort((a, b) => a.dt - b.dt);
    let lastTs = -Infinity;
    for (const item of items) {
      if (item.dt - lastTs > 120000) {
        dedupedCSActions.push(item.r);
        lastTs = item.dt;

        const emp = item.r.name;
        empActionsMap.set(emp, (empActionsMap.get(emp) || 0) + 1);

        if (!empUniqueOrdersTouched.has(emp)) empUniqueOrdersTouched.set(emp, new Set());
        if (item.r.order) empUniqueOrdersTouched.get(emp).add(item.r.order);

        if (!empStatusMap.has(emp)) {
          empStatusMap.set(emp, { printed: 0, pending: 0, processing: 0, cancelled: 0 });
        }
        const counts = empStatusMap.get(emp);
        const st = item.r.st;
        if (st === 'Printed') {
          counts.printed++;
          if (!empUniquePrinted.has(emp)) empUniquePrinted.set(emp, new Set());
          if (item.r.order) empUniquePrinted.get(emp).add(item.r.order);
        } else if (st === 'Pending') {
          counts.pending++;
          if (!empUniquePending.has(emp)) empUniquePending.set(emp, new Set());
          if (item.r.order) empUniquePending.get(emp).add(item.r.order);
        } else if (st === 'Processing') {
          counts.processing++;
          if (!empUniqueProcessing.has(emp)) empUniqueProcessing.set(emp, new Set());
          if (item.r.order) empUniqueProcessing.get(emp).add(item.r.order);
        } else if (st === 'Cancelled') {
          counts.cancelled++;
          if (!empUniqueCancelled.has(emp)) empUniqueCancelled.set(emp, new Set());
          if (item.r.order) empUniqueCancelled.get(emp).add(item.r.order);
        }
      }
    }
  }

  // Deduplicate Alt Phones (2-minute window)
  const empAltMap = new Map();
  const empAltMapCS = new Map();
  const empAltVerifiedMapCS = new Map();
  let totalAltPhones = 0;
  for (const [key, timestamps] of altGroups.entries()) {
    timestamps.sort((a, b) => a - b);
    let lastTs = -Infinity;
    const parts = key.split('|');
    const empName = parts[1];
    const isCsAlt = parts[2] === '1';
    for (const ts of timestamps) {
      if (ts - lastTs > 120000) {
        empAltMap.set(empName, (empAltMap.get(empName) || 0) + 1);
        if (isCsAlt) {
          empAltMapCS.set(empName, (empAltMapCS.get(empName) || 0) + 1);
          empAltVerifiedMapCS.set(empName, (empAltVerifiedMapCS.get(empName) || 0) + 1);
          totalAltPhones++;
        }
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

  // Compute Per-Employee Metrics & Scores (CS EMPLOYEES ONLY)
  const employees = [];
  const allEmpNames = new Set([...empActionsMap.keys(), ...empAltMapCS.keys(), ...addedByEmpCS.keys()]);

  for (const name of allEmpNames) {
    const counts = empStatusMap.get(name) || { printed: 0, pending: 0, processing: 0, cancelled: 0 };
    const actions = (counts.printed + counts.pending + counts.processing + counts.cancelled);
    const alt = empAltMapCS.get(name) || empAltMap.get(name) || 0;
    const alt_verified = empAltVerifiedMapCS.get(name) || alt;
    const added = addedByEmpCS.get(name) || 0;

    const unique_printed_orders = empUniquePrinted.get(name)?.size || 0;
    const unique_pending_orders = empUniquePending.get(name)?.size || 0;
    const unique_processing_orders = empUniqueProcessing.get(name)?.size || 0;
    const unique_cancelled_orders = empUniqueCancelled.get(name)?.size || 0;
    const unique_orders_touched = empUniqueOrdersTouched.get(name)?.size || 0;

    const masterMatch = matchEmployeeInMaster(name, dbEmployeesMap);
    const isApproved = Boolean(masterMatch);
    const employeeId = masterMatch ? masterMatch.id : null;
    const approvedName = masterMatch ? masterMatch.name : null;
    const identityType = isApproved ? 'APPROVED_EMPLOYEE' : (isHistoricalCsName(name) ? 'UNLINKED_HISTORICAL_IDENTITY' : 'NON_CS_ACTOR');
    const isActive = isApproved ? (masterMatch.active === 1) : false;
    const statusStr = isApproved ? (masterMatch.status || (masterMatch.active === 1 ? 'ACTIVE' : 'INACTIVE')) : 'HISTORICAL_UNLINKED';
    const csEligible = isApproved ? isCsEmployee(masterMatch) : false;
    const teamMembership = masterMatch ? (masterMatch.team_membership || 'Both') : 'None';

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

    let assigned_orders = 0;
    let assigned_accounts = 0;
    let current_workload = 0;

    if (targetWorkDate && (employeeId || name)) {
      try {
        const allocRow = db.prepare(`
          SELECT COUNT(DISTINCT order_code) as total_assigned,
                 COUNT(DISTINCT account) as accounts_count
          FROM order_level_allocations
          WHERE (employee_id = ? OR employee_name = ? COLLATE NOCASE)
            AND allocation_date = ?
        `).get(employeeId || -1, name, targetWorkDate);
        assigned_orders = allocRow?.total_assigned || 0;
        assigned_accounts = allocRow?.accounts_count || 0;
      } catch (_) {}
    }

    if (employeeId || name) {
      try {
        const cwoRow = db.prepare(`
          SELECT COUNT(*) as cnt
          FROM current_work_orders
          WHERE (assigned_employee_id = ? OR assigned_employee_name = ? COLLATE NOCASE)
            AND status IN ('New', 'Pending', 'Processing')
        `).get(employeeId || -1, name);
        current_workload = cwoRow?.cnt || 0;
      } catch (_) {}
    }

    const hasOperationalPrivileges = Boolean(isApproved && isActive && csEligible);

    employees.push({
      name,
      employee_id: employeeId,
      approved_name: approvedName,
      identity_type: identityType,
      is_approved: isApproved,
      active: isActive,
      status: statusStr,
      cs_eligible: csEligible,
      team_membership: teamMembership,
      has_operational_privileges: hasOperationalPrivileges,
      printed: counts.printed,
      unique_printed_orders,
      pending: counts.pending,
      unique_pending_orders,
      processing: counts.processing,
      unique_processing_orders,
      cancelled: counts.cancelled,
      unique_cancelled_orders,
      alt,
      alt_verified,
      added,
      actions,
      unique_orders_touched,
      assigned_orders,
      assigned_accounts,
      current_workload,
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
    .filter(([name]) => isCsEmployee(name, dbEmployeesMap))
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

  const log_totals = {
    actions: totalActions,
    printed: totalPrintedActions,
    pending: totalPendingActions,
    processing: totalProcessingActions,
    cancelled: totalCancelledActions,
    alt: totalAltPhones
  };

  const status_totals = {
    Printed: totalPrintedActions,
    Pending: totalPendingActions,
    Processing: totalProcessingActions,
    Cancelled: totalCancelledActions
  };

  const rankings = {
    printed: [...employees].sort((a, b) => (b.printed || 0) - (a.printed || 0)).slice(0, 10).map(e => ({ name: e.name || e.employee_name, value: e.printed || 0 })),
    pending: [...employees].sort((a, b) => (b.pending || 0) - (a.pending || 0)).slice(0, 10).map(e => ({ name: e.name || e.employee_name, value: e.pending || 0 })),
    cancelled: [...employees].sort((a, b) => (b.cancelled || 0) - (a.cancelled || 0)).slice(0, 10).map(e => ({ name: e.name || e.employee_name, value: e.cancelled || 0 }))
  };

  const cancel_rate_rank = [...employees].sort((a, b) => (b.own_cancel_rate || 0) - (a.own_cancel_rate || 0)).map(e => ({ name: e.name || e.employee_name, value: e.own_cancel_rate || 0 }));

  const team_cancel_rate = totalActions > 0 ? Number(((totalCancelledActions / totalActions) * 100).toFixed(1)) : 0.0;
  const team_pending_rate = totalActions > 0 ? Number(((totalPendingActions / totalActions) * 100).toFixed(1)) : 0.0;

  const hr = {
    days: dailyTrend.length || 1,
    tot_new: uniqueAddedOrders.size,
    tot_printed: totalPrintedActions,
    tot_cancel: totalCancelledActions,
    tot_add: uniqueAddedOrders.size
  };

  return {
    summary: {
      rawStatusCount,
      dedupedCSActionsCount: totalActions,
      duplicatesRemovedPct: rawStatusCount > 0 ? Math.round(((rawStatusCount - totalActions) / rawStatusCount) * 1000) / 10 : 0,
      totalNewOrders: uniqueAddedOrders.size,
      totalNewOrdersFromCS: totalAddedCS,
      totalNewOrdersFromOther: totalAddedNonCS,
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
      ordersTouchedByCS: orderEventsMap.size,
      teamCancelRate: Math.round(teamCancelRate * 10) / 10,
    },
    log_totals,
    status_totals,
    rankings,
    cancel_rate_rank,
    team_cancel_rate,
    team_pending_rate,
    hr,
    daily: dailyTrend,
    dedup: {
      removed: Math.max(0, rawStatusCount - totalActions),
      removed_pct: rawStatusCount > 0 ? Math.round(((rawStatusCount - totalActions) / rawStatusCount) * 1000) / 10 : 0
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
export function savePerformanceSnapshotToDB(date, metrics, sourceFileId = null, database = db) {
  const targetDb = database || db;
  const insertSnapshot = targetDb.prepare(`
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
  // CS operational metrics are strictly for CS employees only.
  const findEmp = targetDb.prepare('SELECT id FROM employees WHERE name = ? COLLATE NOCASE');

  const tx = targetDb.transaction(() => {
    // Delete existing snapshot records for this date so no stale non-CS records persist
    targetDb.prepare('DELETE FROM performance_snapshots WHERE date = ?').run(date);

    for (const emp of (metrics.employees || [])) {
      if (emp.isCS !== undefined && !emp.isCS) continue;

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

    // Also persist complete daily metrics snapshot for global date navigation (strictly CS for operational metrics)
    try {
      const cleanEmployees = (metrics.employees || []).filter(e => isCsEmployee(e.name));
      const cleanTopContributors = (metrics.topCSContributors || []).filter(c => isCsEmployee(c.name || c.employee || c));
      const cleanAllContributors = (metrics.allCSContributors || []).filter(c => isCsEmployee(c.name || c.employee || c));
      const cleanRankings = {
        printed: (metrics.rankings?.printed || []).filter(e => isCsEmployee(e.name || e.employee)),
        pending: (metrics.rankings?.pending || []).filter(e => isCsEmployee(e.name || e.employee)),
        cancelled: (metrics.rankings?.cancelled || []).filter(e => isCsEmployee(e.name || e.employee)),
      };
      const sanitizedMetrics = {
        ...metrics,
        employees: cleanEmployees,
        top10Performers: cleanEmployees.slice(0, 10),
        mostActive: [...cleanEmployees].sort((a, b) => (b.actions || 0) - (a.actions || 0)).slice(0, 10),
        topCSContributors: cleanTopContributors,
        topCSContributor: cleanTopContributors[0] || null,
        allCSContributors: cleanAllContributors,
        rankings: cleanRankings,
        cancel_rate_rank: (metrics.cancel_rate_rank || []).filter(e => isCsEmployee(e.name || e.employee)),
        addedOrders: {
          ...(metrics.addedOrders || {}),
          topCSContributor: cleanTopContributors[0] || null,
          topCSContributors: cleanTopContributors,
          allCSContributors: cleanAllContributors,
        }
      };

      db.prepare(`
        INSERT INTO daily_metrics_snapshots (work_date, source_file_id, metrics_json, created_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(work_date) DO UPDATE SET
          source_file_id = excluded.source_file_id,
          metrics_json = excluded.metrics_json,
          created_at = datetime('now')
      `).run(date, sourceFileId, JSON.stringify(sanitizedMetrics));
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
    if (!isCsEmployee(r.employee_name)) continue;
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
  const employees = db.prepare('SELECT id, name, department, team_membership, notes FROM employees WHERE active = 1').all().filter(e => isCsEmployee(e));

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
    snapshotRows = db.prepare(snapQuery).all(...params).filter(s => isCsEmployee(s.employee_name));
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
    rawRows = db.prepare(rawQuery).all(...rawParams).filter(r => isCsEmployee(r.employee_name));
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

/**
 * Returns the exact deduplicated records that built a given employee's metric for a work date.
 * Record count strictly matches the canonical count shown on the profile card.
 */
export function getEmployeeMetricDrilldown(workDate, employeeName, metric = 'ALL') {
  const targetDate = workDate || getCairoBusinessDate();
  let rawRows = db.prepare(`
    SELECT employee_name, action, status, order_code, event_datetime, is_cs, work_date, 'RAW_LOGS' as source
    FROM raw_log_records
    WHERE work_date = ?
    ORDER BY event_datetime ASC
  `).all(targetDate);

  if (rawRows.length === 0) {
    try {
      rawRows = db.prepare(`
        SELECT employee_name, action, action as status, order_code, timestamp_str as event_datetime, 1 as is_cs, work_date, 'VENDOOR_LOGS' as source
        FROM vendoor_logs
        WHERE work_date = ?
        ORDER BY timestamp_str ASC
      `).all(targetDate);
    } catch (_) {}
  }

  if (rawRows.length === 0) {
    return {
      success: true,
      work_date: targetDate,
      employee_name: employeeName,
      metric,
      total_count: 0,
      records: []
    };
  }

  const masterEmployees = db.prepare('SELECT id, name, department, active FROM employees').all();
  const csCache = new Map();

  const targetNorm = normalizeEmployeeName(employeeName);
  const targetMaster = masterEmployees.find(e => normalizeEmployeeName(e.name) === targetNorm);
  const validTargetNames = new Set();
  if (targetNorm) {
    validTargetNames.add(targetNorm);
    const cleanInput = (employeeName || '').replace(/\s+cs$/i, '').trim();
    if (cleanInput) validTargetNames.add(normalizeEmployeeName(cleanInput));
  }
  if (targetMaster) {
    validTargetNames.add(normalizeEmployeeName(targetMaster.name));
    const cleanMaster = (targetMaster.name || '').replace(/\s+cs$/i, '').trim();
    if (cleanMaster) validTargetNames.add(normalizeEmployeeName(cleanMaster));
    if (targetMaster.id) {
      try {
        const mappings = db.prepare('SELECT vendoor_name, normalized_name FROM vendoor_identity_mappings WHERE employee_id = ?').all(targetMaster.id);
        for (const m of mappings) {
          if (m.normalized_name) validTargetNames.add(m.normalized_name);
          if (m.vendoor_name) validTargetNames.add(normalizeEmployeeName(m.vendoor_name));
        }
      } catch (_) {}
    }
  }

  // Pre-filter rows to target employee if specified to avoid normalizing entire company logs
  const candidateRows = (targetNorm && validTargetNames.size > 0)
    ? rawRows.filter(r => {
        const norm = normalizeEmployeeName(r.employee_name);
        return validTargetNames.has(norm);
      })
    : rawRows;

  // Uniform record normalization
  const normalizedRecords = candidateRows.map(r => {
    const rawName = r.employee_name || '';
    const orderCode = r.order_code || '';
    const actionText = r.action || '';
    let statusText = r.status || null;

    let dt = null;
    if (r.event_datetime) {
      dt = parseDate(r.event_datetime);
    }

    const isNote = /ملاحظ/i.test(actionText) || /note/i.test(actionText);
    const isAddressEdit = /عدل.*العنوان|تعديل.*العنوان/i.test(actionText);
    const isClientEdit = /عدل.*اسم.*العميل|تعديل.*اسم.*العميل/i.test(actionText);
    const isAlt = !isNote && !isAddressEdit && !isClientEdit && ALT_RE.test(actionText);
    const isAdded = !isNote && !isAddressEdit && !isClientEdit && ADDED_RE.test(actionText);

    if (isNote || isAddressEdit || isClientEdit) {
      statusText = null;
    } else if (r.status && KNOWN_STATUSES.has(r.status === 'Canceled' ? 'Cancelled' : r.status)) {
      statusText = r.status === 'Canceled' ? 'Cancelled' : r.status;
    } else if (!isAlt && !isAdded) {
      const m = STATUS_RE.exec(actionText);
      if (m) {
        const candidate = m[1].trim() === 'Canceled' ? 'Cancelled' : m[1].trim();
        statusText = KNOWN_STATUSES.has(candidate) ? candidate : null;
      } else {
        const canonical = extractCanonicalStatus(actionText, r.status);
        statusText = KNOWN_STATUSES.has(canonical) ? canonical : null;
      }
    } else {
      statusText = null;
    }

    let isCS = false;
    if (r.is_cs === 1 || r.is_cs === true) {
      isCS = true;
    } else if (r.is_cs === 0 || r.is_cs === false) {
      isCS = false;
    } else {
      const norm = normalizeEmployeeName(rawName);
      if (csCache.has(norm)) {
        isCS = csCache.get(norm);
      } else {
        isCS = isCsEmployee(rawName, masterEmployees);
        csCache.set(norm, isCS);
      }
    }

    return {
      name: rawName,
      order: orderCode,
      act: actionText,
      st: statusText,
      dt,
      event_datetime: r.event_datetime,
      isCS,
      alt: isAlt,
      added: isAdded,
      source: r.source || 'VENDOOR_LOGS'
    };
  });

  const empDisplayNames = new Map();
  function getCanonicalEmpName(rawName) {
    if (!rawName) return '';
    const norm = normalizeEmployeeName(rawName);
    if (empDisplayNames.has(norm)) return empDisplayNames.get(norm);
    const match = matchEmployeeInMaster(rawName, masterEmployees);
    const displayName = match ? match.name : String(rawName).trim();
    empDisplayNames.set(norm, displayName);
    return displayName;
  }

  const statusGroups = new Map();
  const altGroups = new Map();

  for (const r of normalizedRecords) {
    const canonicalName = getCanonicalEmpName(r.name);
    const isCS = r.isCS;
    if (!isCS) continue;

    if (r.alt) {
      const key = `${r.order}|${canonicalName}`;
      if (!altGroups.has(key)) altGroups.set(key, []);
      altGroups.get(key).push({ dt: r.dt || 0, r, canonicalName });
    }

    if (r.st) {
      const key = `${r.order}|${canonicalName}|${r.st}`;
      if (!statusGroups.has(key)) statusGroups.set(key, []);
      statusGroups.get(key).push({ dt: r.dt || 0, r, canonicalName });
    }
  }

  // Deduplicate CS Status Events (120s sliding window)
  const dedupedCSActions = [];
  for (const [, items] of statusGroups.entries()) {
    items.sort((a, b) => a.dt - b.dt);
    let lastTs = -Infinity;
    for (const item of items) {
      if (item.dt - lastTs > 120000) {
        dedupedCSActions.push({ ...item.r, canonicalName: item.canonicalName });
        lastTs = item.dt;
      }
    }
  }

  // Deduplicate Alt Phones (120s sliding window)
  const dedupedAltPhones = [];
  for (const [, items] of altGroups.entries()) {
    items.sort((a, b) => a.dt - b.dt);
    let lastTs = -Infinity;
    for (const item of items) {
      if (item.dt - lastTs > 120000) {
        dedupedAltPhones.push({ ...item.r, canonicalName: item.canonicalName });
        lastTs = item.dt;
      }
    }
  }

  const normMetric = String(metric || 'ALL').trim().toUpperCase();
  let matched = [];

  if (normMetric === 'ALT' || normMetric === 'ALT_PHONE') {
    matched = dedupedAltPhones.filter(r => normalizeEmployeeName(r.canonicalName) === targetNorm || normalizeEmployeeName(r.name) === targetNorm);
  } else {
    const empActions = dedupedCSActions.filter(r => normalizeEmployeeName(r.canonicalName) === targetNorm || normalizeEmployeeName(r.name) === targetNorm);
    if (normMetric === 'PRINTED') {
      matched = empActions.filter(r => r.st === 'Printed');
    } else if (normMetric === 'PENDING') {
      matched = empActions.filter(r => r.st === 'Pending');
    } else if (normMetric === 'CANCEL' || normMetric === 'CANCELLED') {
      matched = empActions.filter(r => r.st === 'Cancelled');
    } else if (normMetric === 'PROCESSING') {
      matched = empActions.filter(r => r.st === 'Processing');
    } else {
      // ACTIONS or ALL
      matched = empActions;
    }
  }

  // Sort descending by event_datetime
  matched.sort((a, b) => (b.dt || 0) - (a.dt || 0));

  return {
    success: true,
    work_date: targetDate,
    employee_name: employeeName,
    metric: normMetric,
    total_count: matched.length,
    records: matched.map(m => ({
      order_code: m.order,
      status: m.st || (m.alt ? 'Alt Phone' : (m.added ? 'Added Order' : 'Action')),
      action: m.act,
      event_datetime: m.event_datetime,
      work_date: targetDate,
      raw_actor_name: m.name,
      source: m.source || 'VENDOOR_LOGS'
    }))
  };
}

/**
 * Returns comprehensive Employee Profile with strict separation of:
 * 1. Actions (Real Deduplicated Actions Breakdown)
 * 2. Unique Orders (Unique Orders Touched, Printed, Cancelled, Pending)
 * 3. Assigned Orders (From order_level_allocations)
 * 4. Current Workload (From current_work_orders & Pending Backlog)
 * 5. Historical Activity (Cross-date performance snapshots & activity history)
 *
 * Enforces authoritative identity rules:
 * - Approved active CS employees receive full operational status.
 * - Historical CS identities retain their activity metrics under their correct identity,
 *   but are explicitly restricted from operational allocation privileges.
 */
export function getEmployeeProfile(workDate, employeeIdOrName) {
  const targetDate = workDate || getCairoBusinessDate();
  
  // 1. Resolve employee identity from Employee Master or raw logs
  let masterEmp = null;
  const isNumericId = typeof employeeIdOrName === 'number' || (/^\d+$/.test(String(employeeIdOrName || '').trim()));
  
  if (isNumericId) {
    masterEmp = db.prepare('SELECT * FROM employees WHERE id = ?').get(parseInt(employeeIdOrName, 10));
  }
  
  if (!masterEmp) {
    const searchName = String(employeeIdOrName || '').trim();
    masterEmp = db.prepare('SELECT * FROM employees WHERE name = ? COLLATE NOCASE').get(searchName);
    if (!masterEmp) {
      const allMasters = db.prepare('SELECT * FROM employees').all();
      masterEmp = matchEmployeeInMaster(searchName, allMasters);
    }
  }
  
  const rawTargetName = masterEmp ? masterEmp.name : String(employeeIdOrName || '').trim();
  const isApproved = Boolean(masterEmp);
  const isActive = isApproved ? (masterEmp.active === 1) : false;
  const isCS = isApproved ? isCsEmployee(masterEmp) : isHistoricalCsName(rawTargetName);
  const hasOperationalPrivileges = Boolean(isApproved && isActive && isCS);
  const identityType = isApproved 
    ? (isActive ? 'APPROVED_ACTIVE_CS' : 'APPROVED_INACTIVE_CS') 
    : (isHistoricalCsName(rawTargetName) ? 'HISTORICAL_CS_IDENTITY' : 'UNRECOGNIZED_ACTOR');

  // 2. Fetch canonical date metrics
  const drilldown = getEmployeeMetricDrilldown(targetDate, rawTargetName, 'ALL');
  const records = drilldown.records || [];

  // Distinct metrics breakdown
  const uniqueOrdersTouched = new Set(records.map(r => r.order_code).filter(Boolean));
  const printedActions = records.filter(r => r.status === 'Printed');
  const uniquePrintedOrders = new Set(printedActions.map(r => r.order_code).filter(Boolean));
  const pendingActions = records.filter(r => r.status === 'Pending');
  const uniquePendingOrders = new Set(pendingActions.map(r => r.order_code).filter(Boolean));
  const cancelledActions = records.filter(r => r.status === 'Cancelled');
  const uniqueCancelledOrders = new Set(cancelledActions.map(r => r.order_code).filter(Boolean));
  const processingActions = records.filter(r => r.status === 'Processing');
  const uniqueProcessingOrders = new Set(processingActions.map(r => r.order_code).filter(Boolean));
  const altDrilldown = getEmployeeMetricDrilldown(targetDate, rawTargetName, 'ALT');
  const altActions = altDrilldown.records || [];

  // Combine actions so Activity History displays all real actions including alt phones
  const combinedMap = new Map();
  for (const r of records) {
    combinedMap.set(`${r.order_code}|${r.event_datetime}|${r.action}`, r);
  }
  for (const r of altActions) {
    const k = `${r.order_code}|${r.event_datetime}|${r.action}`;
    if (!combinedMap.has(k)) {
      combinedMap.set(k, r);
    }
  }
  const allActionsRecords = Array.from(combinedMap.values()).sort((a, b) => {
    return (b.event_datetime || '').localeCompare(a.event_datetime || '');
  });

  // 3. Assigned Orders from order_level_allocations
  let assignedOrders = [];
  try {
    assignedOrders = db.prepare(`
      SELECT order_code, account, status, allocation_date, method, priority, round_number
      FROM order_level_allocations
      WHERE (employee_id = ? OR employee_name = ? COLLATE NOCASE)
        AND allocation_date = ?
      ORDER BY order_code ASC
    `).all(masterEmp?.id || -1, rawTargetName, targetDate);
  } catch (_) {}

  // 4. Current Workload from current_work_orders
  let currentWorkloadOrders = [];
  try {
    currentWorkloadOrders = db.prepare(`
      SELECT order_code, account, status, work_date, work_state, assigned_employee_name
      FROM current_work_orders
      WHERE (assigned_employee_id = ? OR assigned_employee_name = ? COLLATE NOCASE)
        AND status IN ('New', 'Pending', 'Processing')
      ORDER BY work_date DESC
    `).all(masterEmp?.id || -1, rawTargetName);
  } catch (_) {}

  // 5. Historical Snapshots across business dates
  let historicalSnapshots = [];
  try {
    historicalSnapshots = db.prepare(`
      SELECT date, real_actions, printed_orders, printed_actions, pending_backlog,
             pending_actions, cancelled_orders, cancelled_actions, alt_phones,
             performance_score, efficiency_score, grade, segment, cancel_risk,
             own_printed_rate, own_cancel_rate, own_pending_rate
      FROM performance_snapshots
      WHERE (employee_id = ? OR employee_name = ? COLLATE NOCASE)
      ORDER BY date DESC
      LIMIT 30
    `).all(masterEmp?.id || -1, rawTargetName);
  } catch (_) {}

  // Calculate rates and score
  const totalActions = records.length;
  const printedCount = printedActions.length;
  const pendingCount = pendingActions.length;
  const cancelledCount = cancelledActions.length;
  const processingCount = processingActions.length;
  const altCount = altActions.length;

  const ownPrintedRate = totalActions > 0 ? Math.round((printedCount / totalActions) * 1000) / 10 : 0;
  const ownPendingRate = totalActions > 0 ? Math.round((pendingCount / totalActions) * 1000) / 10 : 0;
  const ownCancelRate = totalActions > 0 ? Math.round((cancelledCount / totalActions) * 1000) / 10 : 0;
  const ownAltRate = totalActions > 0 ? Math.round((altCount / totalActions) * 1000) / 10 : 0;

  // Locate snapshot metrics for this specific date if present
  const currentSnap = historicalSnapshots.find(s => s.date === targetDate);

  return {
    success: true,
    work_date: targetDate,
    employee: {
      id: masterEmp?.id || null,
      name: rawTargetName,
      approved_name: masterEmp?.name || null,
      department: masterEmp?.department || (isHistoricalCsName(rawTargetName) ? 'CS' : 'Unknown'),
      active: isActive,
      status: masterEmp?.status || (isApproved ? (isActive ? 'ACTIVE' : 'INACTIVE') : 'HISTORICAL_UNLINKED'),
      team_membership: masterEmp?.team_membership || 'None',
      notes: masterEmp?.notes || null,
      identity_type: identityType,
      is_approved: isApproved,
      is_cs: isCS,
      has_operational_privileges: hasOperationalPrivileges,
      privileges_note: hasOperationalPrivileges 
        ? 'Approved active CS employee with full operational allocation rights.' 
        : 'Historical CS identity retained for analytical and forensic parity without operational privileges.'
    },
    metrics: {
      actions: {
        total_real_actions: totalActions,
        printed_actions: printedCount,
        pending_actions: pendingCount,
        processing_actions: processingCount,
        cancelled_actions: cancelledCount,
        alt_phones_added: altCount
      },
      unique_orders: {
        unique_orders_touched: uniqueOrdersTouched.size,
        unique_printed_orders: uniquePrintedOrders.size,
        unique_pending_orders: uniquePendingOrders.size,
        unique_processing_orders: uniqueProcessingOrders.size,
        unique_cancelled_orders: uniqueCancelledOrders.size
      },
      assigned_orders: {
        total_assigned: assignedOrders.length,
        unique_accounts_count: new Set(assignedOrders.map(o => o.account)).size,
        orders: assignedOrders
      },
      current_workload: {
        total_active_workload: currentWorkloadOrders.length,
        pending_backlog: currentWorkloadOrders.filter(o => o.status === 'Pending').length,
        orders: currentWorkloadOrders
      },
      rates: {
        own_printed_rate: currentSnap?.own_printed_rate ?? ownPrintedRate,
        own_pending_rate: currentSnap?.own_pending_rate ?? ownPendingRate,
        own_cancel_rate: currentSnap?.own_cancel_rate ?? ownCancelRate,
        own_alt_rate: ownAltRate
      },
      scores: {
        performance_score: currentSnap?.performance_score || 0,
        efficiency_score: currentSnap?.efficiency_score || 0,
        grade: currentSnap?.grade || (totalActions > 0 ? 'C' : 'N/A'),
        segment: currentSnap?.segment || (totalActions > 0 ? 'Core Contributor' : 'Inactive'),
        cancel_risk: currentSnap?.cancel_risk || 'Normal'
      }
    },
    historical_activity: {
      total_recorded_dates: historicalSnapshots.length,
      snapshots: historicalSnapshots
    },
    drilldown_records: allActionsRecords
  };
}
