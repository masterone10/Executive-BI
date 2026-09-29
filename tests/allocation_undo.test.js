import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { db, DB_PATH } from '../db/index.js';
import {
  executeEnterpriseAllocation,
  planEnterpriseAllocation,
  saveFinalOrderLevelAllocation,
  createPreAllocationSnapshot,
  undoLastAllocation,
  getLatestUndoableAllocationRun
} from '../services/allocation.js';
import { claimOrder, startOrderProgress, completeOrder, logEmployeeActivity } from '../services/tracking.js';

describe('CS Executive BI — Allocation Undo / Reject Current Distribution Suite', () => {
  const TEST_DATE = '2031-03-15';
  let empAhmed = null;
  let empSara = null;
  let empAli = null;
  let empKhaled = null;

  before(() => {
    // Setup clean test employees
    db.prepare("DELETE FROM employees WHERE name LIKE 'UNDO_TEST_%'").run();

    db.prepare(`
      INSERT INTO employees (name, department, active, status, team_membership)
      VALUES ('UNDO_TEST_Ahmed', 'CS', 1, 'ACTIVE', 'Both')
    `).run();
    empAhmed = db.prepare("SELECT * FROM employees WHERE name = 'UNDO_TEST_Ahmed'").get();

    db.prepare(`
      INSERT INTO employees (name, department, active, status, team_membership)
      VALUES ('UNDO_TEST_Sara', 'CS', 1, 'ACTIVE', 'Both')
    `).run();
    empSara = db.prepare("SELECT * FROM employees WHERE name = 'UNDO_TEST_Sara'").get();

    db.prepare(`
      INSERT INTO employees (name, department, active, status, team_membership)
      VALUES ('UNDO_TEST_Ali', 'CS', 1, 'ACTIVE', 'Both')
    `).run();
    empAli = db.prepare("SELECT * FROM employees WHERE name = 'UNDO_TEST_Ali'").get();

    db.prepare(`
      INSERT INTO employees (name, department, active, status, team_membership)
      VALUES ('UNDO_TEST_Khaled', 'CS', 1, 'ACTIVE', 'Both')
    `).run();
    empKhaled = db.prepare("SELECT * FROM employees WHERE name = 'UNDO_TEST_Khaled'").get();
  });

  after(() => {
    // Cleanup
    cleanTestDate(TEST_DATE);
    db.prepare("DELETE FROM employees WHERE name LIKE 'UNDO_TEST_%'").run();
  });

  function cleanTestDate(date) {
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(date);
    db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(date);
    db.prepare('DELETE FROM allocation_headers WHERE allocation_date = ?').run(date);
    db.prepare('DELETE FROM account_owners WHERE work_date = ?').run(date);
    db.prepare('DELETE FROM employee_daily_allocation_states WHERE work_date = ?').run(date);
    db.prepare('DELETE FROM enterprise_allocation_runs WHERE work_date = ?').run(date);
    db.prepare('DELETE FROM allocation_snapshots WHERE work_date = ?').run(date);
    db.prepare('DELETE FROM allocation_undo_logs WHERE work_date = ?').run(date);
    db.prepare('DELETE FROM allocation_decision_audits WHERE work_date = ?').run(date);
    db.prepare('DELETE FROM distribution_fingerprints WHERE work_date = ?').run(date);
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(date);
    db.prepare('DELETE FROM order_tracking WHERE work_date = ?').run(date);
    db.prepare('DELETE FROM order_tracking_events WHERE work_date = ?').run(date);
    db.prepare('DELETE FROM employee_activity_log WHERE work_date = ?').run(date);
  }

  beforeEach(() => {
    cleanTestDate(TEST_DATE);

    // Set working team for TEST_DATE
    const insertTeam = db.prepare(`
      INSERT INTO daily_working_team (work_date, employee_id, is_working, source)
      VALUES (?, ?, 1, 'MANUAL')
    `);
    insertTeam.run(TEST_DATE, empAhmed.id);
    insertTeam.run(TEST_DATE, empSara.id);
    insertTeam.run(TEST_DATE, empAli.id);
    insertTeam.run(TEST_DATE, empKhaled.id);

    // Set capacity limits
    const setCap = db.prepare(`
      INSERT INTO employee_capacities (employee_id, max_orders, updated_by)
      VALUES (?, 100, 'Test')
      ON CONFLICT(employee_id) DO UPDATE SET max_orders = 100
    `);
    setCap.run(empAhmed.id);
    setCap.run(empSara.id);
    setCap.run(empAli.id);
    setCap.run(empKhaled.id);
  });

  test('1 & 5. Exact Pre-Allocation State Restoration (NOT UNASSIGNED)', () => {
    // Initial State:
    // Order A -> UNASSIGNED
    // Order B -> Ahmed
    // Order C -> Sara
    // Order D -> Ali
    const insertOrder = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, source_type, work_state,
        assigned_employee_id, assigned_employee_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertOrder.run(TEST_DATE, 'ORD_A', 'Shop A', 'New', 'NEW', 'UNASSIGNED', null, 'UNASSIGNED');
    insertOrder.run(TEST_DATE, 'ORD_B', 'Shop B', 'New', 'NEW', 'ASSIGNED', empAhmed.id, empAhmed.name);
    insertOrder.run(TEST_DATE, 'ORD_C', 'Shop C', 'Pending', 'PENDING', 'ASSIGNED', empSara.id, empSara.name);
    insertOrder.run(TEST_DATE, 'ORD_D', 'Shop D', 'Pending', 'PENDING', 'ASSIGNED', empAli.id, empAli.name);

    // Perform an allocation that changes assignments
    // e.g. run a fresh enterprise allocation
    const res = executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE' });
    assert.strictEqual(res.success, true);

    // After allocation, check that assignments changed
    const afterOrders = db.prepare('SELECT order_code, assigned_employee_name, work_state FROM current_work_orders WHERE work_date = ?').all(TEST_DATE);
    const ordAAfter = afterOrders.find(o => o.order_code === 'ORD_A');
    assert.notStrictEqual(ordAAfter.work_state, 'UNASSIGNED', 'Order A should have been assigned by allocation');

    // Execute Undo
    const undoRes = undoLastAllocation(TEST_DATE, { reason: 'Reject test allocation' });
    assert.strictEqual(undoRes.success, true);
    assert.strictEqual(undoRes.undone, true);
    assert.ok(undoRes.restored_orders_count > 0);

    // Verify exact pre-allocation restoration
    const restoredOrders = db.prepare('SELECT order_code, assigned_employee_id, assigned_employee_name, work_state FROM current_work_orders WHERE work_date = ?').all(TEST_DATE);
    const ordA = restoredOrders.find(o => o.order_code === 'ORD_A');
    const ordB = restoredOrders.find(o => o.order_code === 'ORD_B');
    const ordC = restoredOrders.find(o => o.order_code === 'ORD_C');
    const ordD = restoredOrders.find(o => o.order_code === 'ORD_D');

    // Rule 5: ORD_A must be UNASSIGNED, ORD_B must be Ahmed, ORD_C must be Sara, ORD_D must be Ali!
    assert.strictEqual(ordA.assigned_employee_id, null);
    assert.strictEqual(ordA.work_state, 'UNASSIGNED');
    assert.strictEqual(ordB.assigned_employee_id, empAhmed.id);
    assert.strictEqual(ordB.work_state, 'ASSIGNED');
    assert.strictEqual(ordC.assigned_employee_id, empSara.id);
    assert.strictEqual(ordC.work_state, 'ASSIGNED');
    assert.strictEqual(ordD.assigned_employee_id, empAli.id);
    assert.strictEqual(ordD.work_state, 'ASSIGNED');
  });

  test('2. Undo does not touch unaffected orders', () => {
    const insertOrder = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, source_type, work_state,
        assigned_employee_id, assigned_employee_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // ORD_UNAFFECTED was already assigned to Khaled and is closed or preserved
    insertOrder.run(TEST_DATE, 'ORD_UNAFFECTED', 'Locked Shop', 'New', 'NEW', 'ASSIGNED', empKhaled.id, empKhaled.name);
    insertOrder.run(TEST_DATE, 'ORD_CHANGE_ME', 'Open Shop', 'New', 'NEW', 'UNASSIGNED', null, 'UNASSIGNED');

    executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE' });

    undoLastAllocation(TEST_DATE);

    const checkUnaffected = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, 'ORD_UNAFFECTED');
    assert.strictEqual(checkUnaffected.assigned_employee_id, empKhaled.id);
    assert.strictEqual(checkUnaffected.assigned_employee_name, empKhaled.name);
  });

  test('3. CLAIMED is preserved after allocation and not overwritten by Undo', () => {
    const insertOrder = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, source_type, work_state,
        assigned_employee_id, assigned_employee_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOrder.run(TEST_DATE, 'ORD_CLAIM_TEST', 'Shop 1', 'New', 'NEW', 'UNASSIGNED', null, 'UNASSIGNED');

    executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE' });

    // Order was assigned to someone. Now employee claims it:
    claimOrder(TEST_DATE, 'ORD_CLAIM_TEST', empSara.id);

    const undoRes = undoLastAllocation(TEST_DATE);
    assert.strictEqual(undoRes.success, true);
    assert.strictEqual(undoRes.protected_orders_count, 1, 'Claimed order must be counted as protected');

    const ord = db.prepare('SELECT work_state, assigned_employee_id FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, 'ORD_CLAIM_TEST');
    assert.strictEqual(ord.work_state, 'CLAIMED', 'Work state MUST stay CLAIMED');
    assert.strictEqual(ord.assigned_employee_id, empSara.id);
  });

  test('4. IN_PROGRESS is preserved after allocation and not overwritten by Undo', () => {
    const insertOrder = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, source_type, work_state,
        assigned_employee_id, assigned_employee_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOrder.run(TEST_DATE, 'ORD_PROG_TEST', 'Shop 1', 'New', 'NEW', 'UNASSIGNED', null, 'UNASSIGNED');

    executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE' });

    // Progress started
    startOrderProgress(TEST_DATE, 'ORD_PROG_TEST', empAhmed.id);

    const undoRes = undoLastAllocation(TEST_DATE);
    assert.strictEqual(undoRes.success, true);
    assert.ok(undoRes.protected_orders_count >= 1);

    const ord = db.prepare('SELECT work_state, assigned_employee_id FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, 'ORD_PROG_TEST');
    assert.strictEqual(ord.work_state, 'IN_PROGRESS');
    assert.strictEqual(ord.assigned_employee_id, empAhmed.id);
  });

  test('5. PRINTED is preserved after allocation', () => {
    const insertOrder = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, source_type, work_state,
        assigned_employee_id, assigned_employee_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOrder.run(TEST_DATE, 'ORD_PRINT_TEST', 'Shop 1', 'New', 'NEW', 'UNASSIGNED', null, 'UNASSIGNED');

    executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE' });

    // Order printed
    db.prepare("UPDATE current_work_orders SET status = 'Printed' WHERE work_date = ? AND order_code = ?").run(TEST_DATE, 'ORD_PRINT_TEST');

    const undoRes = undoLastAllocation(TEST_DATE);
    assert.strictEqual(undoRes.success, true);
    assert.ok(undoRes.protected_orders_count >= 1);

    const ord = db.prepare('SELECT status FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, 'ORD_PRINT_TEST');
    assert.strictEqual(ord.status, 'Printed');
  });

  test('6. COMPLETED is preserved after allocation', () => {
    const insertOrder = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, source_type, work_state,
        assigned_employee_id, assigned_employee_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOrder.run(TEST_DATE, 'ORD_COMP_TEST', 'Shop 1', 'New', 'NEW', 'UNASSIGNED', null, 'UNASSIGNED');

    executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE' });

    // Complete order
    completeOrder(TEST_DATE, 'ORD_COMP_TEST', empAhmed.id);

    const undoRes = undoLastAllocation(TEST_DATE);
    assert.strictEqual(undoRes.success, true);
    assert.ok(undoRes.protected_orders_count >= 1);

    const ord = db.prepare('SELECT work_state, status FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, 'ORD_COMP_TEST');
    assert.strictEqual(ord.work_state, 'COMPLETED');
    assert.strictEqual(ord.status, 'Completed');
  });

  test('7. Manual reassignment after allocation is NOT wiped', () => {
    const insertOrder = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, source_type, work_state,
        assigned_employee_id, assigned_employee_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOrder.run(TEST_DATE, 'ORD_MANUAL_REASSIGN', 'Special Shop', 'New', 'NEW', 'UNASSIGNED', null, 'UNASSIGNED');

    executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE' });

    // Supervisor manually reassigns account / order
    db.prepare(`
      INSERT INTO account_reassignment_logs (
        work_date, account, previous_employee_id, previous_employee_name,
        new_employee_id, new_employee_name, reassigned_by, reason, created_at
      ) VALUES (?, 'Special Shop', ?, 'Prev', ?, 'UNDO_TEST_Khaled', 'Supervisor', 'Manual reassign', datetime('now'))
    `).run(TEST_DATE, empAhmed.id, empKhaled.id);

    db.prepare(`
      UPDATE current_work_orders
      SET assigned_employee_id = ?, assigned_employee_name = 'UNDO_TEST_Khaled'
      WHERE work_date = ? AND order_code = 'ORD_MANUAL_REASSIGN'
    `).run(empKhaled.id, TEST_DATE);

    const undoRes = undoLastAllocation(TEST_DATE);
    assert.strictEqual(undoRes.success, true);

    const ord = db.prepare('SELECT assigned_employee_id, assigned_employee_name FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, 'ORD_MANUAL_REASSIGN');
    assert.strictEqual(ord.assigned_employee_id, empKhaled.id, 'Manually reassigned order must stay with Khaled');
  });

  test('8. Vendoor changes after allocation are NOT wiped', () => {
    const insertOrder = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, source_type, work_state,
        assigned_employee_id, assigned_employee_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOrder.run(TEST_DATE, 'ORD_VENDOOR_CHANGE', 'Shop V', 'New', 'NEW', 'UNASSIGNED', null, 'UNASSIGNED');

    executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE' });

    // Vendoor cancels order after allocation
    db.prepare(`
      UPDATE current_work_orders
      SET status = 'Cancelled', work_state = 'CANCELLED', updated_at = datetime('now')
      WHERE work_date = ? AND order_code = 'ORD_VENDOOR_CHANGE'
    `).run(TEST_DATE);

    logEmployeeActivity({
      work_date: TEST_DATE,
      employee_id: empAhmed.id,
      employee_name: empAhmed.name,
      action: 'CANCELLED',
      order_code: 'ORD_VENDOOR_CHANGE',
      source: 'VENDOOR_SYNC'
    });

    const undoRes = undoLastAllocation(TEST_DATE);
    assert.strictEqual(undoRes.success, true);

    const ord = db.prepare('SELECT status, work_state FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, 'ORD_VENDOOR_CHANGE');
    assert.strictEqual(ord.status, 'Cancelled');
    assert.strictEqual(ord.work_state, 'CANCELLED');
  });

  test('9. Undo twice for the same Run is strictly FORBIDDEN', () => {
    const insertOrder = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, source_type, work_state,
        assigned_employee_id, assigned_employee_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOrder.run(TEST_DATE, 'ORD_TWICE', 'Shop 1', 'New', 'NEW', 'UNASSIGNED', null, 'UNASSIGNED');

    const res = executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE' });
    assert.strictEqual(res.success, true);
    const runId = res.run_id;

    // First undo: MUST succeed
    const undo1 = undoLastAllocation(TEST_DATE, { allocation_run_id: runId });
    assert.strictEqual(undo1.success, true);

    // Second undo: MUST fail
    assert.throws(() => {
      undoLastAllocation(TEST_DATE, { allocation_run_id: runId });
    }, /already been undone/);
  });

  test('10. Undoing an older Run when a newer run exists is strictly FORBIDDEN', () => {
    const insertOrder = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, source_type, work_state,
        assigned_employee_id, assigned_employee_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOrder.run(TEST_DATE, 'ORD_RUN1', 'Shop 1', 'New', 'NEW', 'UNASSIGNED', null, 'UNASSIGNED');
    insertOrder.run(TEST_DATE, 'ORD_RUN2', 'Shop 2', 'New', 'NEW', 'UNASSIGNED', null, 'UNASSIGNED');

    // Run 1
    const run1 = executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE' });

    // Add another order and Run 2
    insertOrder.run(TEST_DATE, 'ORD_RUN3', 'Shop 3', 'Pending', 'PENDING', 'UNASSIGNED', null, 'UNASSIGNED');
    const run2 = executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE' });

    // Attempting to undo Run 1 directly while Run 2 is active: MUST throw
    assert.throws(() => {
      undoLastAllocation(TEST_DATE, { allocation_run_id: run1.run_id });
    }, /Cannot undo older run/);

    // Undoing Run 2: MUST succeed
    const undoRun2 = undoLastAllocation(TEST_DATE, { allocation_run_id: run2.run_id });
    assert.strictEqual(undoRun2.success, true);

    // Now Run 1 is the latest committed non-undone run -> undoing Run 1 now succeeds!
    const undoRun1 = undoLastAllocation(TEST_DATE, { allocation_run_id: run1.run_id });
    assert.strictEqual(undoRun1.success, true);
  });

  test('11. PREVIEW allocations CANNOT be undone', () => {
    const insertOrder = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, source_type, work_state,
        assigned_employee_id, assigned_employee_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOrder.run(TEST_DATE, 'ORD_PREV', 'Shop 1', 'New', 'NEW', 'UNASSIGNED', null, 'UNASSIGNED');

    const previewPlan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW');
    assert.strictEqual(previewPlan.mode, 'PREVIEW');

    // Record as preview run in table
    db.prepare(`
      INSERT INTO enterprise_allocation_runs (
        run_id, work_date, trigger, mode, allocation_type, status,
        context_hash, started_at, created_at
      ) VALUES (?, ?, 'PREVIEW', 'PREVIEW', 'BATCH', 'PREVIEW_GENERATED', 'ctx', datetime('now'), datetime('now'))
    `).run(previewPlan.run_id, TEST_DATE);

    // Attempt to undo preview: MUST throw error
    assert.throws(() => {
      undoLastAllocation(TEST_DATE, { allocation_run_id: previewPlan.run_id });
    }, /PREVIEW/);
  });

  test('12. Forced failure performs 100% full transaction rollback with ZERO side effects', () => {
    const insertOrder = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, source_type, work_state,
        assigned_employee_id, assigned_employee_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOrder.run(TEST_DATE, 'ORD_FAIL_TEST', 'Shop 1', 'New', 'NEW', 'UNASSIGNED', null, 'UNASSIGNED');

    const run = executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE' });

    // Capture state before failed undo
    const orderBefore = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, 'ORD_FAIL_TEST');
    const runBefore = db.prepare('SELECT status FROM enterprise_allocation_runs WHERE run_id = ?').get(run.run_id);
    assert.strictEqual(runBefore.status, 'COMMITTED');

    // Call undo with forceFailForTest
    assert.throws(() => {
      undoLastAllocation(TEST_DATE, { allocation_run_id: run.run_id, forceFailForTest: true });
    }, /FORCED_FAILURE_FOR_TEST_ROLLBACK_VERIFICATION/);

    // Verify database state is 100% unchanged
    const orderAfter = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, 'ORD_FAIL_TEST');
    const runAfter = db.prepare('SELECT status FROM enterprise_allocation_runs WHERE run_id = ?').get(run.run_id);

    assert.strictEqual(orderAfter.assigned_employee_id, orderBefore.assigned_employee_id);
    assert.strictEqual(orderAfter.work_state, orderBefore.work_state);
    assert.strictEqual(runAfter.status, 'COMMITTED', 'Run status must still be COMMITTED due to rollback');
  });

  test('13. No duplicates after Undo', () => {
    const insertOrder = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, source_type, work_state,
        assigned_employee_id, assigned_employee_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOrder.run(TEST_DATE, 'ORD_DUP_1', 'Shop D1', 'New', 'NEW', 'UNASSIGNED', null, 'UNASSIGNED');
    insertOrder.run(TEST_DATE, 'ORD_DUP_2', 'Shop D2', 'Pending', 'PENDING', 'UNASSIGNED', null, 'UNASSIGNED');

    executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE' });
    undoLastAllocation(TEST_DATE);

    // Check current_work_orders uniqueness
    const orderCodes = db.prepare('SELECT order_code, COUNT(*) as c FROM current_work_orders WHERE work_date = ? GROUP BY order_code HAVING c > 1').all(TEST_DATE);
    assert.strictEqual(orderCodes.length, 0, 'Zero duplicate order codes');

    // Check account_owners uniqueness
    const accOwners = db.prepare('SELECT account, COUNT(*) as c FROM account_owners WHERE work_date = ? GROUP BY account HAVING c > 1').all(TEST_DATE);
    assert.strictEqual(accOwners.length, 0, 'Zero duplicate account owners');
  });

  test('14. Allocation counters return to correct pre-allocation numbers', () => {
    const insertOrder = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, source_type, work_state,
        assigned_employee_id, assigned_employee_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOrder.run(TEST_DATE, 'ORD_CNT_1', 'Shop 1', 'New', 'NEW', 'UNASSIGNED', null, 'UNASSIGNED');
    insertOrder.run(TEST_DATE, 'ORD_CNT_2', 'Shop 2', 'New', 'NEW', 'ASSIGNED', empAhmed.id, empAhmed.name);

    const initialUnassigned = db.prepare("SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ? AND work_state = 'UNASSIGNED'").get(TEST_DATE).c;
    const initialAssigned = db.prepare("SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ? AND work_state != 'UNASSIGNED'").get(TEST_DATE).c;

    executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE' });
    undoLastAllocation(TEST_DATE);

    const afterUnassigned = db.prepare("SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ? AND work_state = 'UNASSIGNED'").get(TEST_DATE).c;
    const afterAssigned = db.prepare("SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ? AND work_state != 'UNASSIGNED'").get(TEST_DATE).c;

    assert.strictEqual(afterUnassigned, initialUnassigned);
    assert.strictEqual(afterAssigned, initialAssigned);
  });

  test('15. Employee workload & sequence return to previous state', () => {
    const insertOrder = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, source_type, work_state,
        assigned_employee_id, assigned_employee_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOrder.run(TEST_DATE, 'ORD_WL_1', 'Shop 1', 'Pending', 'PENDING', 'UNASSIGNED', null, 'UNASSIGNED');

    // Pre-state
    db.prepare(`
      INSERT INTO employee_daily_allocation_states (work_date, employee_id, pending_sequence, new_event_consumed)
      VALUES (?, ?, 2, 0)
    `).run(TEST_DATE, empSara.id);

    executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE' });

    undoLastAllocation(TEST_DATE);

    const empState = db.prepare('SELECT pending_sequence, new_event_consumed FROM employee_daily_allocation_states WHERE work_date = ? AND employee_id = ?').get(TEST_DATE, empSara.id);
    assert.strictEqual(empState.pending_sequence, 2, 'Pending sequence must be restored to 2');
    assert.strictEqual(empState.new_event_consumed, 0);
  });

  test('16. Account ownership returns to previous state', () => {
    // Before allocation, Shop X was owned by Ahmed
    db.prepare(`
      INSERT INTO account_owners (work_date, account, owner_employee_id, owner_employee_name, allocation_version)
      VALUES (?, 'Shop X', ?, ?, 1)
    `).run(TEST_DATE, empAhmed.id, empAhmed.name);

    const insertOrder = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, source_type, work_state,
        assigned_employee_id, assigned_employee_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOrder.run(TEST_DATE, 'ORD_OWN_1', 'Shop X', 'New', 'NEW', 'UNASSIGNED', null, 'UNASSIGNED');

    executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE' });

    undoLastAllocation(TEST_DATE);

    const owner = db.prepare('SELECT owner_employee_id, owner_employee_name FROM account_owners WHERE work_date = ? AND account = ?').get(TEST_DATE, 'Shop X');
    assert.strictEqual(owner.owner_employee_id, empAhmed.id);
    assert.strictEqual(owner.owner_employee_name, empAhmed.name);
  });

  test('17. Allocation history remains preserved for Audit purposes', () => {
    const insertOrder = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, source_type, work_state,
        assigned_employee_id, assigned_employee_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOrder.run(TEST_DATE, 'ORD_AUDIT_1', 'Shop 1', 'New', 'NEW', 'UNASSIGNED', null, 'UNASSIGNED');

    const res = executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE' });
    const undoRes = undoLastAllocation(TEST_DATE, { reason: 'Audit test reason', operator: 'AuditSupervisor' });

    // Enterprise allocation run record is still present with status UNDONE
    const run = db.prepare('SELECT status, block_reason FROM enterprise_allocation_runs WHERE run_id = ?').get(res.run_id);
    assert.strictEqual(run.status, 'UNDONE');
    assert.ok(run.block_reason.includes('AuditSupervisor'));

    // Allocation undo log is recorded
    const undoLog = db.prepare('SELECT * FROM allocation_undo_logs WHERE id = ?').get(undoRes.audit_id);
    assert.ok(undoLog);
    assert.strictEqual(undoLog.allocation_run_id, res.run_id);
    assert.strictEqual(undoLog.generated_by, 'AuditSupervisor');
    assert.strictEqual(undoLog.result, 'SUCCESS');

    // Decision audits contain ALLOCATION_UNDO
    const decisionAudit = db.prepare("SELECT * FROM allocation_decision_audits WHERE run_id = ? AND reason_code = 'ALLOCATION_UNDO'").get(res.run_id);
    assert.ok(decisionAudit);
  });

  test('18. Server restart / reconnection does NOT lose ability to Undo the latest Run', () => {
    const insertOrder = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, source_type, work_state,
        assigned_employee_id, assigned_employee_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOrder.run(TEST_DATE, 'ORD_PERSIST_1', 'Shop 1', 'New', 'NEW', 'UNASSIGNED', null, 'UNASSIGNED');

    const allocRes = executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE' });
    assert.strictEqual(allocRes.success, true);
    const runId = allocRes.run_id;

    // Simulate server restart by creating a completely separate new Database connection to DB_PATH
    const freshDb = new Database(DB_PATH);
    try {
      const persistedRun = freshDb.prepare("SELECT * FROM enterprise_allocation_runs WHERE run_id = ? AND status = 'COMMITTED'").get(runId);
      assert.ok(persistedRun, 'Committed run is preserved in SQLite across sessions');

      const persistedSnapshot = freshDb.prepare('SELECT * FROM allocation_snapshots WHERE run_id = ?').get(runId);
      assert.ok(persistedSnapshot, 'Pre-allocation snapshot is preserved in SQLite across sessions');

      // Execute undo using main service (which reads SQLite directly)
      const undoRes = undoLastAllocation(TEST_DATE, { allocation_run_id: runId });
      assert.strictEqual(undoRes.success, true);
      assert.strictEqual(undoRes.undone, true);

      // Verify order restored to unassigned in freshDb
      const restoredInFresh = freshDb.prepare('SELECT work_state, assigned_employee_id FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, 'ORD_PERSIST_1');
      assert.strictEqual(restoredInFresh.work_state, 'UNASSIGNED');
      assert.strictEqual(restoredInFresh.assigned_employee_id, null);
    } finally {
      freshDb.close();
    }
  });
});
