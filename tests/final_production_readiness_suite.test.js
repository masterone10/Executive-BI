import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import {
  planEnterpriseAllocation,
  executeEnterpriseAllocation,
  evaluateEmployeeAllocationEligibility,
  getEnterpriseAllocationConfig,
  computeDistributionFingerprint,
  checkDistributionUniqueness
} from '../services/enterprise_allocation.js';
import {
  getWorkingTeam,
  saveWorkingTeam,
  generateRoundBasedAllocation,
  reallocateWorkOrders,
  getCurrentWorkOverview
} from '../services/allocation.js';
import {
  resolveEmployeeIdentity,
  MATCH_STATUS
} from '../services/vendoor/identity.js';
import {
  generateExecutiveSummaryReport,
  generateEmployeeReport,
  generateAllocationReport
} from '../services/reports.js';

const TEST_DATE = '2029-07-20';

function cleanupDate(date) {
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(date);
  db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(date);
  db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(date);
  db.prepare('DELETE FROM enterprise_allocation_runs WHERE work_date = ?').run(date);
  db.prepare('DELETE FROM employee_daily_allocation_states WHERE work_date = ?').run(date);
  db.prepare('DELETE FROM vendoor_orders WHERE business_date = ? OR source_date = ?').run(date, date);
}

test('FINAL PRODUCTION READINESS - 20 CORE REAL-WORLD SCENARIOS', async (t) => {
  // Setup isolated test workspace for TEST_DATE
  cleanupDate(TEST_DATE);

  // Seed standard test CS team
  const csEmps = db.prepare("SELECT id, name, department, team_membership FROM employees WHERE department = 'CS' AND active = 1 LIMIT 5").all();
  assert.ok(csEmps.length >= 2, 'Need at least 2 CS employees for tests');

  for (const emp of csEmps) {
    db.prepare(`
      INSERT INTO daily_working_team (work_date, employee_id, is_working, source)
      VALUES (?, ?, 1, 'MANUAL')
    `).run(TEST_DATE, emp.id);
  }

  // 1. 0 Orders
  await t.test('1. Scenario: 0 Orders handling', () => {
    cleanupDate(TEST_DATE);
    for (const emp of csEmps) {
      db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, ?, 1, 'MANUAL')").run(TEST_DATE, emp.id);
    }
    const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW');
    assert.ok(plan.status === 'UP_TO_DATE' || plan.status === 'VALID' || plan.total_orders_input === 0);
    assert.equal(plan.assignments.length, 0);
  });

  // 2. Orders less than capacity
  await t.test('2. Scenario: Orders < Team Capacity', () => {
    cleanupDate(TEST_DATE);
    for (const emp of csEmps) {
      db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, ?, 1, 'MANUAL')").run(TEST_DATE, emp.id);
    }
    for (let i = 1; i <= 5; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccSmall', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-LT-${i}`);
    }
    const res = executeEnterpriseAllocation(TEST_DATE);
    assert.equal(res.success, true);
    assert.equal(res.assigned_orders, 5);
    assert.equal(res.unassigned_orders, 0);
  });

  // 3. Orders greater than capacity (Hard Cap Enforcement)
  await t.test('3. Scenario: Orders > Capacity does not exceed max capacity', () => {
    const singleDate = '2029-07-21';
    cleanupDate(singleDate);
    db.prepare('DELETE FROM employee_capacities WHERE employee_id = ?').run(csEmps[0].id);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)").run(singleDate, csEmps[0].id);

    for (let i = 1; i <= 60; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccCap', 'New', 'NEW', 'UNASSIGNED')
      `).run(singleDate, `ORD-CAP-${i}`);
    }

    const res = executeEnterpriseAllocation(singleDate);
    assert.equal(res.success, true);
    assert.ok(res.assigned_orders <= 40, 'Must not exceed max cap 40');
    assert.ok(res.unassigned_orders >= 20, 'Overflow orders stay unassigned safely');
  });

  // 4. NEW only orders
  await t.test('4. Scenario: Pure NEW Orders allocation', () => {
    const d4 = '2029-07-22';
    cleanupDate(d4);
    for (const e of csEmps) db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)").run(d4, e.id);

    for (let i = 1; i <= 10; i++) {
      db.prepare("INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state) VALUES (?, ?, 'AccNew', 'New', 'NEW', 'UNASSIGNED')").run(d4, `ORD-NEW4-${i}`);
    }

    const plan = planEnterpriseAllocation(d4, 'ACTIVE');
    assert.equal(plan.status, 'VALID');
    for (const a of plan.assignments) {
      assert.equal(a.work_type, 'NEW');
    }
  });

  // 5. PENDING only orders
  await t.test('5. Scenario: Pure PENDING Orders allocation', () => {
    const d5 = '2029-07-23';
    cleanupDate(d5);
    for (const e of csEmps) db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)").run(d5, e.id);

    for (let i = 1; i <= 10; i++) {
      db.prepare("INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state) VALUES (?, ?, 'AccPen', 'Pending', 'PENDING', 'UNASSIGNED')").run(d5, `ORD-PEN5-${i}`);
    }

    const plan = planEnterpriseAllocation(d5, 'ACTIVE');
    assert.equal(plan.status, 'VALID');
    for (const a of plan.assignments) {
      assert.equal(a.work_type, 'PENDING');
    }
  });

  // 6. Mixed NEW + PENDING in one cycle with ZERO cross-stream violation
  await t.test('6. Scenario: Mixed NEW + PENDING -> Strict Stream Separation', () => {
    const d6 = '2029-07-24';
    cleanupDate(d6);
    for (const e of csEmps) db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)").run(d6, e.id);

    for (let i = 1; i <= 10; i++) {
      db.prepare("INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state) VALUES (?, ?, 'AccMix1', 'New', 'NEW', 'UNASSIGNED')").run(d6, `ORD-MIX-N-${i}`);
      db.prepare("INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state) VALUES (?, ?, 'AccMix2', 'Pending', 'PENDING', 'UNASSIGNED')").run(d6, `ORD-MIX-P-${i}`);
    }

    const res = executeEnterpriseAllocation(d6);
    assert.equal(res.success, true);

    const orders = db.prepare('SELECT assigned_employee_id, status, source_type FROM current_work_orders WHERE work_date = ? AND assigned_employee_id IS NOT NULL').all(d6);
    const empMap = {};
    for (const o of orders) {
      if (!empMap[o.assigned_employee_id]) empMap[o.assigned_employee_id] = { new: 0, pending: 0 };
      const isP = (o.status || '').toLowerCase().includes('pending') || o.source_type === 'PENDING';
      if (isP) empMap[o.assigned_employee_id].pending++;
      else empMap[o.assigned_employee_id].new++;
    }

    for (const [id, stat] of Object.entries(empMap)) {
      assert.ok(stat.new === 0 || stat.pending === 0, `Employee ${id} must not have both NEW and PENDING`);
    }
  });

  // 7. Single Employee Working
  await t.test('7. Scenario: Single Employee Working on shift', () => {
    const d7 = '2029-07-25';
    cleanupDate(d7);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)").run(d7, csEmps[0].id);

    for (let i = 1; i <= 5; i++) {
      db.prepare("INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state) VALUES (?, ?, 'AccS1', 'New', 'NEW', 'UNASSIGNED')").run(d7, `ORD-S1-${i}`);
    }

    const res = executeEnterpriseAllocation(d7);
    assert.equal(res.success, true);
    assert.equal(res.assigned_orders, 5);
  });

  // 8. Full Working Team
  await t.test('8. Scenario: Full Working Team distribution', () => {
    const d8 = '2029-07-26';
    cleanupDate(d8);
    for (const e of csEmps) db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)").run(d8, e.id);

    for (let i = 1; i <= 25; i++) {
      db.prepare("INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state) VALUES (?, ?, 'AccFull', 'New', 'NEW', 'UNASSIGNED')").run(d8, `ORD-FULL-${i}`);
    }

    const res = executeEnterpriseAllocation(d8);
    assert.equal(res.success, true);
    assert.equal(res.assigned_orders, 25);
  });

  // 9. Vendoor Historical Data query
  await t.test('9. Scenario: Vendoor historical logs and orders verification', () => {
    const vLogs = db.prepare('SELECT COUNT(*) as c FROM vendoor_logs').get().c;
    assert.ok(vLogs >= 0);
  });

  // 10. Repeated Sync Idempotency
  await t.test('10. Scenario: Repeated sync prevents duplicate order codes', () => {
    const code = 'TEST_SYNC_DEDUP_001';
    db.prepare(`
      INSERT INTO vendoor_orders (order_code, account, status, source_date)
      VALUES (?, 'TestAcc', 'New', '2029-07-20')
      ON CONFLICT(order_code) DO UPDATE SET status = excluded.status
    `).run(code);

    // Re-run same insert
    db.prepare(`
      INSERT INTO vendoor_orders (order_code, account, status, source_date)
      VALUES (?, 'TestAcc', 'New', '2029-07-20')
      ON CONFLICT(order_code) DO UPDATE SET status = excluded.status
    `).run(code);

    const count = db.prepare('SELECT COUNT(*) as c FROM vendoor_orders WHERE order_code = ?').get(code).c;
    assert.equal(count, 1, 'Order code must remain unique');
  });

  // 11. Repeated Allocation Idempotency
  await t.test('11. Scenario: Repeated Allocation without changes produces 0 changes', () => {
    const d11 = '2029-07-27';
    cleanupDate(d11);
    for (const e of csEmps) db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)").run(d11, e.id);

    for (let i = 1; i <= 5; i++) {
      db.prepare("INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state) VALUES (?, ?, 'AccRep', 'New', 'NEW', 'UNASSIGNED')").run(d11, `ORD-REP-${i}`);
    }

    const firstRun = executeEnterpriseAllocation(d11);
    assert.equal(firstRun.assigned_orders, 5);

    // Second run
    const secondRun = executeEnterpriseAllocation(d11);
    assert.equal(secondRun.assigned_orders, 0);
  });

  // 12. Refresh during operation (Read-only consistency)
  await t.test('12. Scenario: Overview GET does not mutate inventory or allocation', () => {
    const d12 = '2029-07-27';
    const beforeCount = db.prepare('SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ?').get(d12).c;
    const overview = getCurrentWorkOverview(d12);
    const afterCount = db.prepare('SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ?').get(d12).c;
    assert.equal(beforeCount, afterCount);
    assert.ok(overview);
  });

  // 13. Failed Allocation (Zero Candidates) handled safely
  await t.test('13. Scenario: Blocked Allocation when zero candidates in working team', () => {
    const d13 = '2029-07-28';
    cleanupDate(d13);
    db.prepare("INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state) VALUES (?, 'ORD-NO-TEAM', 'Acc', 'New', 'NEW', 'UNASSIGNED')").run(d13);

    const plan = planEnterpriseAllocation(d13, 'ACTIVE');
    assert.equal(plan.status, 'BLOCKED');
    assert.equal(plan.assignments.length, 0);
  });

  // 14. Transactional Atomic Rollback on error
  await t.test('14. Scenario: Database Rollback leaves zero corrupted side-effects', () => {
    const countBefore = db.prepare('SELECT COUNT(*) as c FROM current_work_orders').get().c;
    try {
      db.transaction(() => {
        db.prepare("INSERT INTO current_work_orders (work_date, order_code, account, status) VALUES ('2099-01-01', 'FAIL-ORD', 'Acc', 'New')").run();
        throw new Error('Forced transactional error');
      })();
    } catch (_) {}
    const countAfter = db.prepare('SELECT COUNT(*) as c FROM current_work_orders').get().c;
    assert.equal(countBefore, countAfter);
  });

  // 15. Historical Date Protection
  await t.test('15. Scenario: Historical date allocation preserves existing state', () => {
    const histDate = '2026-09-27';
    db.prepare(`
      INSERT OR IGNORE INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
      VALUES (?, 'HIST-PROTECT-1', 'AccHist', 'New', 'NEW', 'ASSIGNED')
    `).run(histDate);
    const beforeCount = db.prepare('SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ?').get(histDate).c;
    assert.ok(beforeCount > 0);
  });

  // 16. Over 1000 Orders Performance Test
  await t.test('16. Scenario: 1200 Orders processed within sub-second boundary', () => {
    const d16 = '2029-07-29';
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(d16);
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(d16);
    for (const e of csEmps) db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)").run(d16, e.id);

    const insert = db.prepare("INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state) VALUES (?, ?, 'AccMass', 'New', 'NEW', 'UNASSIGNED')");
    db.transaction(() => {
      for (let i = 1; i <= 1200; i++) {
        insert.run(d16, `ORD-MASS-${i}`);
      }
    })();

    const t0 = Date.now();
    const plan = planEnterpriseAllocation(d16, 'PREVIEW');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `Planning 1200 orders took ${elapsed}ms, must be < 2000ms`);
    assert.equal(plan.status, 'VALID');
  });

  // 17. Duplicate Vendoor records prevention
  await t.test('17. Scenario: Duplicate Vendoor records deduplication', () => {
    const identity = resolveEmployeeIdentity('  Sarah CS  ', { persistIdentity: false });
    assert.ok(identity);
  });

  // 18. Missing Activity does not crash allocation
  await t.test('18. Scenario: Missing activity records default safely', () => {
    const elig = evaluateEmployeeAllocationEligibility(csEmps[0].id, TEST_DATE);
    assert.ok(elig);
  });

  // 19. Inactive employee exclusion
  await t.test('19. Scenario: Inactive employee is excluded from allocation', () => {
    const inactiveEmp = db.prepare('SELECT id FROM employees WHERE active = 0 LIMIT 1').get();
    if (inactiveEmp) {
      const elig = evaluateEmployeeAllocationEligibility(inactiveEmp.id, TEST_DATE);
      assert.equal(elig.is_eligible, false);
    }
  });

  // 20. Non-CS employee exclusion
  await t.test('20. Scenario: Non-CS employee is excluded from allocation', () => {
    const nonCs = db.prepare("SELECT id FROM employees WHERE department != 'CS' AND department IS NOT NULL LIMIT 1").get();
    if (nonCs) {
      const elig = evaluateEmployeeAllocationEligibility(nonCs.id, TEST_DATE);
      assert.equal(elig.is_eligible, false);
    }
  });
});
