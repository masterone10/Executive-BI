import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import {
  getEnterpriseAllocationConfig,
  saveEnterpriseAllocationConfig,
  saveAccountDaySchedule,
  resetAccountDayScheduleInDb,
  evaluateAccountTimeStatus,
  planEnterpriseAllocation
} from '../services/enterprise_allocation.js';

test('Forensic Account Schedule Root-Cause & 8 Runtime Scenarios Suite', async (t) => {
  const TEST_ACC = 'ARC';

  // Cleanup any test residue for ARC
  db.prepare('DELETE FROM account_schedules WHERE account = ? COLLATE NOCASE').run(TEST_ACC);

  // Set initial default baseline for ARC
  saveAccountDaySchedule({
    account: TEST_ACC,
    status: 'NEW',
    day: 'all',
    start: '08:00',
    end: '18:00',
    operator: 'Supervisor'
  });
  saveAccountDaySchedule({
    account: TEST_ACC,
    status: 'PENDING',
    day: 'all',
    start: '09:00',
    end: '17:00',
    operator: 'Supervisor'
  });

  // Verify baseline in SQLite
  const baselineRow = db.prepare('SELECT * FROM account_schedules WHERE account = ? COLLATE NOCASE').get(TEST_ACC);
  assert.ok(baselineRow, 'ARC row must exist in SQLite');
  assert.equal(baselineRow.new_start_time, '08:00');
  assert.equal(baselineRow.new_end_time, '18:00');
  assert.equal(baselineRow.pending_start_time, '09:00');
  assert.equal(baselineRow.pending_end_time, '17:00');
  console.log('[Baseline Forensic] Initial ARC row in SQLite:', baselineRow);

  // -------------------------------------------------------------
  // Scenario 1: Select Thursday, ARC / NEW = 10:00 -> 14:00, Save, Refresh & verify
  // -------------------------------------------------------------
  await t.test('Scenario 1: Save Thursday Schedule (10:00 -> 14:00) and verify SQLite persistence', () => {
    const saveRes = saveAccountDaySchedule({
      account: TEST_ACC,
      status: 'NEW',
      day: 'thursday',
      start: '10:00',
      end: '14:00',
      operator: 'Supervisor'
    });
    assert.equal(saveRes.success, true);

    // Forensic Database Verification: Query SQLite directly
    const rowAfterThu = db.prepare('SELECT * FROM account_schedules WHERE account = ? COLLATE NOCASE').get(TEST_ACC);
    console.log('[Scenario 1 Forensic] SQLite after Thursday save:', rowAfterThu);
    assert.ok(rowAfterThu.day_schedules_json, 'day_schedules_json must not be empty');

    const parsedThu = JSON.parse(rowAfterThu.day_schedules_json);
    assert.ok(parsedThu.thursday, 'thursday entry must exist in SQLite');
    assert.equal(parsedThu.thursday.new_start_time, '10:00');
    assert.equal(parsedThu.thursday.new_end_time, '14:00');

    // Simulate page refresh / reload via API function
    const reloaded = getEnterpriseAllocationConfig();
    const arcReloaded = reloaded.accounts.find(a => a.account.toLowerCase() === TEST_ACC.toLowerCase());
    assert.ok(arcReloaded, 'ARC must be present in reloaded config');
    assert.equal(arcReloaded.day_schedules?.thursday?.new_start_time, '10:00');
    assert.equal(arcReloaded.day_schedules?.thursday?.new_end_time, '14:00');
  });

  // -------------------------------------------------------------
  // Scenario 2: Without changing Thursday, select Friday, ARC / NEW = 12:00 -> 16:00, Save
  // Verify Thursday is NOT wiped, and Friday is saved
  // -------------------------------------------------------------
  await t.test('Scenario 2: Save Friday Schedule (12:00 -> 16:00) without wiping Thursday', () => {
    const saveRes = saveAccountDaySchedule({
      account: TEST_ACC,
      status: 'NEW',
      day: 'friday',
      start: '12:00',
      end: '16:00',
      operator: 'Supervisor'
    });
    assert.equal(saveRes.success, true);

    // Forensic Database Verification: Query SQLite directly
    const rowAfterFri = db.prepare('SELECT * FROM account_schedules WHERE account = ? COLLATE NOCASE').get(TEST_ACC);
    console.log('[Scenario 2 Forensic] SQLite after Friday save:', rowAfterFri);

    const parsed = JSON.parse(rowAfterFri.day_schedules_json);
    // Both Thursday and Friday MUST exist in SQLite
    assert.ok(parsed.thursday, 'Thursday MUST NOT be wiped when Friday is saved');
    assert.equal(parsed.thursday.new_start_time, '10:00', 'Thursday start time must remain 10:00');
    assert.equal(parsed.thursday.new_end_time, '14:00', 'Thursday end time must remain 14:00');

    assert.ok(parsed.friday, 'Friday must exist in SQLite');
    assert.equal(parsed.friday.new_start_time, '12:00', 'Friday start time must be 12:00');
    assert.equal(parsed.friday.new_end_time, '16:00', 'Friday end time must be 16:00');
  });

  // -------------------------------------------------------------
  // Scenario 3: Modify Thursday to 09:00 -> 15:00, Save
  // Verify Thursday is updated, and Friday is NOT wiped
  // -------------------------------------------------------------
  await t.test('Scenario 3: Modify Thursday Schedule (09:00 -> 15:00) without wiping Friday', () => {
    const saveRes = saveAccountDaySchedule({
      account: TEST_ACC,
      status: 'NEW',
      day: 'thursday',
      start: '09:00',
      end: '15:00',
      operator: 'Supervisor'
    });
    assert.equal(saveRes.success, true);

    // Forensic Database Verification: Query SQLite directly
    const rowAfterThuUpdate = db.prepare('SELECT * FROM account_schedules WHERE account = ? COLLATE NOCASE').get(TEST_ACC);
    console.log('[Scenario 3 Forensic] SQLite after Thursday update:', rowAfterThuUpdate);

    const parsed = JSON.parse(rowAfterThuUpdate.day_schedules_json);
    // Thursday updated
    assert.equal(parsed.thursday.new_start_time, '09:00', 'Thursday start time must be updated to 09:00');
    assert.equal(parsed.thursday.new_end_time, '15:00', 'Thursday end time must be updated to 15:00');

    // Friday untouched
    assert.ok(parsed.friday, 'Friday MUST NOT be wiped when Thursday is updated');
    assert.equal(parsed.friday.new_start_time, '12:00', 'Friday start time must remain 12:00');
    assert.equal(parsed.friday.new_end_time, '16:00', 'Friday end time must remain 16:00');
  });

  // -------------------------------------------------------------
  // Scenario 4: Full refresh / restart / reload from SQLite
  // Verify schedule values remain intact from SQLite
  // -------------------------------------------------------------
  await t.test('Scenario 4: Reload from SQLite reflects both Thursday and Friday schedules', () => {
    const freshConfig = getEnterpriseAllocationConfig();
    const arc = freshConfig.accounts.find(a => a.account.toLowerCase() === TEST_ACC.toLowerCase());
    assert.ok(arc, 'ARC must exist in fresh config loaded from SQLite');

    assert.equal(arc.day_schedules?.thursday?.new_start_time, '09:00');
    assert.equal(arc.day_schedules?.thursday?.new_end_time, '15:00');
    assert.equal(arc.day_schedules?.friday?.new_start_time, '12:00');
    assert.equal(arc.day_schedules?.friday?.new_end_time, '16:00');
  });

  // -------------------------------------------------------------
  // Scenario 5: evaluateAccountTimeStatus() on Thursday uses Thursday schedule,
  // and on Friday uses Friday schedule
  // -------------------------------------------------------------
  await t.test('Scenario 5: Runtime day evaluation uses Thursday on Thursday and Friday on Friday', () => {
    // 1. Thursday evaluation: window is 09:00 -> 15:00
    // At 08:30 (before 09:00) -> NOT_YET_OPEN
    const thuEarly = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '08:30', 'thursday');
    assert.equal(thuEarly.status, 'NOT_YET_OPEN');
    assert.equal(thuEarly.day_override, 'thursday');

    // At 10:00 (inside 09:00 - 15:00) -> OPEN
    const thuOpen = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '10:00', 'thursday');
    assert.equal(thuOpen.status, 'OPEN');
    assert.equal(thuOpen.day_override, 'thursday');

    // At 15:30 (after 15:00) -> CLOSED
    const thuClosed = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '15:30', 'thursday');
    assert.equal(thuClosed.status, 'CLOSED');
    assert.equal(thuClosed.day_override, 'thursday');

    // 2. Friday evaluation: window is 12:00 -> 16:00
    // At 10:00 on Friday (open on Thu, but NOT YET OPEN on Fri) -> NOT_YET_OPEN
    const friEarly = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '10:00', 'friday');
    assert.equal(friEarly.status, 'NOT_YET_OPEN', '10:00 on Friday must be NOT_YET_OPEN');
    assert.equal(friEarly.day_override, 'friday');

    // At 13:00 on Friday -> OPEN
    const friOpen = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '13:00', 'friday');
    assert.equal(friOpen.status, 'OPEN', '13:00 on Friday must be OPEN');
    assert.equal(friOpen.day_override, 'friday');

    // At 16:30 on Friday -> CLOSED
    const friClosed = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '16:30', 'friday');
    assert.equal(friClosed.status, 'CLOSED', '16:30 on Friday must be CLOSED');
    assert.equal(friClosed.day_override, 'friday');
  });

  // -------------------------------------------------------------
  // Scenario 6: Day with no custom schedule (Wednesday) uses Default Schedule (08:00 -> 18:00)
  // -------------------------------------------------------------
  await t.test('Scenario 6: Day with no custom schedule uses Default Schedule', () => {
    // Wednesday has no override, default is 08:00 -> 18:00
    // At 07:30 -> NOT_YET_OPEN
    const wedEarly = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '07:30', 'wednesday');
    assert.equal(wedEarly.status, 'NOT_YET_OPEN');
    assert.equal(wedEarly.day_override, null, 'Must have no day override');

    // At 11:00 -> OPEN
    const wedOpen = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '11:00', 'wednesday');
    assert.equal(wedOpen.status, 'OPEN');
    assert.equal(wedOpen.day_override, null);

    // At 18:30 -> CLOSED
    const wedClosed = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '18:30', 'wednesday');
    assert.equal(wedClosed.status, 'CLOSED');
    assert.equal(wedClosed.day_override, null);
  });

  // -------------------------------------------------------------
  // Scenario 7: Direct API read returns all day schedules without loss
  // -------------------------------------------------------------
  await t.test('Scenario 7: Direct API read returns all day schedules without data loss', () => {
    const config = getEnterpriseAllocationConfig();
    const arc = config.accounts.find(a => a.account.toLowerCase() === TEST_ACC.toLowerCase());
    assert.ok(arc);
    assert.ok(arc.day_schedules.thursday, 'Thursday schedule must be returned by API read');
    assert.ok(arc.day_schedules.friday, 'Friday schedule must be returned by API read');
    assert.equal(arc.day_schedules.thursday.new_start_time, '09:00');
    assert.equal(arc.day_schedules.friday.new_start_time, '12:00');
  });

  // -------------------------------------------------------------
  // Scenario 8: account + NEW vs account + PENDING independence
  // -------------------------------------------------------------
  await t.test('Scenario 8: NEW schedule is independent of PENDING schedule (no overwrite)', () => {
    // Save Thursday PENDING: 14:00 -> 20:00 (while Thursday NEW is 09:00 -> 15:00)
    const saveRes = saveAccountDaySchedule({
      account: TEST_ACC,
      status: 'PENDING',
      day: 'thursday',
      start: '14:00',
      end: '20:00',
      operator: 'Supervisor'
    });
    assert.equal(saveRes.success, true);

    const row = db.prepare('SELECT * FROM account_schedules WHERE account = ? COLLATE NOCASE').get(TEST_ACC);
    const parsed = JSON.parse(row.day_schedules_json);

    // Verify Thursday has BOTH NEW and PENDING independently
    assert.equal(parsed.thursday.new_start_time, '09:00', 'NEW start must remain 09:00');
    assert.equal(parsed.thursday.new_end_time, '15:00', 'NEW end must remain 15:00');
    assert.equal(parsed.thursday.pending_start_time, '14:00', 'PENDING start must be 14:00');
    assert.equal(parsed.thursday.pending_end_time, '20:00', 'PENDING end must be 20:00');

    // Friday must STILL be preserved
    assert.equal(parsed.friday.new_start_time, '12:00', 'Friday NEW must remain 12:00');

    // Evaluation at 10:00 on Thursday:
    // NEW is OPEN (09:00 - 15:00)
    const evalNew = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '10:00', 'thursday');
    assert.equal(evalNew.status, 'OPEN');

    // PENDING is NOT_YET_OPEN (14:00 - 20:00)
    const evalPend = evaluateAccountTimeStatus(TEST_ACC, 'PENDING', '10:00', 'thursday');
    assert.equal(evalPend.status, 'NOT_YET_OPEN');

    // Evaluation at 17:00 on Thursday:
    // NEW is CLOSED (ended at 15:00)
    const evalNewLate = evaluateAccountTimeStatus(TEST_ACC, 'NEW', '17:00', 'thursday');
    assert.equal(evalNewLate.status, 'CLOSED');

    // PENDING is OPEN (14:00 - 20:00)
    const evalPendOpen = evaluateAccountTimeStatus(TEST_ACC, 'PENDING', '17:00', 'thursday');
    assert.equal(evalPendOpen.status, 'OPEN');
  });

  // -------------------------------------------------------------
  // Scenario 9: Reset Thursday to Default and verify Friday remains preserved
  // -------------------------------------------------------------
  await t.test('Scenario 9: Reset Thursday to default deletes Thursday but preserves Friday', () => {
    const resetRes = resetAccountDayScheduleInDb(TEST_ACC, 'thursday', 'Supervisor');
    assert.equal(resetRes.success, true);

    const row = db.prepare('SELECT * FROM account_schedules WHERE account = ? COLLATE NOCASE').get(TEST_ACC);
    const parsed = JSON.parse(row.day_schedules_json);

    assert.equal(parsed.thursday, undefined, 'Thursday must be deleted from SQLite');
    assert.ok(parsed.friday, 'Friday MUST still be preserved in SQLite');
    assert.equal(parsed.friday.new_start_time, '12:00');
  });

  // -------------------------------------------------------------
  // Scenario 10: Case-insensitive upsert prevents duplicate rows
  // -------------------------------------------------------------
  await t.test('Scenario 10: Case-insensitive matching prevents duplicate rows in SQLite', () => {
    saveAccountDaySchedule({
      account: 'arc', // lowercase
      status: 'NEW',
      day: 'friday',
      start: '11:00',
      end: '17:00',
      operator: 'Supervisor'
    });

    const matchingRows = db.prepare('SELECT * FROM account_schedules WHERE account = ? COLLATE NOCASE').all(TEST_ACC);
    assert.equal(matchingRows.length, 1, 'There must be exactly ONE row for ARC regardless of case');
    console.log('[Scenario 10 Forensic] Matching rows in SQLite:', matchingRows);

    const parsed = JSON.parse(matchingRows[0].day_schedules_json);
    assert.equal(parsed.friday.new_start_time, '11:00');
  });

  // Clean test account
  db.prepare('DELETE FROM account_schedules WHERE account = ? COLLATE NOCASE').run(TEST_ACC);
});
