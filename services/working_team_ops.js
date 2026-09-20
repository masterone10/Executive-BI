/**
 * Production Working Team Operations & Observed Team Detection
 *
 * Grounded in real Vendoor operational evidence:
 * - Real logs from vendoor_logs / raw_log_records
 * - Authoritative Employee Master
 * - Manual Working Team authority when configured (precedence #1)
 * - Auto-restore VENDOOR_OBSERVED team when no manual team configured (precedence #2)
 * - SETUP_REQUIRED when no manual team and no log evidence (precedence #3)
 * - Absence of a recent log != proof of absence (idle workers remain in today's team)
 * - Departed / inactive employees strictly excluded
 * - Business Date isolation: date-scoped persistence
 * - Unmatched Vendoor identities routed to Identity Review Queue
 */

import { db } from '../db/index.js';
import { getCompletedOrdersForDate } from './vendoor/completion.js';
import { getFullEmployeeProductivityProfiles } from './vendoor/productivity.js';
import { getEmployeeWorkloadAndRefillStates } from './vendoor/workload.js';
import { resolveEmployeeIdentity } from './vendoor/identity.js';

/**
 * Format timestamp into human readable relative time
 */
export function formatRelativeTime(tsStr) {
  if (!tsStr) return 'No activity yet';
  try {
    const d = new Date(String(tsStr).replace(' ', 'T'));
    if (isNaN(d.getTime())) return tsStr;
    const now = new Date();
    const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000);
    if (diffSec < 60) return 'just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
  } catch {
    return tsStr;
  }
}

/**
 * Synchronize and Restore Today's Working Team from REAL Vendoor Logs
 *
 * Precedence:
 * 1. MANUAL Working Team: If manual records exist for workDate, preserve exact manual team.
 * 2. VENDOOR_OBSERVED Working Team: If no manual team, resolve active employees from real logs.
 * 3. SETUP_REQUIRED: If no manual team and no valid observed employees.
 *
 * Invariants:
 * - Employee Master is authoritative: only matched, active, non-departed employees are eligible.
 * - Unknown identities NEVER auto-create employee records; they are logged for review.
 * - Departed employees are strictly excluded from observed team.
 * - Absence of a recent log is NOT proof of absence: observed today != active right now.
 * - Business Date isolation: all operations strictly scoped to workDate.
 * - Never converts or overwrites MANUAL records.
 */
export function syncAndRestoreObservedTeam(workDate) {
  if (!workDate) {
    workDate = new Date().toISOString().slice(0, 10);
  }

  // 1. Check if a MANUAL working team already exists for this workDate
  // A manual configuration exists if there are records with source = 'MANUAL' or source IS NULL
  const manualRecords = db.prepare(`
    SELECT COUNT(*) as manual_count,
           SUM(CASE WHEN is_working = 1 THEN 1 ELSE 0 END) as working_count
    FROM daily_working_team
    WHERE work_date = ? AND (source = 'MANUAL' OR source IS NULL)
  `).get(workDate);

  if (manualRecords && manualRecords.manual_count > 0) {
    return {
      status: 'MANUAL',
      source: 'MANUAL',
      work_date: workDate,
      working_count: manualRecords.working_count || 0,
      has_manual_configuration: true,
      restored: false,
      message: 'Preserved existing MANUAL Working Team configuration.'
    };
  }

  // 2. Fetch real Vendoor log activity for this specific workDate
  const logRows = db.prepare(`
    SELECT 
      vl.employee_name,
      vl.matched_employee_id,
      COUNT(*) as actions_count,
      COUNT(DISTINCT vl.order_code) as unique_orders,
      MAX(vl.timestamp_str) as last_activity
    FROM vendoor_logs vl
    WHERE vl.work_date = ?
    GROUP BY vl.employee_name
  `).all(workDate);

  // If no logs in vendoor_logs, also check raw_log_records for this date as secondary evidence
  if (logRows.length === 0) {
    const rawRows = db.prepare(`
      SELECT 
        employee_name,
        COUNT(*) as actions_count,
        COUNT(DISTINCT order_code) as unique_orders,
        MAX(event_datetime) as last_activity
      FROM raw_log_records
      WHERE work_date = ?
      GROUP BY employee_name
    `).all(workDate);
    for (const r of rawRows) {
      logRows.push({
        employee_name: r.employee_name,
        matched_employee_id: null,
        actions_count: r.actions_count,
        unique_orders: r.unique_orders,
        last_activity: r.last_activity
      });
    }
  }

  // 3. Resolve identities against Employee Master
  const observedValidEmployees = new Map(); // employee_id -> { last_activity, actions_count }
  const unmatchedLogs = [];

  for (const log of logRows) {
    let empId = log.matched_employee_id;
    if (!empId) {
      const identity = resolveEmployeeIdentity(log.employee_name, { persistIdentity: true });
      empId = identity.employee_id;
    }

    if (empId) {
      // Validate against Employee Master
      const emp = db.prepare(`
        SELECT id, name, status, active, departure_date
        FROM employees
        WHERE id = ?
      `).get(empId);

      // Invariant 9: Employee must be active and not departed
      const isDeparted = emp && (
        emp.status === 'DEPARTED' || 
        (emp.departure_date && emp.departure_date <= workDate)
      );
      const isMasterActive = emp && emp.active === 1 && !isDeparted;

      if (isMasterActive) {
        if (!observedValidEmployees.has(empId)) {
          observedValidEmployees.set(empId, {
            employee_id: empId,
            employee_name: emp.name,
            actions_count: log.actions_count,
            last_activity: log.last_activity
          });
        } else {
          const prev = observedValidEmployees.get(empId);
          prev.actions_count += log.actions_count;
          if (log.last_activity && (!prev.last_activity || log.last_activity > prev.last_activity)) {
            prev.last_activity = log.last_activity;
          }
        }
      }
    } else {
      // Section 15: Unmatched / Unknown identity -> route to review, do NOT auto-create
      unmatchedLogs.push({
        raw_name: log.employee_name,
        actions_count: log.actions_count,
        last_activity: log.last_activity
      });
    }
  }

  // Invariant 8 & 13: Preserve employees already recorded as VENDOOR_OBSERVED earlier today
  const existingObservedRows = db.prepare(`
    SELECT dwt.employee_id, dwt.observed_at, dwt.last_activity_at, e.name, e.status, e.active, e.departure_date
    FROM daily_working_team dwt
    JOIN employees e ON dwt.employee_id = e.id
    WHERE dwt.work_date = ? AND dwt.source = 'VENDOOR_OBSERVED' AND dwt.is_working = 1
  `).all(workDate);

  for (const prev of existingObservedRows) {
    const isDeparted = prev.status === 'DEPARTED' || (prev.departure_date && prev.departure_date <= workDate);
    const isMasterActive = prev.active === 1 && !isDeparted;
    if (isMasterActive && !observedValidEmployees.has(prev.employee_id)) {
      observedValidEmployees.set(prev.employee_id, {
        employee_id: prev.employee_id,
        employee_name: prev.name,
        actions_count: 0,
        last_activity: prev.last_activity_at
      });
    }
  }

  if (observedValidEmployees.size === 0) {
    return {
      status: 'SETUP_REQUIRED',
      source: null,
      work_date: workDate,
      working_count: 0,
      has_manual_configuration: false,
      restored: false,
      unmatched_count: unmatchedLogs.length,
      unmatched_identities: unmatchedLogs,
      message: 'No manual team and no valid Vendoor observed employees found for date.'
    };
  }

  // 4. Persist VENDOOR_OBSERVED team into daily_working_team
  const upsertStmt = db.prepare(`
    INSERT INTO daily_working_team (
      work_date, employee_id, is_working, source, observed_at, last_activity_at, created_at, updated_at
    ) VALUES (?, ?, 1, 'VENDOOR_OBSERVED', datetime('now'), ?, datetime('now'), datetime('now'))
    ON CONFLICT(work_date, employee_id) DO UPDATE SET
      is_working = CASE WHEN daily_working_team.source = 'MANUAL' THEN daily_working_team.is_working ELSE 1 END,
      source = CASE WHEN daily_working_team.source = 'MANUAL' THEN 'MANUAL' ELSE 'VENDOOR_OBSERVED' END,
      last_activity_at = COALESCE(excluded.last_activity_at, daily_working_team.last_activity_at),
      updated_at = datetime('now')
  `);

  // Ensure any DEPARTED employees have is_working = 0
  const deactivateDepartedStmt = db.prepare(`
    UPDATE daily_working_team
    SET is_working = 0, updated_at = datetime('now')
    WHERE work_date = ? AND employee_id IN (
      SELECT id FROM employees WHERE status = 'DEPARTED' OR active = 0 OR (departure_date IS NOT NULL AND departure_date <= ?)
    )
  `);

  const tx = db.transaction(() => {
    for (const [empId, data] of observedValidEmployees.entries()) {
      upsertStmt.run(workDate, empId, data.last_activity || null);
    }
    deactivateDepartedStmt.run(workDate, workDate);
  });

  tx();

  const finalCount = observedValidEmployees.size;

  return {
    status: 'VENDOOR_OBSERVED',
    source: 'VENDOOR_OBSERVED',
    work_date: workDate,
    working_count: finalCount,
    has_manual_configuration: false,
    restored: true,
    unmatched_count: unmatchedLogs.length,
    unmatched_identities: unmatchedLogs,
    message: `Successfully auto-restored ${finalCount} observed employees from real Vendoor logs.`
  };
}

/**
 * Reset manual working team configuration and revert to auto-detected Vendoor logs
 */
export function resetToObservedWorkingTeam(workDate) {
  if (!workDate) {
    workDate = new Date().toISOString().slice(0, 10);
  }
  db.prepare("DELETE FROM daily_working_team WHERE work_date = ? AND (source = 'MANUAL' OR source IS NULL)").run(workDate);
  return syncAndRestoreObservedTeam(workDate);
}

/**
 * Get Comprehensive Working Team & Observed Activity Status for a Business Date
 */
export function getComprehensiveWorkingTeamStatus(workDate) {
  if (!workDate) {
    workDate = new Date().toISOString().slice(0, 10);
  }

  // 1. Check if a MANUAL working team exists for this date
  const manualCountRow = db.prepare(`
    SELECT COUNT(*) as manual_count,
           SUM(CASE WHEN is_working = 1 THEN 1 ELSE 0 END) as manual_working
    FROM daily_working_team
    WHERE work_date = ? AND (source = 'MANUAL' OR source IS NULL)
  `).get(workDate);

  const hasManualConfiguration = Boolean(manualCountRow && manualCountRow.manual_count > 0);

  // If no manual team exists, auto-restore observed team from real logs
  if (!hasManualConfiguration) {
    try {
      syncAndRestoreObservedTeam(workDate);
    } catch (err) {
      console.warn('[getComprehensiveWorkingTeamStatus] Auto-restore notice:', err.message);
    }
  }

  // 2. Fetch all Master Employees (active and inactive/departed)
  const masterEmployees = db.prepare(`
    SELECT id, name, department, team_membership, active, status,
           departure_date, departure_reason, notes, updated_at
    FROM employees
    ORDER BY name COLLATE NOCASE ASC
  `).all();

  const masterEmpMap = new Map();
  for (const emp of masterEmployees) {
    masterEmpMap.set(emp.id, emp);
  }

  // 3. Fetch current working team records from daily_working_team
  const workingRows = db.prepare(`
    SELECT employee_id, is_working, source, observed_at, last_activity_at
    FROM daily_working_team
    WHERE work_date = ?
  `).all(workDate);

  const workingMap = new Map();
  const sourceMap = new Map();
  for (const row of workingRows) {
    workingMap.set(row.employee_id, row.is_working === 1);
    sourceMap.set(row.employee_id, {
      source: row.source || 'MANUAL',
      observed_at: row.observed_at,
      last_activity_at: row.last_activity_at
    });
  }

  // 4. Fetch real activity evidence from vendoor_logs and raw_log_records for today
  const activityRows = db.prepare(`
    SELECT 
      COALESCE(vl.matched_employee_id, NULL) as matched_id,
      vl.employee_name as raw_employee_name,
      COUNT(*) as total_actions,
      COUNT(DISTINCT vl.order_code) as unique_orders_worked,
      MAX(vl.timestamp_str) as last_activity_time,
      SUM(CASE WHEN vl.is_productive = 1 THEN 1 ELSE 0 END) as productive_actions
    FROM vendoor_logs vl
    WHERE vl.work_date = ?
    GROUP BY vl.employee_name
  `).all(workDate);

  // Group activity by employee_id where possible, and collect unmatched names
  const employeeActivityMap = new Map();
  const unmatchedLogs = [];

  for (const act of activityRows) {
    let resolvedId = act.matched_id;

    if (!resolvedId) {
      const identity = resolveEmployeeIdentity(act.raw_employee_name, { persistIdentity: true });
      resolvedId = identity.employee_id;
    }

    if (resolvedId && masterEmpMap.has(resolvedId)) {
      if (!employeeActivityMap.has(resolvedId)) {
        employeeActivityMap.set(resolvedId, {
          total_actions: 0,
          unique_orders_worked: 0,
          productive_actions: 0,
          last_activity_time: null,
          last_action_text: null
        });
      }
      const existing = employeeActivityMap.get(resolvedId);
      existing.total_actions += act.total_actions;
      existing.unique_orders_worked += act.unique_orders_worked;
      existing.productive_actions += act.productive_actions;
      if (!existing.last_activity_time || act.last_activity_time > existing.last_activity_time) {
        existing.last_activity_time = act.last_activity_time;
      }
    } else {
      unmatchedLogs.push({
        raw_name: act.raw_employee_name,
        total_actions: act.total_actions,
        unique_orders_worked: act.unique_orders_worked,
        last_activity_time: act.last_activity_time
      });
    }
  }

  // Fetch the latest action string for each active employee
  for (const [empId, actObj] of employeeActivityMap.entries()) {
    const emp = masterEmpMap.get(empId);
    if (emp) {
      const latestActionRow = db.prepare(`
        SELECT action, timestamp_str
        FROM vendoor_logs
        WHERE work_date = ? AND (matched_employee_id = ? OR LOWER(employee_name) = LOWER(?))
        ORDER BY timestamp_str DESC LIMIT 1
      `).get(workDate, empId, emp.name);

      if (latestActionRow) {
        actObj.last_action_text = latestActionRow.action;
        if (!actObj.last_activity_time) {
          actObj.last_activity_time = latestActionRow.timestamp_str;
        }
      }
    }
  }

  // 5. Fetch latest assigned orders and active workload per employee
  const latestV = db.prepare(`
    SELECT MAX(allocation_version) as max_v
    FROM order_level_allocations
    WHERE allocation_date = ?
  `).get(workDate);

  const version = latestV ? (latestV.max_v || 1) : 1;

  const assignedOrders = db.prepare(`
    SELECT employee_id, order_code, account
    FROM order_level_allocations
    WHERE allocation_date = ? AND allocation_version = ? AND employee_id IS NOT NULL
  `).all(workDate, version);

  const assignedMap = new Map();
  for (const r of assignedOrders) {
    if (!assignedMap.has(r.employee_id)) {
      assignedMap.set(r.employee_id, {
        order_codes: new Set(),
        accounts: new Set()
      });
    }
    const entry = assignedMap.get(r.employee_id);
    entry.order_codes.add(r.order_code);
    entry.accounts.add(r.account);
  }

  // 6. Fetch completion data to compute remaining active orders
  const completionData = getCompletedOrdersForDate(workDate);
  const completedByEmp = completionData.completed_by_employee;

  // 7. Fetch productivity profiles for capacity and rates
  const productivityProfiles = getFullEmployeeProductivityProfiles(workDate);
  const prodMap = new Map(productivityProfiles.map(p => [p.employee_id, p]));

  // 8. Combine into comprehensive operational team status
  const teamMembers = [];
  let workingCount = 0;
  let observedCount = 0;
  let totalActiveOrdersCount = 0;

  for (const emp of masterEmployees) {
    const isDeparted = emp.status === 'DEPARTED' || (emp.departure_date && emp.departure_date <= workDate);
    const isMasterActive = emp.active === 1 && !isDeparted;
    const act = employeeActivityMap.get(emp.id) || null;
    const isObserved = act !== null && act.total_actions > 0;
    const meta = sourceMap.get(emp.id) || null;

    let isWorking = false;
    let membershipSource = 'NOT_IN_TEAM';

    if (isDeparted) {
      isWorking = false;
      membershipSource = 'DEPARTED';
    } else if (hasManualConfiguration) {
      isWorking = workingMap.get(emp.id) === true;
      membershipSource = isWorking ? 'MANUAL' : 'NOT_IN_TEAM';
    } else {
      isWorking = workingMap.get(emp.id) === true;
      membershipSource = isWorking ? 'VENDOOR_OBSERVED' : 'NOT_IN_TEAM';
    }

    if (isWorking) workingCount++;
    if (isObserved) observedCount++;

    // Calculate active orders (Assigned - Completed) matching workload.js invariant
    const assignedEntry = assignedMap.get(emp.id);
    const assignedOrderCodes = assignedEntry ? assignedEntry.order_codes : new Set();
    const assignedAccounts = assignedEntry ? assignedEntry.accounts : new Set();
    const completedSet = completedByEmp.get(emp.id) || new Set();

    let completedAssignedCount = 0;
    for (const code of assignedOrderCodes) {
      if (completedSet.has(code)) {
        completedAssignedCount++;
      }
    }

    const assignedCount = assignedOrderCodes.size;
    const activeOrdersRemaining = Math.max(0, assignedCount - completedAssignedCount);
    totalActiveOrdersCount += activeOrdersRemaining;

    // Productivity metrics
    const prod = prodMap.get(emp.id) || {};
    const estimatedCapacity = prod.estimated_daily_capacity || 40;
    const remainingCapacity = Math.max(0, estimatedCapacity - assignedCount);

    // Operational eligibility status
    let eligibility = 'INELIGIBLE';
    if (isDeparted) {
      eligibility = 'DEPARTED';
    } else if (!isMasterActive) {
      eligibility = 'INACTIVE';
    } else if (!isWorking) {
      eligibility = 'NOT_WORKING_TODAY';
    } else if (remainingCapacity <= 0) {
      eligibility = 'CAPACITY_REACHED';
    } else {
      eligibility = 'ELIGIBLE';
    }

    const lastActivityTime = act ? act.last_activity_time : (meta ? meta.last_activity_at : null);

    teamMembers.push({
      employee_id: emp.id,
      name: emp.name,
      department: emp.department,
      team_membership: emp.team_membership || 'Both',
      master_status: emp.status || (emp.active === 1 ? 'ACTIVE' : 'INACTIVE'),
      is_master_active: isMasterActive,
      is_departed: isDeparted,
      is_working: isWorking,
      membership_source: membershipSource,
      is_observed_today: isObserved,
      total_actions_today: act ? act.total_actions : 0,
      unique_orders_worked: act ? act.unique_orders_worked : 0,
      productive_actions: act ? act.productive_actions : 0,
      last_activity_time: lastActivityTime,
      last_activity_relative: lastActivityTime ? formatRelativeTime(lastActivityTime) : 'No activity today',
      last_action_text: act ? act.last_action_text : null,
      assigned_orders_count: assignedCount,
      assigned_accounts_count: assignedAccounts.size,
      completed_orders_count: completedAssignedCount,
      active_orders_count: activeOrdersRemaining,
      estimated_capacity: estimatedCapacity,
      remaining_capacity: remainingCapacity,
      typical_rate_10m: prod.typical_orders_per_10m || 0,
      recent_rate: prod.recent_rate_10m || 0,
      confidence: prod.confidence || 'LOW',
      eligibility,
      allowed_new: isWorking && (emp.team_membership === 'New' || emp.team_membership === 'Both'),
      allowed_pending: isWorking && (emp.team_membership === 'Pending' || emp.team_membership === 'Both')
    });
  }

  // Precedence determination:
  // 1. MANUAL
  // 2. VENDOOR_OBSERVED
  // 3. SETUP_REQUIRED
  let workingTeamSource = 'SETUP_REQUIRED';
  if (hasManualConfiguration && workingCount > 0) {
    workingTeamSource = 'MANUAL';
  } else if (workingCount > 0) {
    workingTeamSource = 'VENDOOR_OBSERVED';
  }

  return {
    work_date: workDate,
    has_manual_configuration: hasManualConfiguration,
    working_team_source: workingTeamSource,
    summary: {
      total_master_employees: masterEmployees.length,
      working_team_count: workingCount,
      working_team_source: workingTeamSource,
      observed_today_count: observedCount,
      total_active_orders: totalActiveOrdersCount,
      unmatched_identities_count: unmatchedLogs.length
    },
    team_members: teamMembers,
    unmatched_logs: unmatchedLogs
  };
}

/**
 * Toggle an employee's working status for today (creates or updates MANUAL record)
 */
export function toggleWorkingTeamMember(workDate, employeeId, isWorking) {
  const emp = db.prepare('SELECT id, name, status, active FROM employees WHERE id = ?').get(employeeId);
  if (!emp) {
    throw new Error(`Employee ID ${employeeId} not found`);
  }

  if (emp.status === 'DEPARTED' && isWorking) {
    throw new Error(`Cannot add departed employee "${emp.name}" to today's Working Team. Employee is marked as DEPARTED.`);
  }

  db.prepare(`
    INSERT INTO daily_working_team (work_date, employee_id, is_working, source, created_at, updated_at)
    VALUES (?, ?, ?, 'MANUAL', datetime('now'), datetime('now'))
    ON CONFLICT(work_date, employee_id) DO UPDATE SET
      is_working = excluded.is_working,
      source = 'MANUAL',
      updated_at = datetime('now')
  `).run(workDate, employeeId, isWorking ? 1 : 0);

  return {
    success: true,
    work_date: workDate,
    employee_id: employeeId,
    employee_name: emp.name,
    is_working: Boolean(isWorking),
    source: 'MANUAL'
  };
}
