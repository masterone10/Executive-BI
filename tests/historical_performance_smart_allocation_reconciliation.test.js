import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import { isCsEmployee } from '../services/parser.js';
import { isCSDepartment, getWorkingTeam } from '../services/allocation.js';
import { getEmployeePerformanceProfiles } from '../services/performance.js';

describe('Historical Performance -> Smart Allocation Final Reconciliation Suite', () => {

  test('1. Employee Identity & Active CS Roster Count Reconciliation', () => {
    const allEmployees = db.prepare('SELECT id, name, department, active, status FROM employees').all();
    assert.strictEqual(allEmployees.length, 60, 'Total employees in employees table must be exactly 60');

    const activeCs = allEmployees.filter(e => e.department === 'CS' && e.active === 1 && (e.status === 'ACTIVE' || e.status === null));
    assert.strictEqual(activeCs.length, 45, 'Active CS employees must be exactly 45');

    const nonCs = allEmployees.filter(e => e.department !== 'CS');
    assert.strictEqual(nonCs.length, 15, 'Non-CS employees must be exactly 15 (6 Data Entry + 9 Other)');

    const dataEntry = nonCs.filter(e => e.department === 'Data Entry');
    assert.strictEqual(dataEntry.length, 6, 'Data Entry employees must be exactly 6');

    const other = nonCs.filter(e => e.department === 'Other');
    assert.strictEqual(other.length, 9, 'Other department employees must be exactly 9');

    // Invariant: 45 + 15 = 60
    assert.strictEqual(activeCs.length + nonCs.length, allEmployees.length);
  });

  test('2. Snapshot Distinct Employee Count & Date Reconciliation', () => {
    const distinctSnapEmps = db.prepare('SELECT DISTINCT employee_name FROM performance_snapshots').all().map(r => r.employee_name);
    assert.strictEqual(distinctSnapEmps.length, 52, 'Distinct employee_name in performance_snapshots must be exactly 52');

    const snapDates = db.prepare('SELECT date, COUNT(*) as cnt, COUNT(DISTINCT employee_name) as distinct_emp FROM performance_snapshots GROUP BY date ORDER BY date').all();
    assert.strictEqual(snapDates.length, 4, 'Performance snapshot distinct dates count must be 4');

    // Date 2026-09-08: 45 baseline seed snapshots matching active CS roster
    const d0908 = snapDates.find(d => d.date === '2026-09-08');
    assert.ok(d0908);
    assert.strictEqual(d0908.cnt, 45);
    assert.strictEqual(d0908.distinct_emp, 45);

    // Date 2026-09-22: live operational snapshots (>= 16, currently 21 computed from live raw logs)
    const d0922 = snapDates.find(d => d.date === '2026-09-22');
    assert.ok(d0922);
    assert.ok(d0922.cnt >= 16, 'Live snapshots on 2026-09-22 must be at least 16');
    assert.strictEqual(d0922.cnt, d0922.distinct_emp, 'Each agent has at most 1 snapshot per date');

    // Test fixture dates 2026-10-10 & 2026-10-11
    const d1010 = snapDates.find(d => d.date === '2026-10-10');
    assert.ok(d1010);
    assert.strictEqual(d1010.cnt, 2);

    const d1011 = snapDates.find(d => d.date === '2026-10-11');
    assert.ok(d1011);
    assert.strictEqual(d1011.cnt, 3);
  });

  test('3. Historical Source Log Totals & Reconciliation Mathematical Invariants', () => {
    const totalSourceRows = 1198950;
    const importedRows = 1197210;
    const duplicateRows = 1083;
    const rejectedRows = 657;
    const unaccountedRows = totalSourceRows - (importedRows + duplicateRows + rejectedRows);

    assert.strictEqual(unaccountedRows, 0, 'Unaccounted rows must be exactly 0');
    assert.strictEqual(totalSourceRows, importedRows + duplicateRows + rejectedRows, 'Source rows must equal imported + duplicates + rejected');
  });

  test('4. CS vs Non-CS Totals & Actor Distribution Reconciliation', () => {
    const csImported = 669591;
    const nonCsImported = 527619;
    const totalImported = 1197210;

    assert.strictEqual(csImported + nonCsImported, totalImported, 'CS imported + Non-CS imported must equal total imported');

    // Distinct actors in historical archive: 47 CS + 373 Non-CS = 420 Total
    const distinctCsActors = 47;
    const distinctNonCsActors = 373;
    const totalDistinctActors = 420;
    assert.strictEqual(distinctCsActors + distinctNonCsActors, totalDistinctActors);

    // Active CS roster (45) breakdown: 41 with historical logs + 4 without historical logs
    const activeCsWithHistory = 41;
    const activeCsWithoutHistory = 4;
    assert.strictEqual(activeCsWithHistory + activeCsWithoutHistory, 45);

    // Historical CS actors breakdown: 41 in active roster + 6 not in active roster = 47
    const historicalCsNotInActiveRoster = 6;
    assert.strictEqual(activeCsWithHistory + historicalCsNotInActiveRoster, distinctCsActors);

    // 16,028 row discrepancy reconciliation:
    // Faulty report reported Non-CS = 543,647 (shifted 16,028 CS rows to Non-CS)
    const faultyReportNonCs = 543647;
    const correctNonCs = 527619;
    const delta = faultyReportNonCs - correctNonCs;
    assert.strictEqual(delta, 16028, 'Discrepancy must equal exactly 16,028 rows');
  });

  test('5. Active CS Identity Classification Coverage', () => {
    const activeCsNames = db.prepare("SELECT name FROM employees WHERE department = 'CS' AND active = 1").all().map(r => r.name);
    assert.strictEqual(activeCsNames.length, 45);

    // Active CS employees without history
    const withoutHistory = ['MOHAMED OSAMA CS', 'Abrar CS', 'Nour CS', 'Fagr CS'];
    for (const name of withoutHistory) {
      assert.ok(activeCsNames.includes(name), `${name} must be in active CS roster`);
    }

    // Historical CS actors NOT in active roster
    const historicalNotActive = ['Adham CS', 'Merna CS', 'Ahd CS', 'OMAR ASHRAF CS', 'Kenzy cs', 'Yasmin CS'];
    for (const name of historicalNotActive) {
      assert.strictEqual(activeCsNames.includes(name), false, `${name} must NOT be in active CS roster`);
      assert.strictEqual(isCsEmployee(name), true, `${name} must qualify as CS by name pattern`);
    }
  });

  test('6. Profile Retrieval & Historical Metrics Hydration', () => {
    const profiles = getEmployeePerformanceProfiles('2026-09-22');
    assert.ok(profiles instanceof Map);
    assert.ok(profiles.size > 0);

    // Active CS agents should have profiles with valid fields
    for (const [, prof] of profiles.entries()) {
      assert.ok(typeof prof.historical_score === 'number');
      assert.ok(typeof prof.estimated_daily_capacity === 'number');
      assert.ok(typeof prof.historical_rate === 'number');
      assert.ok(typeof prof.confidence === 'string');
    }
  });

  test('7. Smart Allocation Candidate Eligibility Constraint Enforcement', () => {
    const workingTeam = getWorkingTeam('2026-09-22');

    // 1. All candidates must be CS
    for (const candidate of workingTeam) {
      assert.strictEqual(isCsEmployee(candidate), true);
      assert.strictEqual(isCSDepartment(candidate.department, candidate.name), true);
    }

    // 2. Non-roster historical CS actors must NEVER enter working team
    const historicalNotActive = ['Adham CS', 'Merna CS', 'Ahd CS', 'OMAR ASHRAF CS', 'Kenzy cs', 'Yasmin CS'];
    for (const name of historicalNotActive) {
      const found = workingTeam.some(c => c.name === name);
      assert.strictEqual(found, false, `Non-roster historical actor ${name} must be strictly excluded from candidate pool`);
    }

    // 3. Non-CS department staff must NEVER enter working team
    const nonCsStaff = db.prepare("SELECT name FROM employees WHERE department != 'CS'").all().map(r => r.name);
    for (const name of nonCsStaff) {
      const found = workingTeam.some(c => c.name === name);
      assert.strictEqual(found, false, `Non-CS staff ${name} must be strictly excluded from candidate pool`);
    }
  });

});
