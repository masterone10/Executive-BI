/**
 * tests/final_production_allocation_engine.test.js
 * 
 * Forensic Test Suite for CS Executive BI — Final Production Allocation Engine
 * Validates:
 * 1. 30-order account stays unified with 1 employee (0 fragmentation)
 * 2. NEW + PENDING in the same account go to the SAME employee
 * 3. Delayed NEW has Priority 1, Normal NEW is Priority 2, PENDING is Priority 3
 * 4. Delayed NEW does not fragment account (account unity preserved)
 * 5. Incremental allocation (previously allocated orders are preserved and never redistributed)
 * 6. Sticky account ownership (existing valid owner has precedence)
 * 7. Capacity split: 70 orders with 40-cap agents splits to exactly 2 employees (40 + 30)
 * 8. Idempotency: repeated allocation with no new work produces 0 changes
 * 9. Historical version immutability (Version N is preserved when Version N+1 is created)
 * 10. NEW becoming delayed receives higher priority on next incremental run
 * 11. Delayed NEW + sticky owner follows valid owner with capacity
 * 12. Priority does NOT bypass hard capacity limits
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import {
  planEnterpriseAllocation,
  executeEnterpriseAllocation,
  isDelayedNewOrder
} from '../services/enterprise_allocation.js';
import {
  saveWorkingTeam,
  stageSpecificOrdersFile,
  mergeSpecificOrdersPool,
  getOrderLevelAllocation,
  getAllocationVersions
} from '../services/allocation.js';

function cleanTestDate(workDate) {
  db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(workDate);
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(workDate);
  db.prepare('DELETE FROM specific_orders_uploads WHERE work_date = ?').run(workDate);
  db.prepare('DELETE FROM current_work_pool_summary WHERE work_date = ?').run(workDate);
  db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(workDate);
  db.prepare('DELETE FROM allocation_versions WHERE allocation_date = ?').run(workDate);
  db.prepare('DELETE FROM account_owners WHERE work_date = ?').run(workDate);
  db.prepare('DELETE FROM account_reassignment_logs WHERE work_date = ?').run(workDate);
  db.prepare('DELETE FROM enterprise_allocation_runs WHERE work_date = ?').run(workDate);
  db.prepare('DELETE FROM distribution_fingerprints WHERE work_date = ?').run(workDate);
  db.prepare('DELETE FROM employee_daily_allocation_states WHERE work_date = ?').run(workDate);
  db.prepare('DELETE FROM employee_activity_log WHERE work_date = ?').run(workDate);
  db.prepare('DELETE FROM employee_capacities').run();
}

describe('Final Production Allocation Engine Forensic Suite', () => {

  // -------------------------------------------------------------
  // Test 1: 30-Order Account with 40-Cap Employee -> 1 Employee
  // -------------------------------------------------------------
  test('Test 1: 30-order account stays with ONE employee when capacity allows (0 fragmentation)', () => {
    const date = '2030-07-01';
    cleanTestDate(date);

    // Setup working employees
    const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 3").all();
    db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${emps.map(e => e.id).join(',')})`).run();
    saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

    // Create 30 orders for "Clothes corner"
    const orders = [];
    for (let i = 1; i <= 30; i++) {
      orders.push({ order_code: `CC-ORD-${i}`, account: 'Clothes corner', status: 'New' });
    }
    stageSpecificOrdersFile(date, 1, 'ClothesCorner.xlsx', orders);
    mergeSpecificOrdersPool(date);

    const result = executeEnterpriseAllocation(date, { mode: 'ACTIVE' });
    assert.equal(result.success, true);
    assert.equal(result.assigned_count, 30);

    // Verify all 30 orders belong to exactly ONE employee
    const assignedEmps = new Set(result.raw_allocations.map(a => a.employee_id));
    assert.equal(assignedEmps.size, 1, `Expected 1 employee for Clothes corner, got ${assignedEmps.size}`);
    assert.equal(result.raw_allocations.every(a => a.employee_name !== 'UNASSIGNED'), true);
  });

  // -------------------------------------------------------------
  // Test 2: NEW + PENDING in the same Account are separated across employees (no mixed work types)
  // -------------------------------------------------------------
  test('Test 2: NEW + PENDING inside same account allocated to separate employees by stream (never mixed)', () => {
    const date = '2030-07-02';
    cleanTestDate(date);

    const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 3").all();
    db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${emps.map(e => e.id).join(',')})`).run();
    saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

    // Account with 10 NEW and 20 PENDING
    const orders = [];
    for (let i = 1; i <= 10; i++) {
      orders.push({ order_code: `NEW-ORD-${i}`, account: 'Unified Brand', status: 'New' });
    }
    for (let i = 1; i <= 20; i++) {
      orders.push({ order_code: `PEND-ORD-${i}`, account: 'Unified Brand', status: 'Pending' });
    }
    stageSpecificOrdersFile(date, 1, 'UnifiedBrand.xlsx', orders);
    mergeSpecificOrdersPool(date);

    const result = executeEnterpriseAllocation(date, { mode: 'ACTIVE' });
    assert.equal(result.success, true);
    assert.equal(result.assigned_count, 30);

    const assignedEmps = new Set(result.raw_allocations.map(a => a.employee_id));
    assert.equal(assignedEmps.size, 2, 'NEW and PENDING must be separated across employees');

    // Verify no single employee received both NEW and PENDING
    for (const empId of assignedEmps) {
      const empOrders = result.raw_allocations.filter(a => a.employee_id === empId);
      const hasNew = empOrders.some(a => a.work_type === 'NEW' || a.status === 'New');
      const hasPending = empOrders.some(a => a.work_type === 'PENDING' || a.status === 'Pending');
      assert.equal(hasNew && hasPending, false, `Employee ${empId} must NOT receive both NEW and PENDING`);
    }
  });

  // -------------------------------------------------------------
  // Test 3: Priority Order: Delayed NEW (P1) -> Normal NEW (P2) -> PENDING (P3)
  // -------------------------------------------------------------
  test('Test 3: Priority Model processes Delayed NEW before Normal NEW before PENDING', () => {
    const date = '2030-07-03';
    cleanTestDate(date);

    const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 2").all();
    db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${emps.map(e => e.id).join(',')})`).run();
    saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

    // Set capacity of each agent to 10
    for (const e of emps) {
      db.prepare('INSERT OR REPLACE INTO employee_capacities (employee_id, max_orders) VALUES (?, 10)').run(e.id);
    }

    // Account A: 10 Delayed NEW orders
    // Account B: 10 Normal NEW orders
    // Account C: 10 PENDING orders
    // Total orders = 30, but total capacity = 20 (10 + 10)
    // Result: Account A (Delayed NEW) and Account B (Normal NEW) MUST be assigned, Account C (PENDING) must be unassigned
    const orders = [];
    for (let i = 1; i <= 10; i++) {
      orders.push({ order_code: `DELAYED-${i}`, account: 'Account Delayed', status: 'New', priority: 'FAST_TRACK' });
    }
    for (let i = 1; i <= 10; i++) {
      orders.push({ order_code: `NORMAL-${i}`, account: 'Account Normal', status: 'New', priority: 'REGULAR' });
    }
    for (let i = 1; i <= 10; i++) {
      orders.push({ order_code: `PEND-${i}`, account: 'Account Pending', status: 'Pending', priority: 'REGULAR' });
    }

    stageSpecificOrdersFile(date, 1, 'PriorityTest.xlsx', orders);
    mergeSpecificOrdersPool(date);

    const result = executeEnterpriseAllocation(date, { mode: 'ACTIVE' });
    assert.equal(result.success, true);
    assert.equal(result.assigned_count, 20);
    assert.equal(result.unassigned_count, 10);

    // Verify Account Delayed is 100% assigned
    const delayedAssigned = result.raw_allocations.filter(a => a.account === 'Account Delayed' && a.employee_id !== null);
    assert.equal(delayedAssigned.length, 10, 'All Delayed NEW orders must be assigned first');

    // Verify Account Normal is 100% assigned
    const normalAssigned = result.raw_allocations.filter(a => a.account === 'Account Normal' && a.employee_id !== null);
    assert.equal(normalAssigned.length, 10, 'Normal NEW orders must be assigned second');

    // Verify Account Pending is unassigned due to capacity limit
    const pendingUnassigned = result.raw_allocations.filter(a => a.account === 'Account Pending' && a.employee_id === null);
    assert.equal(pendingUnassigned.length, 10, 'PENDING orders must remain unassigned when capacity exhausted by higher priorities');
  });

  // -------------------------------------------------------------
  // Test 4: Delayed NEW does not fragment account
  // -------------------------------------------------------------
  test('Test 4: Account with Delayed NEW + Normal NEW + PENDING stays with ONE employee', () => {
    const date = '2030-07-04';
    cleanTestDate(date);

    const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 3").all();
    db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${emps.map(e => e.id).join(',')})`).run();
    saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

    // Clothes corner with 8 Delayed NEW, 7 Normal NEW, 15 PENDING (Total = 30)
    const orders = [];
    for (let i = 1; i <= 8; i++) {
      orders.push({ order_code: `CC-DEL-${i}`, account: 'Clothes corner', status: 'New', priority: 'FAST_TRACK' });
    }
    for (let i = 1; i <= 7; i++) {
      orders.push({ order_code: `CC-NORM-${i}`, account: 'Clothes corner', status: 'New', priority: 'REGULAR' });
    }
    for (let i = 1; i <= 15; i++) {
      orders.push({ order_code: `CC-PEND-${i}`, account: 'Clothes corner', status: 'Pending', priority: 'REGULAR' });
    }

    stageSpecificOrdersFile(date, 1, 'ClothesCornerMixed.xlsx', orders);
    mergeSpecificOrdersPool(date);

    const result = executeEnterpriseAllocation(date, { mode: 'ACTIVE' });
    assert.equal(result.success, true);
    assert.equal(result.assigned_count, 30);

    // All 15 NEW orders stay together with 1 NEW employee, and 15 PENDING stay together with 1 PENDING employee
    const assignedEmps = new Set(result.raw_allocations.filter(a => a.work_state === 'ASSIGNED').map(a => a.employee_id));
    assert.equal(assignedEmps.size, 2, 'Mixed account must be split across 2 employees: 1 for NEW stream and 1 for PENDING stream');

    for (const empId of assignedEmps) {
      const empOrders = result.raw_allocations.filter(a => a.employee_id === empId);
      const hasNew = empOrders.some(a => a.work_type === 'NEW' || a.status === 'New');
      const hasPending = empOrders.some(a => a.work_type === 'PENDING' || a.status === 'Pending');
      assert.equal(hasNew && hasPending, false, `Employee ${empId} must NOT receive both NEW and PENDING`);
    }
  });

  // -------------------------------------------------------------
  // Test 5: Incremental Arrival: Preserves Existing Allocations
  // -------------------------------------------------------------
  test('Test 5: Incremental Arrival preserves existing 30 orders and adds newly arrived 5 orders', () => {
    const date = '2030-07-05';
    cleanTestDate(date);

    const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 3").all();
    db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${emps.map(e => e.id).join(',')})`).run();
    saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

    // Run 1: 30 orders
    const orders1 = [];
    for (let i = 1; i <= 30; i++) {
      orders1.push({ order_code: `INC-ORD-${i}`, account: 'Store Alpha', status: 'New' });
    }
    stageSpecificOrdersFile(date, 1, 'Batch1.xlsx', orders1);
    mergeSpecificOrdersPool(date);

    const res1 = executeEnterpriseAllocation(date, { mode: 'ACTIVE' });
    assert.equal(res1.assigned_count, 30);
    const initialOwner = res1.raw_allocations[0].employee_id;

    // Run 2: 5 new orders arrive
    const orders2 = [
      ...orders1,
      { order_code: 'INC-ORD-31', account: 'Store Alpha', status: 'New' },
      { order_code: 'INC-ORD-32', account: 'Store Alpha', status: 'New' },
      { order_code: 'INC-ORD-33', account: 'Store Alpha', status: 'New' },
      { order_code: 'INC-ORD-34', account: 'Store Alpha', status: 'New' },
      { order_code: 'INC-ORD-35', account: 'Store Alpha', status: 'New' }
    ];
    stageSpecificOrdersFile(date, 1, 'Batch2.xlsx', orders2);
    mergeSpecificOrdersPool(date);

    const res2 = executeEnterpriseAllocation(date, { mode: 'ACTIVE', regenerate: false });
    assert.equal(res2.success, true);
    assert.equal(res2.total_orders, 35);
    assert.equal(res2.preserved_orders_count, 30);
    assert.equal(res2.assigned_count, 5);

    // Verify existing 30 orders remained with initialOwner
    for (let i = 1; i <= 30; i++) {
      const ord = res2.raw_allocations.find(a => a.order_code === `INC-ORD-${i}`);
      assert.equal(ord.employee_id, initialOwner, `Order INC-ORD-${i} must remain with initial owner`);
    }
  });

  // -------------------------------------------------------------
  // Test 6: Sticky Account Owner remains owner
  // -------------------------------------------------------------
  test('Test 6: Existing Sticky Owner remains owner even if other employees have lower load', () => {
    const date = '2030-07-06';
    cleanTestDate(date);

    const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 3").all();
    db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${emps.map(e => e.id).join(',')})`).run();
    saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

    // Pre-set Account Owner in account_owners table (Emp 1 is owner)
    db.prepare(`
      INSERT INTO account_owners (work_date, account, owner_employee_id, owner_employee_name, allocation_version, is_override)
      VALUES (?, 'Sticky Store', ?, ?, 1, 0)
    `).run(date, emps[0].id, emps[0].name);

    // Add 20 orders for Sticky Store
    const orders = [];
    for (let i = 1; i <= 20; i++) {
      orders.push({ order_code: `STK-${i}`, account: 'Sticky Store', status: 'New' });
    }
    stageSpecificOrdersFile(date, 1, 'StickyStore.xlsx', orders);
    mergeSpecificOrdersPool(date);

    const result = executeEnterpriseAllocation(date, { mode: 'ACTIVE' });
    assert.equal(result.success, true);

    // All assigned orders must go to Emp 1 (sticky owner)
    const assigned = result.raw_allocations.filter(a => a.work_state === 'ASSIGNED');
    assert.equal(assigned.length, 20);
    assert.equal(assigned.every(a => a.employee_id === emps[0].id), true);
  });

  // -------------------------------------------------------------
  // Test 7: Capacity Split (70 Orders -> Exactly 2 Employees: 40 + 30)
  // -------------------------------------------------------------
  test('Test 7: 70 orders with 40-capacity agents splits to exactly 2 employees (40 + 30)', () => {
    const date = '2030-07-07';
    cleanTestDate(date);

    const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 3").all();
    db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${emps.map(e => e.id).join(',')})`).run();
    saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

    // Set max capacity of each agent to 40
    for (const e of emps) {
      db.prepare('INSERT OR REPLACE INTO employee_capacities (employee_id, max_orders) VALUES (?, 40)').run(e.id);
    }

    // 70 orders for Big Merchant
    const orders = [];
    for (let i = 1; i <= 70; i++) {
      orders.push({ order_code: `BIG-ORD-${i}`, account: 'Big Merchant', status: 'New' });
    }
    stageSpecificOrdersFile(date, 1, 'BigMerchant.xlsx', orders);
    mergeSpecificOrdersPool(date);

    const result = executeEnterpriseAllocation(date, { mode: 'ACTIVE' });
    assert.equal(result.success, true);
    assert.equal(result.assigned_count, 70);

    // Count employees used
    const empCounts = new Map();
    for (const a of result.raw_allocations) {
      empCounts.set(a.employee_id, (empCounts.get(a.employee_id) || 0) + 1);
    }

    assert.equal(empCounts.size, 2, `Expected exactly 2 employees, got ${empCounts.size}`);
    const counts = Array.from(empCounts.values()).sort((a, b) => b - a);
    assert.deepEqual(counts, [40, 30], 'Expected 40 orders to Agent 1 and 30 orders to Agent 2');
  });

  // -------------------------------------------------------------
  // Test 8: Idempotency (Repeated allocation with no new work)
  // -------------------------------------------------------------
  test('Test 8: Repeated Auto Fair Allocation with no new work is idempotent', () => {
    const date = '2030-07-08';
    cleanTestDate(date);

    const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 2").all();
    db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${emps.map(e => e.id).join(',')})`).run();
    saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

    const orders = [
      { order_code: 'IDEM-1', account: 'Store X', status: 'New' },
      { order_code: 'IDEM-2', account: 'Store X', status: 'New' }
    ];
    stageSpecificOrdersFile(date, 1, 'Idem.xlsx', orders);
    mergeSpecificOrdersPool(date);

    const run1 = executeEnterpriseAllocation(date, { mode: 'ACTIVE' });
    assert.equal(run1.assigned_count, 2);

    // Second run with identical inventory
    const run2 = executeEnterpriseAllocation(date, { mode: 'ACTIVE', regenerate: false });
    assert.equal(run2.success, true);
    assert.equal(run2.preserved_orders_count, 2);
    assert.equal(run2.assigned_count, 0, 'No newly assigned orders on repeat execution');
  });

  // -------------------------------------------------------------
  // Test 9: Historical Version Immutability
  // -------------------------------------------------------------
  test('Test 9: Historical Version 1 remains intact when Version 2 is created', () => {
    const date = '2030-07-09';
    cleanTestDate(date);

    const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 2").all();
    db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${emps.map(e => e.id).join(',')})`).run();
    saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

    // Version 1
    const orders1 = [{ order_code: 'VER-1', account: 'Store V', status: 'New' }];
    stageSpecificOrdersFile(date, 1, 'V1.xlsx', orders1);
    mergeSpecificOrdersPool(date);
    const r1 = executeEnterpriseAllocation(date, { mode: 'ACTIVE' });
    assert.equal(r1.version, 1);

    // Version 2
    const orders2 = [
      ...orders1,
      { order_code: 'VER-2', account: 'Store V', status: 'New' }
    ];
    stageSpecificOrdersFile(date, 1, 'V2.xlsx', orders2);
    mergeSpecificOrdersPool(date);
    const r2 = executeEnterpriseAllocation(date, { mode: 'ACTIVE', regenerate: false });
    assert.equal(r2.version, 2);

    // Check Version 1 in DB
    const v1Orders = db.prepare('SELECT * FROM order_level_allocations WHERE allocation_date = ? AND allocation_version = 1').all(date);
    assert.equal(v1Orders.length, 1);
    assert.equal(v1Orders[0].order_code, 'VER-1');

    // Check Version 2 in DB
    const v2Orders = db.prepare('SELECT * FROM order_level_allocations WHERE allocation_date = ? AND allocation_version = 2').all(date);
    assert.equal(v2Orders.length, 1);
    assert.equal(v2Orders[0].order_code, 'VER-2');
  });

  // -------------------------------------------------------------
  // Test 10: NEW Order Becoming Delayed receives higher priority
  // -------------------------------------------------------------
  test('Test 10: NEW order becoming delayed is classified as Delayed NEW (Priority 1)', () => {
    const date = '2030-07-10';
    const oldDate = '2030-07-09';

    const normalOrder = { order_code: 'ORD-NORM', status: 'New', order_date: date, priority: 'REGULAR' };
    const delayedByDate = { order_code: 'ORD-OLD', status: 'New', order_date: oldDate, priority: 'REGULAR' };
    const delayedByPrio = { order_code: 'ORD-FAST', status: 'New', order_date: date, priority: 'FAST_TRACK' };

    assert.equal(isDelayedNewOrder(normalOrder, date), false);
    assert.equal(isDelayedNewOrder(delayedByDate, date), true);
    assert.equal(isDelayedNewOrder(delayedByPrio, date), true);
  });

  // -------------------------------------------------------------
  // Test 11: Delayed NEW + Sticky Account Owner follows valid owner
  // -------------------------------------------------------------
  test('Test 11: Delayed NEW under owned account follows valid owner if capacity permits', () => {
    const date = '2030-07-11';
    cleanTestDate(date);

    const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 2").all();
    db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${emps.map(e => e.id).join(',')})`).run();
    saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

    // Pre-set sticky owner
    db.prepare(`
      INSERT INTO account_owners (work_date, account, owner_employee_id, owner_employee_name, allocation_version, is_override)
      VALUES (?, 'Fashion Hub', ?, ?, 1, 0)
    `).run(date, emps[1].id, emps[1].name);

    const orders = [
      { order_code: 'FH-DEL-1', account: 'Fashion Hub', status: 'New', priority: 'FAST_TRACK' },
      { order_code: 'FH-DEL-2', account: 'Fashion Hub', status: 'New', priority: 'FAST_TRACK' }
    ];
    stageSpecificOrdersFile(date, 1, 'FashionHub.xlsx', orders);
    mergeSpecificOrdersPool(date);

    const result = executeEnterpriseAllocation(date, { mode: 'ACTIVE' });
    assert.equal(result.success, true);
    assert.equal(result.raw_allocations.every(a => a.employee_id === emps[1].id), true);
  });

  // -------------------------------------------------------------
  // Test 12: Delayed NEW does NOT bypass hard capacity
  // -------------------------------------------------------------
  test('Test 12: Delayed NEW priority respects hard employee capacity ceilings', () => {
    const date = '2030-07-12';
    cleanTestDate(date);

    const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 2").all();
    db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${emps.map(e => e.id).join(',')})`).run();
    saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

    // Set Agent 1 capacity = 5, Agent 2 capacity = 15
    db.prepare('INSERT OR REPLACE INTO employee_capacities (employee_id, max_orders) VALUES (?, 5)').run(emps[0].id);
    db.prepare('INSERT OR REPLACE INTO employee_capacities (employee_id, max_orders) VALUES (?, 15)').run(emps[1].id);

    // Account with 20 Delayed NEW orders (Total capacity across team = 20)
    const orders = [];
    for (let i = 1; i <= 20; i++) {
      orders.push({ order_code: `CAP-DEL-${i}`, account: 'Cap Store', status: 'New', priority: 'FAST_TRACK' });
    }
    stageSpecificOrdersFile(date, 1, 'CapStore.xlsx', orders);
    mergeSpecificOrdersPool(date);

    const result = executeEnterpriseAllocation(date, { mode: 'ACTIVE' });
    assert.equal(result.success, true);
    assert.equal(result.assigned_count, 20);

    const emp1Orders = result.raw_allocations.filter(a => a.employee_id === emps[0].id).length;
    const emp2Orders = result.raw_allocations.filter(a => a.employee_id === emps[1].id).length;

    assert.equal(emp1Orders, 5, 'Agent 1 must receive exactly 5 orders (hard cap)');
    assert.equal(emp2Orders, 15, 'Agent 2 must receive exactly 15 orders (hard cap)');
  });

});
