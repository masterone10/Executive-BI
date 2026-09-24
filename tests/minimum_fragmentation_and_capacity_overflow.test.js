import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../db/index.js';
import { generateRoundBasedAllocation } from '../services/allocation.js';
import { getTeamTrackingSummary, getAccountDetailedData, getEmployeeTracking } from '../services/tracking.js';
import { isCsEmployee } from '../services/parser.js';

test('EXECUTIVE-BI: MINIMUM FRAGMENTATION & CONTROLLED OVERFLOW AUDIT', async (t) => {
  const TEST_DATE = '2026-09-24';

  function cleanTestEnvironment() {
    db.prepare('DELETE FROM employee_activity_log WHERE employee_id >= 900').run();
    db.prepare('DELETE FROM employee_lifecycle_audit WHERE employee_id >= 900').run();
    db.prepare('DELETE FROM performance_snapshots WHERE employee_id >= 900').run();
    db.prepare('DELETE FROM allocation_items WHERE employee_id >= 900').run();
    db.prepare('DELETE FROM account_exceptions WHERE employee_id >= 900').run();
    db.prepare('DELETE FROM account_owners WHERE owner_employee_id >= 900 OR work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM order_level_allocations WHERE employee_id >= 900 OR allocation_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM daily_working_team WHERE employee_id >= 900 OR work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(TEST_DATE);
    db.prepare("DELETE FROM employees WHERE id >= 900").run();
  }

  // -------------------------------------------------------------
  // TEST 1: 28 Orders for Same Account -> 1 Employee Intact (Zero Split)
  // -------------------------------------------------------------
  await t.test('1. 28 Orders stays with 1 Employee intact', () => {
    cleanTestEnvironment();

    // 2 CS Employees available
    db.prepare("INSERT INTO employees (id, name, department, team_membership, active) VALUES (901, 'Agent One', 'CS', 'Both', 1)").run();
    db.prepare("INSERT INTO employees (id, name, department, team_membership, active) VALUES (902, 'Agent Two', 'CS', 'Both', 1)").run();
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 901, 1, 'MANUAL')").run(TEST_DATE);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 902, 1, 'MANUAL')").run(TEST_DATE);

    // 28 Orders for AccAlpha
    for (let i = 1; i <= 28; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccAlpha', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-ALPHA-${i}`);
    }

    const alloc = generateRoundBasedAllocation(TEST_DATE, { round_number: 1, standard_capacity: 40 });
    assert.equal(alloc.success, true);
    assert.equal(alloc.unassigned_orders, 0);

    // AccAlpha should belong to EXACTLY 1 employee
    const assignedEmps = alloc.by_employee.filter(e => e.orders_count > 0);
    assert.equal(assignedEmps.length, 1, 'Should allocate to exactly 1 employee');
    assert.equal(assignedEmps[0].orders_count, 28, 'Employee should receive all 28 orders');
  });

  // -------------------------------------------------------------
  // TEST 2: 42 Orders with Qualified Overflow Employee -> 1 Employee Intact
  // -------------------------------------------------------------
  await t.test('2. 42 Orders with Qualified High-Efficiency Employee stays with 1 Employee', () => {
    cleanTestEnvironment();

    // Agent 901 is qualified for overflow (efficiency score 90, sustainable capacity 45)
    db.prepare("INSERT INTO employees (id, name, department, team_membership, active) VALUES (901, 'Agent Star', 'CS', 'Both', 1)").run();
    db.prepare("INSERT INTO employees (id, name, department, team_membership, active) VALUES (902, 'Agent Normal', 'CS', 'Both', 1)").run();
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 901, 1, 'MANUAL')").run(TEST_DATE);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 902, 1, 'MANUAL')").run(TEST_DATE);

    // 42 Orders for AccBeta
    for (let i = 1; i <= 42; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccBeta', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-BETA-${i}`);
    }

    const alloc = generateRoundBasedAllocation(TEST_DATE, {
      round_number: 1,
      standard_capacity: 40,
      max_overflow: 10,
      employee_overflow_eligibility: {
        901: { is_high_efficiency: true, has_sustainable_capacity: true, score: 95 }
      }
    });

    assert.equal(alloc.success, true);
    assert.equal(alloc.unassigned_orders, 0);

    const starEmp = alloc.by_employee.find(e => e.employee_id === 901);
    assert.ok(starEmp);
    assert.equal(starEmp.orders_count, 42, 'Qualified employee should take all 42 orders intact without splitting');
  });

  // -------------------------------------------------------------
  // TEST 3: 42 Orders with Standard Employees Only -> Minimum Split into 2 (40 + 2)
  // -------------------------------------------------------------
  await t.test('3. 42 Orders with Standard Employees splits minimally into 2 employees', () => {
    cleanTestEnvironment();

    db.prepare("INSERT INTO employees (id, name, department, team_membership, active) VALUES (901, 'Agent Regular A', 'CS', 'Both', 1)").run();
    db.prepare("INSERT INTO employees (id, name, department, team_membership, active) VALUES (902, 'Agent Regular B', 'CS', 'Both', 1)").run();
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 901, 1, 'MANUAL')").run(TEST_DATE);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 902, 1, 'MANUAL')").run(TEST_DATE);

    for (let i = 1; i <= 42; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccGamma', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-GAMMA-${i}`);
    }

    const alloc = generateRoundBasedAllocation(TEST_DATE, {
      round_number: 1,
      standard_capacity: 40,
      allow_overflow: false
    });

    assert.equal(alloc.success, true);
    assert.equal(alloc.unassigned_orders, 0);

    const activeEmps = alloc.by_employee.filter(e => e.orders_count > 0);
    assert.equal(activeEmps.length, 2, 'Should split into exactly 2 employees');
    const counts = activeEmps.map(e => e.orders_count).sort((a, b) => b - a);
    assert.deepEqual(counts, [40, 2], 'Should take maximum feasible chunk 40 then 2');
  });

  // -------------------------------------------------------------
  // TEST 4: 100 Orders with Qualified Overflow Employees -> Minimal Split into 2 Employees (50 + 50)
  // -------------------------------------------------------------
  await t.test('4. 100 Orders with Qualified Employees splits minimally into 2 employees (50 + 50)', () => {
    cleanTestEnvironment();

    db.prepare("INSERT INTO employees (id, name, department, team_membership, active) VALUES (901, 'HighPerformer A', 'CS', 'Both', 1)").run();
    db.prepare("INSERT INTO employees (id, name, department, team_membership, active) VALUES (902, 'HighPerformer B', 'CS', 'Both', 1)").run();
    db.prepare("INSERT INTO employees (id, name, department, team_membership, active) VALUES (903, 'HighPerformer C', 'CS', 'Both', 1)").run();
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 901, 1, 'MANUAL')").run(TEST_DATE);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 902, 1, 'MANUAL')").run(TEST_DATE);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 903, 1, 'MANUAL')").run(TEST_DATE);

    for (let i = 1; i <= 100; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccMega', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-MEGA-${i}`);
    }

    const alloc = generateRoundBasedAllocation(TEST_DATE, {
      round_number: 1,
      standard_capacity: 40,
      max_overflow: 10,
      employee_overflow_eligibility: {
        901: { is_high_efficiency: true, has_sustainable_capacity: true, score: 90 },
        902: { is_high_efficiency: true, has_sustainable_capacity: true, score: 90 },
        903: { is_high_efficiency: true, has_sustainable_capacity: true, score: 90 }
      }
    });

    assert.equal(alloc.success, true);
    assert.equal(alloc.unassigned_orders, 0);

    const activeEmps = alloc.by_employee.filter(e => e.orders_count > 0);
    assert.equal(activeEmps.length, 2, 'Should split across exactly 2 employees, NEVER 3, 4, 5, or more');
    assert.equal(activeEmps[0].orders_count, 50);
    assert.equal(activeEmps[1].orders_count, 50);
  });

  // -------------------------------------------------------------
  // TEST 5: Fast Track and Regular Orders for Same Account Stay Together
  // -------------------------------------------------------------
  await t.test('5. Fast Track and Regular Orders for Same Account Stay Together with Same Employee', () => {
    cleanTestEnvironment();

    db.prepare("INSERT INTO employees (id, name, department, team_membership, active) VALUES (901, 'Agent Priority', 'CS', 'Both', 1)").run();
    db.prepare("INSERT INTO employees (id, name, department, team_membership, active) VALUES (902, 'Agent Secondary', 'CS', 'Both', 1)").run();
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 901, 1, 'MANUAL')").run(TEST_DATE);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 902, 1, 'MANUAL')").run(TEST_DATE);

    // 5 Fast Track + 15 Regular = 20 Orders for AccPriority
    for (let i = 1; i <= 5; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, priority, work_state)
        VALUES (?, ?, 'AccPriority', 'New', 'NEW', 'FAST_TRACK', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-FAST-${i}`);
    }
    for (let i = 1; i <= 15; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, priority, work_state)
        VALUES (?, ?, 'AccPriority', 'New', 'NEW', 'REGULAR', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-REG-${i}`);
    }

    const alloc = generateRoundBasedAllocation(TEST_DATE, { round_number: 1, standard_capacity: 40 });
    assert.equal(alloc.success, true);

    const activeEmps = alloc.by_employee.filter(e => e.orders_count > 0);
    assert.equal(activeEmps.length, 1, 'Fast track and regular for same account must stay with 1 employee');
    assert.equal(activeEmps[0].orders_count, 20);

    // Fast Track orders must appear FIRST in the assigned orders array
    const assignedOrders = activeEmps[0].orders;
    const firstFive = assignedOrders.slice(0, 5);
    assert.ok(firstFive.every(o => o.priority === 'FAST_TRACK'), 'Fast track orders must be prioritized first in employee queue');
  });

  // -------------------------------------------------------------
  // TEST 6: Strict Server-Side CS Boundary in Tracking
  // -------------------------------------------------------------
  await t.test('6. Non-CS actors never appear in CS Tracking Summary', () => {
    cleanTestEnvironment();

    // CS Employee
    db.prepare("INSERT INTO employees (id, name, department, team_membership, active) VALUES (901, 'Verified CS', 'CS', 'Both', 1)").run();
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 901, 1, 'MANUAL')").run(TEST_DATE);

    // Non-CS Employee (e.g. Operations / Logistics)
    db.prepare("INSERT INTO employees (id, name, department, team_membership, active) VALUES (905, 'Warehouse Actor', 'LOGISTICS', 'None', 1)").run();

    // Raw log with multiple actors:
    // 1. Verified CS Agent
    db.prepare(`
      INSERT INTO raw_log_records (work_date, order_code, employee_name, action, status, event_datetime)
      VALUES (?, 'ORD-T-1', 'Verified CS', 'حالة الطلب إلى Printed', 'Printed', '2026-09-24 10:00:00')
    `).run(TEST_DATE);

    // 2. Logistics actor
    db.prepare(`
      INSERT INTO raw_log_records (work_date, order_code, employee_name, action, status, event_datetime)
      VALUES (?, 'ORD-T-2', 'Warehouse Actor', 'تم الشحن', 'Shipped', '2026-09-24 11:00:00')
    `).run(TEST_DATE);

    // 3. Completely random system actor not in employees table
    db.prepare(`
      INSERT INTO raw_log_records (work_date, order_code, employee_name, action, status, event_datetime)
      VALUES (?, 'ORD-T-3', 'AutoBot CS Integration', 'Sync Order', 'Synced', '2026-09-24 12:00:00')
    `).run(TEST_DATE);

    const trackingSummary = getTeamTrackingSummary(TEST_DATE);
    const trackingNames = trackingSummary.employees.map(e => e.employee_name);

    assert.ok(trackingNames.includes('Verified CS'), 'Verified CS agent must be in tracking');
    assert.equal(trackingNames.includes('Warehouse Actor'), false, 'Non-CS employee must NOT appear in CS tracking table');
    assert.equal(trackingNames.includes('AutoBot CS Integration'), false, 'External log actor with CS in name must NOT appear in CS tracking table');
  });

  // -------------------------------------------------------------
  // TEST 7: Orders Worked is Strictly COUNT(DISTINCT canonical order_code)
  // -------------------------------------------------------------
  await t.test('7. Orders Worked counts unique orders, not event rows', () => {
    cleanTestEnvironment();

    db.prepare("INSERT INTO employees (id, name, department, team_membership, active) VALUES (901, 'Dedicated CS', 'CS', 'Both', 1)").run();
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 901, 1, 'MANUAL')").run(TEST_DATE);

    // Employee touches the SAME order ORD-DEDICATED 10 times with different events
    for (let i = 1; i <= 10; i++) {
      db.prepare(`
        INSERT INTO raw_log_records (work_date, order_code, employee_name, action, status, event_datetime)
        VALUES (?, 'ORD-DEDICATED', 'Dedicated CS', 'تحديث ملاحظة', 'Pending', datetime('2026-09-24 10:00:00', '+' || ? || ' minutes'))
      `).run(TEST_DATE, i * 5);
    }

    // Touches a 2nd order ORD-SECOND once
    db.prepare(`
      INSERT INTO raw_log_records (work_date, order_code, employee_name, action, status, event_datetime)
      VALUES (?, 'ORD-SECOND', 'Dedicated CS', 'طباعة', 'Printed', '2026-09-24 11:30:00')
    `).run(TEST_DATE);

    const empTracking = getEmployeeTracking(TEST_DATE, 901);
    // Despite 11 event rows in raw_log_records, unique orders worked must be exactly 2!
    assert.equal(empTracking.orders_worked_today, 2, 'orders_worked_today must be exactly COUNT(DISTINCT order_code)');
    assert.ok(empTracking.last_activity_time !== null, 'last_activity_time must be populated');
    assert.ok(empTracking.last_productive_activity_time !== null, 'last_productive_activity_time must be populated');
  });

  cleanTestEnvironment();
});
