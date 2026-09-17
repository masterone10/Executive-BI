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
  stageSpecificOrdersFile,
  mergeSpecificOrdersPool,
  getCurrentAccountsWithCounts,
  saveAccountRule,
  saveAccountException
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
  db.prepare('DELETE FROM account_rules').run();
  db.prepare('DELETE FROM account_exceptions WHERE work_date = ?').run(workDate);
  const h = db.prepare('SELECT id FROM allocation_headers WHERE allocation_date = ?').get(workDate);
  if (h) {
    db.prepare('DELETE FROM allocation_items WHERE allocation_header_id = ?').run(h.id);
    db.prepare('DELETE FROM allocation_headers WHERE id = ?').run(h.id);
  }
}

// Setup standard 3 test employees:
// Ahmed (New Only), Basma (Both), Mariam (Pending Only)
function setupTestTeam(workDate) {
  cleanDate(workDate);
  let ahmed = db.prepare("SELECT id, name FROM employees WHERE name = 'Ahmed Test'").get();
  if (!ahmed) {
    const res = db.prepare("INSERT INTO employees (name, department, team_membership, active) VALUES ('Ahmed Test', 'CS', 'New', 1)").run();
    ahmed = { id: res.lastInsertRowid, name: 'Ahmed Test' };
  } else {
    db.prepare("UPDATE employees SET team_membership = 'New', department = 'CS', active = 1 WHERE id = ?").run(ahmed.id);
  }

  let basma = db.prepare("SELECT id, name FROM employees WHERE name = 'Basma Test'").get();
  if (!basma) {
    const res = db.prepare("INSERT INTO employees (name, department, team_membership, active) VALUES ('Basma Test', 'CS', 'Both', 1)").run();
    basma = { id: res.lastInsertRowid, name: 'Basma Test' };
  } else {
    db.prepare("UPDATE employees SET team_membership = 'Both', department = 'CS', active = 1 WHERE id = ?").run(basma.id);
  }

  let mariam = db.prepare("SELECT id, name FROM employees WHERE name = 'Mariam Test'").get();
  if (!mariam) {
    const res = db.prepare("INSERT INTO employees (name, department, team_membership, active) VALUES ('Mariam Test', 'CS', 'Pending', 1)").run();
    mariam = { id: res.lastInsertRowid, name: 'Mariam Test' };
  } else {
    db.prepare("UPDATE employees SET team_membership = 'Pending', department = 'CS', active = 1 WHERE id = ?").run(mariam.id);
  }

  saveWorkingTeam(workDate, [
    { employee_id: ahmed.id, is_working: true },
    { employee_id: basma.id, is_working: true },
    { employee_id: mariam.id, is_working: true }
  ]);

  return { ahmed, basma, mariam };
}

test('SCENARIO 1: Account with NEW only allows New-only employee (Ahmed)', async () => {
  const date = '2026-12-01';
  const { ahmed } = setupTestTeam(date);

  // Doby Store = 200 New, 0 Pending
  const orders = [];
  for (let i = 1; i <= 200; i++) {
    orders.push({ order_code: `DOBY-N-${i}`, account: 'Doby Store', status: 'New' });
  }
  stageSpecificOrdersFile(date, 1, 'Doby.xlsx', orders);
  mergeSpecificOrdersPool(date);

  const alloc = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: true });
  assert.strictEqual(alloc.success, true);
  assert.strictEqual(alloc.assigned_orders, 200);

  const owner = alloc.raw_allocations[0];
  // Ahmed (New) or Basma (Both) are eligible; Mariam (Pending) is NOT
  assert.ok(owner.employee_name === 'Ahmed Test' || owner.employee_name === 'Basma Test');
  assert.notStrictEqual(owner.employee_name, 'Mariam Test');

  // ONE ACCOUNT = ONE EMPLOYEE
  assert.strictEqual(alloc.raw_allocations.every(o => o.employee_id === owner.employee_id), true);
});

test('SCENARIO 2: Account with PENDING only allows Pending-only employee (Mariam)', async () => {
  const date = '2026-12-02';
  const { mariam } = setupTestTeam(date);

  // Doby Store = 0 New, 80 Pending
  const orders = [];
  for (let i = 1; i <= 80; i++) {
    orders.push({ order_code: `DOBY-P-${i}`, account: 'Doby Store', status: 'Pending' });
  }
  stageSpecificOrdersFile(date, 1, 'Doby.xlsx', orders);
  mergeSpecificOrdersPool(date);

  const alloc = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: true });
  assert.strictEqual(alloc.success, true);
  assert.strictEqual(alloc.assigned_orders, 80);

  const owner = alloc.raw_allocations[0];
  // Mariam (Pending) or Basma (Both) are eligible; Ahmed (New) is NOT
  assert.ok(owner.employee_name === 'Mariam Test' || owner.employee_name === 'Basma Test');
  assert.notStrictEqual(owner.employee_name, 'Ahmed Test');

  // ONE ACCOUNT = ONE EMPLOYEE
  assert.strictEqual(alloc.raw_allocations.every(o => o.employee_id === owner.employee_id), true);
});

test('SCENARIO 3: Account with BOTH New and Pending requires Both capability (Basma)', async () => {
  const date = '2026-12-03';
  const { basma } = setupTestTeam(date);

  // Doby Store = 200 New, 80 Pending
  const orders = [];
  for (let i = 1; i <= 200; i++) {
    orders.push({ order_code: `DOBY-N-${i}`, account: 'Doby Store', status: 'New' });
  }
  for (let i = 1; i <= 80; i++) {
    orders.push({ order_code: `DOBY-P-${i}`, account: 'Doby Store', status: 'Pending' });
  }
  stageSpecificOrdersFile(date, 1, 'Doby.xlsx', orders);
  mergeSpecificOrdersPool(date);

  const alloc = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: true });
  assert.strictEqual(alloc.success, true);
  assert.strictEqual(alloc.assigned_orders, 280);

  // ONLY Basma (Both) can be assigned
  const owner = alloc.raw_allocations[0];
  assert.strictEqual(owner.employee_name, 'Basma Test');
  assert.strictEqual(owner.employee_id, basma.id);

  // All 280 orders must go to Basma (never split between Ahmed and Mariam)
  assert.strictEqual(alloc.raw_allocations.every(o => o.employee_id === basma.id), true);
});

test('SCENARIO 4: Account with BOTH streams when NO Both employee exists -> UNASSIGNED (never split)', async () => {
  const date = '2026-12-04';
  const { ahmed, mariam } = setupTestTeam(date);

  // Set today working team to ONLY Ahmed (New) and Mariam (Pending)
  saveWorkingTeam(date, [
    { employee_id: ahmed.id, is_working: true },
    { employee_id: mariam.id, is_working: true }
  ]);

  // Doby Store = 100 New, 50 Pending
  const orders = [];
  for (let i = 1; i <= 100; i++) {
    orders.push({ order_code: `DOBY-N-${i}`, account: 'Doby Store', status: 'New' });
  }
  for (let i = 1; i <= 50; i++) {
    orders.push({ order_code: `DOBY-P-${i}`, account: 'Doby Store', status: 'Pending' });
  }
  stageSpecificOrdersFile(date, 1, 'Doby.xlsx', orders);
  mergeSpecificOrdersPool(date);

  const alloc = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: true });
  assert.strictEqual(alloc.success, true);
  assert.strictEqual(alloc.unassigned_orders, 150);

  // All 150 orders must be UNASSIGNED
  for (const ord of alloc.raw_allocations) {
    assert.strictEqual(ord.employee_id, null);
    assert.strictEqual(ord.employee_name, 'UNASSIGNED');
    assert.ok(ord.rule_note.includes('No single eligible employee for both New and Pending') || ord.rule_note.includes('No eligible employee'));
  }

  // Account card audit
  const accounts = getCurrentAccountsWithCounts(date);
  const dobyAcc = accounts.find(a => a.account === 'Doby Store');
  assert.ok(dobyAcc);
  assert.strictEqual(dobyAcc.is_unassigned, true);
  assert.ok(dobyAcc.conflict_reason.includes('No single eligible employee for both New and Pending'));
});

test('SCENARIO 5: Account Rule Blocked Agent is excluded', async () => {
  const date = '2026-12-05';
  const { ahmed, basma } = setupTestTeam(date);

  // Block Ahmed on Doby Store
  saveAccountRule({ account_name: 'Doby Store', blocked: [ahmed.id], notes: 'Block Ahmed' });

  const orders = [];
  for (let i = 1; i <= 50; i++) {
    orders.push({ order_code: `DOBY-N-${i}`, account: 'Doby Store', status: 'New' });
  }
  stageSpecificOrdersFile(date, 1, 'Doby.xlsx', orders);
  mergeSpecificOrdersPool(date);

  const alloc = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: true });
  const owner = alloc.raw_allocations[0];
  assert.strictEqual(owner.employee_name, 'Basma Test');
  assert.strictEqual(alloc.raw_allocations.every(o => o.employee_id === basma.id), true);
});

test('SCENARIO 6: Date-Specific Exception Allow Only wins over team rules', async () => {
  const date = '2026-12-06';
  const { basma } = setupTestTeam(date);

  // Date exception: allow ONLY Basma
  saveAccountException({
    work_date: date,
    account_name: 'Joud Fragrance',
    exception_type: 'allow_only',
    employee_id: basma.id,
    notes: 'VIP account client preference'
  });

  const orders = [];
  for (let i = 1; i <= 30; i++) {
    orders.push({ order_code: `JOUD-${i}`, account: 'Joud Fragrance', status: 'New' });
  }
  stageSpecificOrdersFile(date, 1, 'Joud.xlsx', orders);
  mergeSpecificOrdersPool(date);

  const alloc = generateOrderLevelAllocation(date, { method: 'fair_random', regenerate: true });
  assert.strictEqual(alloc.raw_allocations.every(o => o.employee_id === basma.id), true);
  assert.ok(alloc.raw_allocations[0].rule_note.includes('Allow Only'));
});

test('SCENARIO 7: Incremental upload detects owner eligibility conflict', async () => {
  const date = '2026-12-07';
  const { ahmed, basma, mariam } = setupTestTeam(date);

  // Pass 1: Doby Store has ONLY New orders. Assign to Ahmed.
  const pass1Orders = [];
  for (let i = 1; i <= 100; i++) {
    pass1Orders.push({ order_code: `DOBY-N-${i}`, account: 'Doby Store', status: 'New' });
  }
  stageSpecificOrdersFile(date, 1, 'Pass1.xlsx', pass1Orders);
  mergeSpecificOrdersPool(date);

  // Manually force owner to Ahmed (New Only)
  reassignAccountOwner(date, 'Doby Store', ahmed.id, 'Initial Assignment');

  // Pass 2: Later, 50 Pending orders are uploaded for Doby Store
  const pass2Orders = [];
  for (let i = 1; i <= 50; i++) {
    pass2Orders.push({ order_code: `DOBY-P-${i}`, account: 'Doby Store', status: 'Pending' });
  }
  stageSpecificOrdersFile(date, 2, 'Pass2.xlsx', pass2Orders);
  mergeSpecificOrdersPool(date);

  // Now Doby Store has BOTH New and Pending, but preserved owner Ahmed is New-only!
  const accounts = getCurrentAccountsWithCounts(date);
  const doby = accounts.find(a => a.account === 'Doby Store');
  assert.strictEqual(doby.has_conflict, true);
  assert.strictEqual(doby.conflict_reason, 'Account Owner requires both New and Pending eligibility.');

  // Supervisor reassigns account to Basma (Both)
  const reassignRes = reassignAccountOwner(date, 'Doby Store', basma.id, 'Resolved stream conflict to Both agent');
  assert.strictEqual(reassignRes.success, true);
  assert.strictEqual(reassignRes.new_owner, 'Basma Test');

  // Now conflict is cleared
  const updatedAccounts = getCurrentAccountsWithCounts(date);
  const updatedDoby = updatedAccounts.find(a => a.account === 'Doby Store');
  assert.strictEqual(updatedDoby.owner_employee_name, 'Basma Test');
  assert.strictEqual(updatedDoby.has_conflict, false);
});

test('SCENARIO 8: Account Reassignment Logs persist supervisor audit trail', async () => {
  const date = '2026-12-08';
  const { ahmed, basma } = setupTestTeam(date);

  const orders = [
    { order_code: 'STORE-1', account: 'Delta Store', status: 'New' },
    { order_code: 'STORE-2', account: 'Delta Store', status: 'Pending' }
  ];
  stageSpecificOrdersFile(date, 1, 'Delta.xlsx', orders);
  mergeSpecificOrdersPool(date);

  reassignAccountOwner(date, 'Delta Store', basma.id, 'Manager override', 'Supervisor John');

  const logs = getAccountReassignmentLogs(date);
  assert.ok(logs.length > 0);
  const deltaLog = logs.find(l => l.account === 'Delta Store');
  assert.ok(deltaLog);
  assert.strictEqual(deltaLog.new_employee_name, 'Basma Test');
  assert.strictEqual(deltaLog.reason, 'Manager override');
  assert.strictEqual(deltaLog.reassigned_by, 'Supervisor John');
});
