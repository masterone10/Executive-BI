import test from 'node:test';
import assert from 'node:assert';
import db from '../db/index.js';
import {
  stageSpecificOrdersFile,
  mergeSpecificOrdersPool,
  generateOrderLevelAllocation,
  saveFinalOrderLevelAllocation,
  manualOverrideOrderAllocation,
  saveWorkingTeam,
  saveAccountRule
} from '../services/allocation.js';

function cleanTestDate(date) {
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(date);
  db.prepare('DELETE FROM specific_orders_uploads WHERE work_date = ?').run(date);
  db.prepare('DELETE FROM current_work_pool_summary WHERE work_date = ?').run(date);
  db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(date);
  db.prepare('DELETE FROM allocation_versions WHERE allocation_date = ?').run(date);
  db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(date);
  db.prepare('DELETE FROM account_exceptions WHERE work_date = ?').run(date);
}

test('1. 15 Small Accounts with 15 Working Employees -> 1 Account per Employee', async () => {
  const date = '2026-10-01';
  cleanTestDate(date);

  // Configure 15 active CS employees for this date with team_membership = 'Both'
  const allEmployees = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 15").all();
  assert.strictEqual(allEmployees.length >= 15, true, 'At least 15 active CS employees exist');

  // Set team_membership to Both for these employees so all are eligible for New
  db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${allEmployees.map(e => e.id).join(',')})`).run();
  saveWorkingTeam(date, allEmployees.map(e => ({ employee_id: e.id, is_working: true })));

  // Create 15 small accounts (1-10 orders each)
  const orders = [];
  for (let accIdx = 1; accIdx <= 15; accIdx++) {
    const accName = `Small Merchant ${accIdx}`;
    const count = 3 + (accIdx % 5); // 3 to 7 orders
    for (let o = 1; o <= count; o++) {
      orders.push({
        order_code: `ORD-SC1-ACC${accIdx}-${o}`,
        account: accName,
        status: 'New'
      });
    }
  }

  stageSpecificOrdersFile(date, 1, 'File1.xlsx', orders);
  mergeSpecificOrdersPool(date);

  const alloc = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: true });
  assert.strictEqual(alloc.total_orders, orders.length);

  // Group by employee
  const empAccountCounts = new Map();
  for (const item of alloc.raw_allocations) {
    if (!empAccountCounts.has(item.employee_name)) {
      empAccountCounts.set(item.employee_name, new Set());
    }
    empAccountCounts.get(item.employee_name).add(item.account);
  }

  // Verify that all 15 employees received exactly 1 small account
  assert.strictEqual(empAccountCounts.size, 15, 'All 15 working employees should receive an account');
  for (const [empName, accSet] of empAccountCounts.entries()) {
    assert.strictEqual(accSet.size, 1, `Employee ${empName} should receive exactly 1 account, got ${accSet.size}`);
  }

  // Also verify each account was given to exactly ONE employee (not split)
  const accountEmpMap = new Map();
  for (const item of alloc.raw_allocations) {
    if (!accountEmpMap.has(item.account)) accountEmpMap.set(item.account, new Set());
    accountEmpMap.get(item.account).add(item.employee_name);
  }
  for (const [accName, emps] of accountEmpMap.entries()) {
    assert.strictEqual(emps.size, 1, `Account ${accName} must not be split, got ${emps.size} employees`);
  }
});

test('2. 15 Small Accounts with 10 Working Employees -> Even Spread (5 get 2, 5 get 1)', async () => {
  const date = '2026-10-02';
  cleanTestDate(date);

  const allEmployees = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 10").all();
  db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${allEmployees.map(e => e.id).join(',')})`).run();
  saveWorkingTeam(date, allEmployees.map(e => ({ employee_id: e.id, is_working: true })));

  const orders = [];
  for (let accIdx = 1; accIdx <= 15; accIdx++) {
    const accName = `TenEmp Merchant ${accIdx}`;
    for (let o = 1; o <= 4; o++) {
      orders.push({
        order_code: `ORD-SC2-ACC${accIdx}-${o}`,
        account: accName,
        status: 'New'
      });
    }
  }

  stageSpecificOrdersFile(date, 1, 'File1.xlsx', orders);
  mergeSpecificOrdersPool(date);

  const alloc = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: true });

  const empAccountCounts = new Map();
  for (const item of alloc.raw_allocations) {
    if (!empAccountCounts.has(item.employee_name)) {
      empAccountCounts.set(item.employee_name, new Set());
    }
    empAccountCounts.get(item.employee_name).add(item.account);
  }

  assert.strictEqual(empAccountCounts.size, 10, 'All 10 working employees should receive accounts');
  const counts = Array.from(empAccountCounts.values()).map(s => s.size).sort();
  // 5 employees should get 1, 5 employees should get 2
  assert.deepStrictEqual(counts, [1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
});

test('3. Restricted Eligibility respects rules while minimizing fragmentation', async () => {
  const date = '2026-10-03';
  cleanTestDate(date);

  const emps = db.prepare('SELECT id, name FROM employees WHERE active = 1 ORDER BY id ASC LIMIT 4').all();
  saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

  // Account A restricted to Emp 0 and Emp 1 only
  saveAccountRule({
    account_name: 'Restricted Store A',
    new_eligible: [emps[0].id, emps[1].id],
    pending_eligible: [],
    blocked: [],
    notes: 'Restricted to first two agents'
  });

  const orders = [
    { order_code: 'R-1', account: 'Restricted Store A', status: 'New' },
    { order_code: 'R-2', account: 'Restricted Store A', status: 'New' },
    { order_code: 'G-1', account: 'General Store B', status: 'New' },
    { order_code: 'G-2', account: 'General Store C', status: 'New' },
    { order_code: 'G-3', account: 'General Store D', status: 'New' }
  ];

  stageSpecificOrdersFile(date, 1, 'File1.xlsx', orders);
  mergeSpecificOrdersPool(date);

  const alloc = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: true });

  // Check that Restricted Store A went to either emps[0] or emps[1]
  const restAItems = alloc.raw_allocations.filter(x => x.account === 'Restricted Store A');
  assert.strictEqual(restAItems.length, 2);
  const assignedEmpId = restAItems[0].employee_id;
  assert.strictEqual([emps[0].id, emps[1].id].includes(assignedEmpId), true);
  // Ensure all 2 orders of Restricted Store A are assigned to that ONE employee
  assert.strictEqual(restAItems.every(x => x.employee_id === assignedEmpId), true);
});

test('4. Independent Logic for New and Pending Pools', async () => {
  const date = '2026-10-04';
  cleanTestDate(date);

  const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 2").all();
  db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${emps.map(e => e.id).join(',')})`).run();
  saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

  const orders = [
    // 2 Small New Accounts
    { order_code: 'N1-1', account: 'New Store 1', status: 'New' },
    { order_code: 'N2-1', account: 'New Store 2', status: 'New' },
    // 2 Small Pending Accounts
    { order_code: 'P1-1', account: 'Pen Store 1', status: 'Pending' },
    { order_code: 'P2-1', account: 'Pen Store 2', status: 'Pending' }
  ];

  stageSpecificOrdersFile(date, 1, 'File1.xlsx', orders);
  mergeSpecificOrdersPool(date);

  const alloc = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: true });

  const newAssigned = alloc.raw_allocations.filter(x => x.status === 'New');
  const penAssigned = alloc.raw_allocations.filter(x => x.status === 'Pending');

  // For New: 2 employees each receive 1 New account
  const newEmpAccs = new Map();
  for (const item of newAssigned) {
    if (!newEmpAccs.has(item.employee_name)) newEmpAccs.set(item.employee_name, new Set());
    newEmpAccs.get(item.employee_name).add(item.account);
  }
  assert.strictEqual(newEmpAccs.size, 2);
  for (const accSet of newEmpAccs.values()) {
    assert.strictEqual(accSet.size, 1);
  }

  // For Pending: 2 employees each receive 1 Pending account
  const penEmpAccs = new Map();
  for (const item of penAssigned) {
    if (!penEmpAccs.has(item.employee_name)) penEmpAccs.set(item.employee_name, new Set());
    penEmpAccs.get(item.employee_name).add(item.account);
  }
  assert.strictEqual(penEmpAccs.size, 2);
  for (const accSet of penEmpAccs.values()) {
    assert.strictEqual(accSet.size, 1);
  }
});

test('5. Incremental Upload Preserves Previous Single-Employee Assignments', async () => {
  const date = '2026-10-05';
  cleanTestDate(date);

  const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 5").all();
  db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${emps.map(e => e.id).join(',')})`).run();
  saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

  // Initial Upload: Doby Store (10 New Orders)
  const initialOrders = [];
  for (let i = 1; i <= 10; i++) {
    initialOrders.push({ order_code: `DOBY-1-${i}`, account: 'Doby Store', status: 'New' });
  }
  stageSpecificOrdersFile(date, 1, 'File1.xlsx', initialOrders);
  mergeSpecificOrdersPool(date);

  const alloc1 = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: true });
  saveFinalOrderLevelAllocation(date, alloc1);

  const assignedAgentName = alloc1.raw_allocations[0].employee_name;
  assert.strictEqual(alloc1.raw_allocations.every(x => x.employee_name === assignedAgentName), true);

  // Second Cumulative Upload: 10 More Orders for Doby Store
  const secondOrders = [];
  for (let i = 11; i <= 20; i++) {
    secondOrders.push({ order_code: `DOBY-2-${i}`, account: 'Doby Store', status: 'New' });
  }
  stageSpecificOrdersFile(date, 2, 'File2.xlsx', secondOrders);
  mergeSpecificOrdersPool(date);

  const alloc2 = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: false });
  assert.strictEqual(alloc2.preserved_orders_count, 10);
  assert.strictEqual(alloc2.new_unallocated_orders_count, 10);

  // Verify all 20 orders are assigned to the SAME agent (no fragmentation across uploads)
  const dobyOrders = alloc2.raw_allocations.filter(x => x.account === 'Doby Store');
  assert.strictEqual(dobyOrders.length, 20);
  assert.strictEqual(dobyOrders.every(x => x.employee_name === assignedAgentName), true);
});

test('6. Manual Override is Respected and Preserved', async () => {
  const date = '2026-10-06';
  cleanTestDate(date);

  const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND department = 'CS' ORDER BY id ASC LIMIT 2").all();
  db.prepare(`UPDATE employees SET team_membership = 'Both' WHERE id IN (${emps.map(e => e.id).join(',')})`).run();
  saveWorkingTeam(date, emps.map(e => ({ employee_id: e.id, is_working: true })));

  const orders = [
    { order_code: 'OVR-1', account: 'Store X', status: 'New' },
    { order_code: 'OVR-2', account: 'Store X', status: 'New' }
  ];
  stageSpecificOrdersFile(date, 1, 'File1.xlsx', orders);
  mergeSpecificOrdersPool(date);

  const alloc1 = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: true });
  const saveRes = saveFinalOrderLevelAllocation(date, alloc1);

  // Reassign OVR-1 to emps[1].id with manual override
  manualOverrideOrderAllocation(date, saveRes.version, 'OVR-1', emps[1].id);

  const allocAfterOverride = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: false });
  const ovr1Item = allocAfterOverride.raw_allocations.find(x => x.order_code === 'OVR-1');
  assert.strictEqual(ovr1Item.employee_id, emps[1].id);
  assert.strictEqual(ovr1Item.is_override, 1);
});
