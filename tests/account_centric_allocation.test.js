import test from 'node:test';
import assert from 'node:assert';
import db from '../db/index.js';
import {
  saveWorkingTeam,
  generateOrderLevelAllocation,
  saveFinalOrderLevelAllocation,
  reassignAccountOwner,
  getAccountOwners,
  getAccountReassignmentLogs,
  generateCopyAllocationText,
  stageSpecificOrdersFile,
  mergeSpecificOrdersPool
} from '../services/allocation.js';

function cleanDate(workDate) {
  db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(workDate);
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(workDate);
  db.prepare('DELETE FROM specific_orders_uploads WHERE work_date = ?').run(workDate);
  db.prepare('DELETE FROM current_work_pool_summary WHERE work_date = ?').run(workDate);
  db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(workDate);
  db.prepare('DELETE FROM allocation_versions WHERE allocation_date = ?').run(workDate);
  db.prepare('DELETE FROM account_owners WHERE work_date = ?').run(workDate);
  db.prepare('DELETE FROM account_reassignment_logs WHERE work_date = ?').run(workDate);
  const h = db.prepare('SELECT id FROM allocation_headers WHERE allocation_date = ?').get(workDate);
  if (h) {
    db.prepare('DELETE FROM allocation_items WHERE allocation_header_id = ?').run(h.id);
    db.prepare('DELETE FROM allocation_headers WHERE id = ?').run(h.id);
  }
}

test('1. Large Account (200 Orders) stays with ONE employee (never split)', async () => {
  const date = '2026-11-01';
  cleanDate(date);

  const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 3").all();
  db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${emps.map(e => e.id).join(',')})`).run();
  saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

  // Doby Store = 200 Orders
  const orders = [];
  for (let i = 1; i <= 200; i++) {
    orders.push({ order_code: `DOBY-LG-${i}`, account: 'Doby Store', status: 'New' });
  }
  stageSpecificOrdersFile(date, 1, 'Doby.xlsx', orders);
  mergeSpecificOrdersPool(date);

  const alloc = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: true });
  assert.strictEqual(alloc.raw_allocations.length, 200);

  // Exactly ONE employee must have all 200 orders
  const ownerId = alloc.raw_allocations[0].employee_id;
  assert.ok(ownerId !== null);
  const allSameOwner = alloc.raw_allocations.every(o => o.employee_id === ownerId);
  assert.strictEqual(allSameOwner, true, 'All 200 orders must be assigned to the single Account Owner');

  // Other employees have 0 orders
  const otherOrders = alloc.raw_allocations.filter(o => o.employee_id !== ownerId);
  assert.strictEqual(otherOrders.length, 0);
});

test('2. New + Pending inside same Account go to the SAME employee', async () => {
  const date = '2026-11-02';
  cleanDate(date);

  const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 3").all();
  db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${emps.map(e => e.id).join(',')})`).run();
  saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

  // Alpha Brand: 100 New, 100 Pending = 200 orders
  const orders = [];
  for (let i = 1; i <= 100; i++) {
    orders.push({ order_code: `ALPHA-N-${i}`, account: 'Alpha Brand', status: 'New' });
    orders.push({ order_code: `ALPHA-P-${i}`, account: 'Alpha Brand', status: 'Pending' });
  }
  stageSpecificOrdersFile(date, 1, 'Alpha.xlsx', orders);
  mergeSpecificOrdersPool(date);

  const alloc = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: true });
  assert.strictEqual(alloc.raw_allocations.length, 200);

  const ownerId = alloc.raw_allocations[0].employee_id;
  assert.ok(ownerId !== null);
  const allSame = alloc.raw_allocations.every(o => o.employee_id === ownerId);
  assert.strictEqual(allSame, true, 'Both New and Pending orders must go to the same employee');
});

test('3. Fairness is based on Number of Accounts per employee', async () => {
  const date = '2026-11-03';
  cleanDate(date);

  const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 3").all();
  db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${emps.map(e => e.id).join(',')})`).run();
  saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

  // 6 Accounts with different sizes
  const accounts = [
    { name: 'Acc1', count: 100 },
    { name: 'Acc2', count: 50 },
    { name: 'Acc3', count: 20 },
    { name: 'Acc4', count: 10 },
    { name: 'Acc5', count: 5 },
    { name: 'Acc6', count: 2 }
  ];

  const orders = [];
  for (const acc of accounts) {
    for (let i = 1; i <= acc.count; i++) {
      orders.push({ order_code: `${acc.name}-${i}`, account: acc.name, status: 'New' });
    }
  }
  stageSpecificOrdersFile(date, 1, 'Accs.xlsx', orders);
  mergeSpecificOrdersPool(date);

  const alloc = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: true });
  saveFinalOrderLevelAllocation(date, alloc);

  // Each of the 3 employees should get exactly 2 accounts (6 accounts / 3 emps = 2)
  for (const emp of alloc.by_employee) {
    assert.strictEqual(emp.accounts_count, 2, `Employee ${emp.employee_name} should have exactly 2 accounts`);
  }
});

test('4. Manual Reassign Account reassigns ALL orders and writes audit log', async () => {
  const date = '2026-11-04';
  cleanDate(date);

  const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 2").all();
  db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${emps.map(e => e.id).join(',')})`).run();
  saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

  const orders = [
    { order_code: 'STORE-1', account: 'Store Beta', status: 'New' },
    { order_code: 'STORE-2', account: 'Store Beta', status: 'Pending' },
    { order_code: 'STORE-3', account: 'Store Beta', status: 'New' }
  ];
  stageSpecificOrdersFile(date, 1, 'Beta.xlsx', orders);
  mergeSpecificOrdersPool(date);

  const alloc = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: true });
  saveFinalOrderLevelAllocation(date, alloc);

  const originalOwnerId = alloc.raw_allocations[0].employee_id;
  const targetEmp = emps.find(e => e.id !== originalOwnerId);

  // Reassign Store Beta to targetEmp
  const reassignRes = reassignAccountOwner(date, 'Store Beta', targetEmp.id, 'Shift coverage', 'Supervisor Sara');
  assert.strictEqual(reassignRes.success, true);
  assert.strictEqual(reassignRes.new_owner, targetEmp.name);

  // Verify all orders in order_level_allocations updated
  const updatedOrders = db.prepare(`
    SELECT * FROM order_level_allocations
    WHERE allocation_date = ? AND account = 'Store Beta'
  `).all(date);
  assert.strictEqual(updatedOrders.length, 3);
  assert.strictEqual(updatedOrders.every(o => o.employee_id === targetEmp.id), true);
  assert.strictEqual(updatedOrders.every(o => o.is_override === 1), true);

  // Verify audit log
  const logs = getAccountReassignmentLogs(date);
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].account, 'Store Beta');
  assert.strictEqual(logs[0].new_employee_id, targetEmp.id);
  assert.strictEqual(logs[0].reason, 'Shift coverage');
  assert.strictEqual(logs[0].reassigned_by, 'Supervisor Sara');
});

test('5. WhatsApp/Teams copy text formats by Account with order codes', async () => {
  const date = '2026-11-05';
  cleanDate(date);

  const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 1").all();
  db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id = ${emps[0].id}`).run();
  saveWorkingTeam(date, [{ employee_id: emps[0].id, is_working: true }]);

  const orders = [
    { order_code: 'XYZ-1', account: 'XYZ Store', status: 'New' },
    { order_code: 'XYZ-2', account: 'XYZ Store', status: 'Pending' }
  ];
  stageSpecificOrdersFile(date, 1, 'XYZ.xlsx', orders);
  mergeSpecificOrdersPool(date);

  const alloc = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: true });
  saveFinalOrderLevelAllocation(date, alloc);

  const text = generateCopyAllocationText(date, 'all_employees');
  assert.ok(text.includes('XYZ Store'));
  assert.ok(text.includes('NEW: 1'));
  assert.ok(text.includes('PENDING: 1'));
  assert.ok(text.includes('TOTAL: 2'));
  assert.ok(text.includes('XYZ-1'));
  assert.ok(text.includes('XYZ-2'));
});
