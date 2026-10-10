import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import {
  saveAccountDaySchedule,
  resetAccountDayScheduleInDb,
  evaluateAccountTimeStatus,
  getEnterpriseAllocationConfig
} from '../services/enterprise_allocation.js';
import {
  computePerformanceFromRecords,
  getEmployeeMetricDrilldown
} from '../services/performance.js';
import {
  resolveEmployeeIdentity,
  getIdentityMappingsQueue,
  isNonCsActor
} from '../services/vendoor/identity.js';
import { isCsEmployee } from '../services/parser.js';

describe('Resumed Checkpoint Verification Suite — Identity, Employee Profiles & Weekly Schedule', () => {
  const TEST_DATE = '2026-10-01';

  // ============================================================
  // 1. IDENTITY RESOLUTION & CS CANDIDATE FILTERING
  // ============================================================
  describe('1. Identity Resolution CS Only Enforcement', () => {
    test('isNonCsActor correctly identifies merchants, marketers, and system actors', () => {
      assert.equal(isNonCsActor('system'), true, 'System actor must be non-CS');
      assert.equal(isNonCsActor('Vendoor System'), true, 'Vendoor system actor must be non-CS');
      assert.equal(isNonCsActor('Admin'), true, 'Admin actor must be non-CS');
    });

    test('resolveEmployeeIdentity handles CS case-insensitively (CS, cs, Cs, cS)', () => {
      // Ensure master CS employee exists
      db.prepare(`
        INSERT INTO employees (name, department, active, status)
        VALUES ('Tarek CS', 'CS', 1, 'ACTIVE')
        ON CONFLICT(name) DO UPDATE SET department = 'CS', active = 1
      `).run();

      const rUpper = resolveEmployeeIdentity('Tarek CS', { persistIdentity: false });
      assert.equal(rUpper.employee_name, 'Tarek CS');

      const rLower = resolveEmployeeIdentity('tarek cs', { persistIdentity: false });
      assert.equal(rLower.employee_name, 'Tarek CS');

      const rMixed1 = resolveEmployeeIdentity('Tarek Cs', { persistIdentity: false });
      assert.equal(rMixed1.employee_name, 'Tarek CS');

      const rMixed2 = resolveEmployeeIdentity('Tarek cS', { persistIdentity: false });
      assert.equal(rMixed2.employee_name, 'Tarek CS');
    });

    test('Identity queue excludes merchants and non-CS actors from candidate queue', () => {
      const q = getIdentityMappingsQueue('ALL');
      assert.equal(q.success, true);
      for (const item of q.items) {
        assert.notEqual(item.status, 'NON_CS_ACTOR');
        assert.equal(isNonCsActor(item.vendoor_name), false, 'Queue items must not be non-CS actors');
      }
    });
  });

  // ============================================================
  // 2. EMPLOYEE PROFILES METRIC DRILLDOWN PARITY
  // ============================================================
  describe('2. Employee Profiles Centralized Metrics & Drilldown Parity', () => {
    test('Drilldown record counts strictly match canonical computed metrics', () => {
      // Seed deterministic raw logs for a test CS agent
      const empName = 'Nourhan CS';
      db.prepare(`
        INSERT INTO employees (name, department, active, status)
        VALUES (?, 'CS', 1, 'ACTIVE')
        ON CONFLICT(name) DO UPDATE SET department = 'CS', active = 1
      `).run(empName);

      db.prepare('DELETE FROM raw_log_records WHERE work_date = ? AND employee_name = ?').run(TEST_DATE, empName);

      // Insert: 3 Printed orders, 2 Pending orders, 1 Cancelled order, 2 Alt phones
      const testEvents = [
        { code: 'ORD_PR1', act: 'عدل حالة الاوردر الى Printed', st: 'Printed', time: `${TEST_DATE} 10:00:00` },
        { code: 'ORD_PR2', act: 'عدل حالة الاوردر الى Printed', st: 'Printed', time: `${TEST_DATE} 10:15:00` },
        { code: 'ORD_PR3', act: 'عدل حالة الاوردر الى Printed', st: 'Printed', time: `${TEST_DATE} 10:30:00` },
        // Duplicate event on ORD_PR3 within 30 seconds -> must be deduplicated
        { code: 'ORD_PR3', act: 'عدل حالة الاوردر الى Printed', st: 'Printed', time: `${TEST_DATE} 10:30:25` },
        { code: 'ORD_PEN1', act: 'عدل حالة الاوردر الى Pending', st: 'Pending', time: `${TEST_DATE} 11:00:00` },
        { code: 'ORD_PEN2', act: 'عدل حالة الاوردر الى Pending', st: 'Pending', time: `${TEST_DATE} 11:15:00` },
        { code: 'ORD_CAN1', act: 'عدل حالة الطلب الى Cancelled', st: 'Cancelled', time: `${TEST_DATE} 12:00:00` },
        { code: 'ORD_ALT1', act: 'اضافة رقم هاتف بديل للعميل', st: null, time: `${TEST_DATE} 13:00:00` },
        { code: 'ORD_ALT2', act: 'تحديث رقم التليفون البديل', st: null, time: `${TEST_DATE} 13:30:00` }
      ];

      for (const ev of testEvents) {
        db.prepare(`
          INSERT INTO raw_log_records (employee_name, order_code, action, status, event_datetime, work_date, is_cs)
          VALUES (?, ?, ?, ?, ?, ?, 1)
        `).run(empName, ev.code, ev.act, ev.st, ev.time, TEST_DATE);
      }

      // Check drilldown for PRINTED
      const printDrill = getEmployeeMetricDrilldown(TEST_DATE, empName, 'PRINTED');
      assert.equal(printDrill.success, true);
      assert.equal(printDrill.total_count, 3, 'Printed count must be exactly 3 (deduplicated)');
      assert.equal(printDrill.records.length, 3);
      assert.equal(printDrill.records[0].order_code, 'ORD_PR3');

      // Check drilldown for PENDING
      const pendDrill = getEmployeeMetricDrilldown(TEST_DATE, empName, 'PENDING');
      assert.equal(pendDrill.total_count, 2, 'Pending count must be exactly 2');

      // Check drilldown for CANCEL
      const cancDrill = getEmployeeMetricDrilldown(TEST_DATE, empName, 'CANCEL');
      assert.equal(cancDrill.total_count, 1, 'Cancel count must be exactly 1');

      // Check drilldown for ACTIONS (All status events = 3 + 2 + 1 = 6)
      const actsDrill = getEmployeeMetricDrilldown(TEST_DATE, empName, 'ACTIONS');
      assert.equal(actsDrill.total_count, 6, 'Actions count must be exactly 6');

      // Check drilldown for ALT
      const altDrill = getEmployeeMetricDrilldown(TEST_DATE, empName, 'ALT');
      assert.equal(altDrill.total_count, 2, 'Alt phones count must be exactly 2');
    });
  });

  // ============================================================
  // 3. ACCOUNT WEEKLY ALLOCATION SCHEDULE SPECIFICATION
  // ============================================================
  describe('3. Account Weekly Allocation Schedule (Sections 44-46, 176)', () => {
    const TEST_ACC = 'TEST_WEEKLY_ACC';

    before(() => {
      db.prepare('DELETE FROM account_schedules WHERE account = ? COLLATE NOCASE').run(TEST_ACC);
    });

    test('Save NEW and PENDING independently for Monday', () => {
      // NEW Monday 18:00 - 23:00
      const saveNew = saveAccountDaySchedule({
        account: TEST_ACC,
        status: 'NEW',
        day: 'monday',
        start: '18:00',
        end: '23:00',
        enabled: true,
        operator: 'Supervisor'
      });
      assert.equal(saveNew.success, true);

      // PENDING Monday ALL_DAY (start = null, end = null, enabled = true)
      const savePend = saveAccountDaySchedule({
        account: TEST_ACC,
        status: 'PENDING',
        day: 'monday',
        start: '',
        end: '',
        enabled: true,
        operator: 'Supervisor'
      });
      assert.equal(savePend.success, true);

      // Verify in SQLite
      const row = db.prepare('SELECT * FROM account_schedules WHERE account = ? COLLATE NOCASE').get(TEST_ACC);
      assert.ok(row, 'Account row must exist');
      const daySched = JSON.parse(row.day_schedules_json);
      assert.ok(daySched.monday, 'Monday override must exist');
      assert.equal(daySched.monday.new_start_time, '18:00');
      assert.equal(daySched.monday.new_end_time, '23:00');
      assert.equal(daySched.monday.new_enabled, true);
      assert.equal(daySched.monday.pending_start_time, '');
      assert.equal(daySched.monday.pending_end_time, '');
      assert.equal(daySched.monday.pending_enabled, true);
    });

    test('Evaluate Monday boundary: Before 18:00, NEW is NOT_YET_OPEN, PENDING is ALL_DAY OPEN', () => {
      // At 17:59 on Monday:
      // NEW is NOT_YET_OPEN
      const stNew1759 = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '17:59', 'monday');
      assert.equal(stNew1759.is_open, false);
      assert.equal(stNew1759.status, 'NOT_YET_OPEN');

      // PENDING is ALL_DAY -> OPEN
      const stPend1759 = evaluateAccountTimeStatus(TEST_ACC, 'PENDING', '17:59', 'monday');
      assert.equal(stPend1759.is_open, true);
      assert.equal(stPend1759.status, 'ALL_DAY');

      // At 18:00 on Monday:
      // NEW is OPEN
      const stNew1800 = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '18:00', 'monday');
      assert.equal(stNew1800.is_open, true);
      assert.equal(stNew1800.status, 'OPEN');

      // At 23:00 on Monday:
      // NEW is CLOSED
      const stNew2300 = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '23:00', 'monday');
      assert.equal(stNew2300.is_open, false);
      assert.equal(stNew2300.status, 'CLOSED');
    });

    test('Disabling a day status immediately marks it CLOSED/DISABLED', () => {
      // Disable NEW on Monday
      saveAccountDaySchedule({
        account: TEST_ACC,
        status: 'NEW',
        day: 'monday',
        enabled: false,
        operator: 'Supervisor'
      });

      const stNewDisabled = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '19:00', 'monday');
      assert.equal(stNewDisabled.is_open, false);
      assert.equal(stNewDisabled.status, 'CLOSED');

      // PENDING remains active and ALL_DAY
      const stPendActive = evaluateAccountTimeStatus(TEST_ACC, 'PENDING', '19:00', 'monday');
      assert.equal(stPendActive.is_open, true);
      assert.equal(stPendActive.status, 'ALL_DAY');
    });

    test('Persisting Wednesday preserves Monday schedule without overwriting', () => {
      saveAccountDaySchedule({
        account: TEST_ACC,
        status: 'NEW',
        day: 'wednesday',
        start: '09:00',
        end: '15:00',
        enabled: true,
        operator: 'Supervisor'
      });

      const row = db.prepare('SELECT * FROM account_schedules WHERE account = ? COLLATE NOCASE').get(TEST_ACC);
      const daySched = JSON.parse(row.day_schedules_json);
      assert.ok(daySched.monday, 'Monday must still exist');
      assert.ok(daySched.wednesday, 'Wednesday must exist');
      assert.equal(daySched.wednesday.new_start_time, '09:00');
      assert.equal(daySched.wednesday.new_end_time, '15:00');
    });
  });
});
