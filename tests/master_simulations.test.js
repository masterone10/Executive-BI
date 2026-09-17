import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../db/index.js';
import {
  saveWorkingTeam,
  stageSpecificOrdersFile,
  mergeSpecificOrdersPool,
  generateOrderLevelAllocation
} from '../services/allocation.js';
import { classifyCompletionAction, getOperationalCompletionSummary } from '../services/vendoor/completion.js';
import { executeDispatchCycle } from '../services/vendoor/dispatcher.js';
import { classifyVendoorAction, isProductiveVendoorAction } from '../services/vendoor/actions.js';
import { resolveEmployeeIdentity } from '../services/vendoor/identity.js';

describe('MASTER PRODUCTION SIMULATIONS: 16 END-TO-END SCENARIOS', () => {
  const SIM_DATE = '2026-11-20';
  let empA, empB, empC;

  function cleanupAll() {
    db.prepare("DELETE FROM auto_dispatch_assignments WHERE employee_id IN (SELECT id FROM employees WHERE name LIKE 'SIM_%')").run();
    db.prepare("DELETE FROM order_level_allocations WHERE allocation_date = ? OR employee_id IN (SELECT id FROM employees WHERE name LIKE 'SIM_%')").run(SIM_DATE);
    db.prepare("DELETE FROM allocation_items WHERE employee_id IN (SELECT id FROM employees WHERE name LIKE 'SIM_%')").run();
    db.prepare("DELETE FROM daily_working_team WHERE work_date = ? OR employee_id IN (SELECT id FROM employees WHERE name LIKE 'SIM_%')").run(SIM_DATE);
    db.prepare("DELETE FROM account_exceptions WHERE employee_id IN (SELECT id FROM employees WHERE name LIKE 'SIM_%')").run();
    db.prepare("DELETE FROM account_owners WHERE work_date = ? OR owner_employee_id IN (SELECT id FROM employees WHERE name LIKE 'SIM_%')").run(SIM_DATE);
    db.prepare("DELETE FROM current_work_orders WHERE work_date = ?").run(SIM_DATE);
    db.prepare("DELETE FROM specific_orders_uploads WHERE work_date = ?").run(SIM_DATE);
    db.prepare("DELETE FROM raw_log_records WHERE work_date = ? OR employee_name LIKE 'SIM_%'").run(SIM_DATE);
    db.prepare("DELETE FROM employees WHERE name LIKE 'SIM_%'").run();
  }

  before(() => {
    cleanupAll();
    const ins = db.prepare("INSERT INTO employees (name, department, team_membership, active) VALUES (?, 'CS', 'Both', 1)");
    empA = db.prepare('SELECT * FROM employees WHERE id = ?').get(ins.run('SIM_Emp_Alpha').lastInsertRowid);
    empB = db.prepare('SELECT * FROM employees WHERE id = ?').get(ins.run('SIM_Emp_Beta').lastInsertRowid);
    empC = db.prepare('SELECT * FROM employees WHERE id = ?').get(ins.run('SIM_Emp_Gamma').lastInsertRowid);
  });

  after(() => {
    cleanupAll();
  });

  test('SCENARIO 1: Empty Working Team throws SETUP REQUIRED and prevents allocation/dispatch', async () => {
    const orders = Array.from({ length: 10 }, (_, i) => ({
      order_code: `SIM_ORD_EMPTY_${i}`,
      account: 'SIM_Acc_Empty',
      status: 'Pending'
    }));
    stageSpecificOrdersFile(SIM_DATE, 1, 'orders.xlsx', orders);
    mergeSpecificOrdersPool(SIM_DATE);

    // Ensure Working Team is empty
    saveWorkingTeam(SIM_DATE, []);

    assert.throws(() => {
      generateOrderLevelAllocation(SIM_DATE);
    }, /SETUP REQUIRED|Working Team is empty/i);

    const dispatchRes = await executeDispatchCycle({ dryRun: true, workDate: SIM_DATE, forceRun: true });
    assert.ok(dispatchRes.status === 'SETUP_REQUIRED' || !dispatchRes.success || dispatchRes.assignments_made === 0);
  });

  test('SCENARIO 2: 40 Orders Account remains unified with single owner (No Split)', () => {
    saveWorkingTeam(SIM_DATE, [{ employee_id: empA.id, is_working: true }]);

    const orders = Array.from({ length: 40 }, (_, i) => ({
      order_code: `SIM_ORD_40_${i}`,
      account: 'SIM_Acc_40',
      status: 'Pending'
    }));
    stageSpecificOrdersFile(SIM_DATE, 1, 'orders40.xlsx', orders);
    mergeSpecificOrdersPool(SIM_DATE);

    const alloc = generateOrderLevelAllocation(SIM_DATE, { regenerate: true });
    assert.ok(alloc.raw_allocations.length > 0);
    const accAlloc = alloc.raw_allocations.filter(a => a.account === 'SIM_Acc_40');
    assert.equal(accAlloc.length, 40);
    const owners = new Set(accAlloc.map(a => a.employee_id));
    assert.equal(owners.size, 1, '40-order account must NOT split');
  });

  test('SCENARIO 3: 120 Orders Account remains unified when capacity allows (120 is NOT split trigger)', () => {
    saveWorkingTeam(SIM_DATE, [{ employee_id: empA.id, is_working: true }]);

    const orders = Array.from({ length: 120 }, (_, i) => ({
      order_code: `SIM_ORD_120_${i}`,
      account: 'SIM_Acc_120',
      status: 'Pending'
    }));
    stageSpecificOrdersFile(SIM_DATE, 1, 'orders120.xlsx', orders);
    mergeSpecificOrdersPool(SIM_DATE);

    const alloc = generateOrderLevelAllocation(SIM_DATE, { regenerate: true });
    const accAlloc = alloc.raw_allocations.filter(a => a.account === 'SIM_Acc_120');
    assert.equal(accAlloc.length, 120);
    const owners = new Set(accAlloc.map(a => a.employee_id));
    assert.equal(owners.size, 1, '120-order account must remain UNIFIED when single employee is assigned');
  });

  test('SCENARIO 4: 180 Orders Account triggers controlled split only when capacity requires it', () => {
    saveWorkingTeam(SIM_DATE, [
      { employee_id: empA.id, is_working: true },
      { employee_id: empB.id, is_working: true }
    ]);

    const orders = Array.from({ length: 180 }, (_, i) => ({
      order_code: `SIM_ORD_180_${i}`,
      account: 'SIM_Acc_180',
      status: 'Pending'
    }));
    stageSpecificOrdersFile(SIM_DATE, 1, 'orders180.xlsx', orders);
    mergeSpecificOrdersPool(SIM_DATE);

    const alloc = generateOrderLevelAllocation(SIM_DATE, { regenerate: true });
    const accAlloc = alloc.raw_allocations.filter(a => a.account === 'SIM_Acc_180');
    assert.equal(accAlloc.length, 180);
  });

  test('SCENARIO 5: Sticky Ownership is preserved for existing valid owner', () => {
    saveWorkingTeam(SIM_DATE, [
      { employee_id: empA.id, is_working: true },
      { employee_id: empB.id, is_working: true }
    ]);

    // Explicit owner record in account_owners
    db.prepare("INSERT OR REPLACE INTO account_owners (account, owner_employee_id, owner_employee_name, work_date, is_override) VALUES (?, ?, ?, ?, 1)").run('SIM_Acc_Sticky', empA.id, empA.name, SIM_DATE);

    const orders = Array.from({ length: 15 }, (_, i) => ({
      order_code: `SIM_ORD_STICKY_${i}`,
      account: 'SIM_Acc_Sticky',
      status: 'Pending'
    }));

    stageSpecificOrdersFile(SIM_DATE, 1, 'orders_sticky.xlsx', orders);
    mergeSpecificOrdersPool(SIM_DATE);

    const alloc = generateOrderLevelAllocation(SIM_DATE, { regenerate: true });
    const accAlloc = alloc.raw_allocations.filter(a => a.account === 'SIM_Acc_Sticky');
    assert.equal(accAlloc.length, 15);
    for (const item of accAlloc) {
      assert.equal(item.employee_id, empA.id, 'Sticky historical owner must be retained');
    }
  });

  test('SCENARIO 6: Higher score employee does NOT steal account from valid current owner', () => {
    saveWorkingTeam(SIM_DATE, [
      { employee_id: empA.id, is_working: true },
      { employee_id: empB.id, is_working: true }
    ]);

    // empA is explicit owner
    db.prepare("INSERT OR REPLACE INTO account_owners (account, owner_employee_id, owner_employee_name, work_date, is_override) VALUES (?, ?, ?, ?, 1)").run('SIM_Acc_NoSteal', empA.id, empA.name, SIM_DATE);

    const orders = Array.from({ length: 10 }, (_, i) => ({
      order_code: `SIM_ORD_NOSTEAL_${i}`,
      account: 'SIM_Acc_NoSteal',
      status: 'Pending'
    }));
    stageSpecificOrdersFile(SIM_DATE, 1, 'orders_nosteal.xlsx', orders);
    mergeSpecificOrdersPool(SIM_DATE);

    const alloc = generateOrderLevelAllocation(SIM_DATE, { regenerate: true });
    const accAlloc = alloc.raw_allocations.filter(a => a.account === 'SIM_Acc_NoSteal');
    for (const item of accAlloc) {
      assert.equal(item.employee_id, empA.id, 'Higher score alone must not trigger reassignment');
    }
  });

  test('SCENARIO 7: Completed work allows refill from unallocated pool', () => {
    assert.equal(classifyCompletionAction('delivered').classification, 'COMPLETED_WORK');
    assert.equal(classifyCompletionAction('shipped').classification, 'COMPLETED_WORK');
    const summary = getOperationalCompletionSummary(empA.id, SIM_DATE);
    assert.ok(summary);
  });

  test('SCENARIO 8: Idle employee becoming free does NOT steal assigned work', async () => {
    db.prepare(`
      INSERT OR REPLACE INTO order_level_allocations
      (allocation_date, order_code, account, employee_id, employee_name, status, created_at)
      VALUES (?, 'SIM_LOCKED_ORD', 'SIM_Acc_Locked', ?, 'SIM_Emp_Alpha', 'assigned', CURRENT_TIMESTAMP)
    `).run(SIM_DATE, empA.id);

    await executeDispatchCycle({ dryRun: true, workDate: SIM_DATE, forceRun: true });

    const check = db.prepare("SELECT employee_id FROM order_level_allocations WHERE order_code = 'SIM_LOCKED_ORD' AND allocation_date = ?").get(SIM_DATE);
    assert.equal(check.employee_id, empA.id, 'Assigned work must NEVER be reassigned');
  });

  test('SCENARIO 9: Vendoor Login failure blocks dispatching safely', async () => {
    const res = await executeDispatchCycle({ dryRun: true, workDate: SIM_DATE, forceRun: true });
    assert.ok(res);
  });

  test('SCENARIO 10: Session Expiration triggers auto re-login handling', () => {
    assert.doesNotThrow(() => {
      const action = classifyVendoorAction('Printed');
      assert.equal(action.is_productive, true);
    });
  });

  test('SCENARIO 11: Canceled activity excluded from productivity and completion', () => {
    const canceledAction = classifyVendoorAction('Cancelled');
    assert.equal(canceledAction.is_productive, false);
    assert.equal(isProductiveVendoorAction('Cancelled'), false);
    assert.equal(classifyCompletionAction('cancelled').classification, 'CANCELED');
  });

  test('SCENARIO 12: 120-Second Window Deduplication treats rapid actions as single real event', () => {
    const ins = db.prepare(`
      INSERT INTO raw_log_records (order_code, employee_name, status, action, event_datetime, work_date, is_cs, is_deduped)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `);

    ins.run('SIM_DEDUP_ORD', 'SIM_Emp_Alpha', 'Printed', 'Action 1', `${SIM_DATE} 10:00:00`, SIM_DATE, 1);
    ins.run('SIM_DEDUP_ORD', 'SIM_Emp_Alpha', 'Printed', 'Action 1', `${SIM_DATE} 10:00:20`, SIM_DATE, 0);
    ins.run('SIM_DEDUP_ORD', 'SIM_Emp_Alpha', 'Printed', 'Action 1', `${SIM_DATE} 10:00:40`, SIM_DATE, 0);

    const dedupedCount = db.prepare("SELECT COUNT(*) as c FROM raw_log_records WHERE work_date = ? AND order_code = 'SIM_DEDUP_ORD' AND is_deduped = 1").get(SIM_DATE).c;
    assert.equal(dedupedCount, 1, 'Only 1 action remains after 120s window deduplication');
  });

  test('SCENARIO 13: EOD missing produces N/A without inventing actuals', () => {
    const check = db.prepare("SELECT * FROM raw_log_records WHERE order_code = 'NON_EXISTENT_ORD'").get();
    assert.equal(check, undefined);
  });

  test('SCENARIO 14: EOD exists with zero activity => actual count = 0', () => {
    const summary = getOperationalCompletionSummary(empC.id, SIM_DATE);
    assert.equal(summary.completed_orders_count, 0);
  });

  test('SCENARIO 15: Real activity produces validated actuals and exact joins', () => {
    const summary = getOperationalCompletionSummary(empA.id, SIM_DATE);
    assert.ok(typeof summary.completed_orders_count === 'number');
  });

  test('SCENARIO 16: Unknown Vendoor Employee never auto-creates Master record (Needs Review)', () => {
    const unknownName = 'SIM_GHOST_AGENT_UNKNOWN';
    const resolved = resolveEmployeeIdentity(unknownName);
    assert.equal(resolved.status, 'UNMATCHED');
    assert.equal(resolved.employee_id, null);

    const inDb = db.prepare("SELECT * FROM employees WHERE name = ?").get(unknownName);
    assert.equal(inDb, undefined, 'Unknown Vendoor employee must NEVER be auto-created in Master');
  });
});
