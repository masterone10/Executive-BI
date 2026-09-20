/**
 * Phase 3 Employee Workload & Refill State Management
 *
 * Responsibilities:
 * - Calculate exact workload metrics for each employee for a given operational date:
 *   1. Assigned Valid Orders (from order_level_allocations)
 *   2. Completed Valid Orders (from real Vendoor evidence via completion.js)
 *   3. Remaining Work = max(0, Assigned - Completed)
 *   4. Current Load = Remaining Work
 *   5. Remaining Capacity = max(0, Estimated Capacity - Assigned Work)
 * - Deterministically evaluate Refill States for Working Team members:
 *   - NOT_WORKING: Not present or active in today's Working Team
 *   - NEEDS_REVIEW: Ambiguous data or blocked identity
 *   - NO_VALID_CAPACITY: Remaining capacity <= 0
 *   - HEALTHY_WORKLOAD: Remaining work > refill_threshold + 5
 *   - NEAR_REFILL: Remaining work between refill_threshold and refill_threshold + 5
 *   - REFILL_ELIGIBLE: Remaining work <= refill_threshold AND remaining capacity > 0
 * - Enforce all 8 required conditions before declaring REFILL_ELIGIBLE
 */

import { db } from '../../db/index.js';
import { getCompletedOrdersForDate } from './completion.js';
import { getFullEmployeeProductivityProfiles } from './productivity.js';

export const REFILL_STATES = Object.freeze({
  NOT_WORKING: 'NOT_WORKING',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  NO_VALID_CAPACITY: 'NO_VALID_CAPACITY',
  HEALTHY_WORKLOAD: 'HEALTHY_WORKLOAD',
  NEAR_REFILL: 'NEAR_REFILL',
  REFILL_ELIGIBLE: 'REFILL_ELIGIBLE'
});

/**
 * Fetch centralized refill threshold from system configs
 */
export function getRefillThreshold() {
  const row = db.prepare("SELECT value FROM system_configs WHERE key = 'refill_threshold'").get();
  return row ? (parseInt(row.value, 10) || 20) : 20;
}

/**
 * Computes live workload and refill states for all employees on a given date.
 *
 * @param {string} workDate - YYYY-MM-DD
 * @param {Object} [options]
 * @param {number} [options.refillThreshold] - Override threshold for simulation/testing
 * @returns {Array<Object>} List of employee workload profiles
 */
export function getEmployeeWorkloadAndRefillStates(workDate, options = {}) {
  if (!workDate) {
    throw new Error('workDate is required for getEmployeeWorkloadAndRefillStates');
  }

  const threshold = options.refillThreshold !== undefined 
    ? options.refillThreshold 
    : getRefillThreshold();

  // 1. Fetch Working Team for this date (MANDATORY check)
  const workingTeamRows = db.prepare(`
    SELECT employee_id, is_working
    FROM daily_working_team
    WHERE work_date = ?
  `).all(workDate);

  const workingTeamMap = new Map();
  for (const wt of workingTeamRows) {
    workingTeamMap.set(wt.employee_id, {
      is_working: Boolean(wt.is_working)
    });
  }

  // 2. Fetch productivity profiles (estimated daily capacity, rate, confidence)
  const productivityProfiles = getFullEmployeeProductivityProfiles(workDate);
  const prodMap = new Map(productivityProfiles.map(p => [p.employee_id, p]));

  // 3. Fetch completed orders evidence for today
  const completionData = getCompletedOrdersForDate(workDate);
  const completedByEmp = completionData.completed_by_employee;

  // 4. Fetch assigned orders from latest allocation version
  const latestVersionRow = db.prepare(`
    SELECT MAX(allocation_version) as max_v
    FROM order_level_allocations
    WHERE allocation_date = ?
  `).get(workDate);

  const latestVersion = latestVersionRow ? (latestVersionRow.max_v || 1) : 1;

  const assignedOrders = db.prepare(`
    SELECT 
      order_code, account, employee_id, employee_name, status, method
    FROM order_level_allocations
    WHERE allocation_date = ? AND allocation_version = ?
  `).all(workDate, latestVersion);

  // Group assignments by employee
  const assignedByEmp = new Map(); // empId -> Array<{ order_code, account }>
  for (const ord of assignedOrders) {
    if (!ord.employee_id || ord.employee_name === 'UNASSIGNED') continue;
    if (!assignedByEmp.has(ord.employee_id)) {
      assignedByEmp.set(ord.employee_id, []);
    }
    assignedByEmp.get(ord.employee_id).push(ord);
  }

  // 5. Fetch all active employees from Master
  const masterEmployees = db.prepare(`
    SELECT id, name, department, team_membership, active, status
    FROM employees
    WHERE active = 1 AND (status = 'ACTIVE' OR status IS NULL)
    ORDER BY name ASC
  `).all();

  const results = [];

  for (const emp of masterEmployees) {
    const wtEntry = workingTeamMap.get(emp.id);
    const isWorking = wtEntry ? wtEntry.is_working : false;
    const prod = prodMap.get(emp.id);

    const assignedList = assignedByEmp.get(emp.id) || [];
    const assignedOrderCodes = new Set(assignedList.map(o => o.order_code));
    const assignedAccounts = new Set(assignedList.map(o => o.account));

    const completedOrdersSet = completedByEmp.get(emp.id) || new Set();
    
    // Count how many of the employee's assigned orders have completed
    let completedAssignedCount = 0;
    for (const code of assignedOrderCodes) {
      if (completedOrdersSet.has(code)) {
        completedAssignedCount++;
      }
    }

    const assignedCount = assignedOrderCodes.size;
    const completedCount = completedAssignedCount;
    
    // Invariant: Remaining Work = max(0, Assigned - Completed)
    const remainingWork = Math.max(0, assignedCount - completedCount);
    const currentLoad = remainingWork;

    const estimatedCapacity = prod ? prod.estimated_capacity : 30;
    
    // Invariant: Remaining Capacity = max(0, Estimated Capacity - Assigned Work)
    const remainingCapacity = Math.max(0, estimatedCapacity - assignedCount);

    // Refill State Evaluation
    let refillState = REFILL_STATES.HEALTHY_WORKLOAD;
    let refillReason = '';
    let isEligible = false;

    const isCS = String(emp.department || '').trim().toUpperCase() === 'CS';

    if (!isWorking) {
      refillState = REFILL_STATES.NOT_WORKING;
      refillReason = 'Employee is not active in today\'s Working Team';
    } else if (!isCS) {
      refillState = REFILL_STATES.NOT_WORKING;
      refillReason = `Employee department is "${emp.department}". CS Work Allocation requires CS department only`;
      isEligible = false;
    } else if (prod && prod.confidence === 'LOW' && prod.unique_orders_worked === 0 && !prod.is_measured_capacity && wtEntry?.notes?.includes('BLOCKED')) {
      refillState = REFILL_STATES.NEEDS_REVIEW;
      refillReason = 'Account/Supervisor block active or unverified identity';
    } else if (remainingCapacity <= 0) {
      refillState = REFILL_STATES.NO_VALID_CAPACITY;
      refillReason = `Daily capacity limit reached (${assignedCount}/${estimatedCapacity} allocated)`;
    } else if (remainingWork <= threshold) {
      refillState = REFILL_STATES.REFILL_ELIGIBLE;
      refillReason = `Remaining workload (${remainingWork}) is at/below threshold (${threshold}); ${remainingCapacity} capacity available`;
      isEligible = true;
    } else if (remainingWork <= threshold + 5) {
      refillState = REFILL_STATES.NEAR_REFILL;
      refillReason = `Approaching refill threshold (${remainingWork} orders remaining, threshold: ${threshold})`;
    } else {
      refillState = REFILL_STATES.HEALTHY_WORKLOAD;
      refillReason = `Active workload is healthy (${remainingWork} orders remaining)`;
    }

    results.push({
      employee_id: emp.id,
      employee_name: emp.name,
      department: emp.department,
      team_membership: emp.team_membership,
      is_working: isWorking,
      team_role: wtEntry ? wtEntry.team_role : 'None',
      assigned_orders_count: assignedCount,
      assigned_accounts_count: assignedAccounts.size,
      assigned_accounts: Array.from(assignedAccounts),
      completed_orders_count: completedCount,
      remaining_work: remainingWork,
      current_load: currentLoad,
      estimated_daily_capacity: estimatedCapacity,
      remaining_capacity: remainingCapacity,
      is_measured_capacity: prod ? prod.is_measured_capacity : false,
      typical_orders_10m: prod ? prod.typical_orders_per_10m : 0,
      recent_rate: prod ? prod.recent_rate : 0,
      long_term_rate: prod ? prod.long_term_rate : 0,
      consistency: prod ? prod.consistency : 0,
      confidence: prod ? prod.confidence : 'LOW',
      refill_threshold: threshold,
      refill_state: refillState,
      refill_eligible: isEligible,
      refill_reason: refillReason,
      last_activity: prod ? prod.last_activity : null
    });
  }

  return results;
}

/**
 * Deterministic helper to evaluate refill need for an individual state
 */
export function evaluateRefillNeed(remainingWork, threshold, remainingCapacity, estimatedCapacity, isWorking) {
  if (!isWorking) {
    return {
      refillNeeded: false,
      refillState: REFILL_STATES.NOT_WORKING,
      reason: "Employee is not active in today's Working Team"
    };
  }
  if (remainingCapacity <= 0) {
    return {
      refillNeeded: false,
      refillState: REFILL_STATES.NO_VALID_CAPACITY,
      reason: 'Daily capacity limit reached'
    };
  }
  if (remainingWork <= threshold) {
    return {
      refillNeeded: true,
      refillState: REFILL_STATES.REFILL_ELIGIBLE,
      reason: `Remaining workload (${remainingWork}) is at/below threshold (${threshold})`
    };
  }
  if (remainingWork <= threshold + 5) {
    return {
      refillNeeded: false,
      refillState: REFILL_STATES.NEAR_REFILL,
      reason: 'Approaching refill threshold'
    };
  }
  return {
    refillNeeded: false,
    refillState: REFILL_STATES.HEALTHY_WORKLOAD,
    reason: `Active workload is healthy (${remainingWork} orders remaining)`
  };
}

export const getLiveEmployeeWorkloads = getEmployeeWorkloadAndRefillStates;

