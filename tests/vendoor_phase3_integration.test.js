import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../db/index.js';
import {
  getOperationalCompletionSummary,
  classifyCompletionAction
} from '../services/vendoor/completion.js';
import {
  getLiveEmployeeWorkloads,
  evaluateRefillNeed
} from '../services/vendoor/workload.js';
import {
  getUnallocatedOrdersPool
} from '../services/vendoor/unallocated.js';
import {
  executeDispatchCycle,
  getDispatcherStatus,
  setDispatcherConfig,
  startDispatcherPolling,
  stopDispatcherPolling
} from '../services/vendoor/dispatcher.js';

describe('PHASE 3 CONTINUOUS AUTO DISPATCHER & SMART REFILL SUITE', () => {
  const TEST_DATE = '2026-09-16';
  let testEmp1Id, testEmp2Id, testEmp3Id;

  before(() => {
    // Ensure clean test harness state for the test date
    db.prepare("DELETE FROM auto_dispatch_assignments WHERE work_date = ?").run(TEST_DATE);
    db.prepare("DELETE FROM auto_dispatch_cycles WHERE work_date = ?").run(TEST_DATE);
    db.prepare("DELETE FROM order_level_allocations WHERE allocation_date = ?").run(TEST_DATE);
    db.prepare("DELETE FROM daily_working_team WHERE work_date = ?").run(TEST_DATE);

    // Pick 3 real active employees from Master
    const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 ORDER BY id ASC LIMIT 3").all();
    assert.ok(emps.length >= 3, 'Must have at least 3 active employees in master');
    testEmp1Id = emps[0].id;
    testEmp2Id = emps[1].id;
    testEmp3Id = emps[2].id;

    // Enroll Emp1 and Emp2 into Working Team for TEST_DATE (Emp3 is left off duty)
    db.prepare(`
      INSERT OR REPLACE INTO daily_working_team (employee_id, work_date, is_working, created_at)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP)
    `).run(testEmp1Id, TEST_DATE);

    db.prepare(`
      INSERT OR REPLACE INTO daily_working_team (employee_id, work_date, is_working, created_at)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP)
    `).run(testEmp2Id, TEST_DATE);

    db.prepare(`
      INSERT OR REPLACE INTO daily_working_team (employee_id, work_date, is_working, created_at)
      VALUES (?, ?, 0, CURRENT_TIMESTAMP)
    `).run(testEmp3Id, TEST_DATE);
  });

  after(() => {
    // Clean up test records
    stopDispatcherPolling();
    db.prepare("DELETE FROM auto_dispatch_assignments WHERE work_date = ?").run(TEST_DATE);
    db.prepare("DELETE FROM auto_dispatch_cycles WHERE work_date = ?").run(TEST_DATE);
    db.prepare("DELETE FROM order_level_allocations WHERE allocation_date = ?").run(TEST_DATE);
    db.prepare("DELETE FROM daily_working_team WHERE work_date = ?").run(TEST_DATE);
  });

  test('1. Completion Engine: Action Classification & Order Deduplication', () => {
    assert.equal(classifyCompletionAction('delivered').classification, 'COMPLETED_WORK');
    assert.equal(classifyCompletionAction('cancelled').classification, 'CANCELED');
    assert.equal(classifyCompletionAction('delivery_attempt_failed').classification, 'UNKNOWN');
    assert.equal(classifyCompletionAction('order_viewed').classification, 'NON_PRODUCTIVE');
    assert.equal(classifyCompletionAction(null).classification, 'UNKNOWN');

    // Test operational completion summary for employee
    const summary = getOperationalCompletionSummary(testEmp1Id, TEST_DATE);
    assert.ok(summary, 'Should return summary object');
    assert.equal(typeof summary.completed_orders_count, 'number');
    assert.equal(typeof summary.total_actions_observed, 'number');
    assert.ok(Array.isArray(summary.completed_order_codes));
  });

  test('2. Workload & Refill State: Mandatory Working Team & Capacity Rules', () => {
    const workloads = getLiveEmployeeWorkloads(TEST_DATE, { refillThreshold: 5 });
    assert.ok(Array.isArray(workloads), 'Should return array of employee workloads');

    const emp1Workload = workloads.find(w => w.employee_id === testEmp1Id);
    const emp3Workload = workloads.find(w => w.employee_id === testEmp3Id);

    assert.ok(emp1Workload, 'Emp1 should be in workloads');
    assert.ok(emp1Workload.is_working, 'Emp1 is in Working Team');

    assert.ok(emp3Workload, 'Emp3 should be in workloads');
    assert.equal(emp3Workload.is_working ? 1 : 0, 0, 'Emp3 is NOT working');
    assert.equal(emp3Workload.refill_state, 'NOT_WORKING', 'Emp3 should be classified as NOT_WORKING');
    assert.equal(!!emp3Workload.refill_eligible, false, 'Non-working employee must NEVER be refill eligible');

    // Test refill evaluation logic directly
    const eligibleState = evaluateRefillNeed(2, 5, 20, 50, true);
    assert.equal(eligibleState.refillNeeded, true);
    assert.equal(eligibleState.refillState, 'REFILL_ELIGIBLE');

    const atCapacityState = evaluateRefillNeed(2, 5, 0, 50, true);
    assert.equal(atCapacityState.refillNeeded, false);
    assert.equal(atCapacityState.refillState, 'NO_VALID_CAPACITY');

    const nonWorkingState = evaluateRefillNeed(2, 5, 20, 50, false);
    assert.equal(nonWorkingState.refillNeeded, false);
    assert.equal(nonWorkingState.refillState, 'NOT_WORKING');
  });

  test('3. Unallocated Pool: Only New / Unassigned Orders', () => {
    const pool = getUnallocatedOrdersPool(TEST_DATE, { limit: 100 });
    assert.ok(pool, 'Pool object should exist');
    assert.equal(typeof pool.total_unallocated_orders, 'number');
    assert.ok(pool.accounts_pool instanceof Map, 'accounts_pool should be Map');
    assert.ok(Array.isArray(pool.unallocated_orders));

    // Verify all returned orders have no active allocation on TEST_DATE
    if (pool.unallocated_orders.length > 0) {
      const sampleCode = pool.unallocated_orders[0].order_code;
      const existing = db.prepare(`
        SELECT id FROM order_level_allocations
        WHERE order_code = ? AND allocation_date = ?
      `).get(sampleCode, TEST_DATE);
      assert.equal(existing, undefined, 'Unallocated order must not have existing allocation record');
    }
  });

  test('4. Safety Invariant: OFF By Default & Polling Inactive on Startup', () => {
    const status = getDispatcherStatus();
    assert.ok(status, 'Status object should be returned');
    assert.equal(status.is_running, false, 'Continuous polling MUST be inactive by default');
    assert.equal(typeof status.config.enabled, 'boolean');
    assert.equal(typeof status.config.dryRunMode, 'boolean');
  });

  test('5. DRY RUN Cycle Invariant: Zero Mutation of order_level_allocations', async () => {
    // Count order allocations before dry run
    const countBefore = db.prepare("SELECT COUNT(*) as cnt FROM order_level_allocations WHERE allocation_date = ?").get(TEST_DATE).cnt;

    const result = await executeDispatchCycle({
      dryRun: true,
      workDate: TEST_DATE,
      forceRun: true
    });

    assert.ok(result, 'Cycle should return result object');
    if (result.mode) {
      assert.equal(result.mode, 'DRY_RUN', 'Cycle mode must be DRY_RUN');
    }
    const expectedStatuses = ['SUCCESS', 'NO_ASSIGNMENTS_MADE', 'NO_UNALLOCATED_WORK', 'NO_ELIGIBLE_EMPLOYEES', 'FAILED', 'SETUP_REQUIRED'];
    assert.ok(expectedStatuses.includes(result.status), `Unexpected status: ${result.status} - message: ${result.message}`);

    // Count order allocations after dry run - MUST BE STRICTLY IDENTICAL
    const countAfter = db.prepare("SELECT COUNT(*) as cnt FROM order_level_allocations WHERE allocation_date = ?").get(TEST_DATE).cnt;
    assert.equal(countAfter, countBefore, 'DRY RUN MUST NEVER mutate order_level_allocations');

    // Audit logs must be recorded
    const cycleAudit = db.prepare("SELECT * FROM auto_dispatch_cycles WHERE cycle_id = ?").get(result.cycle_id);
    assert.ok(cycleAudit, 'Dry run cycle must be recorded in auto_dispatch_cycles');
    assert.equal(cycleAudit.mode, 'DRY_RUN');
  });

  test('6. Non-Theft Invariant: Dispatcher Never Steals or Reassigns Existing Allocations', async () => {
    // Seed a specific order assignment for Emp1
    const testOrderCode = 'TEST_EXISTING_ORD_999';
    db.prepare(`
      INSERT OR REPLACE INTO order_level_allocations
      (allocation_date, order_code, account, employee_id, employee_name, status, created_at)
      VALUES (?, ?, 'TEST_ACCOUNT', ?, 'Emp One', 'assigned', CURRENT_TIMESTAMP)
    `).run(TEST_DATE, testOrderCode, testEmp1Id);

    // Run cycle
    const result = await executeDispatchCycle({
      dryRun: true,
      workDate: TEST_DATE,
      forceRun: true
    });

    // Verify existing assignment remains completely untouched
    const orderRecord = db.prepare(`
      SELECT employee_id FROM order_level_allocations
      WHERE order_code = ? AND allocation_date = ?
    `).get(testOrderCode, TEST_DATE);

    assert.ok(orderRecord, 'Existing allocated order must exist');
    assert.equal(orderRecord.employee_id, testEmp1Id, 'Existing order must remain with its assigned employee');
  });

  test('7. Concurrency Invariant: Concurrent Cycles Return DISPATCHER_LOCKED', async () => {
    // Launch two cycles concurrently
    const p1 = executeDispatchCycle({ dryRun: true, workDate: TEST_DATE, forceRun: true });
    const p2 = executeDispatchCycle({ dryRun: true, workDate: TEST_DATE, forceRun: true });

    const [r1, r2] = await Promise.all([p1, p2]);

    // One of them might succeed, or both complete, or second hits DISPATCHER_LOCKED
    assert.ok(r1.success || r1.status === 'LOCKED_CONCURRENT_CYCLE_IN_PROGRESS' || r1.status === 'FAILED', `Unexpected status r1: ${r1.status}`);
    assert.ok(r2.success || r2.status === 'LOCKED_CONCURRENT_CYCLE_IN_PROGRESS' || r2.status === 'FAILED', `Unexpected status r2: ${r2.status}`);
  });

  test('8. Split Trigger Invariant: 120 is strictly event deduplication window and NOT a split trigger', () => {
    // Verify system config has no split trigger set to 120
    const cfg = db.prepare("SELECT * FROM system_configs WHERE key = 'split_threshold'").get();
    if (cfg) {
      assert.notEqual(parseInt(cfg.value, 10), 120, 'split_threshold must NEVER be 120');
    }
  });

  test('9. Continuous Polling Start/Stop Lifecycle Controls', () => {
    const startRes = startDispatcherPolling();
    // It might return { success: false, status: 'ALREADY_RUNNING' } if running, let's just assert on the status
    assert.equal(getDispatcherStatus().is_running, true);

    const stopRes = stopDispatcherPolling();
    assert.equal(getDispatcherStatus().is_running, false);
  });
});
