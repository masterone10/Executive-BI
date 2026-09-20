import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import {
  getEmployeeLifecycleProfile,
  getEmployeeActiveOrders,
  analyzeDepartureImpact,
  executeEmployeeDeparture,
  updateEmployeeStatus,
  getEmployeePreservedHistory,
  getLifecycleAuditLogs,
  getOrderReviewQueue,
  resolveReviewQueueItem
} from '../services/employee_lifecycle.js';
import {
  getComprehensiveWorkingTeamStatus,
  toggleWorkingTeamMember
} from '../services/working_team_ops.js';
import {
  getWorkingTeam,
  reassignAccountOwner
} from '../services/allocation.js';

test('PRODUCTION TEAM OPERATIONS & EMPLOYEE LIFECYCLE AUDIT SUITE', async (t) => {

  const testDate = '2026-09-30';

  // Setup test employees in DB
  const insertEmp = db.prepare(`
    INSERT INTO employees (name, department, active, status, team_membership, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);

  // Clean up any test records
  db.prepare("DELETE FROM daily_working_team WHERE work_date = ?").run(testDate);
  db.prepare("DELETE FROM order_level_allocations WHERE allocation_date = ?").run(testDate);
  db.prepare("DELETE FROM account_owners WHERE work_date = ?").run(testDate);
  db.prepare("DELETE FROM account_reassignment_logs WHERE work_date = ?").run(testDate);
  db.prepare("DELETE FROM vendoor_logs WHERE work_date = ?").run(testDate);
  db.prepare("DELETE FROM raw_log_records WHERE work_date = ?").run(testDate);
  db.prepare("DELETE FROM order_review_queue WHERE work_date = ?").run(testDate);
  db.prepare("DELETE FROM employee_lifecycle_audit WHERE effective_date = ?").run(testDate);
  db.prepare("DELETE FROM employees WHERE name LIKE 'TestLifecycle_%'").run();

  const emp1Info = insertEmp.run('TestLifecycle_EmpDeparting', 'CS', 1, 'ACTIVE', 'Both');
  const emp1Id = emp1Info.lastInsertRowid;

  const emp2Info = insertEmp.run('TestLifecycle_EmpReplacementA', 'CS', 1, 'ACTIVE', 'Both');
  const emp2Id = emp2Info.lastInsertRowid;

  const emp3Info = insertEmp.run('TestLifecycle_EmpReplacementB', 'CS', 1, 'ACTIVE', 'Both');
  const emp3Id = emp3Info.lastInsertRowid;

  await t.test('1. Setup & Baseline Employee Status', () => {
    const profile = getEmployeeLifecycleProfile(emp1Id);
    assert.equal(profile.name, 'TestLifecycle_EmpDeparting');
    assert.equal(profile.active, true);
    assert.equal(profile.status, 'ACTIVE');
  });

  await t.test('2. Seed Historical Evidence (Logs, Orders, Allocations)', () => {
    // Add historical logs for emp1
    db.prepare(`
      INSERT INTO vendoor_logs (
        employee_name, order_code, action, action_classification, is_productive,
        timestamp_str, work_date, matched_employee_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'TestLifecycle_EmpDeparting',
      'ORD-HIST-001',
      'Confirmed Delivery with customer',
      'Confirmation',
      1,
      `${testDate} 10:15:00`,
      testDate,
      emp1Id
    );

    db.prepare(`
      INSERT INTO raw_log_records (
        employee_name, order_code, action, event_datetime, work_date, is_cs, is_deduped
      ) VALUES (?, ?, ?, ?, ?, 1, 1)
    `).run(
      'TestLifecycle_EmpDeparting',
      'ORD-HIST-001',
      'Confirmed Delivery with customer',
      `${testDate} 10:15:00`,
      testDate
    );

    // Set today's working team
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)").run(testDate, emp1Id);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)").run(testDate, emp2Id);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)").run(testDate, emp3Id);

    // Assign active orders to emp1 for account 'BrandAlpha'
    db.prepare(`
      INSERT INTO account_owners (work_date, account, owner_employee_id, owner_employee_name, allocation_method)
      VALUES (?, 'BrandAlpha', ?, 'TestLifecycle_EmpDeparting', 'Auto')
    `).run(testDate, emp1Id);

    db.prepare(`
      INSERT INTO order_level_allocations (
        allocation_date, allocation_version, order_code, account, status, employee_id, employee_name, method
      ) VALUES (?, 1, 'ORD-ACTIVE-101', 'BrandAlpha', 'New', ?, 'TestLifecycle_EmpDeparting', 'Auto')
    `).run(testDate, emp1Id);

    db.prepare(`
      INSERT INTO order_level_allocations (
        allocation_date, allocation_version, order_code, account, status, employee_id, employee_name, method
      ) VALUES (?, 1, 'ORD-ACTIVE-102', 'BrandAlpha', 'Pending', ?, 'TestLifecycle_EmpDeparting', 'Auto')
    `).run(testDate, emp1Id);

    const activeData = getEmployeeActiveOrders(emp1Id, testDate);
    assert.equal(activeData.active_count, 2);
    assert.equal(activeData.owned_accounts.length, 1);
  });

  await t.test('3. Observed Working Team Detection adheres to Invariants', () => {
    const ops = getComprehensiveWorkingTeamStatus(testDate);
    assert.ok(ops.summary.working_team_count >= 3);

    const emp1Ops = ops.team_members.find(m => m.employee_id === emp1Id);
    assert.ok(emp1Ops);
    assert.equal(emp1Ops.is_working, true);
    assert.equal(emp1Ops.is_observed_today, true);
    assert.equal(emp1Ops.total_actions_today, 1);
    assert.equal(emp1Ops.active_orders_count, 2);

    // Absence of logs != proof of absence invariant: emp2 has NO logs but is configured working!
    const emp2Ops = ops.team_members.find(m => m.employee_id === emp2Id);
    assert.ok(emp2Ops);
    assert.equal(emp2Ops.is_working, true);
    assert.equal(emp2Ops.is_observed_today, false);
    assert.ok(emp2Ops.membership_source === 'MANUAL' || emp2Ops.membership_source === 'MANUAL_CONFIGURED');
  });

  await t.test('4. Departure Impact Analysis generates safe proposals', () => {
    const impact = analyzeDepartureImpact(emp1Id, testDate);
    assert.equal(impact.active_orders_count, 2);
    assert.equal(impact.accounts_count, 1);
    assert.ok(impact.safe_reassignments.length > 0);

    const safeReassign = impact.safe_reassignments[0];
    assert.equal(safeReassign.account, 'BrandAlpha');
    assert.equal(safeReassign.order_count, 2);
    assert.ok([emp2Id, emp3Id].includes(safeReassign.target_employee_id));
  });

  await t.test('5. Non-Destructive Departure Execution with Safe Reassignment', () => {
    const result = executeEmployeeDeparture(emp1Id, {
      workDate: testDate,
      departureDate: testDate,
      departureReason: 'Relocated to another office',
      operator: 'Operations Head',
      reassignSafeOrders: true
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'DEPARTED');
    assert.equal(result.reassigned_accounts_count, 1);
    assert.equal(result.reassigned_orders_count, 2);

    // Check Employee Master
    const profileAfter = getEmployeeLifecycleProfile(emp1Id);
    assert.equal(profileAfter.status, 'DEPARTED');
    assert.equal(profileAfter.active, false);
    assert.equal(profileAfter.departure_reason, 'Relocated to another office');

    // Check that working team was zeroed out for departed employee
    const dwtRow = db.prepare("SELECT is_working FROM daily_working_team WHERE work_date = ? AND employee_id = ?").get(testDate, emp1Id);
    assert.equal(dwtRow.is_working, 0);

    // Invariant: Orders in order_level_allocations have been safely transferred to replacement
    const newAllocRows = db.prepare(`
      SELECT order_code, employee_id, employee_name, method
      FROM order_level_allocations
      WHERE allocation_date = ? AND account = 'BrandAlpha'
    `).all(testDate);

    assert.equal(newAllocRows.length, 2);
    assert.notEqual(newAllocRows[0].employee_id, emp1Id);
    assert.equal(newAllocRows[0].method, 'Departure Reassignment');

    // Invariant: Account Owner updated
    const newOwner = db.prepare("SELECT owner_employee_id, allocation_method FROM account_owners WHERE work_date = ? AND account = 'BrandAlpha'").get(testDate);
    assert.notEqual(newOwner.owner_employee_id, emp1Id);
    assert.equal(newOwner.allocation_method, 'Departure Reassignment');

    // Audit Trail Invariant: recorded in account_reassignment_logs
    const reassignmentLogs = db.prepare("SELECT * FROM account_reassignment_logs WHERE work_date = ? AND account = 'BrandAlpha'").all(testDate);
    assert.ok(reassignmentLogs.length > 0);
    assert.equal(reassignmentLogs[0].previous_employee_id, emp1Id);
    assert.equal(reassignmentLogs[0].reassigned_by, 'Operations Head');

    // Audit Trail Invariant: recorded in employee_lifecycle_audit
    const lifecycleAudits = getLifecycleAuditLogs({ employeeId: emp1Id });
    assert.ok(lifecycleAudits.length > 0);
    assert.equal(lifecycleAudits[0].action_type, 'DEPARTURE');
    assert.equal(lifecycleAudits[0].new_status, 'DEPARTED');
    assert.equal(lifecycleAudits[0].affected_orders_count, 2);
  });

  await t.test('6. CRITICAL: Zero Historical Data Loss upon Departure', () => {
    // Check raw logs still intact!
    const rawLogs = db.prepare("SELECT * FROM raw_log_records WHERE employee_name = 'TestLifecycle_EmpDeparting'").all();
    assert.equal(rawLogs.length, 1);
    assert.equal(rawLogs[0].order_code, 'ORD-HIST-001');

    // Check vendoor logs still intact!
    const vLogs = db.prepare("SELECT * FROM vendoor_logs WHERE employee_name = 'TestLifecycle_EmpDeparting'").all();
    assert.equal(vLogs.length, 1);
    assert.equal(vLogs[0].order_code, 'ORD-HIST-001');

    // Check getEmployeePreservedHistory API
    const history = getEmployeePreservedHistory(emp1Id);
    assert.ok(history);
    assert.equal(history.employee.status, 'DEPARTED');
    assert.equal(history.historical_total_actions, 1);
    assert.equal(history.daily_activity_history[0].actions_count, 1);
  });

  await t.test('7. Departed Employee is Ineligible for Future Working Team & Allocation', () => {
    // 1. getWorkingTeam must exclude emp1
    const availableTeam = getWorkingTeam(testDate);
    assert.equal(availableTeam.some(e => e.id === emp1Id), false);

    // 2. toggleWorkingTeamMember must throw error
    assert.throws(() => {
      toggleWorkingTeamMember(testDate, emp1Id, true);
    }, /Cannot add departed employee/);

    // 3. reassignAccountOwner must throw error when assigning to departed employee
    assert.throws(() => {
      reassignAccountOwner(testDate, 'BrandAlpha', emp1Id, 'Attempt assigning to departed');
    }, /Cannot reassign account to departed employee/);
  });

  await t.test('8. Order Review Queue Workflow for Uncertain Orders', () => {
    // Simulate an uncertain order inserted into order_review_queue
    db.prepare(`
      INSERT INTO order_review_queue (
        work_date, order_code, account, current_status, previous_employee_id, previous_employee_name,
        reason_code, reason_detail, review_status
      ) VALUES (?, 'ORD-UNCERTAIN-999', 'ComplexBrand', 'Pending Reassignment', ?, 'TestLifecycle_EmpDeparting',
                'STREAM_MISMATCH', 'Requires dual-stream certification', 'PENDING')
    `).run(testDate, emp1Id);

    const pendingQueue = getOrderReviewQueue({ workDate: testDate, status: 'PENDING' });
    assert.ok(pendingQueue.some(q => q.order_code === 'ORD-UNCERTAIN-999'));

    const item = pendingQueue.find(q => q.order_code === 'ORD-UNCERTAIN-999');

    // Supervisor resolves the uncertain item
    const resolveResult = resolveReviewQueueItem(item.id, emp2Id, {
      operator: 'Lead Supervisor',
      notes: 'Assigned to qualified team member'
    });

    assert.equal(resolveResult.success, true);
    assert.equal(resolveResult.status, 'RESOLVED');

    // Verify review item is now RESOLVED
    const resolvedItem = db.prepare("SELECT * FROM order_review_queue WHERE id = ?").get(item.id);
    assert.equal(resolvedItem.review_status, 'RESOLVED');
    assert.equal(resolvedItem.resolved_employee_id, emp2Id);
    assert.equal(resolvedItem.resolved_by, 'Lead Supervisor');
  });

  // Cleanup
  db.prepare("DELETE FROM daily_working_team WHERE work_date = ?").run(testDate);
  db.prepare("DELETE FROM order_level_allocations WHERE allocation_date = ?").run(testDate);
  db.prepare("DELETE FROM account_owners WHERE work_date = ?").run(testDate);
  db.prepare("DELETE FROM account_reassignment_logs WHERE work_date = ?").run(testDate);
  db.prepare("DELETE FROM vendoor_logs WHERE work_date = ?").run(testDate);
  db.prepare("DELETE FROM raw_log_records WHERE work_date = ?").run(testDate);
  db.prepare("DELETE FROM order_review_queue WHERE work_date = ?").run(testDate);
  db.prepare("DELETE FROM employee_lifecycle_audit WHERE effective_date = ?").run(testDate);
  db.prepare("DELETE FROM employees WHERE name LIKE 'TestLifecycle_%'").run();
});
