import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import { generateRoundBasedAllocation } from '../services/allocation.js';
import { getEmployeeTracking, getEmployeeLiveRealtime, getTeamLiveStatusSummary } from '../services/tracking.js';

test('EXECUTIVE-BI MINIMUM FRAGMENTATION & TRACKING ACCURACY SUITE', async (t) => {
  const TEST_DATE = '2026-11-20';

  // Setup Clean State
  db.prepare('DELETE FROM employees WHERE id IN (801, 802, 803)').run();
  db.prepare("INSERT INTO employees (id, name, department, team_membership, status) VALUES (801, 'Sara CS Pro', 'CS', 'Both', 'active')").run();
  db.prepare("INSERT INTO employees (id, name, department, team_membership, status) VALUES (802, 'Ahmed CS Core', 'CS', 'Both', 'active')").run();
  db.prepare("INSERT INTO employees (id, name, department, team_membership, status) VALUES (803, 'Mohamed CS Pending', 'CS', 'Pending', 'active')").run();

  db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
  db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 801, 1, 'MANUAL')").run(TEST_DATE);
  db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 802, 1, 'MANUAL')").run(TEST_DATE);
  db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 803, 1, 'MANUAL')").run(TEST_DATE);

  // Setup performance snapshot: Sara has verified high throughput (A grade, 45 actions avg)
  db.prepare('DELETE FROM performance_snapshots WHERE employee_id IN (801, 802, 803)').run();
  db.prepare(`
    INSERT INTO performance_snapshots (date, employee_id, employee_name, real_actions, printed_orders, new_orders, efficiency_score, performance_score, grade)
    VALUES (?, 801, 'Sara CS Pro', 48, 24, 24, 90, 88, 'A')
  `).run(TEST_DATE);

  // 1. Account with 28 orders stays intact with 1 employee (No unnecessary splitting)
  await t.test('1. Account with 28 orders stays intact with 1 employee', () => {
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    for (let i = 1; i <= 28; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'Acc28', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD28-${i}`);
    }

    const alloc = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    assert.equal(alloc.success, true);
    const assignedEmps = alloc.by_employee.filter(e => e.orders_count > 0);
    assert.equal(assignedEmps.length, 1, '28 orders should be assigned to exactly 1 employee');
    assert.equal(assignedEmps[0].orders_count, 28);
  });

  // 2. Account with 42 orders stays intact with 1 qualified employee (Controlled overflow)
  await t.test('2. Account with 42 orders stays intact with 1 qualified employee', () => {
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    for (let i = 1; i <= 42; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'Acc42', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD42-${i}`);
    }

    const alloc = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    assert.equal(alloc.success, true);
    const assignedEmps = alloc.by_employee.filter(e => e.orders_count > 0);
    assert.equal(assignedEmps.length, 1, '42 orders should be assigned to 1 qualified employee');
    assert.equal(assignedEmps[0].employee_id, 801);
    assert.equal(assignedEmps[0].orders_count, 42);
  });

  // 3. Account with 80 orders splits into minimum 2 employees (40 + 40, not 4 employees)
  await t.test('3. Account with 80 orders splits into minimum feasible employees', () => {
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    for (let i = 1; i <= 80; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'Acc80', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD80-${i}`);
    }

    const alloc = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    assert.equal(alloc.success, true);
    const assignedEmps = alloc.by_employee.filter(e => e.orders_count > 0);
    assert.equal(assignedEmps.length, 2, '80 orders should be split across minimum feasible 2 employees');
    assert.equal(assignedEmps[0].orders_count + assignedEmps[1].orders_count, 80);
  });

  // 4. Mixed Account (28 New + 10 Pending) preserves stream isolation and round lock
  await t.test('4. Mixed Account (28 New + 10 Pending) preserves stream isolation', () => {
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    for (let i = 1; i <= 28; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccMixed', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-MIX-N-${i}`);
    }
    for (let i = 1; i <= 10; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccMixed', 'Pending Call', 'PENDING', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-MIX-P-${i}`);
    }

    const alloc = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    assert.equal(alloc.success, true);

    // Each assigned employee in Round 1 must only have ONE stream (no NEW + PENDING mix)
    for (const emp of alloc.by_employee) {
      if (emp.orders_count > 0) {
        const hasNew = emp.orders.some(o => (o.source_type === 'NEW' || !o.status.toLowerCase().includes('pending')));
        const hasPend = emp.orders.some(o => (o.source_type === 'PENDING' || o.status.toLowerCase().includes('pending')));
        assert.ok(!(hasNew && hasPend), `Employee ${emp.employee_name} must not be assigned both NEW and PENDING in Round 1`);
      }
    }
  });

  // 5. Tracking Metrics: Orders Worked is COUNT(DISTINCT canonical order_code), not raw log count
  await t.test('5. Orders Worked is distinct canonical order count', () => {
    db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(TEST_DATE);
    
    // Insert 6 lifecycle events on 2 unique orders by Sara CS Pro
    db.prepare(`
      INSERT INTO raw_log_records (work_date, order_code, status, action, employee_name, is_cs, event_datetime)
      VALUES (?, 'ORD-CAN-1', 'New', 'تم المراجعة', 'Sara CS Pro', 1, '2026-11-20 09:00:00')
    `).run(TEST_DATE);
    db.prepare(`
      INSERT INTO raw_log_records (work_date, order_code, status, action, employee_name, is_cs, event_datetime)
      VALUES (?, 'ORD-CAN-1', 'Printed', 'طباعة البوليصة', 'Sara CS Pro', 1, '2026-11-20 09:05:00')
    `).run(TEST_DATE);
    db.prepare(`
      INSERT INTO raw_log_records (work_date, order_code, status, action, employee_name, is_cs, event_datetime)
      VALUES (?, 'ORD-CAN-1', 'Completed', 'تم تسليم الأوردر', 'Sara CS Pro', 1, '2026-11-20 09:10:00')
    `).run(TEST_DATE);

    db.prepare(`
      INSERT INTO raw_log_records (work_date, order_code, status, action, employee_name, is_cs, event_datetime)
      VALUES (?, 'ORD-CAN-2', 'New', 'تم المراجعة', 'Sara CS Pro', 1, '2026-11-20 09:15:00')
    `).run(TEST_DATE);
    db.prepare(`
      INSERT INTO raw_log_records (work_date, order_code, status, action, employee_name, is_cs, event_datetime)
      VALUES (?, 'ORD-CAN-2', 'Printed', 'طباعة البوليصة', 'Sara CS Pro', 1, '2026-11-20 09:20:00')
    `).run(TEST_DATE);

    // Insert an action by a similar name 'Sara CS Pro Senior' — MUST NOT contaminate Sara CS Pro
    db.prepare(`
      INSERT INTO raw_log_records (work_date, order_code, status, action, employee_name, is_cs, event_datetime)
      VALUES (?, 'ORD-CAN-999', 'Printed', 'طباعة البوليصة', 'Sara CS Pro Senior', 1, '2026-11-20 09:25:00')
    `).run(TEST_DATE);

    const tracking = getEmployeeTracking(TEST_DATE, 801);
    assert.equal(tracking.orders_worked_today, 2, 'Orders Worked must be strictly 2 distinct orders (not 5 raw records or contaminated by other agents)');
    assert.equal(tracking.printed_orders, 2);
  });

  // 6. Live Realtime Monitor returns Last Activity, Last Productive Activity, Idle duration & Live Status
  await t.test('6. Live Realtime Monitor returns rich accurate event details', () => {
    const realtime = getEmployeeLiveRealtime(TEST_DATE, { reference_time: '2026-11-20 09:30:00' });
    assert.equal(realtime.work_date, TEST_DATE);
    
    const saraLive = realtime.employees.find(e => e.employee_id === 801);
    assert.ok(saraLive);
    assert.equal(saraLive.working_today, true);
    assert.equal(saraLive.orders_worked_today, 2);
    assert.equal(saraLive.last_activity_order_code, 'ORD-CAN-2');
    assert.equal(saraLive.last_productive_action, 'طباعة البوليصة');
    assert.equal(saraLive.live_status, 'ACTIVE');
    assert.ok(saraLive.idle_seconds >= 0);
    assert.equal(saraLive.idle_duration_formatted, '10m 0s');
  });
});
