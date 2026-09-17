import { test } from 'node:test';
import assert from 'node:assert';
import { db } from '../db/index.js';
import {
  saveWorkingTeam,
  stageSpecificOrdersFile,
  mergeSpecificOrdersPool,
  generateOrderLevelAllocation
} from '../services/allocation.js';
import {
  getEmployeePerformanceProfiles,
  calculateSmartAllocationScore,
  savePerformanceSnapshotToDB
} from '../services/performance.js';

function cleanTestDate(date) {
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(date);
  db.prepare('DELETE FROM current_work_pool_summary WHERE work_date = ?').run(date);
  db.prepare('DELETE FROM specific_orders_uploads WHERE work_date = ?').run(date);
  db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(date);
  db.prepare('DELETE FROM account_owners WHERE work_date = ?').run(date);
  db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(date);
  db.prepare('DELETE FROM account_exceptions WHERE work_date = ?').run(date);
  db.prepare('DELETE FROM performance_snapshots WHERE date = ?').run(date);
}

function ensureEmployees() {
  const names = ['Smart Ahmed CS', 'Smart Mohamed CS', 'Smart Ali CS'];
  for (const name of names) {
    const existing = db.prepare('SELECT id FROM employees WHERE name = ? COLLATE NOCASE').get(name);
    if (!existing) {
      db.prepare("INSERT INTO employees (name, department, team_membership, active) VALUES (?, 'CS', 'Both', 1)").run(name);
    } else {
      db.prepare("UPDATE employees SET active = 1, team_membership = 'Both', department = 'CS' WHERE id = ?").run(existing.id);
    }
  }
}

function cleanupEmployees() {
  db.prepare("DELETE FROM employees WHERE name LIKE 'Smart % CS'").run();
}

test('Smart Allocation 1: Performance Profiles from Real Snapshots & Logs', async () => {
  const date = '2026-10-10';
  cleanTestDate(date);
  ensureEmployees();

  const ahmed = db.prepare("SELECT id, name FROM employees WHERE name = 'Smart Ahmed CS'").get();
  const mohamed = db.prepare("SELECT id, name FROM employees WHERE name = 'Smart Mohamed CS'").get();

  // Save historical performance snapshots
  savePerformanceSnapshotToDB(date, {
    employees: [
      {
        name: 'Smart Ahmed CS',
        score: 95.0,
        rate: 1.25,
        printed: 85,
        actions: 130,
        real_actions: 110,
        pending: 5,
        cancelled: 2,
        processing: 3
      },
      {
        name: 'Smart Mohamed CS',
        score: 72.0,
        rate: 0.85,
        printed: 45,
        actions: 65,
        real_actions: 55,
        pending: 8,
        cancelled: 4,
        processing: 2
      }
    ]
  });

  const profiles = getEmployeePerformanceProfiles(date);
  const ahmedProfile = profiles.get(ahmed.id);
  const mohamedProfile = profiles.get(mohamed.id);

  assert.ok(ahmedProfile, 'Ahmed profile exists');
  assert.ok(mohamedProfile, 'Mohamed profile exists');
  assert.strictEqual(ahmedProfile.historical_score >= 90, true, 'Ahmed has high historical score');
  assert.strictEqual(ahmedProfile.estimated_daily_capacity > mohamedProfile.estimated_daily_capacity, true, 'Ahmed has higher estimated capacity');
});

test('Smart Allocation 2: 40-Order Account Assigned Entirely to Ahmed with Explanatory Reason', async () => {
  const date = '2026-10-11';
  cleanTestDate(date);
  ensureEmployees();

  // Configure working team with Smart Ahmed CS, Smart Mohamed CS, and Smart Ali CS
  const employees = db.prepare("SELECT id, name FROM employees WHERE name IN ('Smart Ahmed CS', 'Smart Mohamed CS', 'Smart Ali CS')").all();
  assert.strictEqual(employees.length >= 3, true);

  saveWorkingTeam(date, employees.map(e => ({ employee_id: e.id, is_working: true })));

  // Setup performance history: Smart Ahmed CS is top performer
  savePerformanceSnapshotToDB(date, {
    employees: [
      { name: 'Smart Ahmed CS', score: 96.0, rate: 1.30, printed: 90, actions: 140, real_actions: 120, pending: 2, cancelled: 1, processing: 1 },
      { name: 'Smart Mohamed CS', score: 68.0, rate: 0.80, printed: 40, actions: 60, real_actions: 50, pending: 5, cancelled: 3, processing: 2 },
      { name: 'Smart Ali CS', score: 65.0, rate: 0.75, printed: 35, actions: 55, real_actions: 45, pending: 4, cancelled: 2, processing: 1 }
    ]
  });

  // Create an account with 40 orders (larger than the 30-order guideline, but within single employee capacity)
  const orders = [];
  for (let i = 1; i <= 40; i++) {
    orders.push({
      order_code: `ORD-SMART-40-${i}`,
      account: 'Alpha Store',
      status: 'New'
    });
  }

  stageSpecificOrdersFile(date, 1, 'AlphaOrders.xlsx', orders);
  mergeSpecificOrdersPool(date);

  // Generate allocation
  const alloc = generateOrderLevelAllocation(date, { regenerate: true });
  assert.strictEqual(alloc.total_orders, 40);

  // Verification 1: The account is NOT split into pieces (e.g. 30 and 10)
  const assignedEmployees = new Set(alloc.raw_allocations.map(a => a.employee_name));
  assert.strictEqual(assignedEmployees.size, 1, 'All 40 orders must belong to ONE employee');

  // Verification 2: Top performer Smart Ahmed CS is chosen
  const chosenName = Array.from(assignedEmployees)[0];
  assert.strictEqual(chosenName, 'Smart Ahmed CS', 'Ahmed must be chosen based on superior performance and capacity');

  // Verification 3: Explanatory note is present and informative
  const ownerRecord = alloc.account_owners.find(o => o.account === 'Alpha Store');
  assert.ok(ownerRecord, 'Account owner record exists');
  assert.strictEqual(ownerRecord.owner_employee_name || ownerRecord.employee_name, 'Smart Ahmed CS');
  assert.ok(ownerRecord.rule_note.includes('Alpha Store'), 'Rule note names the account');
  assert.ok(ownerRecord.rule_note.includes('capacity') || ownerRecord.rule_note.includes('performance'), 'Rule note mentions capacity/performance reason');
});

test('Smart Allocation 3: Smart Split Proportional Allocation for 180-Order Account', async () => {
  const date = '2026-10-12';
  cleanTestDate(date);
  ensureEmployees();

  const employees = db.prepare("SELECT id, name FROM employees WHERE name IN ('Smart Ahmed CS', 'Smart Mohamed CS', 'Smart Ali CS')").all();
  saveWorkingTeam(date, employees.map(e => ({ employee_id: e.id, is_working: true })));

  // Setup performance history
  savePerformanceSnapshotToDB(date, {
    employees: [
      { name: 'Smart Ahmed CS', score: 95.0, rate: 1.25, printed: 85, actions: 130, real_actions: 110, pending: 3, cancelled: 1, processing: 1 },
      { name: 'Smart Mohamed CS', score: 75.0, rate: 0.90, printed: 55, actions: 80, real_actions: 65, pending: 4, cancelled: 2, processing: 1 },
      { name: 'Smart Ali CS', score: 65.0, rate: 0.70, printed: 40, actions: 60, real_actions: 50, pending: 5, cancelled: 2, processing: 1 }
    ]
  });

  // Create an account with 180 orders (exceeds single employee capacity of 80)
  const orders = [];
  for (let i = 1; i <= 180; i++) {
    orders.push({
      order_code: `ORD-MEGA-180-${i}`,
      account: 'Mega Enterprise',
      status: 'New'
    });
  }

  stageSpecificOrdersFile(date, 1, 'MegaOrders.xlsx', orders);
  mergeSpecificOrdersPool(date);

  // Generate allocation with smart split enabled
  const alloc = generateOrderLevelAllocation(date, { regenerate: true, enable_smart_split: true });
  assert.strictEqual(alloc.total_orders, 180);

  // Verify proportional split distribution
  const empOrderCounts = new Map();
  for (const item of alloc.raw_allocations) {
    empOrderCounts.set(item.employee_name, (empOrderCounts.get(item.employee_name) || 0) + 1);
  }

  assert.strictEqual(empOrderCounts.size > 1, true, '180 orders should be split across multiple employees');
  assert.strictEqual(alloc.raw_allocations.length, 180, 'All 180 orders are allocated');

  // Smart Ahmed CS (top capacity) should receive the largest share
  const ahmedCount = empOrderCounts.get('Smart Ahmed CS') || 0;
  const mohamedCount = empOrderCounts.get('Smart Mohamed CS') || 0;
  const aliCount = empOrderCounts.get('Smart Ali CS') || 0;

  assert.strictEqual(ahmedCount >= mohamedCount, true, 'Ahmed receives proportional share based on capacity');
  assert.strictEqual(mohamedCount >= aliCount, true, 'Mohamed receives proportional share based on capacity');

  // Cleanup test employees
  cleanupEmployees();
  cleanTestDate(date);
});

test('Smart Allocation 4: 40-Order Account with High-Capacity Habiba results in 40/40 Habiba (0 Split)', async () => {
  const date = '2026-10-13';
  cleanTestDate(date);

  // Setup Habiba and Mariam in DB
  const habName = 'Smart Habiba CS';
  const marName = 'Smart Mariam CS';

  for (const name of [habName, marName]) {
    const existing = db.prepare('SELECT id FROM employees WHERE name = ? COLLATE NOCASE').get(name);
    if (!existing) {
      db.prepare("INSERT INTO employees (name, department, team_membership, active) VALUES (?, 'CS', 'Both', 1)").run(name);
    } else {
      db.prepare("UPDATE employees SET active = 1, team_membership = 'Both', department = 'CS' WHERE id = ?").run(existing.id);
    }
  }

  const hab = db.prepare('SELECT id, name FROM employees WHERE name = ?').get(habName);
  const mar = db.prepare('SELECT id, name FROM employees WHERE name = ?').get(marName);

  saveWorkingTeam(date, [
    { employee_id: hab.id, is_working: true },
    { employee_id: mar.id, is_working: true }
  ]);

  // Setup performance: Habiba has high historical score & speed, ample capacity
  savePerformanceSnapshotToDB(date, {
    employees: [
      { name: habName, score: 94.0, rate: 1.25, printed: 80, actions: 120, real_actions: 100, pending: 3, cancelled: 1, processing: 1 },
      { name: marName, score: 75.0, rate: 0.85, printed: 45, actions: 70, real_actions: 55, pending: 4, cancelled: 2, processing: 1 }
    ]
  });

  // Account with 40 orders
  const orders = [];
  for (let i = 1; i <= 40; i++) {
    orders.push({
      order_code: `ORD-HAB-40-${i}`,
      account: 'Habiba VIP Account',
      status: 'New'
    });
  }

  stageSpecificOrdersFile(date, 1, 'Habiba40Orders.xlsx', orders);
  mergeSpecificOrdersPool(date);

  const alloc = generateOrderLevelAllocation(date, { regenerate: true });
  assert.strictEqual(alloc.total_orders, 40);

  // 1. Account is NOT split into 30 + 10
  const assignedEmps = new Set(alloc.raw_allocations.map(a => a.employee_name));
  assert.strictEqual(assignedEmps.size, 1, 'Account of 40 orders MUST NOT be split; 30 is only a guideline');

  // 2. All 40 orders are assigned to Habiba
  const chosenName = Array.from(assignedEmps)[0];
  assert.strictEqual(chosenName, habName, 'Habiba must receive 40/40 orders');

  const habOrders = alloc.raw_allocations.filter(a => a.employee_name === habName);
  assert.strictEqual(habOrders.length, 40, 'Habiba receives all 40 orders');

  cleanTestDate(date);
});

test('Smart Allocation 5: Capacity-Aware Decision (Low-Capacity Habiba vs Adequate-Capacity Mariam)', async () => {
  const date = '2026-10-14';
  cleanTestDate(date);

  const habName = 'Smart Habiba CS';
  const marName = 'Smart Mariam CS';

  const hab = db.prepare('SELECT id, name FROM employees WHERE name = ?').get(habName);
  const mar = db.prepare('SELECT id, name FROM employees WHERE name = ?').get(marName);

  saveWorkingTeam(date, [
    { employee_id: hab.id, is_working: true },
    { employee_id: mar.id, is_working: true }
  ]);

  // Setup snapshot where both have performance scores
  savePerformanceSnapshotToDB(date, {
    employees: [
      { name: habName, score: 96.0, rate: 1.30, printed: 80, actions: 120, real_actions: 100, pending: 2, cancelled: 1, processing: 1 },
      { name: marName, score: 78.0, rate: 0.90, printed: 50, actions: 75, real_actions: 60, pending: 3, cancelled: 2, processing: 1 }
    ]
  });

  // Now create two accounts:
  // Account 1: 90 orders pre-assigned or processed by Habiba (filling her capacity)
  // Account 2: 40 orders (new account)
  // In an incremental or multi-account scenario, let's create AccountExisting (80 orders) and AccountNew (40 orders)
  // Since AccountExisting is evaluated first, Habiba gets AccountExisting (80 orders).
  // Now Habiba has remaining capacity = 0 or < 40!
  // When AccountNew (40 orders) is evaluated, Habiba has insufficient remaining capacity, so Mariam gets AccountNew!

  const orders = [];
  // Existing heavy account (90 orders)
  for (let i = 1; i <= 90; i++) {
    orders.push({
      order_code: `ORD-EXISTING-90-${i}`,
      account: 'Existing Heavy Account',
      status: 'New'
    });
  }
  // New account (40 orders)
  for (let i = 1; i <= 40; i++) {
    orders.push({
      order_code: `ORD-NEW-40-${i}`,
      account: 'New 40 Account',
      status: 'New'
    });
  }

  stageSpecificOrdersFile(date, 1, 'CombinedAccounts.xlsx', orders);
  mergeSpecificOrdersPool(date);

  const alloc = generateOrderLevelAllocation(date, { regenerate: true });

  // Verify Account Existing Heavy Account is assigned to Habiba (highest score)
  const existingOwner = alloc.account_owners.find(o => o.account === 'Existing Heavy Account');
  assert.strictEqual(existingOwner.owner_employee_name || existingOwner.employee_name, habName);

  // Verify New 40 Account is assigned to Mariam because Habiba capacity is exhausted
  const newOwner = alloc.account_owners.find(o => o.account === 'New 40 Account');
  assert.strictEqual(newOwner.owner_employee_name || newOwner.employee_name, marName, 'Mariam receives New 40 Account due to available capacity');

  // Verify New 40 Account orders are all assigned to Mariam (40/40)
  const newAccountOrders = alloc.raw_allocations.filter(a => a.account === 'New 40 Account');
  assert.strictEqual(newAccountOrders.length, 40);
  assert.strictEqual(newAccountOrders.every(o => o.employee_name === marName), true, 'All 40 orders go to Mariam');

  // Cleanup
  db.prepare('DELETE FROM employees WHERE name IN (?, ?)').run(habName, marName);
  cleanTestDate(date);
});
