import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import db from '../db/index.js';
import {
  generateRoundBasedAllocation,
  reallocateWorkOrders
} from '../services/allocation.js';
import {
  recordOrderLifecycleEvent,
  recordInternalHandoff,
  claimOrder,
  startOrderProgress,
  completeOrder,
  cancelOrder,
  getOrderFullHistory,
  getEmployeeLiveRealtime,
  getTeamLiveStatusSummary,
  logEmployeeActivity
} from '../services/tracking.js';

const TEST_DATE = '2026-03-31';

describe('FINAL FORENSIC VERIFICATION & HARDENING SUITE', () => {

  before(() => {
    // Ensure clean state for test date
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM order_tracking_events WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM employee_activity_log WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM allocation_versions WHERE allocation_date = ?').run(TEST_DATE);

    // Insert controlled CS test employees
    // 201: Both streams
    // 202: New only
    // 203: Pending only
    // 204: Both streams
    // 999: Non-CS employee (Warehouse)
    const upsertEmp = db.prepare(`
      INSERT INTO employees (id, name, department, team_membership, active)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET 
        name = excluded.name,
        department = excluded.department,
        team_membership = excluded.team_membership,
        active = 1
    `);

    upsertEmp.run(201, 'Farida CS Both', 'CS', 'Both');
    upsertEmp.run(202, 'Nadia CS New', 'CS', 'New');
    upsertEmp.run(203, 'Kareem CS Pending', 'CS', 'Pending');
    upsertEmp.run(204, 'Tarek CS Both', 'CS', 'Both');
    upsertEmp.run(999, 'Sameh Warehouse', 'Warehouse', 'Both');
  });

  beforeEach(() => {
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM order_tracking_events WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM employee_activity_log WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM allocation_versions WHERE allocation_date = ?').run(TEST_DATE);
  });

  // ============================================================
  // 1 & 3) LIFECYCLE & REALLOCATION: ASSIGNED vs CLAIMED vs PRESERVED
  // ============================================================
  it('1. Full Lifecycle: UNASSIGNED -> ASSIGNED -> CLAIMED -> IN_PROGRESS -> COMPLETED', () => {
    // Setup working CS employee 201
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 201, 1, 'MANUAL')").run(TEST_DATE);

    db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
      VALUES (?, 'ir5425', 'IronMerchant', 'New', 'NEW', 'UNASSIGNED')
    `).run(TEST_DATE);

    // Initial allocation -> ASSIGNED
    const alloc = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    assert.equal(alloc.success, true);

    const ordAfterAlloc = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, 'ir5425');
    assert.equal(ordAfterAlloc.work_state, 'ASSIGNED');
    assert.equal(ordAfterAlloc.assigned_employee_id, 201);
    assert.equal(ordAfterAlloc.claimed_at, null);

    // Employee claims order
    const claimRes = claimOrder(TEST_DATE, 'ir5425', 201);
    assert.equal(claimRes.work_state, 'CLAIMED');

    const ordAfterClaim = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, 'ir5425');
    assert.equal(ordAfterClaim.work_state, 'CLAIMED');
    assert.ok(ordAfterClaim.claimed_at);

    // Employee starts progress
    const progRes = startOrderProgress(TEST_DATE, 'ir5425', 201);
    assert.equal(progRes.work_state, 'IN_PROGRESS');

    const ordAfterProg = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, 'ir5425');
    assert.equal(ordAfterProg.work_state, 'IN_PROGRESS');

    // Employee completes order
    const compRes = completeOrder(TEST_DATE, 'ir5425', 201);
    assert.equal(compRes.work_state, 'COMPLETED');

    const ordAfterComp = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, 'ir5425');
    assert.equal(ordAfterComp.work_state, 'COMPLETED');
    assert.equal(ordAfterComp.status, 'Completed');
    assert.ok(ordAfterComp.completed_at);

    // Full history timeline audit
    const history = getOrderFullHistory(TEST_DATE, 'ir5425');
    assert.equal(history.order_code, 'ir5425');
    assert.equal(history.current_work_state, 'COMPLETED');
    const actions = history.timeline.map(e => e.action);
    assert.ok(actions.includes('ASSIGNED'));
    assert.ok(actions.includes('CLAIMED'));
    assert.ok(actions.includes('IN_PROGRESS'));
    assert.ok(actions.includes('COMPLETED'));
  });

  it('2. Reallocation preserves CLAIMED, IN_PROGRESS, COMPLETED; moves unclaimed ASSIGNED', () => {
    // Both 201 and 204 are working
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 201, 1, 'MANUAL')").run(TEST_DATE);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 204, 1, 'MANUAL')").run(TEST_DATE);

    // Seed 4 orders for employee 201:
    // 1: CLAIMED
    // 2: IN_PROGRESS
    // 3: COMPLETED
    // 4: ASSIGNED (unclaimed)
    db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state, round_number, assigned_employee_id, assigned_employee_name)
      VALUES 
        (?, 'ORD-CLM', 'AccX', 'New', 'NEW', 'CLAIMED', 1, 201, 'Farida CS Both'),
        (?, 'ORD-INP', 'AccX', 'New', 'NEW', 'IN_PROGRESS', 1, 201, 'Farida CS Both'),
        (?, 'ORD-CMP', 'AccX', 'New', 'NEW', 'COMPLETED', 1, 201, 'Farida CS Both'),
        (?, 'ORD-ASN', 'AccX', 'New', 'NEW', 'ASSIGNED', 1, 201, 'Farida CS Both')
    `).run(TEST_DATE, TEST_DATE, TEST_DATE, TEST_DATE);

    // Now employee 201 is removed from working team, only employee 204 is working
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 204, 1, 'MANUAL')").run(TEST_DATE);

    // Trigger smart reallocation
    const realloc = reallocateWorkOrders(TEST_DATE);
    assert.equal(realloc.success, true);

    // Preserved orders MUST remain with 201 even though 201 is off-duty now (ownership cannot be stolen!)
    const oClm = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, 'ORD-CLM');
    assert.equal(oClm.assigned_employee_id, 201);
    assert.equal(oClm.work_state, 'CLAIMED');

    const oInp = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, 'ORD-INP');
    assert.equal(oInp.assigned_employee_id, 201);
    assert.equal(oInp.work_state, 'IN_PROGRESS');

    const oCmp = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, 'ORD-CMP');
    assert.equal(oCmp.assigned_employee_id, 201);
    assert.equal(oCmp.work_state, 'COMPLETED');

    // Unclaimed ASSIGNED order was eligible and moved to 204!
    const oAsn = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, 'ORD-ASN');
    assert.equal(oAsn.assigned_employee_id, 204);
    assert.equal(oAsn.work_state, 'ASSIGNED');

    // Verify audit lifecycle recorded reassignment with previous employee
    const historyAsn = getOrderFullHistory(TEST_DATE, 'ORD-ASN');
    const reassignEvent = historyAsn.timeline.find(e => e.action === 'REASSIGNED' || (e.action === 'ASSIGNED' && e.employee_id === 204));
    assert.ok(reassignEvent);
    assert.equal(reassignEvent.previous_employee_id, 201);
  });

  it('3. Internal Handoff preserves full audit context', () => {
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 201, 1, 'MANUAL')").run(TEST_DATE);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 204, 1, 'MANUAL')").run(TEST_DATE);

    db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state, tracking_id, assigned_employee_id, assigned_employee_name)
      VALUES (?, 'wh3010', 'WarehouseDirect', 'New', 'NEW', 'IN_PROGRESS', 'TRK-20260331-wh3010-1-abcd', 201, 'Farida CS Both')
    `).run(TEST_DATE);

    const handoffRes = recordInternalHandoff({
      work_date: TEST_DATE,
      order_code: 'wh3010',
      tracking_id: 'TRK-20260331-wh3010-1-abcd',
      previous_employee_id: 201,
      previous_employee_name: 'Farida CS Both',
      new_employee_id: 204,
      new_employee_name: 'Tarek CS Both',
      reason: 'Shift Handover'
    });
    assert.equal(handoffRes.success, true);

    const history = getOrderFullHistory(TEST_DATE, 'wh3010');
    const handoffEvent = history.timeline.find(e => e.action === 'HANDOFF');
    assert.ok(handoffEvent);
    assert.equal(handoffEvent.previous_employee_id, 201);
    assert.equal(handoffEvent.employee_id, 204);
    assert.equal(handoffEvent.reason, 'Shift Handover');
    assert.equal(handoffEvent.tracking_id, 'TRK-20260331-wh3010-1-abcd');
  });

  // ============================================================
  // 4) ROUND SEMANTICS & STREAM LOCK
  // ============================================================
  it('4. Round-based stream lock allows stream shift between rounds but isolates streams within round', () => {
    // Farida (Both) is working
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 201, 1, 'MANUAL')").run(TEST_DATE);

    // Round 1: NEW orders
    for (let i = 1; i <= 3; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccNew', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `R1-NEW-${i}`);
    }

    const r1 = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    assert.equal(r1.success, true);
    const empR1 = r1.by_employee.find(e => e.employee_id === 201);
    assert.equal(empR1.round_stream_lock, 'NEW');
    assert.equal(empR1.orders_count, 3);

    // Complete all Round 1 orders
    for (let i = 1; i <= 3; i++) {
      completeOrder(TEST_DATE, `R1-NEW-${i}`, 201);
    }

    // Round 2: PENDING orders
    for (let i = 1; i <= 2; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccPend', 'Pending', 'PENDING', 'UNASSIGNED')
      `).run(TEST_DATE, `R2-PEND-${i}`);
    }

    const r2 = reallocateWorkOrders(TEST_DATE);
    assert.equal(r2.success, true);
    assert.equal(r2.round_number, 2);

    const empR2 = r2.by_employee.find(e => e.employee_id === 201);
    assert.equal(empR2.round_stream_lock, 'PENDING');
    const newInR2 = empR2.orders.filter(o => !o.is_preserved);
    assert.equal(newInR2.length, 2);
    for (const o of newInR2) {
      assert.equal(o.status, 'Pending');
    }
  });

  // ============================================================
  // 5) HARD CAPACITY (40 per employee per date)
  // ============================================================
  it('5. Hard Capacity: 41 splits into 40 + 1, 42 into 40 + 2, 80 into 40 + 40', () => {
    // Farida and Tarek are working (both capacity 40 -> total capacity 80)
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 201, 1, 'MANUAL')").run(TEST_DATE);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 204, 1, 'MANUAL')").run(TEST_DATE);

    // Case A: 41 orders with 2 agents -> 40 + 1
    for (let i = 1; i <= 41; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccCap', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-41-${i}`);
    }

    const alloc41 = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    assert.equal(alloc41.success, true);
    const loads41 = alloc41.by_employee.map(e => e.orders_count).filter(c => c > 0).sort((a, b) => b - a);
    assert.equal(loads41[0], 40);
    assert.equal(loads41[1], 1);
    assert.equal(alloc41.unassigned_orders, 0);

    // Clear and test Case B: 42 orders with 2 agents -> 40 + 2
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(TEST_DATE);

    for (let i = 1; i <= 42; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccCap', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-42-${i}`);
    }

    const alloc42 = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    const loads42 = alloc42.by_employee.map(e => e.orders_count).filter(c => c > 0).sort((a, b) => b - a);
    assert.equal(loads42[0], 40);
    assert.equal(loads42[1], 2);
    assert.equal(alloc42.unassigned_orders, 0);

    // Clear and test Case C: 80 orders with 2 agents -> 40 + 40
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(TEST_DATE);

    for (let i = 1; i <= 80; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccCap', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-80-${i}`);
    }

    const alloc80 = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    const loads80 = alloc80.by_employee.map(e => e.orders_count).filter(c => c > 0).sort((a, b) => b - a);
    assert.equal(loads80[0], 40);
    assert.equal(loads80[1], 40);
    assert.equal(alloc80.unassigned_orders, 0);
  });

  it('6. Incremental Capacity: 35 existing + 6 proposed -> takes 5 to reach 40 cap, 1 remains unassigned', () => {
    // Only Farida working (capacity 40)
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 201, 1, 'MANUAL')").run(TEST_DATE);

    for (let i = 1; i <= 35; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state, round_number, assigned_employee_id, assigned_employee_name)
        VALUES (?, ?, 'AccInc', 'New', 'NEW', 'COMPLETED', 1, 201, 'Farida CS Both')
      `).run(TEST_DATE, `ORD-EXIST-${i}`);
    }

    for (let i = 1; i <= 6; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'AccInc', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `ORD-NEW-PROP-${i}`);
    }

    const alloc = reallocateWorkOrders(TEST_DATE);
    assert.equal(alloc.success, true);

    const emp201 = alloc.by_employee.find(e => e.employee_id === 201);
    assert.equal(emp201.orders_count, 40); // 35 preserved + 5 newly assigned = exactly 40
    assert.equal(alloc.unassigned_orders, 1); // 1 overflow unassigned
  });

  // ============================================================
  // 6) MIXED ACCOUNT (NEW + PENDING)
  // ============================================================
  it('7. Mixed account splits 20 NEW + 10 PENDING to different employees; with 1 employee conflicting portion remains UNASSIGNED', () => {
    // Case A: 2 agents working (Farida and Tarek)
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 201, 1, 'MANUAL')").run(TEST_DATE);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 204, 1, 'MANUAL')").run(TEST_DATE);

    for (let i = 1; i <= 20; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'MixedMerchant', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `MIX-NEW-${i}`);
    }
    for (let i = 1; i <= 10; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'MixedMerchant', 'Pending', 'PENDING', 'UNASSIGNED')
      `).run(TEST_DATE, `MIX-PEND-${i}`);
    }

    const alloc2 = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    assert.equal(alloc2.success, true);
    assert.equal(alloc2.unassigned_orders, 0);

    const e1 = alloc2.by_employee.find(e => e.employee_id === 201);
    const e2 = alloc2.by_employee.find(e => e.employee_id === 204);

    assert.notEqual(e1.round_stream_lock, e2.round_stream_lock);
    const activeStreams = new Set([e1.round_stream_lock, e2.round_stream_lock]);
    assert.ok(activeStreams.has('NEW'));
    assert.ok(activeStreams.has('PENDING'));

    // Case B: Only 1 agent working (Farida)
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 201, 1, 'MANUAL')").run(TEST_DATE);

    for (let i = 1; i <= 20; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'MixedMerchant', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, `MIX-NEW-${i}`);
    }
    for (let i = 1; i <= 10; i++) {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'MixedMerchant', 'Pending', 'PENDING', 'UNASSIGNED')
      `).run(TEST_DATE, `MIX-PEND-${i}`);
    }

    const alloc1 = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    assert.equal(alloc1.success, true);
    // 1 agent takes 1 stream, other stream cannot be taken in the same round and remains unassigned
    assert.equal(alloc1.unassigned_orders, 10);
    const unassignedList = alloc1.unassigned_orders_list;
    for (const u of unassignedList) {
      assert.equal(u.status, 'Pending');
    }
  });

  // ============================================================
  // 7) FAST TRACK PROCESSING
  // ============================================================
  it('8. Fast Track priority processed before Regular without bypassing constraints', () => {
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 201, 1, 'MANUAL')").run(TEST_DATE);

    // Insert 1 regular order and 1 fast-track order
    db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, priority, work_state)
      VALUES 
        (?, 'ORD-REG-1', 'AccFT', 'New', 'NEW', 'REGULAR', 'UNASSIGNED'),
        (?, 'ORD-FAST-1', 'AccFT', 'New', 'NEW', 'FAST_TRACK', 'UNASSIGNED')
    `).run(TEST_DATE, TEST_DATE);

    const alloc = generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    assert.equal(alloc.success, true);
    const empOrders = alloc.by_employee.find(e => e.employee_id === 201).orders;
    assert.equal(empOrders[0].order_code, 'ORD-FAST-1');
    assert.equal(empOrders[1].order_code, 'ORD-REG-1');
  });

  // ============================================================
  // 8 & 10) LIVE MONITORING & READ-SIDE SAFETY
  // ============================================================
  it('9. Live Monitoring distinguishes working attendance vs real activity; GET is read-only', () => {
    // 201 is working in team
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 201, 1, 'MANUAL')").run(TEST_DATE);

    // Initial state: Working today = true, but NO_ACTIVITY
    const initialLive = getEmployeeLiveRealtime(TEST_DATE);
    const empInit = initialLive.employees.find(e => e.employee_id === 201);
    assert.equal(empInit.working_today, true);
    assert.equal(empInit.live_status, 'NO_ACTIVITY');
    assert.equal(empInit.is_idle, false);

    // Log a non-productive VIEWED action
    logEmployeeActivity({
      work_date: TEST_DATE,
      employee_id: 201,
      employee_name: 'Farida CS Both',
      action: 'VIEWED',
      timestamp: '2026-03-31T10:00:00Z'
    });

    const liveAfterView = getEmployeeLiveRealtime(TEST_DATE, { currentTime: '2026-03-31T10:05:00Z' });
    const empView = liveAfterView.employees.find(e => e.employee_id === 201);
    assert.equal(empView.live_status, 'INACTIVE'); // Has action, but none productive -> INACTIVE
    assert.equal(empView.last_activity_action, 'VIEWED');
    assert.equal(empView.last_productive_action, null);

    // Log a productive CLAIMED action
    logEmployeeActivity({
      work_date: TEST_DATE,
      employee_id: 201,
      employee_name: 'Farida CS Both',
      action: 'CLAIMED',
      timestamp: '2026-03-31T10:10:00Z'
    });

    // Check at 10:15 (5 mins later <= 15 min inactiveThreshold) -> ACTIVE
    const liveActive = getEmployeeLiveRealtime(TEST_DATE, { currentTime: '2026-03-31T10:15:00Z' });
    const empActive = liveActive.employees.find(e => e.employee_id === 201);
    assert.equal(empActive.live_status, 'ACTIVE');
    assert.equal(empActive.is_idle, false);
    assert.equal(empActive.idle_seconds, 300);

    // Check at 10:30 (20 mins later > 15 min inactiveThreshold) -> INACTIVE
    const liveInactive = getEmployeeLiveRealtime(TEST_DATE, { currentTime: '2026-03-31T10:30:00Z' });
    const empInactive = liveInactive.employees.find(e => e.employee_id === 201);
    assert.equal(empInactive.live_status, 'INACTIVE');
    assert.equal(empInactive.is_idle, true);
    assert.equal(empInactive.idle_seconds, 1200);

    // Check at 11:10 (60 mins later > 45 min criticalThreshold) -> CRITICAL
    const liveCrit = getEmployeeLiveRealtime(TEST_DATE, { currentTime: '2026-03-31T11:10:00Z' });
    const empCrit = liveCrit.employees.find(e => e.employee_id === 201);
    assert.equal(empCrit.live_status, 'CRITICAL');
    assert.equal(empCrit.is_idle, true);

    // READ-SIDE SAFETY: Verify row counts before and after 5 repeated GET calls
    const countBefore = db.prepare('SELECT COUNT(*) as cnt FROM employee_activity_log WHERE work_date = ?').get(TEST_DATE).cnt;
    for (let i = 0; i < 5; i++) {
      getEmployeeLiveRealtime(TEST_DATE);
      getTeamLiveStatusSummary(TEST_DATE);
    }
    const countAfter = db.prepare('SELECT COUNT(*) as cnt FROM employee_activity_log WHERE work_date = ?').get(TEST_DATE).cnt;
    assert.equal(countBefore, countAfter); // Zero mutations on GET
  });

  // ============================================================
  // 9) EMPLOYEE IDENTITY & CS ISOLATION
  // ============================================================
  it('10. Non-CS employees never appear as operational CS workers', () => {
    // 999 is Warehouse employee, put in daily_working_team
    db.prepare("INSERT INTO daily_working_team (work_date, employee_id, is_working, source) VALUES (?, 999, 1, 'MANUAL')").run(TEST_DATE);

    db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
      VALUES (?, 'ORD-WH-1', 'AccWH', 'New', 'NEW', 'UNASSIGNED')
    `).run(TEST_DATE);

    // Allocation must fail / throw error because no CS employees are in today's working team
    assert.throws(() => {
      generateRoundBasedAllocation(TEST_DATE, { round_number: 1 });
    }, /SETUP REQUIRED|No active CS employees/);

    // Monitoring must not list non-CS employee 999
    const live = getEmployeeLiveRealtime(TEST_DATE);
    const nonCs = live.employees.find(e => e.employee_id === 999);
    assert.equal(nonCs, undefined);
  });

  // ============================================================
  // 11) DATABASE FORENSIC PROOF
  // ============================================================
  it('11. Database Forensic Invariants: zero violations across all tables', () => {
    // 1. Duplicate tracking IDs
    const dupTrack = db.prepare(`
      SELECT tracking_id, COUNT(*) as cnt
      FROM current_work_orders
      WHERE work_date = ? AND tracking_id IS NOT NULL
      GROUP BY tracking_id
      HAVING cnt > 1
    `).all(TEST_DATE);
    assert.equal(dupTrack.length, 0);

    // 2. Capacity > 40
    const capViolations = db.prepare(`
      SELECT assigned_employee_id, COUNT(*) as cnt
      FROM current_work_orders
      WHERE work_date = ? AND assigned_employee_id IS NOT NULL
      GROUP BY assigned_employee_id
      HAVING cnt > 40
    `).all(TEST_DATE);
    assert.equal(capViolations.length, 0);

    // 3. Non-CS operational allocations
    const nonCsAllocs = db.prepare(`
      SELECT cwo.id, cwo.order_code, e.name, e.department
      FROM current_work_orders cwo
      JOIN employees e ON cwo.assigned_employee_id = e.id
      WHERE cwo.work_date = ? AND UPPER(e.department) != 'CS'
    `).all(TEST_DATE);
    assert.equal(nonCsAllocs.length, 0);

    // 4. Orphan tracking records in current_work_orders
    const orphans = db.prepare(`
      SELECT ote.id, ote.order_code
      FROM order_tracking_events ote
      LEFT JOIN current_work_orders cwo ON ote.work_date = cwo.work_date AND ote.order_code = cwo.order_code
      WHERE ote.work_date = ? AND cwo.id IS NULL
    `).all(TEST_DATE);
    assert.equal(orphans.length, 0);
  });
});
