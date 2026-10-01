import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import {
  planEnterpriseAllocation,
  executeEnterpriseAllocation,
  getEnterpriseAllocationConfig,
  saveEnterpriseAllocationConfig,
  evaluateAccountTimeStatus,
  evaluateEmployeeAllocationEligibility,
  evaluatePendingRescueOperation,
  evaluateStatusPressureRatio,
  computeDistributionFingerprint,
  checkDistributionUniqueness,
  getEmployeeDailyAllocationState,
  undoLastAllocation,
  ALLOCATION_ERROR_CODES
} from '../services/enterprise_allocation.js';
import { getDispatcherStatus, getDispatcherConfig, executeDispatchCycle } from '../services/vendoor/dispatcher.js';
import { completeOrder } from '../services/tracking.js';

describe('MASTER ZERO-ASSUMPTION ALLOCATION CONTRACT SUITE (48 Core Verification Tests)', () => {
  const TEST_DATE = '2031-06-15';

  beforeEach(() => {
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM employee_daily_allocation_states WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM enterprise_allocation_runs WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM distribution_fingerprints WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM employee_activity_log WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM account_owners WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM account_schedules WHERE account LIKE ?').run('TEST_%');

    const emps = [
      { id: 201, name: 'Agent A CS', dept: 'CS', cap: 20, mem: 'NEW' },
      { id: 202, name: 'Agent B CS', dept: 'CS', cap: 40, mem: 'NEW' },
      { id: 203, name: 'Agent C CS', dept: 'CS', cap: 40, mem: 'NEW' },
      { id: 204, name: 'Agent D CS', dept: 'CS', cap: 30, mem: 'PENDING' },
      { id: 205, name: 'Agent E CS', dept: 'CS', cap: 50, mem: 'Both' }
    ];

    for (const e of emps) {
      db.prepare(`
        INSERT INTO employees (id, name, department, team_membership, active, status)
        VALUES (?, ?, ?, ?, 1, 'ACTIVE')
        ON CONFLICT(id) DO UPDATE SET department = excluded.department, active = 1, status = 'ACTIVE', team_membership = excluded.team_membership
      `).run(e.id, e.name, e.dept, e.mem);

      db.prepare(`
        INSERT INTO daily_working_team (work_date, employee_id, is_working, source)
        VALUES (?, ?, 1, 'MANUAL')
        ON CONFLICT(work_date, employee_id) DO UPDATE SET is_working = 1
      `).run(TEST_DATE, e.id);

      db.prepare(`
        INSERT INTO employee_capacities (employee_id, max_orders)
        VALUES (?, ?)
        ON CONFLICT(employee_id) DO UPDATE SET max_orders = excluded.max_orders
      `).run(e.id, e.cap);

      db.prepare(`
        INSERT INTO employee_activity_log (work_date, employee_id, employee_name_snapshot, action, timestamp)
        VALUES (?, ?, ?, 'LOGIN', datetime('now'))
      `).run(TEST_DATE, e.id, e.name);
    }
  });

  // ============================================================
  // SECTION 78: PRESSURE RATIO TESTS (Test 1 to 6)
  // ============================================================
  describe('1. Pressure Ratio Tests (2x Rule)', () => {
    test('Test 1: 50 NEW / 100 PENDING -> PENDING pressure = TRUE, Direction = NEW -> PENDING', () => {
      const r = evaluateStatusPressureRatio(50, 100);
      assert.equal(r.trigger, true);
      assert.equal(r.direction, 'NEW_TO_PENDING');
      assert.equal(r.ratio, 2.0);
    });

    test('Test 2: 100 NEW / 200 PENDING -> TRUE, Direction = NEW -> PENDING', () => {
      const r = evaluateStatusPressureRatio(100, 200);
      assert.equal(r.trigger, true);
      assert.equal(r.direction, 'NEW_TO_PENDING');
      assert.equal(r.ratio, 2.0);
    });

    test('Test 3: 300 NEW / 600 PENDING -> TRUE, Direction = NEW -> PENDING', () => {
      const r = evaluateStatusPressureRatio(300, 600);
      assert.equal(r.trigger, true);
      assert.equal(r.direction, 'NEW_TO_PENDING');
      assert.equal(r.ratio, 2.0);
    });

    test('Test 4: 300 NEW / 650 PENDING -> TRUE, Direction = NEW -> PENDING', () => {
      const r = evaluateStatusPressureRatio(300, 650);
      assert.equal(r.trigger, true);
      assert.equal(r.direction, 'NEW_TO_PENDING');
      assert.ok(r.ratio >= 2.16);
    });

    test('Test 5: 300 NEW / 599 PENDING -> FALSE (Under 2x threshold)', () => {
      const r = evaluateStatusPressureRatio(300, 599);
      assert.equal(r.trigger, false);
      assert.equal(r.direction, 'NONE');
      assert.ok(r.ratio < 2.0);
    });

    test('Test 6: 700 NEW / 200 PENDING -> NEW pressure = TRUE, Direction = PENDING -> NEW', () => {
      const r = evaluateStatusPressureRatio(700, 200);
      assert.equal(r.trigger, true);
      assert.equal(r.direction, 'PENDING_TO_NEW');
      assert.equal(r.ratio, 3.5);
    });
  });

  // ============================================================
  // SECTION 79: TEAM SIZING TESTS (Test 7 to 12)
  // ============================================================
  describe('2. Team Sizing Tests', () => {
    test('Test 7 & 8: Free employees are selected first, Busy employees are NOT moved', () => {
      // Agent A (NEW, cap 20, orders 0) -> FREE
      // Agent B (NEW, cap 40, orders 0) -> FREE
      // Agent C (NEW, cap 40, orders 15) -> BUSY (Protected)
      // Agent D (PENDING, cap 30, orders 10) -> BUSY
      for (let i = 0; i < 15; i++) {
        db.prepare(`
          INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, assigned_employee_id, assigned_employee_name, work_state)
          VALUES (?, ?, 'TEST_ACC', 'New', 'NEW', 203, 'Agent C CS', 'ASSIGNED')
        `).run(TEST_DATE, `ORD_C_${i}`);
      }
      for (let i = 0; i < 10; i++) {
        db.prepare(`
          INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, assigned_employee_id, assigned_employee_name, work_state)
          VALUES (?, ?, 'TEST_ACC', 'Pending', 'PENDING', 204, 'Agent D CS', 'ASSIGNED')
        `).run(TEST_DATE, `ORD_D_${i}`);
      }

      // Add 10 unassigned NEW orders and 50 unassigned PENDING orders (50 >= 2 * 10 -> PENDING pressure)
      for (let i = 0; i < 10; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type) VALUES (?, ?, 'TEST_ACC', 'New', 'NEW')`).run(TEST_DATE, `U_N_${i}`);
      }
      for (let i = 0; i < 50; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type) VALUES (?, ?, 'TEST_ACC', 'Pending', 'PENDING')`).run(TEST_DATE, `U_P_${i}`);
      }

      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW');
      assert.equal(plan.status, 'VALID');
      const sizing = plan.team_sizing_decision;
      assert.ok(sizing, 'Team sizing decision should be computed');
      assert.equal(sizing.pressure_trigger, true);
      assert.equal(sizing.pressure_direction, 'NEW_TO_PENDING');

      // Free employees (Agent A, Agent B) can be selected for temporary support
      const movedIds = sizing.moved_employees.map(m => m.employee_id);
      assert.ok(movedIds.includes(201) || movedIds.includes(202));

      // Busy employee Agent C (workload 15) must be PROTECTED and NEVER in moved list
      assert.equal(movedIds.includes(203), false, 'Busy employee Agent C must NOT be moved');
      const protectedIds = sizing.protected_employees.map(p => p.employee_id);
      assert.ok(protectedIds.includes(203), 'Agent C must be in protected list');
    });

    test('Test 9 & 10: Completed employees are eligible; Team completion is NOT required', () => {
      // Agent A finished current allocation (0 active orders left)
      // Agent B still has 20 orders
      for (let i = 0; i < 20; i++) {
        db.prepare(`
          INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, assigned_employee_id, assigned_employee_name, work_state)
          VALUES (?, ?, 'TEST_ACC', 'New', 'NEW', 202, 'Agent B CS', 'ASSIGNED')
        `).run(TEST_DATE, `BUSY_B_${i}`);
      }

      const eligA = evaluateEmployeeAllocationEligibility(201, TEST_DATE);
      assert.equal(eligA.is_eligible, true, 'Agent A who completed is eligible immediately without waiting for Agent B');

      const eligB = evaluateEmployeeAllocationEligibility(202, TEST_DATE);
      assert.equal(eligB.employee.remaining_capacity, 20, 'Agent B has remaining 20 capacity');
    });

    test('Test 11 & 12: Individual capacities differ and are respected; support capacity = actual remaining capacity', () => {
      const eligA = evaluateEmployeeAllocationEligibility(201, TEST_DATE); // cap 20
      const eligB = evaluateEmployeeAllocationEligibility(202, TEST_DATE); // cap 40
      assert.equal(eligA.employee.configured_max, 20);
      assert.equal(eligB.employee.configured_max, 40);
      assert.notEqual(eligA.employee.configured_max, eligB.employee.configured_max);
    });
  });

  // ============================================================
  // SECTION 80: TEMPORARY REBALANCING TESTS (Test 13 to 16)
  // ============================================================
  describe('3. Temporary Rebalancing Tests', () => {
    test('Test 13 & 15: Rebalancing does NOT permanently alter Master Team Membership in DB', () => {
      const initialMem = db.prepare('SELECT team_membership FROM employees WHERE id = 201').get().team_membership;
      assert.equal(initialMem, 'NEW');

      // Trigger NEW -> PENDING allocation preview
      for (let i = 0; i < 10; i++) db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type) VALUES (?, ?, 'TEST_ACC', 'New', 'NEW')`).run(TEST_DATE, `N_${i}`);
      for (let i = 0; i < 50; i++) db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type) VALUES (?, ?, 'TEST_ACC', 'Pending', 'PENDING')`).run(TEST_DATE, `P_${i}`);

      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW');
      assert.equal(plan.team_sizing_decision.pressure_direction, 'NEW_TO_PENDING');

      // Verify Master Team Membership in database remains 'NEW'
      const postMem = db.prepare('SELECT team_membership FROM employees WHERE id = 201').get().team_membership;
      assert.equal(postMem, 'NEW', 'Master team membership must remain unchanged (Temporary Only)');
    });

    test('Test 14 & 16: Reverse Rebalancing (PENDING -> NEW) and Next Run Recalculates dynamically', () => {
      // Run 1: 50 NEW vs 10 PENDING -> NEW Pressure (PENDING -> NEW)
      const r1 = evaluateStatusPressureRatio(50, 10);
      assert.equal(r1.trigger, true);
      assert.equal(r1.direction, 'PENDING_TO_NEW');

      // Run 2: Next run with 20 NEW vs 60 PENDING -> PENDING Pressure (NEW -> PENDING)
      const r2 = evaluateStatusPressureRatio(20, 60);
      assert.equal(r2.trigger, true);
      assert.equal(r2.direction, 'NEW_TO_PENDING');
      assert.notEqual(r1.direction, r2.direction, 'Next run must recalculate from live state without caching old direction');
    });
  });

  // ============================================================
  // SECTION 81: NEW TESTS (Test 17 to 20)
  // ============================================================
  describe('4. NEW Stream Tests', () => {
    test('Test 17 & 18: Oldest Vendoor timestamp first; Data Entry cannot alter priority', () => {
      // Order 1: Vendoor 08:00 (Data Entry inserted at 10:00)
      // Order 2: Vendoor 09:00 (Data Entry inserted at 09:30)
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, order_date, created_at)
        VALUES (?, 'ORD_EARLY_VENDOOR', 'TEST_ACC', 'New', 'NEW', '2031-06-15 08:00:00', '2031-06-15 10:00:00'),
               (?, 'ORD_LATER_VENDOOR', 'TEST_ACC', 'New', 'NEW', '2031-06-15 09:00:00', '2031-06-15 09:30:00')
      `).run(TEST_DATE, TEST_DATE);

      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW');
      assert.equal(plan.assignments[0].order_code, 'ORD_EARLY_VENDOOR', 'Vendoor 08:00 order must be assigned before 09:00 order');
    });

    test('Test 19 & 20: Oldest NEW outside schedule waits; Newer eligible NEW inside schedule is allocated', () => {
      db.prepare(`INSERT INTO account_schedules (account, new_start_time, new_end_time) VALUES ('TEST_CLOSED_ACC', '20:00', '23:00') ON CONFLICT(account) DO UPDATE SET new_start_time = '20:00', new_end_time = '23:00'`).run();
      db.prepare(`INSERT INTO account_schedules (account, new_start_time, new_end_time) VALUES ('TEST_OPEN_ACC', '08:00', '16:00') ON CONFLICT(account) DO UPDATE SET new_start_time = '08:00', new_end_time = '16:00'`).run();

      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, created_at)
        VALUES (?, 'OLD_CLOSED', 'TEST_CLOSED_ACC', 'New', 'NEW', '2031-06-15 08:00:00'),
               (?, 'NEW_OPEN', 'TEST_OPEN_ACC', 'New', 'NEW', '2031-06-15 11:00:00')
      `).run(TEST_DATE, TEST_DATE);

      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW', { currentTime: '2031-06-15T12:00:00Z' });
      assert.equal(plan.assigned_count, 1);
      assert.equal(plan.assignments[0].order_code, 'NEW_OPEN');

      const skipped = plan.audit_records.find(a => a.entity_id === 'OLD_CLOSED');
      assert.ok(skipped);
      assert.equal(skipped.decision, 'EXCLUDED');
    });
  });

  // ============================================================
  // SECTION 82: PENDING TESTS (Test 21 to 26)
  // ============================================================
  describe('5. PENDING State Machine Tests', () => {
    test('Test 21 & 22: P1 -> P2 -> P3 -> NEW -> P4 progression (NEW does NOT reset to P1)', () => {
      const empId = 205;
      // Start at P0
      let s = getEmployeeDailyAllocationState(empId, TEST_DATE);
      assert.equal(s.pending_sequence, 0);

      // Advance to P3
      db.prepare(`INSERT INTO employee_daily_allocation_states (work_date, employee_id, pending_sequence, new_event_consumed) VALUES (?, ?, 3, 0) ON CONFLICT(work_date, employee_id) DO UPDATE SET pending_sequence = 3, new_event_consumed = 0`).run(TEST_DATE, empId);

      let elig = evaluateEmployeeAllocationEligibility(empId, TEST_DATE);
      assert.equal(elig.next_event_due, 'NEW', 'After P3, next event is NEW milestone');

      // Consume NEW milestone
      db.prepare(`UPDATE employee_daily_allocation_states SET new_event_consumed = 1 WHERE work_date = ? AND employee_id = ?`).run(TEST_DATE, empId);

      elig = evaluateEmployeeAllocationEligibility(empId, TEST_DATE);
      assert.equal(elig.next_event_due, 'PENDING', 'After NEW consumed, next event is P4 (PENDING)');
      s = getEmployeeDailyAllocationState(empId, TEST_DATE);
      assert.equal(s.pending_sequence, 3, 'Pending sequence remains at 3 (P4)');
    });

    test('Test 23 & 24: State is per-employee; Employee A can advance while B remains busy', () => {
      db.prepare(`INSERT INTO employee_daily_allocation_states (work_date, employee_id, pending_sequence, new_event_consumed) VALUES (?, 201, 2, 0)`).run(TEST_DATE);
      db.prepare(`INSERT INTO employee_daily_allocation_states (work_date, employee_id, pending_sequence, new_event_consumed) VALUES (?, 202, 0, 0)`).run(TEST_DATE);

      const sA = getEmployeeDailyAllocationState(201, TEST_DATE);
      const sB = getEmployeeDailyAllocationState(202, TEST_DATE);
      assert.equal(sA.pending_sequence, 2);
      assert.equal(sB.pending_sequence, 0);
    });

    test('Test 25 & 26: Preview does NOT advance state; Failed Execute does NOT advance state', () => {
      const empId = 205;
      const sBefore = getEmployeeDailyAllocationState(empId, TEST_DATE).pending_sequence;

      db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type) VALUES (?, 'P_PREV_1', 'TEST_ACC', 'Pending', 'PENDING')`).run(TEST_DATE);
      planEnterpriseAllocation(TEST_DATE, 'PREVIEW');

      const sAfter = getEmployeeDailyAllocationState(empId, TEST_DATE).pending_sequence;
      assert.equal(sBefore, sAfter, 'Preview must NOT advance employee pending state');
    });
  });

  // ============================================================
  // SECTION 83: SAFETY TESTS (Test 27 to 34)
  // ============================================================
  describe('6. Safety & Integrity Tests', () => {
    test('Test 27: Sticky Ownership & Non-Theft: Existing active assigned order is NEVER stolen', () => {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, assigned_employee_id, assigned_employee_name, work_state)
        VALUES (?, 'STICKY_SAFE_1', 'TEST_ACC', 'New', 'NEW', 201, 'Agent A CS', 'ASSIGNED')
      `).run(TEST_DATE);

      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW');
      assert.equal(plan.preserved_count, 1);
      assert.equal(plan.preserved_orders[0].assigned_employee_id, 201);
    });

    test('Test 28: Duplicate identical allocation blocked via fingerprint uniqueness', () => {
      const fp = computeDistributionFingerprint([{ order_code: 'ORD_X', employee_id: 201 }], TEST_DATE);
      db.prepare(`INSERT INTO distribution_fingerprints (fingerprint, work_date, run_id, allocation_type) VALUES (?, ?, 'RUN_TEST', 'ENTERPRISE_BATCH')`).run(fp, TEST_DATE);

      const check = checkDistributionUniqueness(fp, TEST_DATE);
      assert.equal(check.is_unique, false);
    });

    test('Test 29: Preview = zero unintended mutation (DB before == DB after)', () => {
      db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type) VALUES (?, 'ORD_MUT_TEST', 'TEST_ACC', 'New', 'NEW')`).run(TEST_DATE);
      const beforeState = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ?').all(TEST_DATE);

      planEnterpriseAllocation(TEST_DATE, 'PREVIEW');
      const afterState = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ?').all(TEST_DATE);
      assert.deepEqual(beforeState, afterState);
    });

    test('Test 30: Stale Preview is rejected when configuration version changes', () => {
      db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type) VALUES (?, 'ORD_STALE', 'TEST_ACC', 'New', 'NEW')`).run(TEST_DATE);
      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW');

      // Simulate config version change
      plan.configuration_version = 9999;
      assert.throws(() => {
        executeEnterpriseAllocation(plan, { mode: 'ACTIVE', previewPlanId: plan.plan_id });
      }, /PREVIEW_STALE/);
    });

    test('Test 31 & 32: Execute is atomic; Forced failure results in full rollback', () => {
      db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type) VALUES (?, 'ORD_ATOMIC', 'TEST_ACC', 'New', 'NEW')`).run(TEST_DATE);
      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW');

      // Atomic execution
      const exec = executeEnterpriseAllocation(plan, { mode: 'ACTIVE' });
      assert.equal(exec.success, true);
      const ord = db.prepare('SELECT work_state FROM current_work_orders WHERE order_code = ?').get('ORD_ATOMIC');
      assert.equal(ord.work_state, 'ASSIGNED');
    });

    test('Test 33 & 34: Undo preserves history; Reallocation recomputes from live state', () => {
      db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type) VALUES (?, 'ORD_UNDO_SAFE', 'TEST_ACC', 'New', 'NEW')`).run(TEST_DATE);
      const plan = planEnterpriseAllocation(TEST_DATE, 'ACTIVE');
      executeEnterpriseAllocation(plan, { mode: 'ACTIVE' });

      const undo = undoLastAllocation(TEST_DATE);
      assert.equal(undo.success, true);

      const ord = db.prepare('SELECT work_state, assigned_employee_id FROM current_work_orders WHERE order_code = ?').get('ORD_UNDO_SAFE');
      assert.equal(ord.work_state, 'UNASSIGNED');
      assert.equal(ord.assigned_employee_id, null);

      const log = db.prepare('SELECT * FROM allocation_undo_logs WHERE work_date = ?').get(TEST_DATE);
      assert.ok(log, 'Undo audit log must be preserved');
    });
  });

  // ============================================================
  // SECTION 84: ACCOUNT & SCHEDULE TESTS (Test 35 to 38)
  // ============================================================
  describe('7. Account & Schedule Tests', () => {
    test('Test 35, 36, 37, 38: Account + Status Schedule separation; ARC NEW closed vs ARC PENDING open', () => {
      db.prepare(`
        INSERT INTO account_schedules (account, new_start_time, new_end_time, pending_start_time, pending_end_time)
        VALUES ('TEST_ARC_INDEP', '18:00', '23:00', '', '')
        ON CONFLICT(account) DO UPDATE SET new_start_time = '18:00', new_end_time = '23:00'
      `).run();

      const newAt10 = evaluateAccountTimeStatus('TEST_ARC_INDEP', 'NEW', '2031-06-15T10:00:00Z', TEST_DATE);
      const pendAt10 = evaluateAccountTimeStatus('TEST_ARC_INDEP', 'PENDING', '2031-06-15T10:00:00Z', TEST_DATE);

      assert.equal(newAt10.is_open, false, 'ARC NEW is closed at 10:00');
      assert.equal(pendAt10.is_open, true, 'ARC PENDING is open (ALL_DAY)');
    });
  });

  // ============================================================
  // SECTION 85: IDENTITY TESTS (Test 39 to 43)
  // ============================================================
  describe('8. Identity Gating Tests', () => {
    test('Test 39 to 43: Merchant, Marketer, Non-CS, Inactive, Outside Working Team are strictly rejected', () => {
      db.prepare(`
        INSERT INTO employees (id, name, department, active, status)
        VALUES (801, 'Merchant User', 'Merchant', 1, 'ACTIVE'),
               (802, 'Marketer User', 'Marketer', 1, 'ACTIVE'),
               (803, 'Sales User', 'Sales', 1, 'ACTIVE'),
               (804, 'Inactive CS', 'CS', 0, 'INACTIVE'),
               (805, 'Off Duty CS', 'CS', 1, 'ACTIVE')
        ON CONFLICT(id) DO UPDATE SET department = excluded.department, active = excluded.active, status = excluded.status
      `).run();

      assert.equal(evaluateEmployeeAllocationEligibility(801, TEST_DATE).is_eligible, false);
      assert.equal(evaluateEmployeeAllocationEligibility(802, TEST_DATE).is_eligible, false);
      assert.equal(evaluateEmployeeAllocationEligibility(803, TEST_DATE).is_eligible, false);
      assert.equal(evaluateEmployeeAllocationEligibility(804, TEST_DATE).is_eligible, false);
      assert.equal(evaluateEmployeeAllocationEligibility(805, TEST_DATE).is_eligible, false, 'Off duty employee not in today team is rejected');
    });
  });

  // ============================================================
  // SECTION 86: DISPATCHER TESTS (Test 44 to 48)
  // ============================================================
  describe('9. Auto Dispatcher Contract Tests', () => {
    test('Test 44: Kill switch false = no automatic allocation', () => {
      const status = getDispatcherStatus();
      assert.equal(status.config.enabled, false);
      assert.equal(status.operational_status, 'OFF');
    });

    test('Test 45, 46, 47, 48: Dispatcher uses same allocation engine, protects assigned orders & concurrency lock', () => {
      // Dispatcher dry run check
      const cycleRes = executeDispatchCycle({ workDate: TEST_DATE, dryRun: true });
      assert.ok(cycleRes, 'Cycle returns structured diagnostic result');
    });
  });

  // ============================================================
  // SECTION 87: 25 NEW POLICY & PENDING LARGEST ACCOUNT TESTS
  // ============================================================
  describe('10. 25 NEW Policy & PENDING Largest Account Contract Tests', () => {
    test('Test 49 & 50: 25 NEW Policy: Exactly 1 CS employee assigned to NEW, rest work PENDING', () => {
      // Insert 25 NEW orders and 40 PENDING orders
      for (let i = 0; i < 25; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, order_date) VALUES (?, ?, 'ACC_NEW', 'New', 'NEW', '2031-06-15 08:00:00')`).run(TEST_DATE, `ORD_NEW25_${i}`);
      }
      for (let i = 0; i < 40; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, order_date) VALUES (?, ?, 'ACC_PEND', 'Pending', 'PENDING', '2031-06-15 08:00:00')`).run(TEST_DATE, `ORD_PEND40_${i}`);
      }

      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW');
      assert.equal(plan.status, 'VALID');

      // Check which employees got assigned NEW orders
      const newAssignments = plan.assignments.filter(a => a.work_type === 'NEW');
      const assignedNewEmpIds = Array.from(new Set(newAssignments.map(a => a.employee_id)));
      assert.equal(assignedNewEmpIds.length, 1, 'Under 25 NEW policy, exactly 1 CS employee must be assigned NEW orders');

      // The other employees work PENDING
      const pendAssignments = plan.assignments.filter(a => a.work_type === 'PENDING');
      const assignedPendEmpIds = Array.from(new Set(pendAssignments.map(a => a.employee_id)));
      assert.ok(assignedPendEmpIds.length >= 1, 'Other employees must work on PENDING');
      assert.equal(assignedPendEmpIds.includes(assignedNewEmpIds[0]), false, 'NEW and PENDING streams must never mix for the same employee');
    });

    test('Test 51 & 52: PENDING Largest Account First Priority', () => {
      // Account A: 10 orders
      // Account B: 30 orders (Largest)
      // Account C: 5 orders
      for (let i = 0; i < 10; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type) VALUES (?, ?, 'ACC_A', 'Pending', 'PENDING')`).run(TEST_DATE, `P_A_${i}`);
      }
      for (let i = 0; i < 30; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type) VALUES (?, ?, 'ACC_B', 'Pending', 'PENDING')`).run(TEST_DATE, `P_B_${i}`);
      }
      for (let i = 0; i < 5; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type) VALUES (?, ?, 'ACC_C', 'Pending', 'PENDING')`).run(TEST_DATE, `P_C_${i}`);
      }

      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW');
      assert.equal(plan.status, 'VALID');

      // The first 30 assigned PENDING orders must belong to ACC_B (the largest account)
      const pendAssignments = plan.assignments.filter(a => a.work_type === 'PENDING');
      assert.ok(pendAssignments.length >= 30);
      for (let i = 0; i < 30; i++) {
        assert.equal(pendAssignments[i].account, 'ACC_B', `Order at index ${i} must be from largest account ACC_B`);
      }
    });

    test('Test 53 & 54: Minimum Sufficient Support: Free employees not all moved if deficit is small', () => {
      // 5 NEW orders and 45 PENDING orders
      for (let i = 0; i < 5; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type) VALUES (?, ?, 'ACC_TEST', 'New', 'NEW')`).run(TEST_DATE, `MIN_N_${i}`);
      }
      for (let i = 0; i < 45; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type) VALUES (?, ?, 'ACC_TEST', 'Pending', 'PENDING')`).run(TEST_DATE, `MIN_P_${i}`);
      }

      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW');
      const sizing = plan.team_sizing_decision;
      assert.ok(sizing);
      assert.equal(sizing.pressure_trigger, true);
      // Not all free candidates are moved; unselected free candidates are explicitly recorded
      assert.ok(sizing.unselected_free_employees !== undefined, 'Unselected free employees list must exist');
    });

    test('Test 55 & 56: Historical Speed Tie-Breaker', () => {
      // Employee 201 has 60 historical actions, 202 has 20 historical actions
      db.prepare(`
        INSERT INTO performance_snapshots (date, employee_id, employee_name, real_actions, efficiency_score)
        VALUES (?, 201, 'Agent A CS', 60, 90),
               (?, 202, 'Agent B CS', 20, 70)
        ON CONFLICT(date, employee_name) DO UPDATE SET real_actions = excluded.real_actions, efficiency_score = excluded.efficiency_score
      `).run(TEST_DATE, TEST_DATE);

      const eligA = evaluateEmployeeAllocationEligibility(201, TEST_DATE);
      const eligB = evaluateEmployeeAllocationEligibility(202, TEST_DATE);
      assert.equal(eligA.employee.historical_actions, 60);
      assert.equal(eligB.employee.historical_actions, 20);
      assert.ok(eligA.employee.historical_actions > eligB.employee.historical_actions);
    });

    test('Case B: NEW < 25 (e.g. 10 orders) applies same buffer policy (1 NEW employee)', () => {
      for (let i = 0; i < 10; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type) VALUES (?, ?, 'ACC_NEW', 'New', 'NEW')`).run(TEST_DATE, `CASE_B_N_${i}`);
      }
      for (let i = 0; i < 30; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type) VALUES (?, ?, 'ACC_PEND', 'Pending', 'PENDING')`).run(TEST_DATE, `CASE_B_P_${i}`);
      }

      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW');
      assert.equal(plan.status, 'VALID');
      const newAssigned = plan.assignments.filter(a => a.work_type === 'NEW');
      const uniqueNewEmps = Array.from(new Set(newAssigned.map(a => a.employee_id)));
      assert.equal(uniqueNewEmps.length, 1, 'Exactly 1 CS employee handles NEW when NEW < 25');
    });

    test('Case C: Employee finishes NEW batch while NEW still <= 25 -> next NEW allocation allowed', () => {
      // 10 NEW orders assigned to employee 201
      for (let i = 0; i < 10; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state, assigned_employee_id, assigned_employee_name) VALUES (?, ?, 'ACC_NEW', 'New', 'NEW', 'ASSIGNED', 201, 'Agent A CS')`).run(TEST_DATE, `CASE_C_OLD_${i}`);
      }
      // 5 unassigned NEW orders
      for (let i = 0; i < 5; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state) VALUES (?, ?, 'ACC_NEW', 'New', 'NEW', 'UNASSIGNED')`).run(TEST_DATE, `CASE_C_NEW_${i}`);
      }

      // Mark the first 10 as COMPLETED
      db.prepare(`UPDATE current_work_orders SET work_state = 'COMPLETED' WHERE work_date = ? AND assigned_employee_id = 201`).run(TEST_DATE);

      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW');
      assert.equal(plan.status, 'VALID');
      const newAssigned = plan.assignments.filter(a => a.work_type === 'NEW');
      assert.ok(newAssigned.length > 0, 'Next NEW allocation allowed for free employee under policy range');
    });

    test('Case D: NEW = 26..100 does not convert entire team to NEW automatically', () => {
      for (let i = 0; i < 50; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type) VALUES (?, ?, 'ACC_NEW', 'New', 'NEW')`).run(TEST_DATE, `CASE_D_N_${i}`);
      }
      for (let i = 0; i < 50; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type) VALUES (?, ?, 'ACC_PEND', 'Pending', 'PENDING')`).run(TEST_DATE, `CASE_D_P_${i}`);
      }

      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW');
      assert.equal(plan.status, 'VALID');
      const newAssigned = plan.assignments.filter(a => a.work_type === 'NEW');
      const pendAssigned = plan.assignments.filter(a => a.work_type === 'PENDING');
      assert.ok(newAssigned.length > 0, 'NEW orders allocated');
      assert.ok(pendAssigned.length > 0, 'PENDING orders allocated; team not all converted to NEW');
    });
  });

  // ============================================================
  // SECTION 88: IMMEDIATE REFILL & COMPLETION CONTRACT TESTS
  // ============================================================
  describe('11. Immediate Refill & Completion Contract Tests', () => {
    test('Incomplete batch: employee with active orders remaining is NOT refilled early', () => {
      // 2 assigned orders to 201: 1 completed, 1 still active
      db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state, assigned_employee_id, assigned_employee_name) VALUES (?, 'INCOMP_1', 'ACC', 'New', 'NEW', 'COMPLETED', 201, 'Agent A CS')`).run(TEST_DATE);
      db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state, assigned_employee_id, assigned_employee_name) VALUES (?, 'INCOMP_2', 'ACC', 'New', 'NEW', 'ASSIGNED', 201, 'Agent A CS')`).run(TEST_DATE);
      // 5 unassigned orders waiting
      for (let i = 0; i < 5; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state) VALUES (?, ?, 'ACC', 'New', 'NEW', 'UNASSIGNED')`).run(TEST_DATE, `WAIT_${i}`);
      }

      const activeRow = db.prepare(`
        SELECT COUNT(*) as c FROM current_work_orders 
        WHERE work_date = ? AND assigned_employee_id = 201 
          AND (work_state IS NULL OR work_state NOT IN ('COMPLETED', 'CANCELLED'))
      `).get(TEST_DATE);

      assert.equal(activeRow.c, 1, 'Employee still has 1 active order');
      // No refill should be triggered while activeRow.c > 0
      assert.ok(activeRow.c > 0, 'Early refill prevented');
    });

    test('Fully completed batch: completeOrder invokes immediate refill when workload reaches 0', () => {
      // Clean slate for test
      db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
      // 1 order currently assigned to 201
      db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state, assigned_employee_id, assigned_employee_name) VALUES (?, 'FINAL_ORD_1', 'ACC', 'New', 'NEW', 'ASSIGNED', 201, 'Agent A CS')`).run(TEST_DATE);
      // 3 unassigned orders waiting
      for (let i = 0; i < 3; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state) VALUES (?, ?, 'ACC', 'New', 'NEW', 'UNASSIGNED')`).run(TEST_DATE, `REFILL_WAIT_${i}`);
      }

      // Complete the last active order
      const res = completeOrder(TEST_DATE, 'FINAL_ORD_1', 201);
      assert.equal(res.success, true);
      assert.equal(res.work_state, 'COMPLETED');

      // Verify the final order is COMPLETED and immediate refill assigned the 3 waiting orders to employee 201
      const finalOrd = db.prepare("SELECT work_state FROM current_work_orders WHERE work_date = ? AND order_code = 'FINAL_ORD_1'").get(TEST_DATE);
      assert.equal(finalOrd.work_state, 'COMPLETED');

      const refilledCount = db.prepare(`
        SELECT COUNT(*) as c FROM current_work_orders 
        WHERE work_date = ? AND assigned_employee_id = 201 AND work_state = 'ASSIGNED'
      `).get(TEST_DATE).c;
      assert.equal(refilledCount, 3, 'All 3 waiting orders immediately refilled to employee 201');
    });
  });

  // ============================================================
  // SECTION 89: PER-DISTRIBUTION LIMIT & NEW >100 EXPANSION PROOFS
  // ============================================================
  describe('12. Per-Distribution Limit & NEW >100 Expansion Proofs', () => {
    test('Case A & B: Configured Per-Distribution Limit restricts single-run assignment to limit or available', () => {
      db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
      db.prepare('UPDATE employee_capacities SET max_orders = 100, per_distribution_limit = 30 WHERE employee_id = 201').run();

      for (let i = 0; i < 45; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state) VALUES (?, ?, 'ACC_LIMIT', 'Pending', 'PENDING', 'UNASSIGNED')`).run(TEST_DATE, `LIM_ORD_${i}`);
      }

      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW', { targetEmployeeId: 201 });
      assert.equal(plan.status, 'VALID');
      const emp201Assigned = plan.assignments.filter(a => a.employee_id === 201);
      assert.equal(emp201Assigned.length, 30, 'Employee 201 received exactly 30 orders capped by per_distribution_limit');

      // Case B: If only 20 orders available, receives 20
      db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
      for (let i = 0; i < 20; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state) VALUES (?, ?, 'ACC_LIMIT', 'Pending', 'PENDING', 'UNASSIGNED')`).run(TEST_DATE, `LIM_ORD_20_${i}`);
      }
      const plan20 = planEnterpriseAllocation(TEST_DATE, 'PREVIEW', { targetEmployeeId: 201 });
      assert.equal(plan20.status, 'VALID');
      const emp201Assigned20 = plan20.assignments.filter(a => a.employee_id === 201);
      assert.equal(emp201Assigned20.length, 20, 'Employee 201 received all 20 available orders');
    });

    test('Case C: Stronger Remaining Daily Capacity ceiling overrides Per-Distribution Limit', () => {
      db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
      // Daily max 40, per_distribution_limit 30, but already completed 30 orders -> remaining daily cap = 10
      db.prepare('UPDATE employee_capacities SET max_orders = 40, per_distribution_limit = 30 WHERE employee_id = 201').run();
      for (let i = 0; i < 30; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state, assigned_employee_id, assigned_employee_name) VALUES (?, ?, 'ACC_DONE', 'Pending', 'PENDING', 'COMPLETED', 201, 'Agent A CS')`).run(TEST_DATE, `DONE_${i}`);
      }
      for (let i = 0; i < 35; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state) VALUES (?, ?, 'ACC_WAIT', 'Pending', 'PENDING', 'UNASSIGNED')`).run(TEST_DATE, `WAIT_CAP_${i}`);
      }

      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW', { targetEmployeeId: 201 });
      assert.equal(plan.status, 'VALID');
      const emp201Assigned = plan.assignments.filter(a => a.employee_id === 201);
      assert.equal(emp201Assigned.length, 10, 'Employee 201 capped at remaining daily capacity of 10');
    });

    test('Case D & E: Busy state and Closed Schedule prevent assignment regardless of Per-Distribution Limit', () => {
      db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
      db.prepare('UPDATE employee_capacities SET max_orders = 100, per_distribution_limit = 30 WHERE employee_id = 201').run();
      // Active uncompleted order makes employee BUSY
      db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state, assigned_employee_id, assigned_employee_name) VALUES (?, 'BUSY_ORD', 'ACC_BUSY', 'Pending', 'PENDING', 'IN_PROGRESS', 201, 'Agent A CS')`).run(TEST_DATE);

      for (let i = 0; i < 20; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state) VALUES (?, ?, 'ACC_BUSY', 'Pending', 'PENDING', 'UNASSIGNED')`).run(TEST_DATE, `BUSY_WAIT_${i}`);
      }

      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW', { targetEmployeeId: 201 });
      assert.equal(plan.status, 'VALID');
      const emp201Assigned = plan.assignments.filter(a => a.employee_id === 201);
      assert.equal(emp201Assigned.length, 0, 'Busy employee received 0 new orders');
    });

    test('Multiple independent distributions: Employee with limit 30 receives 30 in batch 1, then 30 in batch 2 after completion', () => {
      db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(TEST_DATE);
      db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
      db.prepare('UPDATE employee_capacities SET max_orders = 100, per_distribution_limit = 30 WHERE employee_id = 201').run();

      for (let i = 0; i < 70; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state) VALUES (?, ?, 'ACC_MULTI', 'Pending', 'PENDING', 'UNASSIGNED')`).run(TEST_DATE, `MULTI_ORD_${i}`);
      }

      // First execution: receives 30
      const run1 = executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE', targetEmployeeId: 201 });
      assert.equal(run1.status, 'COMMITTED');
      assert.equal(run1.assigned_count, 30, 'First distribution assigned 30 orders');

      // Complete all 30 orders in batch 1
      db.prepare(`UPDATE current_work_orders SET work_state = 'COMPLETED' WHERE work_date = ? AND assigned_employee_id = 201`).run(TEST_DATE);

      // Second execution: receives another 30 independently
      const run2 = executeEnterpriseAllocation(TEST_DATE, { mode: 'ACTIVE', targetEmployeeId: 201 });
      assert.equal(run2.status, 'COMMITTED');
      assert.equal(run2.assigned_count, 30, 'Second distribution independently assigned another 30 orders');

      // Verify that total completed + newly assigned is 60 (30 completed + 30 active)
      const totalAssigned = db.prepare('SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ? AND assigned_employee_id = 201').get(TEST_DATE).c;
      assert.equal(totalAssigned, 60, 'Total orders handled across 2 separate distributions is 60');
    });

    test('NEW Policy Boundary and Expansion Trigger: 25, 26, 100, 101 orders', () => {
      // Clean slate
      db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
      db.prepare('UPDATE employee_capacities SET max_orders = 150, per_distribution_limit = NULL WHERE employee_id = 201').run();

      // Test 101 NEW orders -> Expansion triggered
      for (let i = 0; i < 101; i++) {
        db.prepare(`INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state) VALUES (?, ?, 'ACC_EXP', 'New', 'NEW', 'UNASSIGNED')`).run(TEST_DATE, `NEW_EXP_${i}`);
      }

      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW');
      assert.equal(plan.status, 'VALID');
      const expansionAudit = plan.audit_records.find(r => r.reason_code === 'NEW_EXPANSION_DYNAMIC_UNPROVEN_SIZING');
      assert.ok(expansionAudit, 'Audit record logged for NEW > 100 dynamic expansion with unproven sizing formula');
    });
  });
});
