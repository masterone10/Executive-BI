import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import {
  getEnterpriseAllocationConfig,
  saveEnterpriseAllocationConfig,
  validateEnterpriseAllocationConfig,
  evaluateAccountTimeStatus,
  planEnterpriseAllocation,
  executeEnterpriseAllocation
} from '../services/enterprise_allocation.js';

test('Multi-Day Account + Status Schedule Persistence & Evaluation Suite', async (t) => {
  // Setup isolated test account
  const TEST_ACC = 'TEST_MULTI_DAY_ARC';
  const TEST_THU_DATE = '2026-10-01'; // 2026-10-01 is Thursday
  const TEST_FRI_DATE = '2026-10-02'; // 2026-10-02 is Friday
  const TEST_SAT_DATE = '2026-10-03'; // 2026-10-03 is Saturday

  // Clean initial state
  db.prepare('DELETE FROM account_schedules WHERE account = ?').run(TEST_ACC);

  await t.test('Step 1: Save Thursday Schedule and verify persistence', () => {
    const initialConfig = getEnterpriseAllocationConfig();
    let acc = initialConfig.accounts.find(a => a.account.toLowerCase() === TEST_ACC.toLowerCase());
    if (!acc) {
      acc = {
        account: TEST_ACC,
        new_start_time: '08:00',
        new_end_time: '18:00',
        pending_start_time: '09:00',
        pending_end_time: '17:00',
        day_schedules: {}
      };
      initialConfig.accounts.push(acc);
    } else {
      acc.new_start_time = '08:00';
      acc.new_end_time = '18:00';
      acc.pending_start_time = '09:00';
      acc.pending_end_time = '17:00';
      acc.day_schedules = {};
    }

    // Set Thursday override: ARC NEW = 10:00 -> 14:00
    acc.day_schedules['thursday'] = {
      new_start_time: '10:00',
      new_end_time: '14:00',
      pending_start_time: '11:00',
      pending_end_time: '15:00'
    };

    const valResult = validateEnterpriseAllocationConfig(initialConfig);
    assert.equal(valResult.valid, true, 'Thursday config draft must be valid');

    const saveRes = saveEnterpriseAllocationConfig(initialConfig, 'Supervisor', initialConfig.version);
    assert.equal(saveRes.success, true, 'Save Thursday must succeed');

    // Reload from database
    const reloaded = getEnterpriseAllocationConfig();
    const reloadedAcc = reloaded.accounts.find(a => a.account.toLowerCase() === TEST_ACC.toLowerCase());
    assert.ok(reloadedAcc, 'Account must exist after reload');
    assert.equal(reloadedAcc.new_start_time, '08:00', 'Default NEW start time preserved');
    assert.equal(reloadedAcc.new_end_time, '18:00', 'Default NEW end time preserved');
    assert.ok(reloadedAcc.day_schedules, 'day_schedules object must exist');
    assert.ok(reloadedAcc.day_schedules.thursday, 'Thursday schedule must exist');
    assert.equal(reloadedAcc.day_schedules.thursday.new_start_time, '10:00');
    assert.equal(reloadedAcc.day_schedules.thursday.new_end_time, '14:00');
    assert.equal(reloadedAcc.day_schedules.thursday.pending_start_time, '11:00');
    assert.equal(reloadedAcc.day_schedules.thursday.pending_end_time, '15:00');
  });

  await t.test('Step 2: Save Friday Schedule and verify Thursday is NOT erased', () => {
    // Fetch latest config (which has Thursday)
    const configAfterThu = getEnterpriseAllocationConfig();
    const acc = configAfterThu.accounts.find(a => a.account.toLowerCase() === TEST_ACC.toLowerCase());
    assert.ok(acc.day_schedules.thursday, 'Thursday schedule must be present in config before editing Friday');

    // Edit Friday: ARC NEW = 12:00 -> 16:00
    acc.day_schedules['friday'] = {
      new_start_time: '12:00',
      new_end_time: '16:00',
      pending_start_time: '13:00',
      pending_end_time: '17:00'
    };

    const valResult = validateEnterpriseAllocationConfig(configAfterThu);
    assert.equal(valResult.valid, true, 'Draft with Thursday + Friday must be valid');

    const saveRes = saveEnterpriseAllocationConfig(configAfterThu, 'Supervisor', configAfterThu.version);
    assert.equal(saveRes.success, true, 'Save Friday must succeed');

    // Reload and verify BOTH Thursday and Friday exist independently
    const reloaded = getEnterpriseAllocationConfig();
    const reloadedAcc = reloaded.accounts.find(a => a.account.toLowerCase() === TEST_ACC.toLowerCase());
    assert.ok(reloadedAcc.day_schedules.thursday, 'Thursday schedule must NOT be erased by saving Friday');
    assert.ok(reloadedAcc.day_schedules.friday, 'Friday schedule must be saved');

    assert.equal(reloadedAcc.day_schedules.thursday.new_start_time, '10:00');
    assert.equal(reloadedAcc.day_schedules.thursday.new_end_time, '14:00');
    assert.equal(reloadedAcc.day_schedules.friday.new_start_time, '12:00');
    assert.equal(reloadedAcc.day_schedules.friday.new_end_time, '16:00');
  });

  await t.test('Step 3: Save Thursday update and verify Friday is NOT erased', () => {
    const currentConfig = getEnterpriseAllocationConfig();
    const acc = currentConfig.accounts.find(a => a.account.toLowerCase() === TEST_ACC.toLowerCase());

    // Update Thursday slightly: 10:30 -> 14:30
    acc.day_schedules.thursday.new_start_time = '10:30';
    acc.day_schedules.thursday.new_end_time = '14:30';

    const saveRes = saveEnterpriseAllocationConfig(currentConfig, 'Supervisor', currentConfig.version);
    assert.equal(saveRes.success, true);

    // Reload and verify
    const reloaded = getEnterpriseAllocationConfig();
    const reloadedAcc = reloaded.accounts.find(a => a.account.toLowerCase() === TEST_ACC.toLowerCase());
    assert.equal(reloadedAcc.day_schedules.thursday.new_start_time, '10:30');
    assert.equal(reloadedAcc.day_schedules.thursday.new_end_time, '14:30');
    assert.ok(reloadedAcc.day_schedules.friday, 'Friday schedule must NOT be erased by updating Thursday');
    assert.equal(reloadedAcc.day_schedules.friday.new_start_time, '12:00');
    assert.equal(reloadedAcc.day_schedules.friday.new_end_time, '16:00');
  });

  await t.test('Step 4: Verify accurate day-specific time window boundaries in evaluateAccountTimeStatus', () => {
    // Thursday Evaluation (2026-10-01) -> NEW is 10:30 -> 14:30
    const thuBeforeOpen = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '10:00', TEST_THU_DATE);
    assert.equal(thuBeforeOpen.is_open, false, 'Thursday 10:00 must be CLOSED (window opens 10:30)');
    assert.equal(thuBeforeOpen.status, 'NOT_YET_OPEN');
    assert.equal(thuBeforeOpen.day_override, 'thursday');

    const thuAtOpen = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '10:30', TEST_THU_DATE);
    assert.equal(thuAtOpen.is_open, true, 'Thursday exact start 10:30 must be OPEN');
    assert.equal(thuAtOpen.status, 'OPEN');

    const thuInside = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '12:00', TEST_THU_DATE);
    assert.equal(thuInside.is_open, true, 'Thursday 12:00 must be OPEN');

    const thuAtClose = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '14:30', TEST_THU_DATE);
    assert.equal(thuAtClose.is_open, false, 'Thursday exact end 14:30 must be CLOSED');
    assert.equal(thuAtClose.status, 'CLOSED');

    // Friday Evaluation (2026-10-02) -> NEW is 12:00 -> 16:00
    const friBeforeOpen = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '11:30', TEST_FRI_DATE);
    assert.equal(friBeforeOpen.is_open, false, 'Friday 11:30 must be CLOSED (window opens 12:00)');
    assert.equal(friBeforeOpen.day_override, 'friday');

    const friAtOpen = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '12:00', TEST_FRI_DATE);
    assert.equal(friAtOpen.is_open, true, 'Friday exact start 12:00 must be OPEN');

    const friInside = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '15:00', TEST_FRI_DATE);
    assert.equal(friInside.is_open, true, 'Friday 15:00 must be OPEN');

    const friAtClose = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '16:00', TEST_FRI_DATE);
    assert.equal(friAtClose.is_open, false, 'Friday exact end 16:00 must be CLOSED');

    // Saturday Evaluation (2026-10-03) -> No day override -> Falls back to default 08:00 -> 18:00
    const satAt09 = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '09:00', TEST_SAT_DATE);
    assert.equal(satAt09.is_open, true, 'Saturday 09:00 falls back to default schedule and must be OPEN');
    assert.equal(satAt09.day_override, null, 'No day override on Saturday');
  });

  await t.test('Step 5: Verify Enterprise Allocation Engine respects day-specific schedule in real planning', () => {
    // Setup test orders for Thursday and Friday
    db.prepare('DELETE FROM current_work_orders WHERE account = ?').run(TEST_ACC);

    // Create 5 NEW orders for Thursday
    const insOrder = db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, work_state)
      VALUES (?, ?, ?, 'New', 'UNASSIGNED')
    `);

    insOrder.run(TEST_THU_DATE, 'ORD_THU_1', TEST_ACC);
    insOrder.run(TEST_THU_DATE, 'ORD_THU_2', TEST_ACC);

    // Ensure working team exists
    const emp = db.prepare("SELECT id FROM employees WHERE department = 'CS' AND active = 1 LIMIT 1").get();
    if (emp) {
      db.prepare(`
        INSERT INTO daily_working_team (work_date, employee_id, is_working, last_productive_activity_at)
        VALUES (?, ?, 1, datetime('now'))
        ON CONFLICT(work_date, employee_id) DO UPDATE SET is_working = 1, last_productive_activity_at = datetime('now')
      `).run(TEST_THU_DATE, emp.id);
    }

    // Plan on Thursday at 10:00 (Outside Thursday window 10:30-14:30) -> Orders should be EXCLUDED
    const planThuClosed = planEnterpriseAllocation(TEST_THU_DATE, 'PREVIEW', { currentTimeStr: '10:00' });
    const arcThuExcluded = (planThuClosed.audit_records || []).some(
      d => d.entity_id === 'ORD_THU_1' && d.decision === 'EXCLUDED'
    );
    assert.ok(arcThuExcluded, 'Order on Thursday 10:00 must be excluded due to account closed at 10:00');

    // Plan on Thursday at 12:00 (Inside Thursday window 10:30-14:30) -> Orders should be ELIGIBLE
    const planThuOpen = planEnterpriseAllocation(TEST_THU_DATE, 'PREVIEW', { currentTimeStr: '12:00' });
    const arcThuAssigned = (planThuOpen.assignments || planThuOpen.proposal || []).some(p => p.order_code === 'ORD_THU_1');
    assert.ok(arcThuAssigned, 'Order on Thursday 12:00 must be assigned during open time window');

    // Clean up test orders
    db.prepare('DELETE FROM current_work_orders WHERE account = ?').run(TEST_ACC);
    db.prepare('DELETE FROM account_schedules WHERE account = ?').run(TEST_ACC);
  });

  await t.test('Step 6: Automatic day-of-week detection and named day parameter', async () => {
    // Setup test account with specific Saturday schedule and default schedule
    const ACC_AUTO = 'TEST_AUTO_DAY_ACC';
    db.prepare('DELETE FROM account_schedules WHERE account = ?').run(ACC_AUTO);

    const draft = {
      accounts: [
        {
          account: ACC_AUTO,
          new_start_time: '18:00',
          new_end_time: '23:00',
          day_schedules: {
            saturday: {
              new_start_time: '09:00',
              new_end_time: '13:00'
            },
            thursday: {
              new_start_time: '11:00',
              new_end_time: '15:00'
            }
          }
        }
      ],
      employees: [],
      global_settings: {}
    };

    saveEnterpriseAllocationConfig(draft, 'TEST_OPERATOR');

    // 1. Direct named day 'saturday'
    const evalSat = evaluateAccountTimeStatus(ACC_AUTO, 'NEW', '10:00', 'saturday');
    assert.equal(evalSat.status, 'OPEN');
    assert.equal(evalSat.day_override, 'saturday');

    // 2. Direct named day 'thursday' at 10:00 (before 11:00)
    const evalThuEarly = evaluateAccountTimeStatus(ACC_AUTO, 'NEW', '10:00', 'thursday');
    assert.equal(evalThuEarly.status, 'NOT_YET_OPEN');
    assert.equal(evalThuEarly.day_override, 'thursday');

    // 3. Direct named day 'thursday' at 12:00 (between 11:00 and 15:00)
    const evalThuOpen = evaluateAccountTimeStatus(ACC_AUTO, 'NEW', '12:00', 'thursday');
    assert.equal(evalThuOpen.status, 'OPEN');

    // 4. Day with no override (e.g. 'monday') falls back to default 18:00-23:00
    const evalMonEarly = evaluateAccountTimeStatus(ACC_AUTO, 'NEW', '12:00', 'monday');
    assert.equal(evalMonEarly.status, 'NOT_YET_OPEN');
    assert.equal(evalMonEarly.day_override, null);

    const evalMonOpen = evaluateAccountTimeStatus(ACC_AUTO, 'NEW', '19:00', 'monday');
    assert.equal(evalMonOpen.status, 'OPEN');
    assert.equal(evalMonOpen.day_override, null);

    // 5. Automatic Cairo day without passing workDate
    const evalAuto = evaluateAccountTimeStatus(ACC_AUTO, 'NEW');
    assert.ok(evalAuto.status, 'Automatic evaluation should return valid status');
    assert.ok(evalAuto.current_time, 'Should contain current time');

    db.prepare('DELETE FROM account_schedules WHERE account = ?').run(ACC_AUTO);
  });
});
