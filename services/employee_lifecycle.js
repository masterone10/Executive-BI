/**
 * Production Employee Lifecycle & Operational Reassignment Engine
 *
 * Core Mandates:
 * 1. Employee Master is strictly authoritative.
 * 2. Marking departed is NON-DESTRUCTIVE: all historical data (logs, orders worked, allocations, audit trails)
 *    remain 100% intact and permanent.
 * 3. Departed employees become strictly INELIGIBLE for future allocations and working teams.
 * 4. Safe active orders (NEW / PENDING) are analyzed and reassigned using canonical efficiency-aware Smart Allocation.
 * 5. Uncertain orders are placed in the Review Queue for supervisor inspection.
 * 6. Historical logs (vendoor_logs, raw_log_records) are NEVER rewritten.
 * 7. All lifecycle changes and reassignments are recorded in append-only audit tables.
 */

import { db } from '../db/index.js';
import { getCompletedOrdersForDate } from './vendoor/completion.js';
import { getFullEmployeeProductivityProfiles } from './vendoor/productivity.js';
import { getEmployeeWorkloadAndRefillStates } from './vendoor/workload.js';

export const LIFECYCLE_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  DEPARTED: 'DEPARTED'
});

export const TRANSFER_SAFETY = Object.freeze({
  SAFE_TO_REASSIGN: 'SAFE_TO_REASSIGN',
  NEEDS_REVIEW: 'NEEDS_REVIEW'
});

/**
 * Normalize text safely
 */
function norm(str) {
  return String(str || '').trim();
}

/**
 * Get detailed employee profile including lifecycle status
 */
export function getEmployeeLifecycleProfile(employeeId) {
  const emp = db.prepare(`
    SELECT id, name, department, team_membership, active, status,
           effective_from, effective_to, departure_date, departure_reason,
           notes, created_at, updated_at
    FROM employees
    WHERE id = ?
  `).get(employeeId);

  if (!emp) return null;

  return {
    id: emp.id,
    name: emp.name,
    department: emp.department,
    team_membership: emp.team_membership || 'Both',
    active: emp.active === 1,
    status: emp.status || (emp.active === 1 ? 'ACTIVE' : 'INACTIVE'),
    effective_from: emp.effective_from,
    effective_to: emp.effective_to,
    departure_date: emp.departure_date,
    departure_reason: emp.departure_reason,
    notes: emp.notes,
    created_at: emp.created_at,
    updated_at: emp.updated_at
  };
}

/**
 * Retrieve open/active orders currently assigned to an employee on a given date.
 * Distinguishes open orders from completed work.
 */
export function getEmployeeActiveOrders(employeeId, workDate) {
  const emp = db.prepare('SELECT id, name FROM employees WHERE id = ?').get(employeeId);
  if (!emp) return { employee: null, active_orders: [], completed_orders: [] };

  // 1. Get latest allocation version for this date
  const latestV = db.prepare(`
    SELECT MAX(allocation_version) as max_v
    FROM order_level_allocations
    WHERE allocation_date = ?
  `).get(workDate);

  const version = latestV ? (latestV.max_v || 1) : 1;

  // 2. Fetch all orders assigned to this employee in order_level_allocations
  const assignedRows = db.prepare(`
    SELECT ola.order_code, ola.account, ola.status as allocated_status, ola.method, ola.rule_note,
           cwo.merchant_code, cwo.status as cwo_status, cwo.created_at as order_created_at,
           vo.city, vo.total_price
    FROM order_level_allocations ola
    LEFT JOIN current_work_orders cwo ON cwo.work_date = ola.allocation_date AND cwo.order_code = ola.order_code
    LEFT JOIN vendoor_orders vo ON vo.order_code = ola.order_code
    WHERE ola.allocation_date = ? AND ola.allocation_version = ? AND ola.employee_id = ?
  `).all(workDate, version, employeeId);

  // 3. Check completion evidence for today
  const completionData = getCompletedOrdersForDate(workDate);
  const completedOrdersSet = completionData.completed_by_employee.get(employeeId) || new Set();

  const activeOrders = [];
  const completedOrders = [];

  for (const row of assignedRows) {
    const isCompleted = completedOrdersSet.has(row.order_code) ||
      (row.cwo_status && ['Completed', 'Delivered', 'Cancelled', 'Closed'].some(s => row.cwo_status.toLowerCase().includes(s.toLowerCase())));

    const orderObj = {
      order_code: row.order_code,
      account: row.account,
      merchant_code: row.merchant_code || '',
      status: row.cwo_status || row.allocated_status || 'Active',
      allocated_status: row.allocated_status,
      method: row.method,
      rule_note: row.rule_note,
      city: row.city || null,
      total_price: row.total_price || 0,
      order_created_at: row.order_created_at,
      is_completed: isCompleted
    };

    if (isCompleted) {
      completedOrders.push(orderObj);
    } else {
      activeOrders.push(orderObj);
    }
  }

  // Also check account_owners to find accounts owned by this employee today
  const ownedAccounts = db.prepare(`
    SELECT account, allocation_method, is_override, notes
    FROM account_owners
    WHERE work_date = ? AND owner_employee_id = ?
  `).all(workDate, employeeId);

  return {
    employee: emp,
    work_date: workDate,
    active_orders: activeOrders,
    active_count: activeOrders.length,
    completed_orders: completedOrders,
    completed_count: completedOrders.length,
    owned_accounts: ownedAccounts,
    accounts_count: ownedAccounts.length
  };
}

/**
 * Analyze Departure Impact & Generate Safe Reassignment Proposal
 *
 * Checks all active orders of departing employee, validates candidate replacements
 * from Today's Working Team, applies efficiency-aware scoring, and flags uncertain items.
 */
export function analyzeDepartureImpact(employeeId, workDate, options = {}) {
  const empProfile = getEmployeeLifecycleProfile(employeeId);
  if (!empProfile) {
    throw new Error(`Employee ID ${employeeId} not found in Employee Master`);
  }

  const activeData = getEmployeeActiveOrders(employeeId, workDate);
  const activeOrders = activeData.active_orders;
  const ownedAccounts = activeData.owned_accounts;

  // 1. Get eligible active candidates from Today's Working Team
  const workingTeamRows = db.prepare(`
    SELECT dwt.employee_id, e.name, e.department, e.team_membership, e.active, e.status
    FROM daily_working_team dwt
    JOIN employees e ON e.id = dwt.employee_id
    WHERE dwt.work_date = ? AND dwt.is_working = 1
      AND e.active = 1 AND (e.status = 'ACTIVE' OR e.status IS NULL)
      AND e.id != ?
    ORDER BY e.name ASC
  `).all(workDate, employeeId);

  // 2. Fetch live productivity and workload metrics for eligible candidates
  const productivityProfiles = getFullEmployeeProductivityProfiles(workDate);
  const prodMap = new Map(productivityProfiles.map(p => [p.employee_id, p]));

  let workloadList = [];
  try {
    workloadList = getEmployeeWorkloadAndRefillStates(workDate);
  } catch (e) {
    workloadList = [];
  }
  const workMap = new Map(workloadList.map(w => [w.employee_id, w]));

  // 3. Fetch account rules for account-level restrictions
  const ruleRows = db.prepare('SELECT account_name, blocked_json, new_eligible_json FROM account_rules WHERE active = 1').all();
  const accountRulesMap = new Map();
  for (const r of ruleRows) {
    accountRulesMap.set(r.account_name, {
      blocked: JSON.parse(r.blocked_json || '[]'),
      eligible: JSON.parse(r.new_eligible_json || '[]')
    });
  }

  // Build candidate objects with efficiency & capacity metrics
  const candidates = workingTeamRows.map(cand => {
    const prod = prodMap.get(cand.employee_id) || {};
    const work = workMap.get(cand.employee_id) || {};

    return {
      employee_id: cand.employee_id,
      name: cand.name,
      department: cand.department,
      team_membership: cand.team_membership || 'Both',
      remaining_capacity: work.remaining_capacity !== undefined ? work.remaining_capacity : (prod.estimated_daily_capacity || 40),
      current_load: work.remaining_work !== undefined ? work.remaining_work : 0,
      assigned_count: work.assigned_count || 0,
      completed_count: work.completed_count || 0,
      typical_rate_10m: prod.typical_orders_per_10m || 0,
      recent_rate: prod.recent_rate_10m || 0,
      long_term_rate: prod.long_term_rate_10m || 0,
      consistency: prod.consistency || 0,
      confidence: prod.confidence || 'LOW',
      historical_unique_orders: prod.historical_unique_orders || 0,
      historical_active_days: prod.historical_active_days || 0,
      owned_accounts_count: 0 // dynamically tracked
    };
  });

  // Track owned accounts per candidate today to maintain Account Fairness
  const todayAccountOwners = db.prepare('SELECT account, owner_employee_id FROM account_owners WHERE work_date = ?').all(workDate);
  const candidateAccountCountMap = new Map();
  for (const row of todayAccountOwners) {
    if (row.owner_employee_id) {
      candidateAccountCountMap.set(
        row.owner_employee_id,
        (candidateAccountCountMap.get(row.owner_employee_id) || 0) + 1
      );
    }
  }
  candidates.forEach(c => {
    c.owned_accounts_count = candidateAccountCountMap.get(c.employee_id) || 0;
  });

  // Dynamic capacity tracking during reassignment simulation
  const simCapMap = new Map(candidates.map(c => [c.employee_id, c.remaining_capacity]));
  const simAccMap = new Map(candidates.map(c => [c.employee_id, c.owned_accounts_count]));
  const simLoadMap = new Map(candidates.map(c => [c.employee_id, c.current_load]));

  // Group active orders by Account (One Account = One Employee principle!)
  const ordersByAccount = new Map();
  for (const ord of activeOrders) {
    const acc = ord.account || 'Unassigned / Unknown Account';
    if (!ordersByAccount.has(acc)) {
      ordersByAccount.set(acc, []);
    }
    ordersByAccount.get(acc).push(ord);
  }

  // Also include any owned accounts that have 0 orders currently in table
  for (const ow of ownedAccounts) {
    if (!ordersByAccount.has(ow.account)) {
      ordersByAccount.set(ow.account, []);
    }
  }

  const safeReassignments = [];
  const uncertainItems = [];

  for (const [accountName, accOrders] of ordersByAccount.entries()) {
    const orderCount = accOrders.length;
    const orderCodes = accOrders.map(o => o.order_code);

    // Detect streams for this account
    const hasNew = accOrders.some(o => (o.status && o.status.toLowerCase().includes('new')) || o.allocated_status === 'New');
    const hasPending = accOrders.some(o => (o.status && o.status.toLowerCase().includes('pending')) || o.allocated_status === 'Pending');

    const rules = accountRulesMap.get(accountName);

    // Filter viable candidates based on eligibility rules:
    // 1. Permanent team membership compatible with account streams
    // 2. Not blocked by account rules
    // 3. Positive remaining capacity
    const viableCandidates = candidates.filter(cand => {
      // Stream compatibility
      const allowedNew = cand.team_membership === 'New' || cand.team_membership === 'Both';
      const allowedPending = cand.team_membership === 'Pending' || cand.team_membership === 'Both';

      if (hasNew && !allowedNew) return false;
      if (hasPending && !allowedPending) return false;

      // Account rule blocked check
      if (rules && rules.blocked && rules.blocked.length > 0) {
        if (rules.blocked.includes(cand.employee_id) || rules.blocked.includes(cand.name)) {
          return false;
        }
      }

      // Check simulated capacity
      const remCap = simCapMap.get(cand.employee_id) || 0;
      if (orderCount > 0 && remCap <= 0) return false;

      return true;
    });

    if (viableCandidates.length === 0) {
      // No valid replacement candidate found -> Flag as UNCERTAIN / NEEDS_REVIEW
      uncertainItems.push({
        type: 'ACCOUNT_OR_ORDERS',
        account: accountName,
        order_codes: orderCodes,
        order_count: orderCount,
        reason_code: 'NO_ELIGIBLE_REPLACEMENT_AVAILABLE',
        reason_detail: `No active working team member has compatible stream capability and remaining capacity for account "${accountName}" (${orderCount} orders).`,
        suggested_candidate: null
      });
      continue;
    }

    // Score viable candidates using efficiency-aware Smart Allocation hierarchy:
    // Primary fairness metric: Account count (fewest owned accounts first)
    // Secondary: Efficiency score = (recent_rate * 0.35) + (remCap * 0.35) - (currentLoad * 0.20) + (confidenceBonus)
    viableCandidates.sort((a, b) => {
      const accA = simAccMap.get(a.employee_id) || 0;
      const accB = simAccMap.get(b.employee_id) || 0;
      if (accA !== accB) {
        return accA - accB; // Fewer accounts owned first
      }

      const capA = simCapMap.get(a.employee_id) || 0;
      const capB = simCapMap.get(b.employee_id) || 0;

      const loadA = simLoadMap.get(a.employee_id) || 0;
      const loadB = simLoadMap.get(b.employee_id) || 0;

      const confBonusA = a.confidence === 'HIGH' ? 1.0 : (a.confidence === 'MEDIUM' ? 0.5 : 0);
      const confBonusB = b.confidence === 'HIGH' ? 1.0 : (b.confidence === 'MEDIUM' ? 0.5 : 0);

      const scoreA = (a.recent_rate * 0.35) + (capA * 0.35) - (loadA * 0.20) + confBonusA;
      const scoreB = (b.recent_rate * 0.35) + (capB * 0.35) - (loadB * 0.20) + confBonusB;

      if (Math.abs(scoreB - scoreA) > 0.001) {
        return scoreB - scoreA; // Higher efficiency first
      }

      // Deterministic alphabetical tie-break
      return a.name.localeCompare(b.name);
    });

    const bestCandidate = viableCandidates[0];
    const bestCap = simCapMap.get(bestCandidate.employee_id) || 0;

    // Check if best candidate has enough capacity for all orders of this account
    if (orderCount > 0 && bestCap < orderCount && viableCandidates.length > 1) {
      // Candidate does not have full capacity, but can still accept if supervisor approves or mark review
      const hasFullCapCandidate = viableCandidates.find(c => (simCapMap.get(c.employee_id) || 0) >= orderCount);
      const chosen = hasFullCapCandidate || bestCandidate;

      // Update simulated stats
      simCapMap.set(chosen.employee_id, Math.max(0, (simCapMap.get(chosen.employee_id) || 0) - orderCount));
      simAccMap.set(chosen.employee_id, (simAccMap.get(chosen.employee_id) || 0) + 1);
      simLoadMap.set(chosen.employee_id, (simLoadMap.get(chosen.employee_id) || 0) + orderCount);

      safeReassignments.push({
        account: accountName,
        order_codes: orderCodes,
        order_count: orderCount,
        previous_owner_id: employeeId,
        previous_owner_name: empProfile.name,
        target_employee_id: chosen.employee_id,
        target_employee_name: chosen.name,
        target_department: chosen.department,
        reason: `Efficiency Reassignment (Fair Account Balance, ${orderCount} orders)`,
        match_score: +(chosen.recent_rate * 0.35 + (simCapMap.get(chosen.employee_id) || 0) * 0.35).toFixed(2),
        capacity_before: simCapMap.get(chosen.employee_id) + orderCount,
        capacity_after: simCapMap.get(chosen.employee_id),
        safety: TRANSFER_SAFETY.SAFE_TO_REASSIGN
      });
    } else {
      // Safe unified reassignment
      simCapMap.set(bestCandidate.employee_id, Math.max(0, bestCap - orderCount));
      simAccMap.set(bestCandidate.employee_id, (simAccMap.get(bestCandidate.employee_id) || 0) + 1);
      simLoadMap.set(bestCandidate.employee_id, (simLoadMap.get(bestCandidate.employee_id) || 0) + orderCount);

      safeReassignments.push({
        account: accountName,
        order_codes: orderCodes,
        order_count: orderCount,
        previous_owner_id: employeeId,
        previous_owner_name: empProfile.name,
        target_employee_id: bestCandidate.employee_id,
        target_employee_name: bestCandidate.name,
        target_department: bestCandidate.department,
        reason: `Efficiency Reassignment (Fair Account Balance, ${orderCount} orders)`,
        match_score: +(bestCandidate.recent_rate * 0.35 + bestCap * 0.35).toFixed(2),
        capacity_before: bestCap,
        capacity_after: Math.max(0, bestCap - orderCount),
        safety: TRANSFER_SAFETY.SAFE_TO_REASSIGN
      });
    }
  }

  return {
    employee: empProfile,
    work_date: workDate,
    active_orders_count: activeOrders.length,
    completed_orders_count: activeData.completed_count,
    accounts_count: ordersByAccount.size,
    available_candidates_count: candidates.length,
    available_candidates: candidates.map(c => ({
      employee_id: c.employee_id,
      name: c.name,
      department: c.department,
      team_membership: c.team_membership,
      remaining_capacity: simCapMap.get(c.employee_id),
      current_load: simLoadMap.get(c.employee_id),
      typical_rate_10m: c.typical_rate_10m,
      confidence: c.confidence
    })),
    safe_reassignments: safeReassignments,
    uncertain_items: uncertainItems,
    summary: {
      safe_accounts_count: safeReassignments.length,
      uncertain_accounts_count: uncertainItems.length,
      safe_orders_count: safeReassignments.reduce((sum, r) => sum + r.order_count, 0),
      uncertain_orders_count: uncertainItems.reduce((sum, u) => sum + u.order_count, 0)
    }
  };
}

/**
 * Execute Employee Departure Workflow
 *
 * Atomically marks employee as DEPARTED without data loss, reassigns safe orders,
 * queues uncertain orders, and records comprehensive audit trails.
 */
export function executeEmployeeDeparture(employeeId, options = {}) {
  const empId = parseInt(employeeId, 10);
  const workDate = options.workDate || new Date().toISOString().slice(0, 10);
  const departureDate = options.departureDate || workDate;
  const departureReason = norm(options.departureReason || options.reason || 'Left the team');
  const operator = norm(options.operator || 'Supervisor');
  const reassignSafeOrders = options.reassignSafeOrders !== false;

  const empProfile = getEmployeeLifecycleProfile(empId);
  if (!empProfile) {
    throw new Error(`Employee ID ${empId} not found in Employee Master`);
  }

  if (empProfile.status === LIFECYCLE_STATUS.DEPARTED) {
    return {
      success: false,
      already_departed: true,
      message: `Employee ${empProfile.name} is already marked as DEPARTED.`,
      employee: empProfile
    };
  }

  // Run impact analysis to get safe reassignments and uncertain items
  const impact = analyzeDepartureImpact(empId, workDate);

  let executedReassignments = [];
  let queuedReviewItems = [];

  const tx = db.transaction(() => {
    // 1. Update Employee Master record: Mark DEPARTED, active = 0, keep all identity & history intact
    db.prepare(`
      UPDATE employees
      SET status = 'DEPARTED',
          active = 0,
          departure_date = ?,
          departure_reason = ?,
          effective_to = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(departureDate, departureReason, departureDate, empId);

    // 2. Remove / disable from daily_working_team for today and future dates
    db.prepare(`
      UPDATE daily_working_team
      SET is_working = 0
      WHERE employee_id = ? AND work_date >= ?
    `).run(empId, workDate);

    // 3. Process Safe Reassignments if enabled
    if (reassignSafeOrders && impact.safe_reassignments.length > 0) {
      for (const reassign of impact.safe_reassignments) {
        const account = reassign.account;
        const targetId = reassign.target_employee_id;
        const targetName = reassign.target_employee_name;
        const reasonNote = `[Departure Reassignment] ${empProfile.name} departed: ${departureReason}`;

        // Upsert into account_owners
        db.prepare(`
          INSERT INTO account_owners (
            work_date, account, owner_employee_id, owner_employee_name,
            allocation_method, is_override, notes, updated_at
          ) VALUES (?, ?, ?, ?, 'Departure Reassignment', 1, ?, datetime('now'))
          ON CONFLICT(work_date, account) DO UPDATE SET
            owner_employee_id = excluded.owner_employee_id,
            owner_employee_name = excluded.owner_employee_name,
            allocation_method = 'Departure Reassignment',
            is_override = 1,
            notes = excluded.notes,
            updated_at = datetime('now')
        `).run(workDate, account, targetId, targetName, reasonNote);

        // Update order_level_allocations for this account
        db.prepare(`
          UPDATE order_level_allocations
          SET employee_id = ?, employee_name = ?, is_override = 1,
              method = 'Departure Reassignment',
              rule_note = ?
          WHERE allocation_date = ? AND LOWER(account) = LOWER(?) AND employee_id = ?
        `).run(targetId, targetName, reasonNote, workDate, account, empId);

        // Log into account_reassignment_logs
        db.prepare(`
          INSERT INTO account_reassignment_logs (
            work_date, account, previous_employee_id, previous_employee_name,
            new_employee_id, new_employee_name, reassigned_by, reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(workDate, account, empId, empProfile.name, targetId, targetName, operator, reasonNote);

        executedReassignments.push({
          account,
          orders_count: reassign.order_count,
          target_employee_id: targetId,
          target_employee_name: targetName
        });
      }
    }

    // 4. Queue Uncertain Items in order_review_queue
    if (impact.uncertain_items.length > 0) {
      const insertReviewQueueStmt = db.prepare(`
        INSERT INTO order_review_queue (
          work_date, order_code, account, current_status,
          previous_employee_id, previous_employee_name,
          reason_code, reason_detail, suggested_employee_id, suggested_employee_name,
          review_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', datetime('now'), datetime('now'))
        ON CONFLICT(work_date, order_code) DO UPDATE SET
          reason_code = excluded.reason_code,
          reason_detail = excluded.reason_detail,
          updated_at = datetime('now')
      `);

      for (const item of impact.uncertain_items) {
        for (const code of item.order_codes) {
          insertReviewQueueStmt.run(
            workDate,
            code,
            item.account,
            'Pending Reassignment',
            empId,
            empProfile.name,
            item.reason_code,
            item.reason_detail,
            item.suggested_candidate ? item.suggested_candidate.employee_id : null,
            item.suggested_candidate ? item.suggested_candidate.name : null
          );
        }
        queuedReviewItems.push(item);
      }
    }

    // 5. Insert comprehensive record into employee_lifecycle_audit
    db.prepare(`
      INSERT INTO employee_lifecycle_audit (
        employee_id, employee_name, action_type, previous_status, new_status,
        effective_date, operator, reason, impact_summary_json,
        affected_orders_count, reassigned_orders_count, uncertain_orders_count,
        reassignments_json, review_items_json, created_at
      ) VALUES (?, ?, 'DEPARTURE', ?, 'DEPARTED', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      empId,
      empProfile.name,
      empProfile.status,
      departureDate,
      operator,
      departureReason,
      JSON.stringify({
        active_orders_count: impact.active_orders_count,
        completed_orders_count: impact.completed_orders_count,
        accounts_count: impact.accounts_count
      }),
      impact.active_orders_count,
      executedReassignments.reduce((sum, r) => sum + r.orders_count, 0),
      queuedReviewItems.reduce((sum, u) => sum + u.order_count, 0),
      JSON.stringify(executedReassignments),
      JSON.stringify(queuedReviewItems)
    );
  });

  tx();

  const updatedProfile = getEmployeeLifecycleProfile(empId);

  return {
    success: true,
    employee_id: empId,
    employee_name: empProfile.name,
    status: LIFECYCLE_STATUS.DEPARTED,
    departure_date: departureDate,
    departure_reason: departureReason,
    reassigned_accounts_count: executedReassignments.length,
    reassigned_orders_count: executedReassignments.reduce((sum, r) => sum + r.orders_count, 0),
    uncertain_orders_queued: queuedReviewItems.reduce((sum, u) => sum + u.order_count, 0),
    executed_reassignments: executedReassignments,
    queued_review_items: queuedReviewItems,
    employee: updatedProfile
  };
}

/**
 * Update employee status with lifecycle validation and audit
 */
export function updateEmployeeStatus(employeeId, newStatus, options = {}) {
  const empId = parseInt(employeeId, 10);
  const status = String(newStatus || '').toUpperCase();
  const operator = norm(options.operator || 'Supervisor');
  const reason = norm(options.reason || `Status updated to ${status}`);
  const effectiveDate = options.effectiveDate || new Date().toISOString().slice(0, 10);

  if (![LIFECYCLE_STATUS.ACTIVE, LIFECYCLE_STATUS.INACTIVE, LIFECYCLE_STATUS.DEPARTED].includes(status)) {
    throw new Error(`Invalid employee status: ${newStatus}. Must be ACTIVE, INACTIVE, or DEPARTED.`);
  }

  const existing = getEmployeeLifecycleProfile(empId);
  if (!existing) {
    throw new Error(`Employee ID ${empId} not found`);
  }

  if (status === LIFECYCLE_STATUS.DEPARTED) {
    return executeEmployeeDeparture(empId, {
      departureDate: effectiveDate,
      departureReason: reason,
      operator,
      workDate: options.workDate || effectiveDate
    });
  }

  const newActive = status === LIFECYCLE_STATUS.ACTIVE ? 1 : 0;

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE employees
      SET status = ?,
          active = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(status, newActive, empId);

    if (newActive === 0) {
      db.prepare(`
        UPDATE daily_working_team
        SET is_working = 0
        WHERE employee_id = ? AND work_date >= ?
      `).run(empId, effectiveDate);
    }

    db.prepare(`
      INSERT INTO employee_lifecycle_audit (
        employee_id, employee_name, action_type, previous_status, new_status,
        effective_date, operator, reason, affected_orders_count, created_at
      ) VALUES (?, ?, 'STATUS_CHANGE', ?, ?, ?, ?, ?, 0, datetime('now'))
    `).run(empId, existing.name, existing.status, status, effectiveDate, operator, reason);
  });

  tx();

  return {
    success: true,
    employee: getEmployeeLifecycleProfile(empId)
  };
}

/**
 * Get comprehensive preserved employee history (proving zero data loss upon departure)
 */
export function getEmployeePreservedHistory(employeeId) {
  const emp = getEmployeeLifecycleProfile(employeeId);
  if (!emp) return null;

  // 1. Historical action records from raw_log_records
  const logSummaryRows = db.prepare(`
    SELECT work_date, COUNT(*) as actions_count, COUNT(DISTINCT order_code) as unique_orders_count
    FROM raw_log_records
    WHERE LOWER(employee_name) = LOWER(?)
    GROUP BY work_date
    ORDER BY work_date DESC
  `).all(emp.name);

  // 2. Historical performance snapshots
  const snapshots = db.prepare(`
    SELECT date, real_actions, grade, segment, cancel_risk
    FROM performance_snapshots
    WHERE employee_id = ?
    ORDER BY date DESC
  `).all(emp.id);

  // 3. Historical allocations
  const pastAllocations = db.prepare(`
    SELECT allocation_date, COUNT(*) as allocated_orders_count, COUNT(DISTINCT account) as accounts_count
    FROM order_level_allocations
    WHERE employee_id = ?
    GROUP BY allocation_date
    ORDER BY allocation_date DESC
  `).all(emp.id);

  // 4. Lifecycle audit events
  const lifecycleAudits = db.prepare(`
    SELECT action_type, previous_status, new_status, effective_date, operator, reason, created_at
    FROM employee_lifecycle_audit
    WHERE employee_id = ?
    ORDER BY created_at DESC
  `).all(emp.id);

  return {
    employee: emp,
    historical_logs_dates_count: logSummaryRows.length,
    historical_total_actions: logSummaryRows.reduce((sum, r) => sum + r.actions_count, 0),
    historical_total_unique_orders: logSummaryRows.reduce((sum, r) => sum + r.unique_orders_count, 0),
    daily_activity_history: logSummaryRows,
    performance_snapshots: snapshots,
    past_allocations: pastAllocations,
    lifecycle_audits: lifecycleAudits
  };
}

/**
 * Retrieve Lifecycle Audit Logs
 */
export function getLifecycleAuditLogs(options = {}) {
  let query = `
    SELECT id, employee_id, employee_name, action_type, previous_status, new_status,
           effective_date, operator, reason, impact_summary_json,
           affected_orders_count, reassigned_orders_count, uncertain_orders_count,
           reassignments_json, review_items_json, created_at
    FROM employee_lifecycle_audit
  `;
  const params = [];

  if (options.employeeId) {
    query += ' WHERE employee_id = ? ';
    params.push(options.employeeId);
  }

  query += ' ORDER BY created_at DESC LIMIT ? ';
  params.push(options.limit || 100);

  return db.prepare(query).all(...params);
}

/**
 * Retrieve Order Review Queue
 */
export function getOrderReviewQueue(options = {}) {
  let query = `
    SELECT id, work_date, order_code, account, merchant_code, current_status,
           previous_employee_id, previous_employee_name,
           reason_code, reason_detail, suggested_employee_id, suggested_employee_name,
           suggested_score, review_status, resolved_employee_id, resolved_employee_name,
           resolved_by, resolved_at, resolution_notes, created_at, updated_at
    FROM order_review_queue
  `;
  const conditions = [];
  const params = [];

  if (options.workDate) {
    conditions.push(' work_date = ? ');
    params.push(options.workDate);
  }

  if (options.status) {
    conditions.push(' review_status = ? ');
    params.push(options.status);
  } else if (!options.all) {
    conditions.push(" review_status = 'PENDING' ");
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY created_at DESC LIMIT ? ';
  params.push(options.limit || 200);

  return db.prepare(query).all(...params);
}

/**
 * Resolve an item in the Order Review Queue
 */
export function resolveReviewQueueItem(reviewId, targetEmployeeId, options = {}) {
  const targetId = parseInt(targetEmployeeId, 10);
  const operator = norm(options.operator || 'Supervisor');
  const notes = norm(options.notes || 'Resolved by supervisor');

  const reviewItem = db.prepare('SELECT * FROM order_review_queue WHERE id = ?').get(reviewId);
  if (!reviewItem) {
    throw new Error(`Review queue item ID ${reviewId} not found`);
  }

  const targetEmp = db.prepare('SELECT id, name FROM employees WHERE id = ?').get(targetId);
  if (!targetEmp) {
    throw new Error(`Target employee ID ${targetId} not found`);
  }

  const tx = db.transaction(() => {
    // 1. Update order_level_allocations
    db.prepare(`
      UPDATE order_level_allocations
      SET employee_id = ?, employee_name = ?, is_override = 1,
          method = 'Review Queue Resolution',
          rule_note = ?
      WHERE allocation_date = ? AND order_code = ?
    `).run(targetEmp.id, targetEmp.name, notes, reviewItem.work_date, reviewItem.order_code);

    // 2. Mark review queue item as RESOLVED
    db.prepare(`
      UPDATE order_review_queue
      SET review_status = 'RESOLVED',
          resolved_employee_id = ?,
          resolved_employee_name = ?,
          resolved_by = ?,
          resolved_at = datetime('now'),
          resolution_notes = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(targetEmp.id, targetEmp.name, operator, notes, reviewId);

    // 3. Log to account_reassignment_logs
    db.prepare(`
      INSERT INTO account_reassignment_logs (
        work_date, account, previous_employee_id, previous_employee_name,
        new_employee_id, new_employee_name, reassigned_by, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reviewItem.work_date,
      reviewItem.account || 'Unknown',
      reviewItem.previous_employee_id,
      reviewItem.previous_employee_name || 'UNASSIGNED',
      targetEmp.id,
      targetEmp.name,
      operator,
      `[Review Queue Resolution] ${notes}`
    );
  });

  tx();

  return {
    success: true,
    review_id: reviewId,
    order_code: reviewItem.order_code,
    resolved_to: targetEmp.name,
    status: 'RESOLVED'
  };
}
