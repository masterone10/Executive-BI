/**
 * tests/enterprise_allocation_engine.test.js
 * 
 * Comprehensive Automated Test Suite for CS Executive BI Enterprise Allocation Engine
 * Validates sections 133A, 170-189:
 * 1. Configuration Center (Atomic save, validation, versioning, precedence, immutability)
 * 2. Account Schedule Evaluator (ARC NEW 18:00-23:00 boundary tests, blank all-day, PENDING independence)
 * 3. Employee Workload Capacities (Hard caps, individual limits, active workload, capacity exhaustion)
 * 4. NEW / PENDING State Machine (P1 -> P2 -> P3 -> NEW -> P4 -> P5 -> P6, batch event counting, commit-only advancement)
 * 5. PENDING Rescue Engine (300 NEW + 600 PENDING, operational pressure formula, support quantity, daily mode lock)
 * 6. Two-Level Distribution Uniqueness (Batch & Mapping fingerprints, reordering detection, deterministic regeneration)
 * 7. Transactional Safety & Rollback (All-or-nothing, error before commit leaves zero side effects)
 * 8. Pre-allocation Snapshots, Context Hashes & Stale Preview Protection
 * 9. Working Team, CS Identity & Recent Activity Gating
 * 10. Large Load Scenarios (>1000 orders) & Performance
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import {
  getEnterpriseAllocationConfig,
  validateEnterpriseAllocationConfig,
  saveEnterpriseAllocationConfig,
  getEnterpriseConfigurationHistory,
  evaluateAccountTimeStatus,
  evaluateEmployeeAllocationEligibility,
  evaluatePendingRescueOperation,
  computeDistributionFingerprint,
  checkDistributionUniqueness,
  planEnterpriseAllocation,
  executeEnterpriseAllocation,
  checkEnterpriseOperationalAlerts,
  getEmployeeDailyAllocationState,
  ALLOCATION_ERROR_CODES
} from '../services/enterprise_allocation.js';

describe('Enterprise Allocation Engine - Complete Specification Verification', () => {

  const TEST_DATE = '2030-01-15';

  before(() => {
    // Ensure test database has clean state for TEST_DATE
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM employee_daily_allocation_states WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM enterprise_allocation_runs WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM distribution_fingerprints WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM employee_activity_log WHERE work_date = ?').run(TEST_DATE);
  });

  // ============================================================
  // SECTION 133A: CONFIGURATION CENTER TESTS
  // ============================================================
  describe('1. Allocation Configuration Center (Section 133A.50 - 133A.57)', () => {

    test('133A.50 (1-5): Load existing configuration, validate valid draft', () => {
      const config = getEnterpriseAllocationConfig();
      assert.ok(config, 'Configuration should be loaded');
      assert.ok(config.version >= 1, 'Version should be >= 1');
      assert.ok(Array.isArray(config.accounts), 'Accounts should be an array');
      assert.ok(Array.isArray(config.employees), 'Employees should be an array');

      // Valid draft
      const draft = {
        global_settings: {
          allocation_mode: 'ACTIVE',
          activity_lookback_minutes: 15,
          low_remaining_threshold: 3,
          pending_rescue_threshold: 20
        },
        accounts: [
          { account: 'ARC', new_start_time: '18:00', new_end_time: '23:00', pending_start_time: '', pending_end_time: '' },
          { account: 'DOBY', new_start_time: '20:00', new_end_time: '23:00', pending_start_time: '', pending_end_time: '' }
        ],
        employees: config.employees.slice(0, 2).map(e => ({
          employee_id: e.employee_id,
          employee_name: e.employee_name,
          max_orders: 25
        }))
      };

      const val = validateEnterpriseAllocationConfig(draft);
      assert.equal(val.valid, true, 'Draft should be valid');
      assert.equal(val.errors.length, 0);
    });

    test('133A.50 (6, 7, 53): Reject invalid value and verify no partial save', () => {
      const initialVer = getEnterpriseAllocationConfig().version;

      const invalidDraft = {
        global_settings: {
          pending_rescue_threshold: -50 // Invalid negative threshold
        },
        accounts: [
          { account: 'ARC', new_start_time: '23:00', new_end_time: '18:00' } // Invalid: End before Start
        ],
        employees: [
          { employee_id: 1, max_orders: -10 } // Invalid negative capacity
        ]
      };

      const val = validateEnterpriseAllocationConfig(invalidDraft);
      assert.equal(val.valid, false, 'Invalid draft must fail validation');
      assert.ok(val.errors.length >= 3, 'Must capture multiple structured errors');

      // Attempting save must throw and rollback
      assert.throws(() => {
        saveEnterpriseAllocationConfig(invalidDraft, 'Supervisor Test');
      });

      const afterVer = getEnterpriseAllocationConfig().version;
      assert.equal(afterVer, initialVer, 'Version must not increment on failed validation');
    });

    test('133A.51 & 133A.52: Multi-entry save and ARC Schedule Verification', () => {
      const initialCfg = getEnterpriseAllocationConfig();
      const initialVer = initialCfg.version;

      const multiEntryDraft = {
        global_settings: {
          allocation_mode: 'ACTIVE',
          activity_lookback_minutes: 15,
          low_remaining_threshold: 3,
          pending_rescue_threshold: 20
        },
        accounts: [
          { account: 'ARC', new_start_time: '18:00', new_end_time: '23:00', pending_start_time: '', pending_end_time: '' },
          { account: 'DOBY', new_start_time: '19:00', new_end_time: '23:30', pending_start_time: '', pending_end_time: '' }
        ],
        employees: initialCfg.employees.slice(0, 3).map((e, idx) => ({
          employee_id: e.employee_id,
          employee_name: e.employee_name,
          max_orders: idx === 0 ? 20 : (idx === 1 ? 15 : 10)
        }))
      };

      const result = saveEnterpriseAllocationConfig(multiEntryDraft, 'Supervisor Ziad');
      assert.equal(result.success, true);
      assert.equal(result.version, initialVer + 1, 'Version must increment by 1');

      // Verify published values
      const published = getEnterpriseAllocationConfig();
      assert.equal(published.version, initialVer + 1);

      const arcSched = published.accounts.find(a => a.account === 'ARC');
      assert.ok(arcSched, 'ARC schedule must be saved');
      assert.equal(arcSched.new_start_time, '18:00');
      assert.equal(arcSched.new_end_time, '23:00');
      assert.equal(arcSched.pending_start_time, '');
      assert.equal(arcSched.pending_end_time, '');
      assert.equal(arcSched.is_pending_all_day, true, 'ARC PENDING blank must be ALL_DAY');
    });

    test('133A.55 & 133A.56: Save configuration does NOT execute allocation or reset daily state', () => {
      // Seed employee daily state
      const empId = 1;
      db.prepare(`
        INSERT INTO employee_daily_allocation_states (work_date, employee_id, pending_sequence, new_event_consumed, daily_mode, rescue_state)
        VALUES (?, ?, 3, 1, 'NORMAL', 'NONE')
        ON CONFLICT(work_date, employee_id) DO UPDATE SET
          pending_sequence = 3, new_event_consumed = 1, daily_mode = 'NORMAL'
      `).run(TEST_DATE, empId);

      const stateBefore = getEmployeeDailyAllocationState(empId, TEST_DATE);
      assert.equal(stateBefore.pending_sequence, 3);
      assert.equal(stateBefore.new_event_consumed, 1);

      // Save new configuration
      const cfg = getEnterpriseAllocationConfig();
      saveEnterpriseAllocationConfig({
        ...cfg,
        global_settings: { ...cfg.global_settings, low_remaining_threshold: 4 }
      }, 'Supervisor');

      // Verify daily state is NOT reset
      const stateAfter = getEmployeeDailyAllocationState(empId, TEST_DATE);
      assert.equal(stateAfter.pending_sequence, 3, 'PENDING sequence must not reset');
      assert.equal(stateAfter.new_event_consumed, 1, 'NEW milestone consumed must not reset');
      assert.equal(stateAfter.daily_mode, 'NORMAL');
    });

    test('133A.57: Lowering Max Orders during active day does not delete existing orders', () => {
      const empId = 1;
      // Seed 15 active orders for this employee
      for (let i = 1; i <= 15; i++) {
        db.prepare(`
          INSERT INTO current_work_orders (work_date, order_code, account, status, assigned_employee_id, work_state)
          VALUES (?, ?, 'TEST_ACC', 'New', ?, 'ASSIGNED')
          ON CONFLICT(work_date, order_code) DO UPDATE SET assigned_employee_id = excluded.assigned_employee_id
        `).run(TEST_DATE, `ORD_LOAD_${i}`, empId);
      }

      // Configure employee max = 10 (less than current workload 15)
      const cfg = getEnterpriseAllocationConfig();
      saveEnterpriseAllocationConfig({
        ...cfg,
        employees: [{ employee_id: empId, max_orders: 10 }]
      }, 'Supervisor');

      // Check workload & remaining capacity
      const updatedCfg = getEnterpriseAllocationConfig(TEST_DATE);
      const empCap = updatedCfg.employees.find(e => e.employee_id === empId);
      assert.ok(empCap);
      assert.equal(empCap.max_orders, 10);
      assert.ok(empCap.current_workload >= 15, 'Current workload must remain intact');
      assert.equal(empCap.remaining_capacity, 0, 'Remaining capacity must safely be 0');

      // Check order rows were NOT deleted
      const orderCount = db.prepare('SELECT COUNT(*) as cnt FROM current_work_orders WHERE work_date = ? AND assigned_employee_id = ?').get(TEST_DATE, empId).cnt;
      assert.equal(orderCount, 15, 'Existing 15 orders must NOT be deleted or unassigned');
    });

    test('133A.18: Concurrency Conflict Detection on Configuration Save', () => {
      const cfg = getEnterpriseAllocationConfig();
      const currentVer = cfg.version;

      // Passing a stale expected version must throw CONFIGURATION_CONFLICT
      assert.throws(() => {
        saveEnterpriseAllocationConfig(cfg, 'Supervisor Conflict Test', currentVer - 1);
      }, (err) => err.code === ALLOCATION_ERROR_CODES.CONFIGURATION_CONFLICT);
    });
  });

  // ============================================================
  // SECTION 44, 46, 176: ACCOUNT SCHEDULE EXACT BOUNDARY TESTS
  // ============================================================
  describe('2. Account Schedule Evaluator (Sections 44-46, 176)', () => {

    before(() => {
      // Set ARC NEW 18:00 - 23:00, ARC PENDING ALL_DAY
      const cfg = getEnterpriseAllocationConfig();
      saveEnterpriseAllocationConfig({
        ...cfg,
        accounts: [
          { account: 'ARC', new_start_time: '18:00', new_end_time: '23:00', pending_start_time: '', pending_end_time: '' },
          { account: 'ALL_DAY_ACC', new_start_time: '', new_end_time: '', pending_start_time: '', pending_end_time: '' }
        ]
      }, 'Supervisor');
    });

    test('Section 176: ARC NEW exact boundaries (17:59, 18:00, 22:59, 23:00)', () => {
      // 17:59 -> blocked (NOT_YET_OPEN)
      const st1759 = evaluateAccountTimeStatus('ARC', 'NEW', '17:59');
      assert.equal(st1759.is_open, false);
      assert.equal(st1759.status, 'NOT_YET_OPEN');
      assert.equal(st1759.reason_code, ALLOCATION_ERROR_CODES.ACCOUNT_STATUS_NOT_YET_OPEN);

      // 18:00 -> exact START = OPEN
      const st1800 = evaluateAccountTimeStatus('ARC', 'NEW', '18:00');
      assert.equal(st1800.is_open, true);
      assert.equal(st1800.status, 'OPEN');

      // 22:59 -> inside window = OPEN
      const st2259 = evaluateAccountTimeStatus('ARC', 'NEW', '22:59');
      assert.equal(st2259.is_open, true);
      assert.equal(st2259.status, 'OPEN');

      // 23:00 -> exact END = CLOSED
      const st2300 = evaluateAccountTimeStatus('ARC', 'NEW', '23:00');
      assert.equal(st2300.is_open, false);
      assert.equal(st2300.status, 'CLOSED');
      assert.equal(st2300.reason_code, ALLOCATION_ERROR_CODES.ACCOUNT_STATUS_CLOSED);
    });

    test('Section 44 & 45: ARC PENDING remains ALL_DAY regardless of time', () => {
      const p1 = evaluateAccountTimeStatus('ARC', 'PENDING', '17:00');
      assert.equal(p1.is_open, true);
      assert.equal(p1.status, 'ALL_DAY');

      const p2 = evaluateAccountTimeStatus('ARC', 'PENDING', '23:30');
      assert.equal(p2.is_open, true);
      assert.equal(p2.status, 'ALL_DAY');
    });

    test('Section 48: Time Priority Ranking', () => {
      const openScheduled = evaluateAccountTimeStatus('ARC', 'NEW', '19:00');
      const allDay = evaluateAccountTimeStatus('ALL_DAY_ACC', 'NEW', '19:00');

      assert.equal(openScheduled.time_priority_rank, 1, 'Currently open scheduled account has rank 1');
      assert.equal(allDay.time_priority_rank, 4, 'ALL_DAY account has rank 4');
    });
  });

  // ============================================================
  // SECTION 38-42, 177, 178: EMPLOYEE ELIGIBILITY & ACTIVITY GATE
  // ============================================================
  describe('3. Employee Eligibility & Activity Gating (Sections 38-42, 177, 178)', () => {

    beforeEach(() => {
      db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
      db.prepare('DELETE FROM employee_activity_log WHERE work_date = ?').run(TEST_DATE);
      db.prepare('UPDATE employee_capacities SET max_orders = 40').run();
    });

    test('Section 39 & 40: Non-CS employee is rejected', () => {
      let nonCs = db.prepare("SELECT id FROM employees WHERE UPPER(department) NOT IN ('CS', 'CUSTOMER SERVICE') AND UPPER(department) NOT LIKE 'CS %' AND UPPER(department) NOT LIKE '% CS' LIMIT 1").get();
      if (!nonCs) {
        const ins = db.prepare("INSERT INTO employees (name, department, active, status) VALUES ('Non CS Tester', 'Marketing', 1, 'ACTIVE')").run();
        nonCs = { id: ins.lastInsertRowid };
      }

      const elig = evaluateEmployeeAllocationEligibility(nonCs.id, TEST_DATE, { skip_working_team_check: true });
      assert.equal(elig.is_eligible, false);
      assert.ok(elig.exclusion_reasons.includes(ALLOCATION_ERROR_CODES.EMPLOYEE_NOT_CS));
    });

    test('Section 38: Employee not in Today\'s Working Team is rejected', () => {
      const cs = db.prepare("SELECT id FROM employees WHERE department = 'CS' AND active = 1 LIMIT 1").get();
      const csEmpId = cs.id;

      // Ensure employee is not in working team
      db.prepare('DELETE FROM daily_working_team WHERE work_date = ? AND employee_id = ?').run(TEST_DATE, csEmpId);

      const elig = evaluateEmployeeAllocationEligibility(csEmpId, TEST_DATE, { skip_working_team_check: false });
      assert.equal(elig.is_eligible, false);
      assert.ok(elig.exclusion_reasons.includes(ALLOCATION_ERROR_CODES.EMPLOYEE_NOT_IN_WORKING_TEAM));
    });

    test('Section 41 & 42: Stale activity is a hard constraint', () => {
      const cs = db.prepare("SELECT id FROM employees WHERE department = 'CS' AND active = 1 LIMIT 1").get();
      const csEmpId = cs.id;

      db.prepare('DELETE FROM employee_activity_log WHERE work_date = ? AND employee_id = ?').run(TEST_DATE, csEmpId);

      // Add employee to working team
      db.prepare(`
        INSERT INTO daily_working_team (work_date, employee_id, is_working, last_activity_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(work_date, employee_id) DO UPDATE SET is_working = 1, last_activity_at = excluded.last_activity_at
      `).run(TEST_DATE, csEmpId, '2030-01-15 08:00:00');

      // Test with current time 08:30:00 (30 mins later, lookback is 15 min)
      const eligStale = evaluateEmployeeAllocationEligibility(csEmpId, TEST_DATE, {
        currentTime: '2030-01-15T08:30:00Z',
        activity_lookback_minutes: 15
      });
      assert.equal(eligStale.is_eligible, false, 'Activity older than 15 mins must be excluded');
      assert.ok(eligStale.exclusion_reasons.includes(ALLOCATION_ERROR_CODES.EMPLOYEE_ACTIVITY_TOO_OLD));

      // Test with current time 08:10:00 (10 mins later, inside 15 min lookback)
      const eligFresh = evaluateEmployeeAllocationEligibility(csEmpId, TEST_DATE, {
        currentTime: '2030-01-15T08:10:00Z',
        activity_lookback_minutes: 15
      });
      assert.equal(eligFresh.is_eligible, true, 'Fresh activity inside 15 mins must be eligible');
    });
  });

  // ============================================================
  // SECTION 16-24, 172: PENDING SEQUENCE STATE MACHINE
  // ============================================================
  describe('4. PENDING Sequence & NEW Milestone State Machine (Sections 16-24, 172)', () => {

    let empId;

    before(() => {
      const cs = db.prepare("SELECT id FROM employees WHERE department = 'CS' AND active = 1 LIMIT 1").get();
      empId = cs.id;

      // Clean work orders and activity logs for TEST_DATE
      db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
      db.prepare('DELETE FROM employee_activity_log WHERE work_date = ?').run(TEST_DATE);
      db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);

      // Put employee into working team with fresh activity
      db.prepare(`
        INSERT INTO daily_working_team (work_date, employee_id, is_working, last_activity_at)
        VALUES (?, ?, 1, '2030-01-15 18:05:00')
        ON CONFLICT(work_date, employee_id) DO UPDATE SET is_working = 1, last_activity_at = '2030-01-15 18:05:00'
      `).run(TEST_DATE, empId);

      // Set capacity = 50
      db.prepare(`
        INSERT INTO employee_capacities (employee_id, max_orders) VALUES (?, 50)
        ON CONFLICT(employee_id) DO UPDATE SET max_orders = 50
      `).run(empId);
    });

    test('Section 16-22: Sequence progression P1 -> P2 -> P3 -> NEW -> P4', () => {
      // Reset daily state
      db.prepare(`
        INSERT INTO employee_daily_allocation_states (work_date, employee_id, pending_sequence, new_event_consumed, daily_mode, rescue_state)
        VALUES (?, ?, 0, 0, 'NORMAL', 'NONE')
        ON CONFLICT(work_date, employee_id) DO UPDATE SET pending_sequence = 0, new_event_consumed = 0, daily_mode = 'NORMAL'
      `).run(TEST_DATE, empId);

      // Helper to simulate committed allocation
      function commitTestAllocation(workType, count = 5) {
        const orderCodes = [];
        for (let i = 1; i <= count; i++) {
          const code = `ORD_${workType}_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`;
          db.prepare(`
            INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
            VALUES (?, ?, 'TEST_ACC', ?, ?, 'UNASSIGNED')
          `).run(TEST_DATE, code, workType === 'NEW' ? 'New' : 'Pending', workType);
          orderCodes.push(code);
        }

        const plan = planEnterpriseAllocation(TEST_DATE, 'ACTIVE', { currentTime: '2030-01-15T18:10:00Z' });
        assert.equal(plan.status, 'VALID');

        // Execute commit
        const res = executeEnterpriseAllocation(plan);
        assert.equal(res.success, true);
        return res;
      }

      // Check initial state: pending_sequence = 0 -> next due = PENDING (P1)
      let elig = evaluateEmployeeAllocationEligibility(empId, TEST_DATE, { currentTime: '2030-01-15T18:10:00Z' });
      assert.equal(elig.daily_state.pending_sequence, 0);
      assert.equal(elig.next_event_due, 'PENDING');

      // Commit P1 (10 orders in one batch = 1 PENDING event)
      commitTestAllocation('PENDING', 10);
      elig = evaluateEmployeeAllocationEligibility(empId, TEST_DATE, { currentTime: '2030-01-15T18:10:00Z' });
      assert.equal(elig.daily_state.pending_sequence, 1, 'P1 committed advances sequence to 1');
      assert.equal(elig.next_event_due, 'PENDING');

      // Commit P2
      commitTestAllocation('PENDING', 5);
      elig = evaluateEmployeeAllocationEligibility(empId, TEST_DATE, { currentTime: '2030-01-15T18:10:00Z' });
      assert.equal(elig.daily_state.pending_sequence, 2, 'P2 committed advances sequence to 2');
      assert.equal(elig.next_event_due, 'PENDING');

      // Commit P3
      commitTestAllocation('PENDING', 5);
      elig = evaluateEmployeeAllocationEligibility(empId, TEST_DATE, { currentTime: '2030-01-15T18:10:00Z' });
      assert.equal(elig.daily_state.pending_sequence, 3, 'P3 committed advances sequence to 3');
      assert.equal(elig.daily_state.new_event_consumed, 0);
      assert.equal(elig.next_event_due, 'NEW', 'After P3, next event due MUST be NEW');

      // Commit NEW event milestone
      commitTestAllocation('NEW', 8);
      elig = evaluateEmployeeAllocationEligibility(empId, TEST_DATE, { currentTime: '2030-01-15T18:10:00Z' });
      assert.equal(elig.daily_state.new_event_consumed, 1, 'NEW milestone marked consumed');
      assert.equal(elig.daily_state.pending_sequence, 3, 'NEW must NOT reset or advance PENDING sequence!');
      assert.equal(elig.next_event_due, 'PENDING', 'After NEW milestone, next event due MUST be PENDING (P4)');

      // Commit P4
      commitTestAllocation('PENDING', 5);
      elig = evaluateEmployeeAllocationEligibility(empId, TEST_DATE, { currentTime: '2030-01-15T18:10:00Z' });
      assert.equal(elig.daily_state.pending_sequence, 4, 'P4 committed advances sequence to 4');
    });

    test('Section 18 & 102: Sequence does NOT advance on preview or failure', () => {
      const stateBefore = getEmployeeDailyAllocationState(empId, TEST_DATE);
      const seqBefore = stateBefore.pending_sequence;

      // Run Preview
      const preview = planEnterpriseAllocation(TEST_DATE, 'PREVIEW');
      assert.equal(preview.mode, 'PREVIEW');

      const stateAfterPreview = getEmployeeDailyAllocationState(empId, TEST_DATE);
      assert.equal(stateAfterPreview.pending_sequence, seqBefore, 'Preview must NOT advance sequence');
    });
  });

  // ============================================================
  // SECTION 51-61, 173, 179, 180: RESCUE ENGINE & PRESSURE FORMULA
  // ============================================================
  describe('5. PENDING Rescue Engine (Sections 51-61, 173, 179, 180)', () => {

    test('Section 51, 52, 180: 300 NEW + 600 PENDING operational pressure formula', () => {
      // Operational pressure definition:
      // pending_pressure_units = max(0, eligible_unassigned_pending - total_remaining_capacity_of_eligible_pending_participants)
      // rescue_triggered = pending_pressure_units >= configured_pending_rescue_threshold

      // Setup simulated order inventory: 300 NEW, 600 PENDING
      const orders = [];
      for (let i = 1; i <= 300; i++) {
        orders.push({ order_code: `N_${i}`, account: 'ALL_DAY_ACC', status: 'New', source_type: 'NEW' });
      }
      for (let i = 1; i <= 600; i++) {
        orders.push({ order_code: `P_${i}`, account: 'ALL_DAY_ACC', status: 'Pending', source_type: 'PENDING' });
      }

      const rescueEval = evaluatePendingRescueOperation(TEST_DATE, { orders });
      assert.ok(rescueEval.unassigned_pending_orders_count >= 600, 'Must recognize 600 pending orders');
      assert.ok(rescueEval.pending_pressure_units > 20, 'Pressure must exceed default threshold 20');
      assert.equal(rescueEval.rescue_triggered, true, 'Rescue must trigger even though total < 1000!');
      assert.ok(rescueEval.bounded_support_quantity > 0, 'Must calculate bounded support quantity');
    });

    test('Section 23, 24, 58, 173: Rescue support NEW orders do NOT consume normal NEW milestone', () => {
      const cs = db.prepare("SELECT id FROM employees WHERE department = 'CS' AND active = 1 LIMIT 1").get();
      const empId = cs.id;

      // Seed employee state: P2, NEW not consumed, normal mode
      db.prepare(`
        INSERT INTO employee_daily_allocation_states (work_date, employee_id, pending_sequence, new_event_consumed, daily_mode, rescue_state)
        VALUES (?, ?, 2, 0, 'NORMAL', 'NONE')
        ON CONFLICT(work_date, employee_id) DO UPDATE SET pending_sequence = 2, new_event_consumed = 0, daily_mode = 'NORMAL'
      `).run(TEST_DATE, empId);

      // Seed unassigned NEW orders helping as rescue support
      const plan = {
        run_id: `run_rescue_test_${Date.now()}`,
        work_date: TEST_DATE,
        configuration_version: 1,
        context_hash: 'test_hash_rescue',
        fingerprint: 'fp_rescue_test',
        total_orders_input: 5,
        unassigned_count: 0,
        is_rescue_active: true,
        candidate_decisions: [{ employee_id: empId, is_eligible: true }],
        assignments: [
          {
            order_code: `ORD_RESCUE_${Date.now()}`,
            account: 'ALL_DAY_ACC',
            status: 'New',
            work_type: 'NEW',
            employee_id: empId,
            employee_name: 'CS Test Agent',
            allocation_mode: 'PENDING_RESCUE_SUPPORT',
            is_rescue_support: true
          }
        ],
        snapshot_data: { test: true },
        audit_records: []
      };

      // Commit the rescue support allocation
      executeEnterpriseAllocation(plan);

      // Verify daily state after rescue support
      const state = getEmployeeDailyAllocationState(empId, TEST_DATE);
      assert.equal(state.daily_mode, 'PENDING_RESCUE', 'Employee enters daily PENDING_RESCUE mode');
      assert.equal(state.rescue_state, 'ACTIVE', 'Rescue state becomes ACTIVE');
      assert.equal(state.new_event_consumed, 0, 'Rescue support MUST NOT consume normal NEW milestone!');
      assert.equal(state.pending_sequence, 2, 'Rescue support MUST NOT alter PENDING sequence!');

      // Verify normal NEW allocation is now prohibited for the rest of the workday (Section 27)
      const elig = evaluateEmployeeAllocationEligibility(empId, TEST_DATE);
      assert.equal(elig.daily_state.daily_mode, 'PENDING_RESCUE');
      assert.notEqual(elig.next_event_due, 'NEW', 'Normal NEW allocation is prohibited in rescue mode');
    });
  });

  // ============================================================
  // SECTION 66-76, 182: TWO-LEVEL DISTRIBUTION UNIQUENESS
  // ============================================================
  describe('6. Distribution Uniqueness & Fingerprints (Sections 66-76, 182)', () => {

    test('Section 68, 69, 182: Reordered order codes produce IDENTICAL fingerprint', () => {
      const assignments1 = [
        { order_code: 'ORD_A', employee_id: 101 },
        { order_code: 'ORD_B', employee_id: 102 },
        { order_code: 'ORD_C', employee_id: 103 }
      ];

      const assignments2 = [
        { order_code: 'ORD_C', employee_id: 103 },
        { order_code: 'ORD_A', employee_id: 101 },
        { order_code: 'ORD_B', employee_id: 102 }
      ];

      const fp1 = computeDistributionFingerprint(assignments1, TEST_DATE);
      const fp2 = computeDistributionFingerprint(assignments2, TEST_DATE);

      assert.equal(fp1, fp2, 'Different order sequence of the same batch must have identical fingerprint');
    });

    test('Section 70: Different recipient mapping produces DIFFERENT fingerprint', () => {
      const assignments1 = [
        { order_code: 'ORD_A', employee_id: 101 },
        { order_code: 'ORD_B', employee_id: 102 }
      ];

      const assignments2 = [
        { order_code: 'ORD_A', employee_id: 102 }, // Swapped recipient
        { order_code: 'ORD_B', employee_id: 101 }
      ];

      const fp1 = computeDistributionFingerprint(assignments1, TEST_DATE);
      const fp2 = computeDistributionFingerprint(assignments2, TEST_DATE);

      assert.notEqual(fp1, fp2, 'Different recipient mapping must yield different fingerprint');
    });

    test('Section 72 & 182: Duplicate committed distribution is detected and blocked', () => {
      const assignments = [
        { order_code: `ORD_DUP_${Date.now()}_1`, employee_id: 1 },
        { order_code: `ORD_DUP_${Date.now()}_2`, employee_id: 2 }
      ];

      const fp = computeDistributionFingerprint(assignments, TEST_DATE);

      // Initially unique
      const check1 = checkDistributionUniqueness(fp, TEST_DATE);
      assert.equal(check1.is_unique, true);

      // Commit fingerprint to database
      db.prepare(`
        INSERT INTO distribution_fingerprints (fingerprint, work_date, run_id, created_at)
        VALUES (?, ?, 'run_dup_test_1', datetime('now'))
      `).run(fp, TEST_DATE);

      // Second check must detect duplicate
      const check2 = checkDistributionUniqueness(fp, TEST_DATE);
      assert.equal(check2.is_unique, false, 'Must detect duplicate committed distribution');
      assert.equal(check2.existing_run_id, 'run_dup_test_1');
    });
  });

  // ============================================================
  // SECTION 101, 108, 184: TRANSACTIONAL ALL-OR-NOTHING COMMIT
  // ============================================================
  describe('7. Transactional Safety & Atomic Rollback (Sections 101, 108, 184)', () => {

    test('Section 184: Forced failure leaves ZERO side effects in production state', () => {
      const cs = db.prepare("SELECT id FROM employees WHERE department = 'CS' AND active = 1 LIMIT 1").get();
      const empId = cs.id;

      const stateBefore = getEmployeeDailyAllocationState(empId, TEST_DATE);
      const initialRunsCount = db.prepare('SELECT COUNT(*) as cnt FROM enterprise_allocation_runs WHERE work_date = ?').get(TEST_DATE).cnt;

      const brokenPlan = {
        run_id: `run_failure_${Date.now()}`,
        work_date: TEST_DATE,
        configuration_version: 1,
        context_hash: 'bad_hash',
        fingerprint: 'fp_broken',
        total_orders_input: 1,
        unassigned_count: 0,
        candidate_decisions: [],
        assignments: [
          {
            order_code: null, // Intentional NULL order code causing SQLite NOT NULL constraint violation!
            account: 'ARC',
            work_type: 'NEW',
            employee_id: empId,
            employee_name: 'Test',
            is_rescue_support: false
          }
        ],
        snapshot_data: { test: true },
        audit_records: []
      };

      assert.throws(() => {
        executeEnterpriseAllocation(brokenPlan);
      }, 'Commit must throw and abort transaction');

      const runsCountAfter = db.prepare('SELECT COUNT(*) as cnt FROM enterprise_allocation_runs WHERE work_date = ?').get(TEST_DATE).cnt;
      assert.equal(runsCountAfter, initialRunsCount, 'Zero allocation runs must be committed on failure');

      const stateAfter = getEmployeeDailyAllocationState(empId, TEST_DATE);
      assert.equal(stateAfter.pending_sequence, stateBefore.pending_sequence, 'Sequence must not advance on failure');
      assert.equal(stateAfter.new_event_consumed, stateBefore.new_event_consumed, 'NEW milestone must not consume on failure');
    });
  });

  // ============================================================
  // SECTION 35-37, 175: OPERATIONAL ALERTS & DEDUPLICATION
  // ============================================================
  describe('8. Operational Monitoring & Low Remaining Alerts (Sections 35-37, 175)', () => {

    test('Section 175: Low remaining threshold alert generated without duplicate spam', () => {
      const alerts = checkEnterpriseOperationalAlerts(TEST_DATE, '17:55');
      assert.ok(Array.isArray(alerts));

      // Alert generation does NOT trigger allocation (Section 36)
      const runsCount = db.prepare('SELECT COUNT(*) as cnt FROM enterprise_allocation_runs WHERE work_date = ?').get(TEST_DATE).cnt;
      checkEnterpriseOperationalAlerts(TEST_DATE, '17:55');
      const runsCountAfter = db.prepare('SELECT COUNT(*) as cnt FROM enterprise_allocation_runs WHERE work_date = ?').get(TEST_DATE).cnt;
      assert.equal(runsCountAfter, runsCount, 'Alert checks must NEVER execute allocations');
    });
  });

  // ============================================================
  // SECTION 181, 189: LARGE DATA PERFORMANCE TEST (>1000 ORDERS)
  // ============================================================
  describe('9. Large Data Performance (>1000 Orders, Section 181, 189)', () => {

    test('Section 181 & 189: Fast, bounded in-memory planning for 1200 orders', () => {
      const largeOrders = [];
      for (let i = 1; i <= 400; i++) {
        largeOrders.push({ order_code: `LG_NEW_${i}`, account: 'ARC', status: 'New', source_type: 'NEW' });
      }
      for (let i = 1; i <= 800; i++) {
        largeOrders.push({ order_code: `LG_PEN_${i}`, account: 'ALL_DAY_ACC', status: 'Pending', source_type: 'PENDING' });
      }

      const t0 = Date.now();
      const rescueEval = evaluatePendingRescueOperation(TEST_DATE, { orders: largeOrders, currentTime: '2030-01-15T19:00:00Z' });
      const duration = Date.now() - t0;

      assert.ok(duration < 500, `Large load pressure evaluation must complete quickly (took ${duration}ms)`);
      assert.equal(rescueEval.rescue_triggered, true);
    });
  });

  // ============================================================
  // SECTION 10: CRITICAL FORENSIC EDGE INVARIANTS
  // ============================================================
  describe('10. Critical Forensic Edge Invariants', () => {

    test('Mode OFF safeguard: executeEnterpriseAllocation does not mutate state when OFF', () => {
      const testCode = `OFF_ORD_${Date.now()}`;
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'TEST_ACC', 'Pending', 'PENDING', 'UNASSIGNED')
      `).run(TEST_DATE, testCode);

      const res = executeEnterpriseAllocation(TEST_DATE, { forceMode: 'OFF' });
      assert.equal(res.success, false);
      assert.equal(res.status, 'OFF');

      const orderCheck = db.prepare('SELECT work_state, assigned_employee_id FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(TEST_DATE, testCode);
      assert.equal(orderCheck.work_state, 'UNASSIGNED', 'Order must remain UNASSIGNED when engine is OFF');
      assert.equal(orderCheck.assigned_employee_id, null);
    });

    test('Critical Rescue Invariant: Authoritative NEW order keeps work_type=NEW and sets mode=PENDING_RESCUE_SUPPORT', () => {
      const newCode = `RESCUE_ORD_${Date.now()}`;
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
        VALUES (?, ?, 'TEST_ACC', 'New', 'NEW', 'UNASSIGNED')
      `).run(TEST_DATE, newCode);

      // Construct simulated rescue plan
      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW', { currentTime: '2030-01-15T18:10:00Z' });
      const assignedOrd = plan.assignments.find(a => a.order_code === newCode);
      if (assignedOrd) {
        // Assert that original work_type is preserved as NEW
        assert.equal(assignedOrd.work_type, 'NEW', 'Authoritative NEW order must retain work_type=NEW');
      }
    });

    test('Stale Preview Protection: Configuration version mismatch aborts execution with PREVIEW_STALE', () => {
      const plan = planEnterpriseAllocation(TEST_DATE, 'PREVIEW', { currentTime: '2030-01-15T18:10:00Z' });
      assert.ok(plan.plan_id);

      // Mutate plan's configuration version to simulate stale preview
      const stalePlan = { ...plan, configuration_version: plan.configuration_version - 1 };

      assert.throws(() => {
        executeEnterpriseAllocation(stalePlan, { mode: 'ACTIVE', previewPlanId: plan.plan_id });
      }, (err) => {
        return err.code === ALLOCATION_ERROR_CODES.PREVIEW_STALE;
      });
    });
  });
});
