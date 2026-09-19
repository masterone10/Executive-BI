/**
 * EXECUTIVE-BI Authoritative Reports Service
 * Centralizes all 9 system report types, guaranteeing 100% mathematical
 * and business-rule parity with the operational dashboard, tracking,
 * allocation, and productivity engines.
 */

import { db, checkDatabaseIntegrity } from '../db/index.js';
import { getFullEmployeeProductivityProfiles } from './vendoor/productivity.js';
import { getEmployeeWorkloadAndRefillStates } from './vendoor/workload.js';
import { getDispatcherStatus, getDispatcherConfig, getEffectiveWorkDate } from './vendoor/dispatcher.js';
import { getUnallocatedOrdersPool } from './vendoor/unallocated.js';
import { classifyVendoorAction } from './vendoor/actions.js';
import { getSafeVendoorStatus } from './vendoor/auth.js';
import { computePerformanceFromRecords } from './performance.js';
import * as XLSX from 'xlsx';

/**
 * Helper to resolve date range from mode and parameters
 */
export function resolveDateRange(dateMode = 'day', targetDate, startDate, endDate) {
  let mode = dateMode;
  let target = targetDate;
  let start = startDate;
  let end = endDate;

  if (typeof dateMode === 'object' && dateMode !== null) {
    mode = dateMode.dateMode || dateMode.date_mode || 'day';
    target = dateMode.targetDate || dateMode.target_date;
    start = dateMode.startDate || dateMode.start_date;
    end = dateMode.endDate || dateMode.end_date;
  }

  const baseDate = target || getEffectiveWorkDate();
  
  if (mode === 'day') {
    return {
      dateMode: 'day',
      startDate: baseDate,
      endDate: baseDate,
      dates: [baseDate]
    };
  }

  if (mode === 'week') {
    const endDt = new Date(baseDate + 'T00:00:00Z');
    const dates = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(endDt.getTime() - i * 86400000);
      dates.push(d.toISOString().slice(0, 10));
    }
    return {
      dateMode: 'week',
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      dates
    };
  }

  if (mode === 'month') {
    const endDt = new Date(baseDate + 'T00:00:00Z');
    const dates = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(endDt.getTime() - i * 86400000);
      dates.push(d.toISOString().slice(0, 10));
    }
    return {
      dateMode: 'month',
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      dates
    };
  }

  if (mode === 'custom') {
    const s = start || baseDate;
    const e = end || baseDate;
    const sTime = new Date(s + 'T00:00:00Z').getTime();
    const eTime = new Date(e + 'T00:00:00Z').getTime();
    const dates = [];
    const step = 86400000;
    for (let t = sTime; t <= eTime; t += step) {
      dates.push(new Date(t).toISOString().slice(0, 10));
    }
    if (dates.length === 0) dates.push(baseDate);
    return {
      dateMode: 'custom',
      startDate: s,
      endDate: e,
      dates
    };
  }

  return {
    dateMode: 'day',
    startDate: baseDate,
    endDate: baseDate,
    dates: [baseDate]
  };
}

export function getCanonicalRealActionsCount(workDate) {
  const snap = db.prepare('SELECT metrics_json FROM daily_metrics_snapshots WHERE work_date = ?').get(workDate);
  if (snap && snap.metrics_json) {
    try {
      const parsed = JSON.parse(snap.metrics_json);
      const total = parsed.summary?.totalRealActions ?? parsed.log_totals?.actions;
      if (typeof total === 'number') return total;
    } catch (_) {}
  }
  const rows = db.prepare('SELECT * FROM raw_log_records WHERE work_date = ?').all(workDate);
  if (rows.length === 0) return 0;
  const perf = computePerformanceFromRecords(rows);
  return perf.summary?.totalRealActions || 0;
}

export function getDayWorkloadSummary(workDate) {
  // Query authoritative total orders and distinct accounts for the work date
  let totalOrders = 0;
  let totalAccounts = 0;

  try {
    const vRow = db.prepare(`
      SELECT COUNT(DISTINCT order_code) as total_orders, COUNT(DISTINCT account) as total_accounts
      FROM vendoor_orders
      WHERE source_date = ?
    `).get(workDate);

    if (vRow && vRow.total_orders > 0) {
      totalOrders = vRow.total_orders;
      totalAccounts = vRow.total_accounts;
    } else {
      const cwRow = db.prepare(`
        SELECT COUNT(DISTINCT order_code) as total_orders, COUNT(DISTINCT account) as total_accounts
        FROM current_work_orders
        WHERE work_date = ?
      `).get(workDate);
      if (cwRow && cwRow.total_orders > 0) {
        totalOrders = cwRow.total_orders;
        totalAccounts = cwRow.total_accounts;
      }
    }
  } catch (_) {}

  const states = getEmployeeWorkloadAndRefillStates(workDate);
  const accRow = db.prepare('SELECT COUNT(DISTINCT account) as c FROM order_level_allocations WHERE allocation_date = ?').get(workDate);
  const accountsCount = accRow?.c || 0;

  let assignedOrders = 0;
  let completedOrders = 0;
  let remainingOrders = 0;
  let workingEmployees = 0;

  for (const s of states) {
    if (s.is_working) workingEmployees++;
    assignedOrders += s.assigned_orders_count || 0;
    completedOrders += s.completed_orders_count || 0;
    remainingOrders += s.remaining_work || 0;
  }

  // If totalOrders was not found in inventory tables, fallback to states + unallocated
  if (totalOrders === 0) {
    const unallocatedPool = getUnallocatedOrdersPool(workDate);
    totalOrders = assignedOrders + unallocatedPool.total_unallocated_orders;
    totalAccounts = accountsCount + unallocatedPool.unique_accounts_count;
  }

  // Canonical Arithmetic: Total Orders = Allocated Orders + Unallocated Orders
  const unallocatedOrders = Math.max(0, totalOrders - assignedOrders);
  const unallocatedAccounts = Math.max(0, totalAccounts - accountsCount);

  return {
    total_orders: totalOrders,
    assigned_orders: assignedOrders,
    allocated_orders: assignedOrders,
    completed_orders: completedOrders,
    remaining_orders: remainingOrders,
    working_employees_count: workingEmployees,
    accounts_count: accountsCount,
    total_accounts: totalAccounts,
    unallocated_orders: unallocatedOrders,
    unallocated_accounts: unallocatedAccounts
  };
}

/**
 * 1. Executive Summary Report
 */
export function generateExecutiveSummaryReport(opts = {}) {
  const dateMode = opts.dateMode || opts.date_mode || 'day';
  const targetDate = opts.targetDate || opts.target_date;
  const startDate = opts.startDate || opts.start_date;
  const endDate = opts.endDate || opts.end_date;
  const filters = opts.filters || opts;
  const range = resolveDateRange(dateMode, targetDate, startDate, endDate);
  const dailyBreakdown = [];

  let aggregateOrders = 0;
  let aggregateAssigned = 0;
  let aggregateCompleted = 0;
  let aggregateRemaining = 0;
  let aggregateUnallocated = 0;
  let aggregateActions = 0;

  for (const d of range.dates) {
    const workload = getDayWorkloadSummary(d);
    
    // Authoritative canonical deduplicated Real Actions
    const actionsCount = getCanonicalRealActionsCount(d);

    const dayStat = {
      date: d,
      total_orders: workload.total_orders,
      allocated_orders: workload.assigned_orders,
      assigned_orders: workload.assigned_orders,
      unallocated_orders: workload.unallocated_orders,
      completed_orders: workload.completed_orders,
      remaining_orders: workload.remaining_orders,
      active_employees: workload.working_employees_count,
      working_team_count: workload.working_employees_count,
      total_accounts: workload.total_accounts,
      allocation_coverage_pct: workload.total_orders > 0
        ? Math.round((workload.assigned_orders / workload.total_orders) * 100)
        : 0,
      completion_pct: workload.assigned_orders > 0
        ? Math.round((workload.completed_orders / workload.assigned_orders) * 100)
        : 0,
      real_actions: actionsCount
    };

    dailyBreakdown.push(dayStat);

    aggregateOrders += dayStat.total_orders;
    aggregateAssigned += dayStat.assigned_orders;
    aggregateCompleted += dayStat.completed_orders;
    aggregateRemaining += dayStat.remaining_orders;
    aggregateUnallocated += dayStat.unallocated_orders;
    aggregateActions += dayStat.real_actions;
  }

  // System & Vendoor Health for the summary
  const vStatus = getSafeVendoorStatus();
  const dStatus = getDispatcherStatus();
  const dbHealth = checkDatabaseIntegrity(db);
  const alerts = getSystemAlerts(range.endDate);

  const summary = {
    report_type: 'executive_summary',
    date_mode: range.dateMode,
    start_date: range.startDate,
    end_date: range.endDate,
    filters,
    total_orders: aggregateOrders,
    allocated_orders: aggregateAssigned,
    assigned_orders: aggregateAssigned,
    unallocated_orders: aggregateUnallocated,
    completed_orders: aggregateCompleted,
    remaining_orders: aggregateRemaining,
    real_actions: aggregateActions,
    allocation_coverage_pct: aggregateOrders > 0 ? Math.round((aggregateAssigned / aggregateOrders) * 100) : 0,
    completion_pct: aggregateAssigned > 0 ? Math.round((aggregateCompleted / aggregateAssigned) * 100) : 0,
    daily_breakdown: dailyBreakdown,
    system_health: {
      db_healthy: dbHealth.healthy,
      vendoor_connected: vStatus.enabled && vStatus.has_credentials,
      dispatcher_status: dStatus.operational_status,
      active_alerts_count: alerts.length
    },
    alerts
  };

  return summary;
}

/**
 * 2. Employee Report
 */
export function generateEmployeeReport(opts = {}) {
  const dateMode = opts.dateMode || opts.date_mode || 'day';
  const targetDate = opts.targetDate || opts.target_date;
  const startDate = opts.startDate || opts.start_date;
  const endDate = opts.endDate || opts.end_date;
  const filters = opts.filters || opts;
  const range = resolveDateRange(dateMode, targetDate, startDate, endDate);
  const profiles = getFullEmployeeProductivityProfiles();
  const profileMap = new Map(profiles.map(p => [p.employee_id, p]));
  const states = getEmployeeWorkloadAndRefillStates(range.endDate);
  const stateMap = new Map(states.map(s => [s.employee_id, s]));

  // Employees master
  let employeesQuery = 'SELECT * FROM employees WHERE active = 1';
  const params = [];
  if (filters.team && filters.team !== 'ALL') {
    employeesQuery += ' AND team_membership = ?';
    params.push(filters.team);
  }
  if (filters.employee_id) {
    employeesQuery += ' AND id = ?';
    params.push(parseInt(filters.employee_id, 10));
  }
  employeesQuery += ' ORDER BY name ASC';
  const employees = db.prepare(employeesQuery).all(...params);

  const employeeRows = [];

  for (const emp of employees) {
    // Working days in range
    const placeholders = range.dates.map(() => '?').join(',');
    const workingDays = db.prepare(`
      SELECT COUNT(DISTINCT work_date) as cnt 
      FROM daily_working_team 
      WHERE employee_id = ? AND is_working = 1 AND work_date IN (${placeholders})
    `).get(emp.id, ...range.dates)?.cnt || 0;

    // Filter by working team if requested
    if (filters.working_only && workingDays === 0) {
      continue;
    }

    // Assigned and Completed orders in range
    const allocs = db.prepare(`
      SELECT COUNT(DISTINCT order_code) as total_assigned,
             COUNT(DISTINCT account) as accounts_count
      FROM order_level_allocations
      WHERE employee_id = ? AND allocation_date IN (${placeholders})
    `).get(emp.id, ...range.dates);

    const totalAssigned = allocs?.total_assigned || 0;
    const accountsCount = allocs?.accounts_count || 0;

    // Real actions and valid unique orders worked in range from raw logs
    const logs = db.prepare(`
      SELECT COUNT(*) as real_actions,
             COUNT(DISTINCT order_code) as unique_worked
      FROM raw_log_records
      WHERE employee_name = ? AND work_date IN (${placeholders})
    `).get(emp.name, ...range.dates);

    const realActions = logs?.real_actions || 0;
    const uniqueOrdersWorked = logs?.unique_worked || 0;

    // Completed orders in range from vendoor_logs
    const compRow = db.prepare(`
      SELECT COUNT(DISTINCT order_code) as comp_count
      FROM vendoor_logs
      WHERE matched_employee_id = ? AND work_date IN (${placeholders}) AND is_productive = 1
    `).get(emp.id, ...range.dates);
    const completedOrders = compRow?.comp_count || 0;
    const remainingOrders = Math.max(0, totalAssigned - completedOrders);

    // Auto Dispatch refills in range
    const refillsRow = db.prepare(`
      SELECT COUNT(DISTINCT cycle_id) as cycle_count,
             COUNT(*) as assign_count
      FROM auto_dispatch_assignments
      WHERE employee_id = ? AND work_date IN (${placeholders}) AND is_dry_run = 0
    `).get(emp.id, ...range.dates);
    const dispatcherRefills = refillsRow?.cycle_count || 0;

    // Forensic profile metrics
    const prof = profileMap.get(emp.id);
    const typical10m = prof ? prof.typical_orders_per_10m : 0;
    const recentRate = prof ? prof.recent_rate : 0;
    const longTermRate = prof ? prof.long_term_rate : 0;
    const effectiveRate = prof ? prof.effective_rate : 0;
    const consistency = prof ? prof.consistency : '—';
    const confidence = prof ? prof.confidence : 'NO_LOG_HISTORY';
    const sampleSize = prof ? prof.sample_size : 0;

    // Live capacity for latest target date
    const cap = stateMap.get(emp.id) || {};
    const currentLoad = cap.current_load !== undefined ? cap.current_load : remainingOrders;
    const remainingCapacity = cap.remaining_capacity !== undefined ? cap.remaining_capacity : 0;
    const refillThreshold = cap.refill_threshold !== undefined ? cap.refill_threshold : 20;
    const refillEligible = !!cap.refill_eligible;

    // Operational Status Determination
    let operationalStatus = 'HEALTHY';
    if (workingDays === 0) {
      operationalStatus = 'NOT WORKING';
    } else if (cap.refill_state === 'BLOCKED_BY_ERRORS') {
      operationalStatus = 'NEEDS REVIEW';
    } else if (remainingCapacity <= 0) {
      operationalStatus = 'NO CAPACITY';
    } else if (refillEligible) {
      operationalStatus = 'REFILL ELIGIBLE';
    } else if (currentLoad <= (refillThreshold + 5)) {
      operationalStatus = 'NEAR REFILL';
    } else if (currentLoad === 0) {
      operationalStatus = 'NEEDS WORK';
    }

    if (filters.operational_status && filters.operational_status !== 'ALL' && operationalStatus !== filters.operational_status) {
      continue;
    }

    employeeRows.push({
      employee_id: emp.id,
      employee_name: emp.name,
      department: emp.department || 'CS',
      team_membership: emp.team_membership || 'Both',
      working_days: workingDays,
      valid_unique_orders_worked: uniqueOrdersWorked,
      typical_orders_10m: typical10m,
      recent_rate: recentRate,
      long_term_rate: longTermRate,
      effective_rate: effectiveRate,
      consistency_mad: consistency,
      confidence_level: confidence,
      sample_size_windows: sampleSize,
      current_load: currentLoad,
      remaining_capacity: remainingCapacity,
      refill_threshold: refillThreshold,
      refill_eligible: refillEligible,
      assigned_orders: totalAssigned,
      completed_orders: completedOrders,
      remaining_orders: remainingOrders,
      real_actions: realActions,
      accounts_count: accountsCount,
      dispatcher_refills: dispatcherRefills,
      operational_status: operationalStatus
    });
  }

  return {
    report_type: 'employee',
    date_mode: range.dateMode,
    start_date: range.startDate,
    end_date: range.endDate,
    filters,
    total_employees: employeeRows.length,
    rows: employeeRows
  };
}

/**
 * 3. Account Report
 */
export function generateAccountReport(opts = {}) {
  const dateMode = opts.dateMode || opts.date_mode || 'day';
  const targetDate = opts.targetDate || opts.target_date;
  const startDate = opts.startDate || opts.start_date;
  const endDate = opts.endDate || opts.end_date;
  const filters = opts.filters || opts;
  const range = resolveDateRange(dateMode, targetDate, startDate, endDate);
  const placeholders = range.dates.map(() => '?').join(',');

  // Query distinct accounts allocated in the period
  const accountsQuery = `
    SELECT DISTINCT account
    FROM order_level_allocations
    WHERE allocation_date IN (${placeholders})
    ORDER BY account ASC
  `;
  const accounts = db.prepare(accountsQuery).all(...range.dates).map(r => r.account);

  const accountRows = [];

  for (const acc of accounts) {
    if (filters.account && !acc.toLowerCase().includes(filters.account.toLowerCase())) {
      continue;
    }

    // Orders stats in period
    const ordersStats = db.prepare(`
      SELECT 
        COUNT(*) as total_orders,
        SUM(CASE WHEN status LIKE '%new%' OR status LIKE '%جديد%' THEN 1 ELSE 0 END) as new_count,
        SUM(CASE WHEN status LIKE '%pending%' OR status LIKE '%معلق%' THEN 1 ELSE 0 END) as pending_count,
        COUNT(DISTINCT employee_id) as assigned_employees_count
      FROM order_level_allocations
      WHERE account = ? AND allocation_date IN (${placeholders})
    `).get(acc, ...range.dates);

    // Current designated owner for the latest date
    const ownerRow = db.prepare(`
      SELECT owner_employee_name, is_override, allocation_method
      FROM account_owners
      WHERE account = ? AND work_date = ?
    `).get(acc, range.endDate);

    const ownerName = ownerRow?.owner_employee_name || 'UNASSIGNED';

    // List of assigned employees
    const empRows = db.prepare(`
      SELECT employee_name, COUNT(*) as cnt
      FROM order_level_allocations
      WHERE account = ? AND allocation_date IN (${placeholders})
      GROUP BY employee_name
    `).all(acc, ...range.dates);

    // Completed orders in period from logs
    const comp = db.prepare(`
      SELECT COUNT(DISTINCT l.order_code) as comp_count
      FROM order_level_allocations a
      JOIN vendoor_logs l ON a.order_code = l.order_code
      WHERE a.account = ? AND a.allocation_date IN (${placeholders}) AND l.is_productive = 1
    `).get(acc, ...range.dates);
    const completedCount = comp?.comp_count || 0;

    const remainingCount = Math.max(0, (ordersStats?.total_orders || 0) - completedCount);
    const isSplit = (ordersStats?.assigned_employees_count || 0) > 1;

    // Eligibility & rules
    const rule = db.prepare('SELECT active, notes, blocked_json FROM account_rules WHERE account_name = ?').get(acc);

    accountRows.push({
      account_name: acc,
      merchant_code: acc.replace(/[^0-9]/g, '') || 'M-ACC',
      total_orders: ordersStats?.total_orders || 0,
      owner_name: ownerName,
      assigned_employees: empRows.map(e => `${e.employee_name} (${e.cnt})`).join(', '),
      assigned_employees_count: ordersStats?.assigned_employees_count || 0,
      new_count: ordersStats?.new_count || 0,
      pending_count: ordersStats?.pending_count || 0,
      completed_count: completedCount,
      remaining_count: remainingCount,
      unified_or_split: isSplit ? 'SPLIT' : 'UNIFIED',
      split_reason: isSplit ? 'Capacity Distribution Across Working Team' : 'Unified Single Owner',
      rule_type: rule ? (rule.active ? 'Custom Rules' : 'Inactive Rules') : 'Standard',
      rule_notes: rule?.notes || 'None'
    });
  }

  return {
    report_type: 'account',
    date_mode: range.dateMode,
    start_date: range.startDate,
    end_date: range.endDate,
    filters,
    total_accounts: accountRows.length,
    rows: accountRows
  };
}

/**
 * 4. Allocation Report (Read-only from saved final state)
 */
export function generateAllocationReport(opts = {}) {
  const dateMode = opts.dateMode || opts.date_mode || 'day';
  const targetDate = opts.targetDate || opts.target_date;
  const startDate = opts.startDate || opts.start_date;
  const endDate = opts.endDate || opts.end_date;
  const filters = opts.filters || opts;
  const range = resolveDateRange(dateMode, targetDate, startDate, endDate);
  const placeholders = range.dates.map(() => '?').join(',');

  let query = `
    SELECT 
      allocation_date,
      allocation_version,
      order_code,
      account,
      status,
      employee_id,
      employee_name,
      method,
      rule_note,
      is_override,
      created_at
    FROM order_level_allocations
    WHERE allocation_date IN (${placeholders})
  `;
  const params = [...range.dates];

  if (filters.employee_name && filters.employee_name !== 'ALL') {
    query += ' AND employee_name = ?';
    params.push(filters.employee_name);
  }
  if (filters.account && filters.account !== 'ALL') {
    query += ' AND account = ?';
    params.push(filters.account);
  }
  if (filters.status && filters.status !== 'ALL') {
    query += ' AND status = ?';
    params.push(filters.status);
  }

  query += ' ORDER BY allocation_date DESC, account ASC, order_code ASC';

  const rows = db.prepare(query).all(...params);

  // Group by account to detect unified vs split
  const accEmps = new Map();
  rows.forEach(r => {
    if (!accEmps.has(r.account)) accEmps.set(r.account, new Set());
    accEmps.get(r.account).add(r.employee_name);
  });

  const formattedRows = rows.map(r => ({
    allocation_date: r.allocation_date,
    allocation_version: r.allocation_version,
    order_code: r.order_code,
    account: r.account,
    status: r.status,
    employee_name: r.employee_name,
    source: r.is_override ? 'MANUAL_OVERRIDE' : (r.method?.includes('AUTO') ? 'AUTO_DISPATCH' : 'MANUAL_BATCH'),
    unified_or_split: (accEmps.get(r.account)?.size || 0) > 1 ? 'SPLIT' : 'UNIFIED',
    reason: r.rule_note || r.method || 'Standard Allocation',
    created_at: r.created_at
  }));

  return {
    report_type: 'allocation',
    date_mode: range.dateMode,
    start_date: range.startDate,
    end_date: range.endDate,
    filters,
    total_allocations: formattedRows.length,
    rows: formattedRows
  };
}

/**
 * 5. Activity / Logs Report
 */
export function generateActivityLogsReport(opts = {}) {
  const dateMode = opts.dateMode || opts.date_mode || 'day';
  const targetDate = opts.targetDate || opts.target_date;
  const startDate = opts.startDate || opts.start_date;
  const endDate = opts.endDate || opts.end_date;
  const limit = opts.limit ? parseInt(opts.limit, 10) : 500;
  const filters = opts.filters || opts;
  const range = resolveDateRange(dateMode, targetDate, startDate, endDate);
  const placeholders = range.dates.map(() => '?').join(',');

  let query = `
    SELECT 
      work_date,
      employee_name,
      order_code,
      action,
      status,
      event_datetime,
      is_deduped
    FROM raw_log_records
    WHERE work_date IN (${placeholders})
  `;
  const params = [...range.dates];

  if (filters.employee_name && filters.employee_name !== 'ALL') {
    query += ' AND employee_name = ?';
    params.push(filters.employee_name);
  }
  if (filters.order_code) {
    query += ' AND order_code LIKE ?';
    params.push(`%${filters.order_code}%`);
  }

  query += ` ORDER BY event_datetime DESC LIMIT ${parseInt(limit, 10) || 500}`;

  const rows = db.prepare(query).all(...params);

  const formatted = rows.map(r => {
    const classification = classifyVendoorAction(r.action || r.status || '');
    return {
      work_date: r.work_date,
      employee_name: r.employee_name,
      order_code: r.order_code,
      action_type: r.action || r.status || 'Action',
      is_productive: classification.is_productive,
      is_canceled: classification.is_canceled,
      is_completion: classification.is_completion,
      dedup_status: r.is_deduped ? 'DEDUPED' : 'VALID_ACTION',
      timestamp: r.event_datetime || '—'
    };
  });

  return {
    report_type: 'activity',
    date_mode: range.dateMode,
    start_date: range.startDate,
    end_date: range.endDate,
    filters,
    total_logs_returned: formatted.length,
    rows: formatted
  };
}

/**
 * 6. Productivity Report
 */
export function generateProductivityReport(opts = {}) {
  const targetDate = opts.targetDate || opts.target_date;
  const filters = opts.filters || opts;
  const workDate = targetDate || getEffectiveWorkDate();
  const profiles = getFullEmployeeProductivityProfiles();
  const states = getEmployeeWorkloadAndRefillStates(workDate);
  const stateMap = new Map(states.map(s => [s.employee_id, s]));

  const rows = profiles.map(p => {
    const cap = stateMap.get(p.employee_id) || {};
    return {
      employee_id: p.employee_id,
      employee_name: p.employee_name,
      unique_orders_worked: p.unique_orders_worked,
      typical_orders_10m: p.typical_orders_per_10m,
      recent_rate: p.recent_rate,
      long_term_rate: p.long_term_rate,
      effective_rate: p.effective_rate,
      consistency_mad: p.consistency,
      confidence_level: p.confidence,
      sample_size_windows: p.sample_size,
      historical_coverage_days: p.historical_coverage,
      current_load: cap.current_load !== undefined ? cap.current_load : 0,
      remaining_capacity: cap.remaining_capacity !== undefined ? cap.remaining_capacity : 0,
      refill_eligible: !!cap.refill_eligible,
      quality_warnings: p.confidence === 'NO_LOG_HISTORY' ? 'No historical activity logs found in database' : 'None'
    };
  });

  return {
    report_type: 'productivity',
    work_date: workDate,
    filters,
    total_profiles: rows.length,
    rows
  };
}

/**
 * 7. Dispatcher / Refill Report
 */
export function generateDispatcherReport(opts = {}) {
  const dateMode = opts.dateMode || opts.date_mode || 'day';
  const targetDate = opts.targetDate || opts.target_date;
  const startDate = opts.startDate || opts.start_date;
  const endDate = opts.endDate || opts.end_date;
  const filters = opts.filters || opts;
  const range = resolveDateRange(dateMode, targetDate, startDate, endDate);
  const placeholders = range.dates.map(() => '?').join(',');

  const cycles = db.prepare(`
    SELECT * FROM auto_dispatch_cycles
    WHERE work_date IN (${placeholders})
    ORDER BY id DESC
  `).all(...range.dates);

  const cycleIds = cycles.map(c => c.cycle_id);
  let assignments = [];
  if (cycleIds.length > 0) {
    const idPlaceholders = cycleIds.map(() => '?').join(',');
    assignments = db.prepare(`
      SELECT * FROM auto_dispatch_assignments
      WHERE cycle_id IN (${idPlaceholders})
      ORDER BY id DESC
    `).all(...cycleIds);
  }

  return {
    report_type: 'dispatcher',
    date_mode: range.dateMode,
    start_date: range.startDate,
    end_date: range.endDate,
    filters,
    total_cycles: cycles.length,
    total_dry_run_cycles: cycles.filter(c => c.dry_run === 1 || c.dry_run === true).length,
    total_real_cycles: cycles.filter(c => c.dry_run === 0 || c.dry_run === false).length,
    total_assignments: assignments.length,
    cycles,
    assignments
  };
}

/**
 * 8. Data Quality Report
 */
export function generateDataQualityReport(opts = {}) {
  const targetDate = opts.targetDate || opts.target_date;
  const filters = opts.filters || opts;
  const workDate = targetDate || getEffectiveWorkDate();
  const cfg = getDispatcherConfig();

  // Unmatched Vendoor identities
  const unmatched = db.prepare(`
    SELECT * FROM vendoor_identity_mappings WHERE status = 'NEEDS_REVIEW'
  `).all();

  // Canceled actions volume
  const canceledRow = db.prepare(`
    SELECT COUNT(*) as count FROM vendoor_logs WHERE action_classification = 'CANCELED'
  `).get();

  // Unknown actions volume
  const unknownRow = db.prepare(`
    SELECT COUNT(*) as count FROM vendoor_logs WHERE action_classification = 'UNKNOWN'
  `).get();

  // Stale checks
  const latestOrdersSync = db.prepare("SELECT created_at, status FROM vendoor_sync_runs WHERE resource='orders' AND status='SUCCESS' ORDER BY id DESC LIMIT 1").get();
  const latestLogsSync = db.prepare("SELECT created_at, status FROM vendoor_sync_runs WHERE resource='logs' AND status='SUCCESS' ORDER BY id DESC LIMIT 1").get();
  
  const nowMs = Date.now();
  const ordersStale = !latestOrdersSync || (nowMs - new Date(latestOrdersSync.created_at + 'Z').getTime()) > cfg.staleOrdersLimitMs;
  const logsStale = !latestLogsSync || (nowMs - new Date(latestLogsSync.created_at + 'Z').getTime()) > cfg.staleLogsLimitMs;

  // Working team coverage
  const wtCount = db.prepare('SELECT COUNT(*) as c FROM daily_working_team WHERE work_date = ? AND is_working = 1').get(workDate)?.c || 0;

  return {
    report_type: 'data_quality',
    work_date: workDate,
    filters,
    unmatched_identities_count: unmatched.length,
    unmatched_identities: unmatched,
    canceled_actions_volume: canceledRow?.count || 0,
    unknown_actions_volume: unknownRow?.count || 0,
    orders_data_stale: ordersStale,
    logs_data_stale: logsStale,
    last_orders_sync: latestOrdersSync?.created_at || 'Never',
    last_logs_sync: latestLogsSync?.created_at || 'Never',
    active_working_team_count: wtCount,
    working_team_configured: wtCount > 0,
    stale_orders_limit_ms: cfg.staleOrdersLimitMs,
    stale_logs_limit_ms: cfg.staleLogsLimitMs
  };
}

/**
 * 9. System / Operational Health Report
 */
export function generateSystemHealthReport(opts = {}) {
  const targetDate = opts.targetDate || opts.target_date;
  const workDate = targetDate || getEffectiveWorkDate();
  const dbHealth = checkDatabaseIntegrity(db);
  const vStatus = getSafeVendoorStatus();
  const dStatus = getDispatcherStatus();
  const workload = getDayWorkloadSummary(workDate);
  const alerts = getSystemAlerts(workDate);

  // Core tables readability
  const coreTables = [
    'employees', 'daily_working_team', 'raw_log_records', 'vendoor_orders',
    'vendoor_logs', 'order_level_allocations', 'account_owners', 'system_configs'
  ];
  const tableStats = {};
  for (const t of coreTables) {
    try {
      const c = db.prepare(`SELECT COUNT(*) as cnt FROM ${t}`).get()?.cnt || 0;
      tableStats[t] = { readable: true, count: c };
    } catch (e) {
      tableStats[t] = { readable: false, error: e.message };
    }
  }

  return {
    report_type: 'system_health',
    work_date: workDate,
    database: {
      healthy: dbHealth.healthy,
      journal_mode: dbHealth.journal_mode,
      integrity_check: dbHealth.integrity_check,
      quick_check: dbHealth.quick_check,
      core_tables: tableStats
    },
    vendoor: {
      enabled: vStatus.enabled,
      mock_mode: vStatus.mock_mode,
      has_credentials: vStatus.has_credentials,
      auth_method: vStatus.auth_method
    },
    dispatcher: {
      operational_status: dStatus.operational_status,
      is_running: dStatus.is_running,
      is_locked: dStatus.is_locked,
      cycle_count: dStatus.cycle_count,
      last_cycle_at: dStatus.last_cycle_at
    },
    data_metrics: {
      assigned_orders: workload.assigned_orders,
      unallocated_orders: workload.unallocated_orders,
      completed_orders: workload.completed_orders,
      remaining_orders: workload.remaining_orders,
      working_employees_count: workload.working_employees_count
    },
    alerts
  };
}

/**
 * Operational Alerts Generator
 */
export function getSystemAlerts(workDate = getEffectiveWorkDate()) {
  const alerts = [];
  const cfg = getDispatcherConfig();
  const vStatus = getSafeVendoorStatus();

  // 1. Vendoor Connection Alert
  if (!vStatus.has_credentials) {
    alerts.push({
      type: 'VENDOOR_NO_CREDENTIALS',
      severity: 'WARNING',
      title: 'Vendoor Credentials Missing',
      scope: 'Integrations',
      message: 'Vendoor employee credentials are not configured.',
      operator_action: 'Configure Vendoor Email and Password in Management.'
    });
  }

  // 2. Data Freshness Alerts
  const latestOrdersSync = db.prepare("SELECT created_at, status FROM vendoor_sync_runs WHERE resource='orders' AND status='SUCCESS' ORDER BY id DESC LIMIT 1").get();
  const latestLogsSync = db.prepare("SELECT created_at, status FROM vendoor_sync_runs WHERE resource='logs' AND status='SUCCESS' ORDER BY id DESC LIMIT 1").get();
  const nowMs = Date.now();

  if (!latestOrdersSync || (nowMs - new Date(latestOrdersSync.created_at + 'Z').getTime()) > cfg.staleOrdersLimitMs) {
    alerts.push({
      type: 'ORDERS_STALE',
      severity: 'CRITICAL',
      title: 'Orders Data Stale',
      scope: 'Data Sync',
      message: 'Orders data has not been synced within the required freshness window.',
      operator_action: 'Run a fresh Orders sync from the Vendoor tab or upload new orders.'
    });
  }

  if (!latestLogsSync || (nowMs - new Date(latestLogsSync.created_at + 'Z').getTime()) > cfg.staleLogsLimitMs) {
    alerts.push({
      type: 'LOGS_STALE',
      severity: 'CRITICAL',
      title: 'Logs Data Stale',
      scope: 'Data Sync',
      message: 'Activity logs have not been synced within the required freshness window.',
      operator_action: 'Run a fresh Logs sync from the Vendoor tab to refresh productivity.'
    });
  }

  // 3. Working Team Alert
  const wtCount = db.prepare('SELECT COUNT(*) as c FROM daily_working_team WHERE work_date = ? AND is_working = 1').get(workDate)?.c || 0;
  if (wtCount === 0) {
    alerts.push({
      type: 'NO_WORKING_TEAM',
      severity: 'CRITICAL',
      title: 'No Active Working Team Configured',
      scope: 'Operations',
      message: `Zero employees are marked as working for business date ${workDate}.`,
      operator_action: 'Go to Operations -> Today\'s Working Team and activate the scheduled team.'
    });
  }

  // 4. Identity Review Alert
  const unmatchedCount = db.prepare("SELECT COUNT(*) as c FROM vendoor_identity_mappings WHERE status = 'NEEDS_REVIEW'").get()?.c || 0;
  if (unmatchedCount > 0) {
    alerts.push({
      type: 'UNMATCHED_IDENTITIES',
      severity: 'WARNING',
      title: 'Unmatched Vendoor Identities',
      scope: 'Identity Management',
      message: `${unmatchedCount} Vendoor identities require manual review and employee mapping.`,
      operator_action: 'Review the Identity Review Queue in Management -> Vendoor.'
    });
  }

  // 5. Database Integrity Alert
  const dbHealth = checkDatabaseIntegrity(db);
  if (!dbHealth.healthy) {
    alerts.push({
      type: 'DATABASE_CORRUPTION',
      severity: 'CRITICAL',
      title: 'Database Integrity Warning',
      scope: 'Storage',
      message: 'SQLite integrity check reported potential issues.',
      operator_action: 'Halt automated jobs immediately and run diagnostic recovery.'
    });
  }

  return alerts;
}

/**
 * Report History Persistence
 */
export function recordReportHistory({ report_type, date_mode, start_date, end_date, filters = {}, summary_metadata = {}, generated_by = 'Supervisor' }) {
  const insertStmt = db.prepare(`
    INSERT INTO report_history (report_type, date_mode, start_date, end_date, filters_json, summary_metadata_json, generated_by, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'COMPLETED')
  `);
  const res = insertStmt.run(
    report_type,
    date_mode,
    start_date,
    end_date,
    JSON.stringify(filters),
    JSON.stringify(summary_metadata),
    generated_by
  );
  return { id: res.lastInsertRowid };
}

export function saveReportRecord(params) {
  return recordReportHistory({
    report_type: params.report_type || params.reportType,
    date_mode: params.date_mode || params.dateMode,
    start_date: params.start_date || params.startDate,
    end_date: params.end_date || params.endDate,
    filters: params.filters || {},
    summary_metadata: params.summary_metadata || params.reportData || { rowCount: params.rowCount },
    generated_by: params.generated_by || params.generatedBy || 'Supervisor'
  });
}

export function getReportHistory(limit = 20) {
  const rows = db.prepare(`
    SELECT * FROM report_history
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
  return rows.map(r => ({
    ...r,
    filters: r.filters_json ? JSON.parse(r.filters_json) : {},
    summary_metadata: r.summary_metadata_json ? JSON.parse(r.summary_metadata_json) : {}
  }));
}

export function getReportById(id) {
  const row = db.prepare('SELECT * FROM report_history WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    filters: row.filters_json ? JSON.parse(row.filters_json) : {},
    summary_metadata: row.summary_metadata_json ? JSON.parse(row.summary_metadata_json) : {}
  };
}

/**
 * Convert report data to CSV string
 */
export function exportReportToCSV(reportData) {
  let rows = [];
  if (reportData.rows && Array.isArray(reportData.rows)) {
    rows = reportData.rows;
  } else if (reportData.daily_breakdown && Array.isArray(reportData.daily_breakdown)) {
    rows = reportData.daily_breakdown;
  } else if (reportData.cycles && Array.isArray(reportData.cycles)) {
    rows = reportData.cycles;
  }

  if (rows.length === 0) {
    return 'No data available for export';
  }

  const headers = Object.keys(rows[0]);
  const csvLines = [headers.join(',')];

  for (const r of rows) {
    const values = headers.map(h => {
      let val = r[h];
      if (val === null || val === undefined) val = '';
      if (typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))) {
        val = `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    });
    csvLines.push(values.join(','));
  }

  return csvLines.join('\n');
}

/**
 * Convert report data to Excel buffer
 */
export function exportReportToExcel(reportData, sheetName = 'Report') {
  let rows = [];
  if (reportData.rows && Array.isArray(reportData.rows)) {
    rows = reportData.rows;
  } else if (reportData.daily_breakdown && Array.isArray(reportData.daily_breakdown)) {
    rows = reportData.daily_breakdown;
  } else if (reportData.cycles && Array.isArray(reportData.cycles)) {
    rows = reportData.cycles;
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : [{ Status: 'No data' }]);
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
