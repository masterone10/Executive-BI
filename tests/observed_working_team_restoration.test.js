import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import {
  syncAndRestoreObservedTeam,
  resetToObservedWorkingTeam,
  getComprehensiveWorkingTeamStatus,
  toggleWorkingTeamMember
} from '../services/working_team_ops.js';
import {
  getWorkingTeam,
  saveWorkingTeam,
  getCurrentWorkOverview
} from '../services/allocation.js';
import {
  getDispatcherStatus,
  getDispatcherAlerts,
  getDispatcherConfig
} from '../services/vendoor/dispatcher.js';

test('REGRESSION TEST SUITE: TODAY WORKING TEAM AUTO-RESTORATION FROM REAL VENDOOR LOGS', async (t) => {
  const testDate = '2026-11-15';
  const otherDate = '2026-11-16';

  // Setup helper: Clean database for test dates
  function cleanTestDates() {
    db.prepare("DELETE FROM daily_working_team WHERE work_date IN (?, ?)").run(testDate, otherDate);
    db.prepare("DELETE FROM vendoor_logs WHERE work_date IN (?, ?)").run(testDate, otherDate);
    db.prepare("DELETE FROM raw_log_records WHERE work_date IN (?, ?)").run(testDate, otherDate);
    db.prepare("DELETE FROM employees WHERE name LIKE 'AutoObsTest_%'").run();
  }

  cleanTestDates();

  // Helper: insert test employee
  const insertEmp = db.prepare(`
    INSERT INTO employees (name, department, active, status, team_membership, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);

  const emp1Res = insertEmp.run('AutoObsTest_Worker1', 'CS', 1, 'ACTIVE', 'Both');
  const emp1Id = emp1Res.lastInsertRowid;

  const emp2Res = insertEmp.run('AutoObsTest_Worker2', 'CS', 1, 'ACTIVE', 'New');
  const emp2Id = emp2Res.lastInsertRowid;

  const empDepartedRes = insertEmp.run('AutoObsTest_DepartedWorker', 'CS', 0, 'DEPARTED', 'Both');
  const empDepartedId = empDepartedRes.lastInsertRowid;

  // Insert mock Vendoor logs for emp1 and emp2 on testDate
  const insertLog = db.prepare(`
    INSERT INTO vendoor_logs (
      work_date, employee_name, matched_employee_id, action,
      order_code, is_productive, timestamp_str
    ) VALUES (?, ?, ?, ?, ?, 1, ?)
  `);

  insertLog.run(testDate, 'AutoObsTest_Worker1', emp1Id, 'STATUS_CHANGE: PREPARED', 'ORD-001', '2026-11-15 08:30:00');
  insertLog.run(testDate, 'AutoObsTest_Worker1', emp1Id, 'PRINTED', 'ORD-002', '2026-11-15 09:15:00');
  insertLog.run(testDate, 'AutoObsTest_Worker2', emp2Id, 'STATUS_CHANGE: DELIVERED', 'ORD-003', '2026-11-15 07:00:00');

  // Also insert log for departed employee to test exclusion
  insertLog.run(testDate, 'AutoObsTest_DepartedWorker', empDepartedId, 'PRINTED', 'ORD-004', '2026-11-15 08:00:00');

  // Also insert an unknown name not in Employee Master
  insertLog.run(testDate, 'AutoObsTest_PhantomGhostName', null, 'PRINTED', 'ORD-005', '2026-11-15 08:45:00');

  // -------------------------------------------------------------
  // Scenario 1: No manual team + real Vendoor logs today -> auto restores VENDOOR_OBSERVED team
  // -------------------------------------------------------------
  await t.test('Scenario 1: Auto restores VENDOOR_OBSERVED team when no manual team exists', async () => {
    const restoreRes = syncAndRestoreObservedTeam(testDate);
    assert.equal(restoreRes.status, 'VENDOOR_OBSERVED');
    assert.equal(restoreRes.source, 'VENDOOR_OBSERVED');
    assert.equal(restoreRes.has_manual_configuration, false);
    assert.equal(restoreRes.restored, true);
    assert.ok(restoreRes.working_count >= 2, `Expected at least 2 working agents, got ${restoreRes.working_count}`);

    // Check comprehensive status
    const status = getComprehensiveWorkingTeamStatus(testDate);
    assert.equal(status.working_team_source, 'VENDOOR_OBSERVED');
    assert.equal(status.has_manual_configuration, false);

    const m1 = status.team_members.find(m => m.employee_id === emp1Id);
    assert.ok(m1, 'Worker 1 must be present in team members');
    assert.equal(m1.is_working, true);
    assert.equal(m1.membership_source, 'VENDOOR_OBSERVED');
    assert.equal(m1.is_observed_today, true);
  });

  // -------------------------------------------------------------
  // Scenario 2: Valid Manual team exists -> preserves exact manual team, ignores logs override
  // -------------------------------------------------------------
  await t.test('Scenario 2: Preserves manual team precedence and does not overwrite with logs', async () => {
    // Manually set ONLY worker2 as working for testDate
    saveWorkingTeam(testDate, [{ employee_id: emp2Id, is_working: 1 }]);

    const restoreRes = syncAndRestoreObservedTeam(testDate);
    assert.equal(restoreRes.status, 'MANUAL');
    assert.equal(restoreRes.source, 'MANUAL');
    assert.equal(restoreRes.has_manual_configuration, true);
    assert.equal(restoreRes.restored, false);

    const status = getComprehensiveWorkingTeamStatus(testDate);
    assert.equal(status.working_team_source, 'MANUAL');
    assert.equal(status.has_manual_configuration, true);

    const m1 = status.team_members.find(m => m.employee_id === emp1Id);
    const m2 = status.team_members.find(m => m.employee_id === emp2Id);
    assert.equal(m1.is_working, false, 'Worker 1 was omitted manually and must NOT be forced back in');
    assert.equal(m2.is_working, true, 'Worker 2 was manually selected');
    assert.equal(m2.membership_source, 'MANUAL');
  });

  // -------------------------------------------------------------
  // Scenario 3: Logs contain unknown identity -> routes to Review Queue / UNKNOWN, never inserts to Employee Master
  // -------------------------------------------------------------
  await t.test('Scenario 3: Unknown identities in logs NEVER auto-create employee records', async () => {
    const countBefore = db.prepare("SELECT COUNT(*) as c FROM employees WHERE name = 'AutoObsTest_PhantomGhostName'").get().c;
    assert.equal(countBefore, 0, 'Ghost name must not exist in employee master');

    resetToObservedWorkingTeam(testDate);

    const countAfter = db.prepare("SELECT COUNT(*) as c FROM employees WHERE name = 'AutoObsTest_PhantomGhostName'").get().c;
    assert.equal(countAfter, 0, 'Ghost name must STILL not exist in employee master');

    const status = getComprehensiveWorkingTeamStatus(testDate);
    const hasGhostInTeam = status.team_members.some(m => m.name === 'AutoObsTest_PhantomGhostName');
    assert.equal(hasGhostInTeam, false, 'Ghost name must NOT be a team member');
    assert.ok(status.unmatched_logs.some(u => u.raw_name === 'AutoObsTest_PhantomGhostName'), 'Ghost name must be recorded in unmatched_logs');
  });

  // -------------------------------------------------------------
  // Scenario 4: Employee is DEPARTED / INACTIVE -> never enters observed team even if log exists
  // -------------------------------------------------------------
  await t.test('Scenario 4: DEPARTED or INACTIVE employee strictly excluded from observed team', async () => {
    resetToObservedWorkingTeam(testDate);

    const status = getComprehensiveWorkingTeamStatus(testDate);
    const depMember = status.team_members.find(m => m.employee_id === empDepartedId);
    assert.ok(depMember, 'Departed worker found in master list');
    assert.equal(depMember.is_working, false, 'Departed worker must NOT be marked working');
    assert.equal(depMember.membership_source, 'DEPARTED');
    assert.equal(depMember.eligibility, 'DEPARTED');

    // Also check daily_working_team table row
    const dwtRow = db.prepare("SELECT is_working FROM daily_working_team WHERE work_date = ? AND employee_id = ?").get(testDate, empDepartedId);
    assert.ok(!dwtRow || dwtRow.is_working === 0, 'daily_working_team must not have is_working=1 for departed worker');
  });

  // -------------------------------------------------------------
  // Scenario 5: Business Date isolation -> today's team doesn't leak to yesterday or tomorrow
  // -------------------------------------------------------------
  await t.test('Scenario 5: Strict Business Date isolation', async () => {
    // otherDate has no logs and no manual team
    const otherStatus = getComprehensiveWorkingTeamStatus(otherDate);
    assert.equal(otherStatus.has_manual_configuration, false);
    assert.equal(otherStatus.working_team_source, 'SETUP_REQUIRED');
    assert.equal(otherStatus.summary.working_team_count, 0);

    const otherOverview = getCurrentWorkOverview(otherDate);
    assert.equal(otherOverview.working_team_count, 0);
  });

  // -------------------------------------------------------------
  // Scenario 6: Inactive / idle worker (no log in last 30 minutes) -> NOT removed
  // -------------------------------------------------------------
  await t.test('Scenario 6: Lack of a recent log does NOT remove employee from observed team', async () => {
    // Worker 2 had an action at 07:00:00 (several hours ago)
    resetToObservedWorkingTeam(testDate);
    const status = getComprehensiveWorkingTeamStatus(testDate);
    const m2 = status.team_members.find(m => m.employee_id === emp2Id);
    assert.equal(m2.is_working, true, 'Worker 2 with earlier action must remain in working team');
    assert.equal(m2.membership_source, 'VENDOOR_OBSERVED');
  });

  // -------------------------------------------------------------
  // Scenario 7: Persistence -> source = 'VENDOOR_OBSERVED', observed_at, last_activity_at
  // -------------------------------------------------------------
  await t.test('Scenario 7: Database persistence tracks source, observed_at, and last_activity_at', async () => {
    resetToObservedWorkingTeam(testDate);
    const row = db.prepare("SELECT source, observed_at, last_activity_at FROM daily_working_team WHERE work_date = ? AND employee_id = ?").get(testDate, emp1Id);
    assert.ok(row, 'Row in daily_working_team must exist');
    assert.equal(row.source, 'VENDOOR_OBSERVED');
    assert.ok(row.observed_at, 'observed_at must be populated');
    assert.equal(row.last_activity_at, '2026-11-15 09:15:00');
  });

  // -------------------------------------------------------------
  // Scenario 8: Dispatcher OFF remains OFF when observed team restored
  // -------------------------------------------------------------
  await t.test('Scenario 8: Dispatcher OFF remains OFF even after observed team restoration', async () => {
    const dispStatus = getDispatcherStatus();
    const cfg = getDispatcherConfig();
    if (!cfg.enabled) {
      assert.equal(dispStatus.operational_status, 'OFF', 'Dispatcher must remain OFF');
      assert.equal(dispStatus.is_running, false);
    }
  });

  // -------------------------------------------------------------
  // Scenario 9: Allocation engine respect eligibility and capacity
  // -------------------------------------------------------------
  await t.test('Scenario 9: Working team feeds correct allowed teams and eligibility', async () => {
    const wtList = getWorkingTeam(testDate);
    const w1 = wtList.find(e => e.employee_id === emp1Id);
    const w2 = wtList.find(e => e.employee_id === emp2Id);
    assert.equal(w1.is_working, true);
    assert.equal(w1.allowed_new, true);
    assert.equal(w1.allowed_pending, true);

    assert.equal(w2.is_working, true);
    assert.equal(w2.allowed_new, true);
    assert.equal(w2.allowed_pending, false, 'Worker 2 is permanent New only');
  });

  // -------------------------------------------------------------
  // Scenario 10: Dynamic addition of newly active employee in subsequent sync
  // -------------------------------------------------------------
  await t.test('Scenario 10: Newly active employee in subsequent sync is dynamically added to observed team', async () => {
    const emp3Res = insertEmp.run('AutoObsTest_LateWorker', 'CS', 1, 'ACTIVE', 'Both');
    const emp3Id = emp3Res.lastInsertRowid;

    // Simulate new log arriving
    insertLog.run(testDate, 'AutoObsTest_LateWorker', emp3Id, 'PRINTED', 'ORD-006', '2026-11-15 11:30:00');

    // Run sync again
    const res = syncAndRestoreObservedTeam(testDate);
    assert.equal(res.status, 'VENDOOR_OBSERVED');

    const status = getComprehensiveWorkingTeamStatus(testDate);
    const m3 = status.team_members.find(m => m.employee_id === emp3Id);
    assert.ok(m3, 'Late worker must be present');
    assert.equal(m3.is_working, true);
    assert.equal(m3.membership_source, 'VENDOOR_OBSERVED');
  });

  // -------------------------------------------------------------
  // Scenario 11: Manual toggle converts/records as MANUAL
  // -------------------------------------------------------------
  await t.test('Scenario 11: Manual toggle marks source as MANUAL', async () => {
    const toggleRes = toggleWorkingTeamMember(testDate, emp1Id, false);
    assert.equal(toggleRes.success, true);
    assert.equal(toggleRes.source, 'MANUAL');

    const row = db.prepare("SELECT is_working, source FROM daily_working_team WHERE work_date = ? AND employee_id = ?").get(testDate, emp1Id);
    assert.equal(row.is_working, 0);
    assert.equal(row.source, 'MANUAL');
  });

  // -------------------------------------------------------------
  // Scenario 12: Empty logs + no manual team -> status = SETUP_REQUIRED, team = 0
  // -------------------------------------------------------------
  await t.test('Scenario 12: Empty logs + no manual team -> SETUP_REQUIRED, team = 0, no blind fallback', async () => {
    const emptyDate = '2026-12-01';
    db.prepare("DELETE FROM daily_working_team WHERE work_date = ?").run(emptyDate);
    db.prepare("DELETE FROM vendoor_logs WHERE work_date = ?").run(emptyDate);
    db.prepare("DELETE FROM raw_log_records WHERE work_date = ?").run(emptyDate);

    const restoreRes = syncAndRestoreObservedTeam(emptyDate);
    assert.equal(restoreRes.status, 'SETUP_REQUIRED');
    assert.equal(restoreRes.working_count, 0);

    const status = getComprehensiveWorkingTeamStatus(emptyDate);
    assert.equal(status.working_team_source, 'SETUP_REQUIRED');
    assert.equal(status.summary.working_team_count, 0);

    const wtList = getWorkingTeam(emptyDate);
    assert.ok(wtList.every(e => !e.is_working), 'No employee should be considered working when team is unconfigured and no logs exist');
  });

  // Clean up test data
  cleanTestDates();
});
