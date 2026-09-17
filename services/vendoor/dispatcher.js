/**
 * Phase 3 Continuous Auto Dispatcher & Smart Refill Engine
 *
 * Core Principles & Mandatory Invariants:
 * 1. OFF by default; continuous polling does NOT start automatically on server launch.
 * 2. DRY RUN by default; simulation does NOT mutate allocation tables.
 * 3. Working Team is MANDATORY: If empty/unconfigured, emits SETUP_REQUIRED and 0 assignments.
 * 4. Never steal or rebalance assigned work (AUTO DISPATCH MAY ADD WORK, NEVER TAKE WORK AWAY).
 * 5. Pulls strictly from the UNALLOCATED orders pool.
 * 6. Account-Centric: 40, 100, 120 orders stay unified if single eligible employee has capacity.
 * 7. Sticky ownership: Preserved for existing account owner if eligible and has capacity.
 * 8. Reuses existing Smart Allocation multi-factor scoring (Quality, Capacity, Workload Balance).
 * 9. Enforces single-instance execution lock (no concurrent overlapping cycles).
 * 10. Atomic DB transactions protect all allocation writes.
 */

import { db } from '../../db/index.js';
import { getEmployeeWorkloadAndRefillStates, REFILL_STATES, getRefillThreshold } from './workload.js';
import { getUnallocatedOrdersPool } from './unallocated.js';
import { getCompletedOrdersForDate } from './completion.js';
import { getOperationalBusinessDate } from '../parser.js';

export function getEffectiveWorkDate(dateInput) {
  if (dateInput) return dateInput;
  const op = getOperationalBusinessDate(new Date());
  return op ? op.business_date : new Date().toISOString().slice(0, 10);
}

// Central in-memory state of the Dispatcher Engine
const dispatcherState = {
  isRunning: false,
  isLocked: false,
  lockAcquiredAt: null,
  activeTimerId: null,
  currentCycleId: null,
  lastCycleResult: null,
  lastCycleAt: null,
  cycleCount: 0,
  alerts: []
};

/**
 * Fetch dispatcher configurations from database
 */
export function getDispatcherConfig() {
  const getCfg = (k, def) => {
    const r = db.prepare('SELECT value FROM system_configs WHERE key = ?').get(k);
    return r ? r.value : def;
  };

  return {
    enabled: getCfg('vendoor_auto_dispatch_enabled', 'false') === 'true',
    dryRunMode: getCfg('dry_run_mode', 'true') === 'true',
    refillThreshold: parseInt(getCfg('refill_threshold', '20'), 10) || 20,
    intervalMs: parseInt(getCfg('dispatcher_interval_ms', '60000'), 10) || 60000,
    maxOrdersPerCycle: parseInt(getCfg('max_orders_per_cycle', '50'), 10) || 50,
    maxAssignmentsPerCycle: parseInt(getCfg('max_assignments_per_cycle', '100'), 10) || 100,
    timeBudgetMs: parseInt(getCfg('dispatcher_time_budget_ms', '15000'), 10) || 15000,
    safetyMargin: parseFloat(getCfg('safety_margin', '0.85')) || 0.85,
    staleOrdersLimitMs: parseInt(getCfg('stale_orders_limit_ms', '3600000'), 10) || 3600000,
    staleLogsLimitMs: parseInt(getCfg('stale_logs_limit_ms', '3600000'), 10) || 3600000
  };
}

/**
 * Update a dispatcher configuration parameter
 */
export function updateDispatcherConfig(key, value) {
  db.prepare(`
    INSERT INTO system_configs (key, value, description)
    VALUES (?, ?, 'Auto Dispatcher config')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

/**
 * Acquire single-instance execution lock
 */
function acquireLock(timeBudgetMs = 15000) {
  const now = Date.now();
  if (dispatcherState.isLocked) {
    // Check for stale lock timeout
    if (dispatcherState.lockAcquiredAt && (now - dispatcherState.lockAcquiredAt > timeBudgetMs)) {
      console.warn('[AutoDispatcher] Clearing stale lock after timeout');
      dispatcherState.isLocked = false;
    } else {
      return false;
    }
  }

  dispatcherState.isLocked = true;
  dispatcherState.lockAcquiredAt = now;
  return true;
}

/**
 * Release execution lock
 */
function releaseLock() {
  dispatcherState.isLocked = false;
  dispatcherState.lockAcquiredAt = null;
}

/**
 * Generates a unique cycle ID
 */
export function generateCycleId() {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `cycle-${ts}-${rand}`;
}

/**
 * Executes a single controlled Auto Dispatcher & Smart Refill cycle.
 *
 * @param {Object} [options]
 * @param {string} [options.workDate] - Target operational day (YYYY-MM-DD)
 * @param {boolean} [options.dryRun] - Explicit dry-run override
 * @param {string} [options.trigger='MANUAL_CYCLE'] - Trigger source
 * @param {boolean} [options.forceRun=false] - Bypass enabled check for explicit single cycle
 * @returns {Promise<Object>} Detailed cycle summary
 */
export async function runDispatcherCycle(options = {}) {
  const cfg = getDispatcherConfig();
  const workDate = getEffectiveWorkDate(options.workDate);
  const isDryRun = options.dryRun !== undefined ? Boolean(options.dryRun) : cfg.dryRunMode;
  const trigger = options.trigger || 'MANUAL_CYCLE';
  const forceRun = Boolean(options.forceRun);

  // 1. Lock acquisition
  if (!acquireLock(cfg.timeBudgetMs)) {
    return {
      success: false,
      cycle_id: null,
      status: 'LOCKED_CONCURRENT_CYCLE_IN_PROGRESS',
      message: 'Another auto-dispatch cycle is currently running. Skipping cycle.'
    };
  }

  const cycleId = generateCycleId();
  dispatcherState.currentCycleId = cycleId;
  const startedAt = new Date().toISOString();

  try {
    // 2. Pre-condition Safety Checks
    if (!cfg.enabled && !forceRun && !isDryRun) {
      releaseLock();
      return {
        success: false,
        cycle_id: cycleId,
        status: 'OFF',
        message: 'Auto Dispatcher is disabled in configuration (VENDOOR_AUTO_DISPATCH_ENABLED=false).'
      };
    }

    // Date isolation and validity
    if (!workDate || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
      releaseLock();
      return { success: false, cycle_id: cycleId, status: 'INVALID_DATE', message: 'Current business date is invalid.' };
    }

    // Vendoor Data Freshness & Sync Health
    if (!isDryRun) {
      const nowMs = Date.now();
      
      const latestOrdersSync = db.prepare("SELECT created_at, status FROM vendoor_sync_runs WHERE resource='orders' AND status='SUCCESS' ORDER BY id DESC LIMIT 1").get();
      const latestLogsSync = db.prepare("SELECT created_at, status FROM vendoor_sync_runs WHERE resource='logs' AND status='SUCCESS' ORDER BY id DESC LIMIT 1").get();
      
      if (!latestOrdersSync || (nowMs - new Date(latestOrdersSync.created_at + 'Z').getTime()) > cfg.staleOrdersLimitMs) {
        releaseLock();
        return { success: false, cycle_id: cycleId, status: 'STALE_DATA', message: 'Orders data is not fresh enough. Vendoor sync required.' };
      }
      if (!latestLogsSync || (nowMs - new Date(latestLogsSync.created_at + 'Z').getTime()) > cfg.staleLogsLimitMs) {
        releaseLock();
        return { success: false, cycle_id: cycleId, status: 'STALE_DATA', message: 'Logs data is not fresh enough. Vendoor sync required.' };
      }
    }

    // A. Working Team Check (Mandatory Invariant)
    const workingTeamCountRow = db.prepare(`
      SELECT COUNT(*) as c FROM daily_working_team
      WHERE work_date = ? AND is_working = 1
    `).get(workDate);

    const workingTeamCount = workingTeamCountRow ? workingTeamCountRow.c : 0;
    if (workingTeamCount === 0) {
      recordCycleAudit({
        cycle_id: cycleId,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        work_date: workDate,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE_DISPATCH',
        trigger,
        status: 'SETUP_REQUIRED',
        working_employees_count: 0,
        unallocated_orders_count: 0,
        eligible_employees_count: 0,
        employees_needing_refill_count: 0,
        assignments_attempted: 0,
        assignments_created: 0,
        assignments_skipped: 0,
        assignments_failed: 0,
        completed_orders_observed: 0,
        summary_json: { reason: 'No active employees in daily_working_team for date' },
        error_safe: 'SETUP_REQUIRED: Working Team is empty. Refill aborted.'
      });

      releaseLock();
      return {
        success: false,
        cycle_id: cycleId,
        status: 'SETUP_REQUIRED',
        message: `No active Working Team found for ${workDate}. Setup is required before auto-dispatch.`
      };
    }

    // B. Calculate Employee Workloads and Refill States
    const employeeStates = getEmployeeWorkloadAndRefillStates(workDate, {
      refillThreshold: cfg.refillThreshold
    });

    // Filter to refill-eligible employees
    const eligibleEmployees = employeeStates.filter(e => e.refill_eligible && e.remaining_capacity > 0);

    // C. Completion Observations
    const completionData = getCompletedOrdersForDate(workDate);
    const completedOrdersObserved = completionData.completed_order_codes.size;

    // If no employees need refill
    if (eligibleEmployees.length === 0) {
      recordCycleAudit({
        cycle_id: cycleId,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        work_date: workDate,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE_DISPATCH',
        trigger,
        status: 'NO_ELIGIBLE_EMPLOYEES',
        working_employees_count: workingTeamCount,
        unallocated_orders_count: 0,
        eligible_employees_count: 0,
        employees_needing_refill_count: 0,
        assignments_attempted: 0,
        assignments_created: 0,
        assignments_skipped: 0,
        assignments_failed: 0,
        completed_orders_observed: completedOrdersObserved,
        summary_json: { reason: 'All working employees have healthy workloads or reached capacity' },
        error_safe: null
      });

      releaseLock();
      return {
        success: true,
        cycle_id: cycleId,
        status: 'NO_ELIGIBLE_EMPLOYEES',
        message: 'No employees currently meet the refill criteria.',
        eligible_employees_count: 0,
        working_employees_count: workingTeamCount
      };
    }

    // D. Extract Unallocated Pool
    const unallocatedPool = getUnallocatedOrdersPool(workDate, {
      limit: cfg.maxOrdersPerCycle
    });

    const unallocatedCount = unallocatedPool.total_unallocated_orders;

    if (unallocatedCount === 0) {
      recordCycleAudit({
        cycle_id: cycleId,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        work_date: workDate,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE_DISPATCH',
        trigger,
        status: 'NO_UNALLOCATED_WORK',
        working_employees_count: workingTeamCount,
        unallocated_orders_count: 0,
        eligible_employees_count: eligibleEmployees.length,
        employees_needing_refill_count: eligibleEmployees.length,
        assignments_attempted: 0,
        assignments_created: 0,
        assignments_skipped: 0,
        assignments_failed: 0,
        completed_orders_observed: completedOrdersObserved,
        summary_json: { reason: 'No unallocated orders available in the pool' },
        error_safe: null
      });

      releaseLock();
      return {
        success: true,
        cycle_id: cycleId,
        status: 'NO_UNALLOCATED_WORK',
        message: 'Unallocated orders pool is empty.',
        eligible_employees_count: eligibleEmployees.length,
        unallocated_orders_count: 0
      };
    }

    // 3. Smart Refill Assignment Process (Account-Centric & Sticky Ownership)
    // Fetch sticky account owners for today
    const ownerRows = db.prepare(`
      SELECT account, owner_employee_id, owner_employee_name
      FROM account_owners
      WHERE work_date = ?
    `).all(workDate);

    const accountOwnersMap = new Map();
    for (const ow of ownerRows) {
      accountOwnersMap.set(ow.account, ow);
    }

    // Fetch account rules for restrictions
    const ruleRows = db.prepare('SELECT account_name, blocked_json, new_eligible_json FROM account_rules WHERE active = 1').all();
    const accountRulesMap = new Map();
    for (const r of ruleRows) {
      accountRulesMap.set(r.account_name, {
        blocked: JSON.parse(r.blocked_json || '[]'),
        eligible: JSON.parse(r.new_eligible_json || '[]')
      });
    }

    // Track simulated dynamic capacity during this cycle
    const simulatedCapacityMap = new Map(eligibleEmployees.map(e => [e.employee_id, e.remaining_capacity]));
    const simulatedWorkloadMap = new Map(eligibleEmployees.map(e => [e.employee_id, e.remaining_work]));

    const plannedAssignments = []; // Array of assignment candidates
    let totalAttempted = 0;
    let totalCreated = 0;
    let totalSkipped = 0;

    // Process accounts from unallocated pool
    for (const [accountName, accountOrders] of unallocatedPool.accounts_pool.entries()) {
      if (accountOrders.length === 0) continue;
      if (totalCreated >= cfg.maxAssignmentsPerCycle) break;

      totalAttempted += accountOrders.length;
      const accountOrderCount = accountOrders.length;

      // Check Rule 1: Sticky Ownership
      const stickyOwner = accountOwnersMap.get(accountName);
      let assignedEmployee = null;
      let assignmentReason = '';

      if (stickyOwner && stickyOwner.owner_employee_id) {
        const ownerEmp = eligibleEmployees.find(e => e.employee_id === stickyOwner.owner_employee_id);
        const ownerCap = simulatedCapacityMap.get(stickyOwner.owner_employee_id) || 0;

        if (ownerEmp && ownerCap >= accountOrderCount) {
          // Sticky owner is refill-eligible and has capacity!
          assignedEmployee = ownerEmp;
          assignmentReason = `Sticky Account Owner preserved (${accountName})`;
        }
      }

      // If sticky owner unavailable or lacks capacity, run Smart Allocation scoring
      if (!assignedEmployee) {
        const rules = accountRulesMap.get(accountName);

        // Filter eligible candidates by account rules
        const viableCandidates = eligibleEmployees.filter(emp => {
          const cap = simulatedCapacityMap.get(emp.employee_id) || 0;
          if (cap <= 0) return false;

          // Check blocked list
          if (rules && rules.blocked && rules.blocked.length > 0) {
            if (rules.blocked.includes(emp.employee_id) || rules.blocked.includes(emp.employee_name)) {
              return false;
            }
          }
          return true;
        });

        if (viableCandidates.length === 0) {
          totalSkipped += accountOrderCount;
          continue;
        }

        // Single employee capacity check: Can any candidate take the WHOLE account? (Account-Centric)
        const candidatesWithFullCapacity = viableCandidates.filter(emp => {
          const cap = simulatedCapacityMap.get(emp.employee_id) || 0;
          return cap >= accountOrderCount;
        });

        if (candidatesWithFullCapacity.length > 0) {
          // Score candidates with full capacity
          candidatesWithFullCapacity.sort((a, b) => {
            const capA = simulatedCapacityMap.get(a.employee_id) || 0;
            const capB = simulatedCapacityMap.get(b.employee_id) || 0;
            const scoreA = (a.recent_rate * 0.40) + (capA * 0.35) - (a.remaining_work * 0.25);
            const scoreB = (b.recent_rate * 0.40) + (capB * 0.35) - (b.remaining_work * 0.25);
            return scoreB - scoreA;
          });

          assignedEmployee = candidatesWithFullCapacity[0];
          assignmentReason = `Smart Allocation Account-Centric match (${accountOrderCount} orders unified)`;
        } else {
          // Smart Split: Account is larger than any single candidate's capacity
          // Proportional allocation across top viable candidates
          let orderIdx = 0;
          for (const cand of viableCandidates) {
            const candCap = simulatedCapacityMap.get(cand.employee_id) || 0;
            if (candCap <= 0 || orderIdx >= accountOrderCount) continue;

            const sliceSize = Math.min(candCap, accountOrderCount - orderIdx);
            const subOrders = accountOrders.slice(orderIdx, orderIdx + sliceSize);

            for (const ord of subOrders) {
              const capBefore = simulatedCapacityMap.get(cand.employee_id);
              const workBefore = simulatedWorkloadMap.get(cand.employee_id);

              simulatedCapacityMap.set(cand.employee_id, capBefore - 1);
              simulatedWorkloadMap.set(cand.employee_id, workBefore + 1);

              plannedAssignments.push({
                order_code: ord.order_code,
                account: ord.account,
                employee_id: cand.employee_id,
                employee_name: cand.employee_name,
                reason: `Smart Split Proportional Refill (${sliceSize}/${accountOrderCount} orders for ${cand.employee_name})`,
                capacity_before: capBefore,
                capacity_after: capBefore - 1,
                remaining_workload_before: workBefore,
                remaining_workload_after: workBefore + 1,
                smart_score: +(cand.recent_rate * 0.40 + capBefore * 0.35).toFixed(2)
              });
              totalCreated++;
            }
            orderIdx += sliceSize;
          }
          continue; // Account split handled
        }
      }

      // Assign unified account to assignedEmployee
      if (assignedEmployee) {
        for (const ord of accountOrders) {
          if (totalCreated >= cfg.maxAssignmentsPerCycle) break;

          const capBefore = simulatedCapacityMap.get(assignedEmployee.employee_id);
          const workBefore = simulatedWorkloadMap.get(assignedEmployee.employee_id);

          simulatedCapacityMap.set(assignedEmployee.employee_id, capBefore - 1);
          simulatedWorkloadMap.set(assignedEmployee.employee_id, workBefore + 1);

          plannedAssignments.push({
            order_code: ord.order_code,
            account: ord.account,
            employee_id: assignedEmployee.employee_id,
            employee_name: assignedEmployee.employee_name,
            reason: assignmentReason,
            capacity_before: capBefore,
            capacity_after: capBefore - 1,
            remaining_workload_before: workBefore,
            remaining_workload_after: workBefore + 1,
            smart_score: +(assignedEmployee.recent_rate * 0.40 + capBefore * 0.35).toFixed(2)
          });
          totalCreated++;
        }
      }
    }

    // 4. Persistence & Transaction Safety
    const latestVersionRow = db.prepare(`
      SELECT MAX(allocation_version) as max_v
      FROM order_level_allocations
      WHERE allocation_date = ?
    `).get(workDate);

    const latestVersion = latestVersionRow ? (latestVersionRow.max_v || 1) : 1;

    // Record initial cycle row so auto_dispatch_assignments satisfy FOREIGN KEY constraint
    recordCycleAudit({
      cycle_id: cycleId,
      started_at: startedAt,
      finished_at: null,
      work_date: workDate,
      mode: isDryRun ? 'DRY_RUN' : 'LIVE_DISPATCH',
      trigger,
      status: 'IN_PROGRESS',
      working_employees_count: workingTeamCount,
      unallocated_orders_count: unallocatedCount,
      eligible_employees_count: eligibleEmployees.length,
      employees_needing_refill_count: eligibleEmployees.length,
      assignments_attempted: totalAttempted,
      assignments_created: 0,
      assignments_skipped: totalSkipped,
      assignments_failed: 0,
      completed_orders_observed: completedOrdersObserved,
      summary_json: null,
      error_safe: null
    });

    let actuallyWritten = 0;

    if (!isDryRun && plannedAssignments.length > 0) {
      // Transactional commit for real auto-dispatch
      const insertAssignStmt = db.prepare(`
        INSERT INTO order_level_allocations (
          allocation_date, allocation_version, order_code, account, status,
          employee_id, employee_name, method, rule_note, is_override, created_at
        ) VALUES (?, ?, ?, ?, 'New', ?, ?, 'AUTO_DISPATCH', ?, 0, datetime('now'))
        ON CONFLICT(allocation_date, allocation_version, order_code) DO UPDATE SET
          employee_id = excluded.employee_id,
          employee_name = excluded.employee_name,
          method = 'AUTO_DISPATCH',
          rule_note = excluded.rule_note
      `);

      const verifyUnallocatedStmt = db.prepare(`
        SELECT employee_name FROM order_level_allocations
        WHERE allocation_date = ? AND allocation_version = ? AND order_code = ?
      `);

      const tx = db.transaction(() => {
        for (const assign of plannedAssignments) {
          // Re-verify order is still unallocated (protect against race condition)
          const existing = verifyUnallocatedStmt.get(workDate, latestVersion, assign.order_code);
          if (existing && existing.employee_name && existing.employee_name !== 'UNASSIGNED') {
            // Already allocated in concurrent operation; skip safely
            continue;
          }

          insertAssignStmt.run(
            workDate,
            latestVersion,
            assign.order_code,
            assign.account,
            assign.employee_id,
            assign.employee_name,
            `Auto Refill (${cycleId}): ${assign.reason}`
          );

          recordAssignmentAudit({
            cycle_id: cycleId,
            work_date: workDate,
            order_code: assign.order_code,
            account: assign.account,
            employee_id: assign.employee_id,
            employee_name: assign.employee_name,
            is_dry_run: 0,
            source: 'AUTO_DISPATCH',
            reason: assign.reason,
            capacity_before: assign.capacity_before,
            capacity_after: assign.capacity_after,
            remaining_workload_before: assign.remaining_workload_before,
            remaining_workload_after: assign.remaining_workload_after,
            smart_score: assign.smart_score
          });

          actuallyWritten++;
        }
      });

      tx();
    } else if (isDryRun && plannedAssignments.length > 0) {
      // Dry-run: record simulation audit only without mutating order_level_allocations
      for (const assign of plannedAssignments) {
        recordAssignmentAudit({
          cycle_id: cycleId,
          work_date: workDate,
          order_code: assign.order_code,
          account: assign.account,
          employee_id: assign.employee_id,
          employee_name: assign.employee_name,
          is_dry_run: 1,
          source: 'AUTO_DISPATCH_DRY_RUN',
          reason: assign.reason,
          capacity_before: assign.capacity_before,
          capacity_after: assign.capacity_after,
          remaining_workload_before: assign.remaining_workload_before,
          remaining_workload_after: assign.remaining_workload_after,
          smart_score: assign.smart_score
        });
      }
      actuallyWritten = plannedAssignments.length;
    }

    const finishedAt = new Date().toISOString();
    const finalStatus = plannedAssignments.length > 0 ? 'SUCCESS' : 'NO_ASSIGNMENTS_MADE';

    // 5. Audit Logging
    recordCycleAudit({
      cycle_id: cycleId,
      started_at: startedAt,
      finished_at: finishedAt,
      work_date: workDate,
      mode: isDryRun ? 'DRY_RUN' : 'LIVE_DISPATCH',
      trigger,
      status: finalStatus,
      working_employees_count: workingTeamCount,
      unallocated_orders_count: unallocatedCount,
      eligible_employees_count: eligibleEmployees.length,
      employees_needing_refill_count: eligibleEmployees.length,
      assignments_attempted: totalAttempted,
      assignments_created: actuallyWritten,
      assignments_skipped: totalSkipped,
      assignments_failed: 0,
      completed_orders_observed: completedOrdersObserved,
      summary_json: {
        planned_count: plannedAssignments.length,
        written_count: actuallyWritten,
        is_dry_run: isDryRun,
        accounts_evaluated: unallocatedPool.unique_accounts_count
      },
      error_safe: null
    });

    const result = {
      success: true,
      cycle_id: cycleId,
      work_date: workDate,
      mode: isDryRun ? 'DRY_RUN' : 'LIVE_DISPATCH',
      trigger,
      status: finalStatus,
      working_employees_count: workingTeamCount,
      eligible_employees_count: eligibleEmployees.length,
      unallocated_orders_count: unallocatedCount,
      assignments_created: actuallyWritten,
      assignments_skipped: totalSkipped,
      completed_orders_observed: completedOrdersObserved,
      planned_assignments: plannedAssignments
    };

    dispatcherState.lastCycleResult = result;
    dispatcherState.lastCycleAt = finishedAt;
    dispatcherState.cycleCount++;

    releaseLock();
    return result;

  } catch (err) {
    releaseLock();
    const finishedAt = new Date().toISOString();
    console.error('[AutoDispatcher] Cycle error:', err);

    recordCycleAudit({
      cycle_id: cycleId,
      started_at: startedAt,
      finished_at: finishedAt,
      work_date: workDate,
      mode: isDryRun ? 'DRY_RUN' : 'LIVE_DISPATCH',
      trigger,
      status: 'FAILED',
      working_employees_count: 0,
      unallocated_orders_count: 0,
      eligible_employees_count: 0,
      employees_needing_refill_count: 0,
      assignments_attempted: 0,
      assignments_created: 0,
      assignments_skipped: 0,
      assignments_failed: 1,
      completed_orders_observed: 0,
      summary_json: null,
      error_safe: err.message
    });

    return {
      success: false,
      cycle_id: cycleId,
      status: 'FAILED',
      message: err.message
    };
  }
}

/**
 * Persist cycle audit record
 */
function recordCycleAudit(data) {
  try {
    db.prepare(`
      INSERT INTO auto_dispatch_cycles (
        cycle_id, started_at, finished_at, work_date, mode, trigger, status,
        working_employees_count, unallocated_orders_count, eligible_employees_count,
        employees_needing_refill_count, assignments_attempted, assignments_created,
        assignments_skipped, assignments_failed, completed_orders_observed,
        summary_json, error_safe
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cycle_id) DO UPDATE SET
        finished_at = excluded.finished_at,
        status = excluded.status,
        assignments_attempted = excluded.assignments_attempted,
        assignments_created = excluded.assignments_created,
        assignments_skipped = excluded.assignments_skipped,
        assignments_failed = excluded.assignments_failed,
        completed_orders_observed = excluded.completed_orders_observed,
        summary_json = excluded.summary_json,
        error_safe = excluded.error_safe
    `).run(
      data.cycle_id,
      data.started_at,
      data.finished_at,
      data.work_date,
      data.mode,
      data.trigger,
      data.status,
      data.working_employees_count || 0,
      data.unallocated_orders_count || 0,
      data.eligible_employees_count || 0,
      data.employees_needing_refill_count || 0,
      data.assignments_attempted || 0,
      data.assignments_created || 0,
      data.assignments_skipped || 0,
      data.assignments_failed || 0,
      data.completed_orders_observed || 0,
      data.summary_json ? JSON.stringify(data.summary_json) : null,
      data.error_safe || null
    );
  } catch (e) {
    console.error('[AutoDispatcher] Failed to write cycle audit:', e.message);
  }
}

/**
 * Persist individual assignment audit record
 */
function recordAssignmentAudit(data) {
  try {
    db.prepare(`
      INSERT INTO auto_dispatch_assignments (
        cycle_id, work_date, order_code, account, employee_id, employee_name,
        is_dry_run, source, reason, capacity_before, capacity_after,
        remaining_workload_before, remaining_workload_after, smart_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.cycle_id,
      data.work_date,
      data.order_code,
      data.account,
      data.employee_id,
      data.employee_name,
      data.is_dry_run ? 1 : 0,
      data.source || 'AUTO_DISPATCH',
      data.reason || '',
      data.capacity_before || 0,
      data.capacity_after || 0,
      data.remaining_workload_before || 0,
      data.remaining_workload_after || 0,
      data.smart_score || 0
    );
  } catch (e) {
    console.error('[AutoDispatcher] Failed to write assignment audit:', e.message);
  }
}

/**
 * Start continuous dispatcher interval
 */
export function startContinuousDispatcher(intervalMs) {
  const cfg = getDispatcherConfig();
  const effectiveInterval = intervalMs || cfg.intervalMs || 60000;

  if (dispatcherState.activeTimerId) {
    clearInterval(dispatcherState.activeTimerId);
    dispatcherState.activeTimerId = null;
  }

  updateDispatcherConfig('vendoor_auto_dispatch_enabled', 'true');
  dispatcherState.isRunning = true;

  dispatcherState.activeTimerId = setInterval(async () => {
    try {
      await runDispatcherCycle({ trigger: 'POLLING_INTERVAL' });
    } catch (err) {
      console.error('[AutoDispatcher] Background interval execution failed:', err.message);
    }
  }, effectiveInterval);

  return {
    status: 'ACTIVE',
    interval_ms: effectiveInterval,
    message: `Continuous auto dispatcher started with ${effectiveInterval}ms interval.`
  };
}

/**
 * Stop continuous dispatcher interval
 */
export function stopContinuousDispatcher() {
  if (dispatcherState.activeTimerId) {
    clearInterval(dispatcherState.activeTimerId);
    dispatcherState.activeTimerId = null;
  }

  updateDispatcherConfig('vendoor_auto_dispatch_enabled', 'false');
  dispatcherState.isRunning = false;

  return {
    status: 'OFF',
    message: 'Continuous auto dispatcher stopped.'
  };
}

/**
 * Get comprehensive dispatcher status and diagnostic state
 */
export function getDispatcherStatus() {
  const cfg = getDispatcherConfig();
  const workDate = getEffectiveWorkDate();

  // Working team count
  const wtRow = db.prepare('SELECT COUNT(*) as c FROM daily_working_team WHERE work_date = ? AND is_working = 1').get(workDate);
  const wtCount = wtRow ? wtRow.c : 0;

  // Unallocated orders count
  const unallocated = getUnallocatedOrdersPool(workDate, { limit: 1 });

  let operationalStatus = 'OFF';
  if (!cfg.enabled) {
    operationalStatus = 'OFF';
  } else if (wtCount === 0) {
    operationalStatus = 'SETUP_REQUIRED';
  } else if (cfg.dryRunMode) {
    operationalStatus = 'DRY_RUN';
  } else if (dispatcherState.isRunning) {
    operationalStatus = 'ACTIVE';
  } else {
    operationalStatus = 'PAUSED';
  }

  return {
    operational_status: operationalStatus,
    is_running: dispatcherState.isRunning,
    is_locked: dispatcherState.isLocked,
    work_date: workDate,
    config: cfg,
    working_team_count: wtCount,
    unallocated_pool_count: unallocated.total_unallocated_orders,
    cycle_count: dispatcherState.cycleCount,
    last_cycle_at: dispatcherState.lastCycleAt,
    last_cycle_result: dispatcherState.lastCycleResult
  };
}

/**
 * Get recent cycle audit history
 */
export function getDispatcherAuditHistory(limit = 20) {
  const boundedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  return db.prepare(`
    SELECT * FROM auto_dispatch_cycles
    ORDER BY id DESC
    LIMIT ?
  `).all(boundedLimit);
}

/**
 * Get operational alerts
 */
export function getDispatcherAlerts() {
  const workDate = getEffectiveWorkDate();
  const alerts = [];

  // Alert 1: Empty Working Team
  const wtRow = db.prepare('SELECT COUNT(*) as c FROM daily_working_team WHERE work_date = ? AND is_working = 1').get(workDate);
  if (!wtRow || wtRow.c === 0) {
    alerts.push({
      severity: 'WARNING',
      code: 'EMPTY_WORKING_TEAM',
      message: `No active Working Team found for ${workDate}. Auto-dispatch cannot allocate.`
    });
  }

  // Alert 2: Unallocated Backlog Growing
  const unalloc = getUnallocatedOrdersPool(workDate, { limit: 1 });
  if (unalloc.total_unallocated_orders > 100) {
    alerts.push({
      severity: 'INFO',
      code: 'UNALLOCATED_BACKLOG_GROWING',
      message: `${unalloc.total_unallocated_orders} unallocated orders waiting in pool.`
    });
  }

  return alerts;
}

export const executeDispatchCycle = runDispatcherCycle;
export const startDispatcherPolling = startContinuousDispatcher;
export const stopDispatcherPolling = stopContinuousDispatcher;
export const setDispatcherConfig = updateDispatcherConfig;

