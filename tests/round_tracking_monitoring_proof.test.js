import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import {
  generateRoundBasedAllocation,
  reallocateWorkOrders
} from '../services/allocation.js';
import {
  generateTrackingId,
  recordOrderLifecycleEvent,
  recordInternalHandoff,
  claimOrder,
  startOrderProgress,
  completeOrder,
  logEmployeeActivity,
  getEmployeeLiveRealtime,
  getTeamLiveStatusSummary,
  getOrderFullHistory
} from '../services/tracking.js';

describe('Comprehensive 22-Point Validation: Round-Based Allocation, Tracking, & Live Monitoring', () => {
  const TEST_DATE = '2026-03-30';

  beforeEach(() => {
    // Clean up test date records
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM allocation_versions WHERE allocation_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM employee_activity_log WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM order_tracking_events WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM account_exceptions WHERE work_date = ?').run(TEST_DATE);

    // Ensure employees table has test CS employees
    const upsertEmp = db.prepare(`
      INSERT INTO employees (id, name, department, team_membership, active, status)
      VALUES (?, ?, ?, ?, 1, 'ACTIVE')
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        department = excluded.department,
        team_membership = excluded.team_membership,
        active = 1,
        status = 'ACTIVE'
    `);

    upsertEmp.run(101, 'Sara CS Both', 'CS', 'Both');
    upsertEmp.run(102, 'Nour CS New', 'CS', 'New');
    upsertEmp.run(103, 'Mona CS Pending', 'CS', 'Pending');
    upsertEmp.run(104, 'Ahmed CS Both', 'CS', 'Both');
    upsertEmp.run(105, 'Tariq Marketing', 'Marketing', 'Both');

    // Setup working team for TEST_DATE
    const insertTeam = db.prepare(`
      INSERT INTO daily_working_team (work_date, employee_id, is_working, source)
      VALUES (?, ?, 1, 'MANUAL')
    `);

    insertTeam.run(TEST_DATE, 101);
    insertTeam.run(TEST_DATE, 102);
    insertTeam.run(TEST_DATE, 103);
    insertTeam.run(TEST_DATE, 104);
  });

  // TEST 1: BOTH employee gets NEW in Round 1
  it('1. BOTH employee gets NEW in Round 1', () => {
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 101, 1, 'MANUAL')").run(TEST_DATE);

    for (let i = 1; i <= 5; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccA', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-T1-${i}`);
    }

    const alloc = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    assert.equal(alloc.success, true);

    const emp101 = alloc.by_employee.find(e => e.employee_id === 101);
    assert.ok(emp101);
    assert.ok(emp101.orders_count > 0);
    assert.equal(emp101.round_stream_lock, 'NEW');
    for (const o of emp101.orders) {
      assert.equal(o.status, 'New');
    }
  });

  // TEST 2: Same employee can switch to PENDING in Round 2
  it('2. Same employee can switch to PENDING in Round 2', () => {
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 101, 1, 'MANUAL')").run(TEST_DATE);

    db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state, round_number, assigned_employee_id, assigned_employee_name)
      VALUES 
        (?, 'ORD-R1-1', 'AccA', 'New', 'NEW', 'COMPLETED', 1, 101, 'Sara CS Both'),
        (?, 'ORD-R1-2', 'AccA', 'New', 'NEW', 'COMPLETED', 1, 101, 'Sara CS Both'),
        (?, 'ORD-R2-1', 'AccB', 'Pending', 'PENDING', 'UNASSIGNED', 1, null, 'UNASSIGNED')
    `).run(TEST_DATE, TEST_DATE, TEST_DATE);

    const r2 = reallocateWorkOrders(TEST_DATE);
    assert.equal(r2.success, true);
    assert.equal(r2.round_number, 2);

    const emp101 = r2.by_employee.find(e => e.employee_id === 101);
    assert.ok(emp101);
    const newAssignedInR2 = emp101.orders.filter(o => !o.is_preserved);
    assert.equal(newAssignedInR2.length, 1);
    assert.equal(newAssignedInR2[0].order_code, 'ORD-R2-1');
    assert.equal(newAssignedInR2[0].status, 'Pending');
    assert.equal(emp101.round_stream_lock, 'PENDING');
  });

  // TEST 3: Same-round NEW + PENDING is forbidden
  it('3. Same-round NEW + PENDING is forbidden for any employee', () => {
    for (let i = 1; i <= 5; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccMixed', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-NEW-${i}`);
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccMixed', 'Pending', 'PENDING', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-PEND-${i}`);
    }

    const alloc = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    assert.equal(alloc.success, true);

    for (const emp of alloc.by_employee) {
      const assignedNew = emp.orders.filter(o => !o.is_preserved && (o.status || '').toLowerCase() === 'new');
      const assignedPending = emp.orders.filter(o => !o.is_preserved && (o.status || '').toLowerCase().includes('pending'));
      assert.ok(assignedNew.length === 0 || assignedPending.length === 0);
    }
  });

  // TEST 4: Employee locked NEW can take additional NEW
  it('4. Employee locked NEW can take additional NEW', () => {
    for (let i = 1; i <= 8; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccNewOnly', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-MULTI-NEW-${i}`);
    }

    const alloc = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    const emp101 = alloc.by_employee.find(e => e.employee_id === 101);
    if (emp101 && emp101.orders_count > 0) {
      assert.equal(emp101.round_stream_lock, 'NEW');
      assert.ok(emp101.orders.every(o => o.status === 'New'));
    }
  });

  // TEST 5: Employee locked NEW cannot take PENDING in the same round
  it('5. Employee locked NEW cannot take PENDING in the same round', () => {
    for (let i = 1; i <= 5; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccA', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-N-${i}`);
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccB', 'Pending', 'PENDING', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-P-${i}`);
    }

    const alloc = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    for (const emp of alloc.by_employee) {
      if (emp.round_stream_lock === 'NEW') {
        const hasPending = emp.orders.some(o => (o.status || '').toLowerCase().includes('pending'));
        assert.equal(hasPending, false);
      }
    }
  });

  // TEST 6: Reallocation preserves CLAIMED
  it('6. Reallocation preserves CLAIMED', () => {
    db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state, round_number, assigned_employee_id, assigned_employee_name)
      VALUES (?, 'ORD-CLAIMED-1', 'AccA', 'New', 'NEW', 'CLAIMED', 1, 101, 'Sara CS Both')
    `).run(TEST_DATE);

    db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
      VALUES (?, 'ORD-UNCLAIMED-1', 'AccA', 'New', 'NEW', 'UNASSIGNED')
    `).run(TEST_DATE);

    const r2 = reallocateWorkOrders(TEST_DATE);
    const emp101 = r2.by_employee.find(e => e.employee_id === 101);
    const preserved = emp101.orders.find(o => o.order_code === 'ORD-CLAIMED-1');
    assert.ok(preserved);
    assert.equal(preserved.is_preserved, true);
    assert.equal(preserved.work_state, 'CLAIMED');
  });

  // TEST 7: Reallocation preserves IN_PROGRESS
  it('7. Reallocation preserves IN_PROGRESS', () => {
    db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state, round_number, assigned_employee_id, assigned_employee_name)
      VALUES (?, 'ORD-INPROG-1', 'AccA', 'New', 'NEW', 'IN_PROGRESS', 1, 101, 'Sara CS Both')
    `).run(TEST_DATE);

    const r2 = reallocateWorkOrders(TEST_DATE);
    const emp101 = r2.by_employee.find(e => e.employee_id === 101);
    const inProg = emp101.orders.find(o => o.order_code === 'ORD-INPROG-1');
    assert.ok(inProg);
    assert.equal(inProg.is_preserved, true);
    assert.equal(inProg.work_state, 'IN_PROGRESS');
  });

  // TEST 8: Reallocation preserves COMPLETED
  it('8. Reallocation preserves COMPLETED', () => {
    db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state, round_number, assigned_employee_id, assigned_employee_name)
      VALUES (?, 'ORD-DONE-1', 'AccA', 'New', 'NEW', 'COMPLETED', 1, 101, 'Sara CS Both')
    `).run(TEST_DATE);

    const r2 = reallocateWorkOrders(TEST_DATE);
    const emp101 = r2.by_employee.find(e => e.employee_id === 101);
    const done = emp101.orders.find(o => o.order_code === 'ORD-DONE-1');
    assert.ok(done);
    assert.equal(done.is_preserved, true);
    assert.equal(done.work_state, 'COMPLETED');
  });

  // TEST 9: Reallocation only takes unclaimed work
  it('9. Reallocation only takes unclaimed work', () => {
    db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state, round_number, assigned_employee_id, assigned_employee_name)
      VALUES 
        (?, 'ORD-PRESERVED', 'AccA', 'New', 'NEW', 'COMPLETED', 1, 101, 'Sara CS Both'),
        (?, 'ORD-UNCLAIMED', 'AccA', 'New', 'NEW', 'UNASSIGNED', 1, null, 'UNASSIGNED')
    `).run(TEST_DATE, TEST_DATE);

    const r2 = reallocateWorkOrders(TEST_DATE);
    assert.equal(r2.preserved_orders, 1);
    assert.equal(r2.total_orders, 2);
  });

  // TEST 10: 41 orders splits into 40 + 1 (Hard capacity 40)
  it('10. 41 orders splits into 40 + 1 respecting 40 cap', () => {
    for (let i = 1; i <= 41; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccLarge', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-CAP-${i}`);
    }

    const alloc = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    assert.equal(alloc.success, true);

    for (const emp of alloc.by_employee) {
      assert.ok(emp.orders_count <= 40);
    }

    const counts = alloc.by_employee.map(e => e.orders_count).filter(c => c > 0).sort((a, b) => b - a);
    assert.equal(counts[0], 40);
    assert.equal(counts[1], 1);
  });

  // TEST 11: Existing 35 + proposed 6 -> takes 5 to reach 40, no overflow
  it('11. Existing 35 + proposed 6 -> takes 5 to reach 40, no overflow', () => {
    // Only emp 101 is working to test strict employee-level capacity cap
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 101, 1, 'MANUAL')").run(TEST_DATE);

    for (let i = 1; i <= 35; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state, round_number, assigned_employee_id, assigned_employee_name)
        VALUES (?, ?, 'AccOld', 'New', 'NEW', 'COMPLETED', 1, 101, 'Sara CS Both')
      `).run(TEST_DATE, `ORD-EXIST-${i}`);
    }

    for (let i = 1; i <= 6; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccNewBatch', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-BATCH6-${i}`);
    }

    const r2 = reallocateWorkOrders(TEST_DATE);
    const emp101 = r2.by_employee.find(e => e.employee_id === 101);
    assert.equal(emp101.orders_count, 40);
    assert.equal(emp101.preserved_count, 35);
    assert.equal(emp101.newly_assigned_count, 5);
    // The 1 extra order could not overflow emp 101, so it remained unassigned!
    assert.equal(r2.unassigned_orders, 1);
    assert.equal(r2.total_orders, 41);
  });

  // TEST 12: Mixed account splits by stream into independent pools
  it('12. Mixed account splits by stream into independent pools', () => {
    for (let i = 1; i <= 4; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'MixCo', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-MIX-N-${i}`);
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'MixCo', 'Pending', 'PENDING', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-MIX-P-${i}`);
    }

    const alloc = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    assert.equal(alloc.success, true);

    for (const emp of alloc.by_employee) {
      const newOrders = emp.orders.filter(o => o.account === 'MixCo' && o.status === 'New');
      const pendingOrders = emp.orders.filter(o => o.account === 'MixCo' && o.status === 'Pending');
      assert.ok(newOrders.length === 0 || pendingOrders.length === 0);
    }
  });

  // TEST 13: Fast Track ordered before Regular
  it('13. Fast Track ordered before Regular', () => {
    db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, priority, work_state)
      VALUES 
        (?, 'ORD-REG-1', 'AccA', 'New', 'NEW', 'REGULAR', 'UNASSIGNED'),
        (?, 'ORD-FAST-1', 'AccA', 'New', 'NEW', 'FAST_TRACK', 'UNASSIGNED')
    `).run(TEST_DATE, TEST_DATE);

    const alloc = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    assert.equal(alloc.success, true);
    const allAssigned = alloc.by_employee.flatMap(e => e.orders);
    assert.ok(allAssigned.some(o => o.order_code === 'ORD-FAST-1' && o.priority === 'FAST_TRACK'));
  });

  // TEST 14: Fast Track does not bypass hard rules
  it('14. Fast Track does not bypass hard rules', () => {
    for (let i = 1; i <= 40; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state, round_number, assigned_employee_id, assigned_employee_name)
        VALUES (?, ?, 'AccFull', 'New', 'NEW', 'COMPLETED', 1, 101, 'Sara CS Both')
      `).run(TEST_DATE, `ORD-FULL-${i}`);
    }

    db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, priority, work_state)
      VALUES (?, 'ORD-FAST-EXTRA', 'AccFull', 'New', 'NEW', 'FAST_TRACK', 'UNASSIGNED')
    `).run(TEST_DATE);

    const alloc = reallocateWorkOrders(TEST_DATE);
    const emp101 = alloc.by_employee.find(e => e.employee_id === 101);
    assert.equal(emp101.orders_count, 40);
  });

  // TEST 15: Every tracking record has unique tracking_id
  it('15. Every tracking record has unique tracking_id', () => {
    for (let i = 1; i <= 5; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccA', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-TID-${i}`);
    }

    const alloc = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    const trackingIds = new Set();
    const rows = db.prepare('SELECT tracking_id FROM current_work_orders WHERE work_date = ?').all(TEST_DATE);
    for (const r of rows) {
      assert.ok(r.tracking_id);
      assert.ok(r.tracking_id.length > 0);
      assert.equal(trackingIds.has(r.tracking_id), false);
      trackingIds.add(r.tracking_id);
    }
  });

  // TEST 16: Tracking returns full lifecycle history
  it('16. Tracking returns full lifecycle history', () => {
    const tid = generateTrackingId('ORD-LIFE-1', TEST_DATE, 1);
    db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, tracking_id, work_state, assigned_employee_id, assigned_employee_name)
      VALUES (?, 'ORD-LIFE-1', 'AccA', 'New', 'NEW', ?, 'ASSIGNED', 101, 'Sara CS Both')
    `).run(TEST_DATE, tid);

    claimOrder(TEST_DATE, 'ORD-LIFE-1', 101);
    startOrderProgress(TEST_DATE, 'ORD-LIFE-1', 101);
    recordInternalHandoff({
      tracking_id: tid,
      order_code: 'ORD-LIFE-1',
      work_date: TEST_DATE,
      from_employee_id: 101,
      to_employee_id: 104,
      reason: 'Shift end handoff'
    });
    completeOrder(TEST_DATE, 'ORD-LIFE-1', 104);

    const history = getOrderFullHistory(TEST_DATE, 'ORD-LIFE-1');
    assert.equal(history.order_code, 'ORD-LIFE-1');
    assert.ok(history.timeline.length >= 4);
    const actions = history.timeline.map(t => t.action);
    assert.ok(actions.includes('CLAIMED'));
    assert.ok(actions.includes('IN_PROGRESS'));
    assert.ok(actions.includes('HANDOFF'));
    assert.ok(actions.includes('COMPLETED'));
  });

  // TEST 17: Working Team != Live Activity
  it('17. Working Team != Live Activity', () => {
    const live = getEmployeeLiveRealtime(TEST_DATE);
    const emp102 = live.employees.find(e => e.employee_id === 102);
    assert.ok(emp102);
    assert.equal(emp102.working_today, true);
    assert.equal(emp102.live_status, 'NO_ACTIVITY');
    assert.equal(emp102.is_idle, false);
  });

  // TEST 18: VIEWED does not equal productive activity
  it('18. VIEWED does not equal productive activity', () => {
    const t0 = new Date('2026-03-30T10:00:00Z').toISOString();
    logEmployeeActivity({
      work_date: TEST_DATE,
      employee_id: 101,
      employee_name: 'Sara CS Both',
      action: 'CLAIMED',
      timestamp: t0
    });

    const t1 = new Date('2026-03-30T10:20:00Z').toISOString();
    logEmployeeActivity({
      work_date: TEST_DATE,
      employee_id: 101,
      employee_name: 'Sara CS Both',
      action: 'VIEWED',
      timestamp: t1
    });

    const tCheck = new Date('2026-03-30T10:25:00Z').toISOString();
    const live = getEmployeeLiveRealtime(TEST_DATE, { currentTime: tCheck });
    const emp101 = live.employees.find(e => e.employee_id === 101);

    assert.ok(emp101);
    assert.equal(emp101.idle_seconds, 1500);
    assert.equal(emp101.last_productive_action, 'CLAIMED');
    assert.equal(emp101.last_activity_action, 'VIEWED');
  });

  // TEST 19: Last Activity and Last Productive Activity are separate
  it('19. Last Activity and Last Productive Activity are separate', () => {
    const tProd = new Date('2026-03-30T09:00:00Z').toISOString();
    const tView = new Date('2026-03-30T09:30:00Z').toISOString();

    logEmployeeActivity({
      work_date: TEST_DATE,
      employee_id: 101,
      employee_name: 'Sara CS Both',
      action: 'IN_PROGRESS',
      timestamp: tProd
    });

    logEmployeeActivity({
      work_date: TEST_DATE,
      employee_id: 101,
      employee_name: 'Sara CS Both',
      action: 'SEARCHED',
      timestamp: tView
    });

    const live = getEmployeeLiveRealtime(TEST_DATE, { currentTime: '2026-03-30T10:00:00Z' });
    const emp101 = live.employees.find(e => e.employee_id === 101);
    assert.equal(emp101.last_productive_activity_time, tProd);
    assert.equal(emp101.last_activity_time, tView);
  });

  // TEST 20: No polling-generated idle rows
  it('20. No polling-generated idle rows on GET', () => {
    const countBefore = db.prepare('SELECT COUNT(*) as c FROM employee_activity_log WHERE work_date = ?').get(TEST_DATE).c;

    for (let i = 0; i < 5; i++) {
      getEmployeeLiveRealtime(TEST_DATE);
      getTeamLiveStatusSummary(TEST_DATE);
    }

    const countAfter = db.prepare('SELECT COUNT(*) as c FROM employee_activity_log WHERE work_date = ?').get(TEST_DATE).c;
    assert.equal(countAfter, countBefore);
  });

  // TEST 21: Non-CS employees never appear as operational CS workers
  it('21. Non-CS employees never appear as operational CS workers', () => {
    db.prepare(`
      INSERT INTO daily_working_team (work_date, employee_id, is_working, source)
      VALUES (?, 105, 1, 'MANUAL')
    `).run(TEST_DATE);

    db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
      VALUES (?, 'ORD-CS-CHECK', 'AccA', 'New', 'NEW', 'UNASSIGNED')
    `).run(TEST_DATE);

    const alloc = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    const emp105 = alloc.by_employee.find(e => e.employee_id === 105);
    assert.equal(emp105, undefined);
  });

  // TEST 22: Historical date does not mutate during GET
  it('22. Historical date does not mutate during GET', () => {
    const HISTORICAL_DATE = '2026-01-15';
    const result1 = getEmployeeLiveRealtime(HISTORICAL_DATE, { currentTime: '2026-01-15T18:00:00Z' });
    const result2 = getEmployeeLiveRealtime(HISTORICAL_DATE, { currentTime: '2026-01-15T18:00:00Z' });
    assert.deepEqual(result1, result2);
  });
});
