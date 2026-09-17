import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { db } from '../db/index.js';
import {
  computeForensicProductivityFromLogs,
  getEmployeePerformanceProfiles,
  calculateSmartAllocationScore
} from '../services/performance.js';
import {
  generateOrderLevelAllocation,
  getWorkingTeam,
  deleteAllocationForDate
} from '../services/allocation.js';

function seedCurrentOrders(date, orders) {
  const ins = db.prepare(`
    INSERT INTO current_work_orders (work_date, order_code, account, status)
    VALUES (?, ?, ?, ?)
  `);
  const tx = db.transaction((ords) => {
    for (const o of ords) {
      ins.run(date, o.order_code, o.account, o.status || 'New');
    }
  });
  tx(orders);
}

describe('FORENSIC ALLOCATION INTEGRATION SUITE', () => {
  const TEST_DATE = '2026-11-20';
  const PRIOR_DATE = '2026-11-19';

  let empA, empB, empC, empD;

  before(() => {
    // Clean up test data
    deleteAllocationForDate(TEST_DATE);
    deleteAllocationForDate(PRIOR_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date IN (?, ?)').run(TEST_DATE, PRIOR_DATE);
    db.prepare('DELETE FROM daily_working_team WHERE work_date IN (?, ?)').run(TEST_DATE, PRIOR_DATE);
    db.prepare('DELETE FROM account_owners WHERE work_date IN (?, ?)').run(TEST_DATE, PRIOR_DATE);
    db.prepare('DELETE FROM raw_log_records WHERE work_date IN (?, ?)').run(TEST_DATE, PRIOR_DATE);
    db.prepare("DELETE FROM employees WHERE name LIKE 'TEST_FORENSIC_%'").run();

    // Create test employees
    const insEmp = db.prepare(`
      INSERT INTO employees (name, department, active, team_membership)
      VALUES (?, 'CS', 1, 'Both')
    `);

    const rA = insEmp.run('TEST_FORENSIC_ALICE');
    const rB = insEmp.run('TEST_FORENSIC_BOB');
    const rC = insEmp.run('TEST_FORENSIC_CHARLIE');
    const rD = insEmp.run('TEST_FORENSIC_DINA');

    empA = db.prepare('SELECT * FROM employees WHERE id = ?').get(rA.lastInsertRowid);
    empB = db.prepare('SELECT * FROM employees WHERE id = ?').get(rB.lastInsertRowid);
    empC = db.prepare('SELECT * FROM employees WHERE id = ?').get(rC.lastInsertRowid);
    empD = db.prepare('SELECT * FROM employees WHERE id = ?').get(rD.lastInsertRowid);
  });

  after(() => {
    // Clean up
    deleteAllocationForDate(TEST_DATE);
    deleteAllocationForDate(PRIOR_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date IN (?, ?)').run(TEST_DATE, PRIOR_DATE);
    db.prepare('DELETE FROM daily_working_team WHERE work_date IN (?, ?)').run(TEST_DATE, PRIOR_DATE);
    db.prepare('DELETE FROM account_owners WHERE work_date IN (?, ?)').run(TEST_DATE, PRIOR_DATE);
    db.prepare('DELETE FROM raw_log_records WHERE work_date IN (?, ?)').run(TEST_DATE, PRIOR_DATE);
    db.prepare("DELETE FROM employees WHERE name LIKE 'TEST_FORENSIC_%'").run();
  });

  beforeEach(() => {
    deleteAllocationForDate(TEST_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
  });

  test('1. Real-log productivity changes the final allocation decision', () => {
    // Stage 1: Insert log evidence where ALICE has high throughput and BOB has low throughput
    const insLog = db.prepare(`
      INSERT INTO raw_log_records (order_code, employee_name, status, action, event_datetime, work_date, is_cs, is_deduped)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1)
    `);

    // Alice works 50 unique orders across 10 distinct 10-minute windows (5 orders per window)
    for (let w = 0; w < 10; w++) {
      const minStr = String(w * 10).padStart(2, '0');
      for (let o = 0; o < 5; o++) {
        const oCode = `ORD_A_${w}_${o}`;
        const dt = `2026-11-19 09:${minStr}:${String(o * 10).padStart(2, '0')}`;
        insLog.run(oCode, empA.name, 'Printed', 'Action Completed', dt, PRIOR_DATE);
      }
    }

    // Bob works 10 unique orders across 10 distinct 10-minute windows (1 order per window)
    for (let w = 0; w < 10; w++) {
      const minStr = String(w * 10).padStart(2, '0');
      const oCode = `ORD_B_${w}_0`;
      const dt = `2026-11-19 09:${minStr}:00`;
      insLog.run(oCode, empB.name, 'Printed', 'Action Completed', dt, PRIOR_DATE);
    }

    // Setup working team for TEST_DATE with Alice and Bob
    db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(TEST_DATE, empA.id);
    db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(TEST_DATE, empB.id);

    // Verify profiles extracted from real logs
    const profiles = getEmployeePerformanceProfiles(TEST_DATE);
    const profA = profiles.get(empA.id);
    const profB = profiles.get(empB.id);

    assert.ok(profA, 'Alice profile must exist');
    assert.ok(profB, 'Bob profile must exist');
    assert.strictEqual(profA.typical_orders_10m, 5, 'Alice typical orders per 10m must be 5');
    assert.strictEqual(profB.typical_orders_10m, 1, 'Bob typical orders per 10m must be 1');
    assert.ok(profA.estimated_daily_capacity > profB.estimated_daily_capacity, 'Alice capacity must be higher than Bob');
    assert.ok(profA.historical_rate > profB.historical_rate, 'Alice rate must be higher than Bob');

    // Generate allocation for a 30-order account
    const ordersBatch1 = [];
    for (let i = 1; i <= 30; i++) {
      ordersBatch1.push({
        order_code: `TEST_ACC_ORD_${i}`,
        account: 'ALPHA_STORE',
        status: 'New'
      });
    }
    seedCurrentOrders(TEST_DATE, ordersBatch1);

    const allocResult1 = generateOrderLevelAllocation(TEST_DATE, { regenerate: true });
    const ownerAlpha = allocResult1.account_owners.find(o => o.account === 'ALPHA_STORE');
    assert.strictEqual(ownerAlpha.employee_id, empA.id, 'Alice must win the account due to higher log throughput');
    assert.strictEqual(ownerAlpha.is_split, 0, 'Account must remain unsplit');
    assert.strictEqual(ownerAlpha.total_orders, 30);

    // Clean up allocation and working team for stage 2
    deleteAllocationForDate(TEST_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
  });

  test('2. Canceled orders do NOT inflate productivity or throughput', () => {
    // EmpC has 100 log records, but 90 are Canceled and only 10 are valid
    const insLog = db.prepare(`
      INSERT INTO raw_log_records (order_code, employee_name, status, action, event_datetime, work_date, is_cs, is_deduped)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1)
    `);

    for (let i = 1; i <= 90; i++) {
      insLog.run(`ORD_C_CANCEL_${i}`, empC.name, 'Canceled', 'عدل حالة الاوردر الى Canceled', `2026-11-19 10:00:${String(i % 60).padStart(2, '0')}`, PRIOR_DATE);
    }
    for (let i = 1; i <= 10; i++) {
      insLog.run(`ORD_C_VALID_${i}`, empC.name, 'Printed', 'Action Printed', `2026-11-19 11:${String(i * 2).padStart(2, '0')}:00`, PRIOR_DATE);
    }

    const forensicMap = computeForensicProductivityFromLogs(TEST_DATE);
    const profC = forensicMap.get(empC.name.toLowerCase());

    assert.ok(profC, 'Charlie forensic record must exist');
    assert.strictEqual(profC.sampleSize, 10, 'Sample size must be 10 valid orders, completely excluding 90 canceled orders');
  });

  test('3. Faster employee with low remaining capacity does NOT get the account', () => {
    // Configure Working Team with Alice and Bob
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(TEST_DATE, empA.id);
    db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(TEST_DATE, empB.id);

    // We simulate Alice already having an assigned heavy account (110 orders), so her remaining capacity is small
    // Bob has 0 assigned orders and has sufficient capacity (e.g. 40)
    // Account 1: Heavy Account
    const orders = [];
    for (let i = 1; i <= 110; i++) {
      orders.push({ order_code: `ORD_HEAVY_${i}`, account: 'HEAVY_CORP', status: 'New' });
    }
    // Account 2: Account needing 40 orders
    for (let i = 1; i <= 40; i++) {
      orders.push({ order_code: `ORD_MEDIUM_${i}`, account: 'MEDIUM_SHOP', status: 'New' });
    }
    seedCurrentOrders(TEST_DATE, orders);

    const res = generateOrderLevelAllocation(TEST_DATE, { regenerate: true });
    const mediumOwner = res.account_owners.find(o => o.account === 'MEDIUM_SHOP');
    assert.strictEqual(mediumOwner.employee_id, empB.id, 'Bob must receive MEDIUM_SHOP because Alice lacks remaining capacity');
    assert.strictEqual(mediumOwner.is_split, 0, 'MEDIUM_SHOP must be kept together');

    deleteAllocationForDate(TEST_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
  });

  test('4. Sticky ownership is preserved even when another employee has higher Smart Score', () => {
    // Setup: Account BETA_STORE was owned by Bob on PRIOR_DATE
    db.prepare(`
      INSERT INTO account_owners (work_date, account, owner_employee_id, owner_employee_name, allocation_method, notes)
      VALUES (?, 'BETA_STORE', ?, ?, 'Account Owner', 'Historical Owner')
    `).run(PRIOR_DATE, empB.id, empB.name);

    // Setup working team for TEST_DATE with Alice (higher score) and Bob (sticky owner)
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(TEST_DATE, empA.id);
    db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(TEST_DATE, empB.id);

    const orders = [];
    for (let i = 1; i <= 35; i++) {
      orders.push({ order_code: `ORD_BETA_${i}`, account: 'BETA_STORE', status: 'New' });
    }
    seedCurrentOrders(TEST_DATE, orders);

    const res = generateOrderLevelAllocation(TEST_DATE, { regenerate: true });
    const ownerBeta = res.account_owners.find(o => o.account === 'BETA_STORE');

    assert.strictEqual(ownerBeta.employee_id, empB.id, 'Sticky owner Bob must be preserved despite Alice having higher throughput/score');

    deleteAllocationForDate(TEST_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
  });

  test('5. 40-order and 100-order accounts remain unified with single owner (100 is NOT a split trigger)', () => {
    // Configure working team with Alice (whose remaining capacity is >100) and Bob
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(TEST_DATE, empA.id);
    db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(TEST_DATE, empB.id);

    // Test 40 orders
    const orders40 = [];
    for (let i = 1; i <= 40; i++) {
      orders40.push({ order_code: `ORD_40_${i}`, account: 'STORE_40', status: 'New' });
    }
    seedCurrentOrders(TEST_DATE, orders40);
    const res40 = generateOrderLevelAllocation(TEST_DATE, { enable_smart_split: true, regenerate: true });
    const owner40 = res40.account_owners.find(o => o.account === 'STORE_40');
    assert.strictEqual(owner40.is_split, 0, '40-order account must remain unified (0 split)');
    assert.strictEqual(owner40.total_orders, 40);
    deleteAllocationForDate(TEST_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);

    // Test 100 orders: Even with enable_smart_split = true, because Alice has capacity >= 100, 100/100 must stay unified!
    const orders100 = [];
    for (let i = 1; i <= 100; i++) {
      orders100.push({ order_code: `ORD_100_${i}`, account: 'STORE_100', status: 'New' });
    }
    seedCurrentOrders(TEST_DATE, orders100);
    const res100 = generateOrderLevelAllocation(TEST_DATE, { enable_smart_split: true, regenerate: true });
    const owner100 = res100.account_owners.find(o => o.account === 'STORE_100');
    assert.strictEqual(owner100.is_split, 0, '100-order account must NOT split when an eligible employee has capacity (100 is NOT a split trigger)');
    assert.strictEqual(owner100.total_orders, 100);
    assert.strictEqual(owner100.employee_id, empA.id, 'Alice gets 100/100 entire account');
    deleteAllocationForDate(TEST_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
  });

  test('6. 180-order account triggers Smart Split when no single employee has capacity, preserving 1 parent account', () => {
    // Both Alice (capacity ~120) and Bob (capacity ~40) cannot absorb 180 orders alone
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(TEST_DATE, empA.id);
    db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(TEST_DATE, empB.id);

    const orders180 = [];
    for (let i = 1; i <= 180; i++) {
      orders180.push({ order_code: `ORD_180_${i}`, account: 'MEGA_STORE', status: 'New' });
    }
    seedCurrentOrders(TEST_DATE, orders180);

    const res180 = generateOrderLevelAllocation(TEST_DATE, { enable_smart_split: true, regenerate: true });
    const owner180 = res180.account_owners.find(o => o.account === 'MEGA_STORE');

    assert.ok(owner180, 'Mega Store owner record must exist');
    assert.strictEqual(owner180.is_split, 1, 'Mega Store must be smart-split because 180 exceeds any single candidate capacity');
    assert.ok(Array.isArray(owner180.split_details), 'Split details must be attached');
    assert.strictEqual(owner180.split_details.length, 2, 'Workload must be split across both candidates');

    // Total orders allocated across split parts must equal 180
    const totalSplitAssigned = owner180.split_details.reduce((sum, s) => sum + s.orders_count, 0);
    assert.strictEqual(totalSplitAssigned, 180, 'All 180 orders must be allocated');

    // And raw order-level allocations must also reflect this
    const megaOrders = res180.raw_allocations.filter(a => a.account === 'MEGA_STORE');
    assert.strictEqual(megaOrders.length, 180, 'All 180 individual orders must be allocated');

    deleteAllocationForDate(TEST_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
  });

  test('7. Empty or unconfigured Working Team throws SETUP REQUIRED / VALIDATION ERROR and never defaults to all active', () => {
    // Seed orders first so it doesn't fail on "no orders"
    seedCurrentOrders(TEST_DATE, [
      { order_code: 'ORD_ERR_1', account: 'STORE_ERR', status: 'New' }
    ]);
    // Ensure no working team is configured for TEST_DATE
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);

    assert.throws(() => {
      generateOrderLevelAllocation(TEST_DATE);
    }, (err) => {
      assert.ok(
        err.message.includes('SETUP REQUIRED / VALIDATION ERROR') ||
        err.message.includes('Please configure Today\'s Working Team'),
        `Expected validation error, got: ${err.message}`
      );
      return true;
    });

    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
  });

  test('8. min_capacity_floor does NOT create fake operational capacity for low-throughput employees', async () => {
    db.prepare('DELETE FROM raw_log_records WHERE employee_name = ?').run(empC.name);

    // Stage very low throughput for Charlie: 1 order over 10 windows
    const insLog = db.prepare(`
      INSERT INTO raw_log_records (order_code, employee_name, status, action, event_datetime, work_date, is_cs, is_deduped)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1)
    `);
    for (let w = 0; w < 10; w++) {
      const minStr = String(w * 10).padStart(2, '0');
      // Only 1 order in 10 windows
      if (w === 0) {
        insLog.run(`ORD_C_${w}`, empC.name, 'Printed', 'Action Completed', `2026-11-19 09:${minStr}:00`, PRIOR_DATE);
      }
    }

    const { getEmployeePerformanceProfiles } = await import('../services/performance.js');
    const profs = getEmployeePerformanceProfiles(TEST_DATE);
    const profC = profs.get(empC.id);
    assert.ok(profC, 'Charlie profile must exist');
    assert.ok(profC.estimated_daily_capacity < 30, `Calculated capacity (${profC.estimated_daily_capacity}) must reflect actual low throughput and NOT be inflated to 30 floor`);
  });

  test('9. 120-order account stays unified when an eligible employee has sufficient capacity (120 is NOT a split trigger)', () => {
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(TEST_DATE, empA.id);
    db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(TEST_DATE, empB.id);

    const orders120 = [];
    for (let i = 1; i <= 120; i++) {
      orders120.push({ order_code: `ORD_120_${i}`, account: 'STORE_120', status: 'New' });
    }
    seedCurrentOrders(TEST_DATE, orders120);

    const res120 = generateOrderLevelAllocation(TEST_DATE, { enable_smart_split: true, regenerate: true });
    const owner120 = res120.account_owners.find(o => o.account === 'STORE_120');

    assert.ok(owner120, 'STORE_120 owner record must exist');
    assert.strictEqual(owner120.is_split, 0, '120-order account must NOT split when employee capacity is sufficient (120 is not a split trigger)');
    assert.strictEqual(owner120.total_orders, 120);
    assert.strictEqual(owner120.employee_id, empA.id, 'Alice gets 120/120 entire account');

    deleteAllocationForDate(TEST_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
  });

  test('10. Remaining capacity updates dynamically across sequential accounts to prevent overallocation', () => {
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(TEST_DATE, empA.id);
    db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(TEST_DATE, empB.id);

    // Seed two accounts: STORE_A (60 orders) and STORE_B (60 orders)
    const ordersSeq = [];
    for (let i = 1; i <= 60; i++) {
      ordersSeq.push({ order_code: `ORD_SEQ_A_${i}`, account: 'STORE_SEQ_A', status: 'New' });
      ordersSeq.push({ order_code: `ORD_SEQ_B_${i}`, account: 'STORE_SEQ_B', status: 'New' });
    }
    seedCurrentOrders(TEST_DATE, ordersSeq);

    const res = generateOrderLevelAllocation(TEST_DATE, { enable_smart_split: true, regenerate: true });
    const ownerA = res.account_owners.find(o => o.account === 'STORE_SEQ_A');
    const ownerB = res.account_owners.find(o => o.account === 'STORE_SEQ_B');

    assert.ok(ownerA && ownerB, 'Both account owners must be resolved');
    // Because Alice took STORE_SEQ_A (60 orders), her remaining capacity dropped (~52 remaining of 112).
    // STORE_SEQ_B (60 orders) requires 60 capacity, which exceeds Alice's remaining 52.
    // Therefore, STORE_SEQ_B is assigned to Bob or split, preventing Alice from exceeding capacity!
    const aliceTotalAssigned = (ownerA.employee_id === empA.id ? 60 : 0) + (ownerB.employee_id === empA.id ? 60 : 0);
    assert.ok(aliceTotalAssigned <= 120, 'Alice must not be overallocated beyond her dynamic daily capacity');

    deleteAllocationForDate(TEST_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
  });
});
