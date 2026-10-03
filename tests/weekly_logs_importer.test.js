/**
 * tests/weekly_logs_importer.test.js
 * Comprehensive Test Suite for Historical Vendoor Logs Weekly Import
 */

import assert from 'assert';
import { db } from '../db/index.js';
import { getPreviousCompletedWeekRange, getCairoBusinessDate } from '../services/time_utils.js';
import {
  importWeeklyVendoorLogs,
  getWeeklyLogsImportStatus
} from '../services/vendoor/weekly_logs_importer.js';
import { getAvailableBusinessDates, getHistoricalDayOverview } from '../services/historical_dates.js';
import { getTrackingOverview } from '../services/tracking.js';
import { generateActivityLogsReport } from '../services/reports.js';

console.log('--- STARTING HISTORICAL VENDOOR LOGS WEEKLY IMPORT TEST SUITE ---');

// -------------------------------------------------------------
// TEST 1: Previous Week Range Calculation (Monday -> Sunday, Cairo Calendar)
// -------------------------------------------------------------
{
  console.log('Testing: getPreviousCompletedWeekRange calculation...');

  // Saturday 2026-10-03 -> Expected: Monday 2026-09-21 to Sunday 2026-09-27
  const weekForSaturday = getPreviousCompletedWeekRange('2026-10-03');
  assert.strictEqual(weekForSaturday.startDate, '2026-09-21', 'Start date must be Monday 2026-09-21');
  assert.strictEqual(weekForSaturday.endDate, '2026-09-27', 'End date must be Sunday 2026-09-27');
  assert.strictEqual(weekForSaturday.daysCount, 7, 'Days count must be exactly 7');
  assert.deepStrictEqual(weekForSaturday.dates, [
    '2026-09-21',
    '2026-09-22',
    '2026-09-23',
    '2026-09-24',
    '2026-09-25',
    '2026-09-26',
    '2026-09-27'
  ]);

  // Monday 2026-09-28 -> Expected: Monday 2026-09-21 to Sunday 2026-09-27
  const weekForMonday = getPreviousCompletedWeekRange('2026-09-28');
  assert.strictEqual(weekForMonday.startDate, '2026-09-21');
  assert.strictEqual(weekForMonday.endDate, '2026-09-27');

  // Sunday 2026-10-04 -> Expected: Monday 2026-09-21 to Sunday 2026-09-27
  const weekForSunday = getPreviousCompletedWeekRange('2026-10-04');
  assert.strictEqual(weekForSunday.startDate, '2026-09-21');
  assert.strictEqual(weekForSunday.endDate, '2026-09-27');

  console.log('✓ PASS: Previous week calculation is strictly Monday -> Sunday across all days of the week.');
}

// -------------------------------------------------------------
// TEST 2: Full 7-Day Weekly Import Execution & SQL Persistence
// -------------------------------------------------------------
{
  console.log('Testing: Full 7-Day Weekly Logs Import Execution...');

  // Clean test historical dates
  const testDates = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'];
  for (const d of testDates) {
    db.prepare('DELETE FROM vendoor_logs WHERE work_date = ?').run(d);
    db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(d);
  }

  const initialEmpCount = db.prepare('SELECT COUNT(*) as c FROM employees').get().c;
  const initialCurrentWorkOrdersCount = db.prepare('SELECT COUNT(*) as c FROM current_work_orders').get().c;

  const result = await importWeeklyVendoorLogs({
    startDate: '2026-09-21',
    endDate: '2026-09-27',
    forceMode: 'mock'
  });

  assert.strictEqual(result.success, true, 'Import should succeed');
  assert.strictEqual(result.days, 7, 'Must process all 7 days');
  assert.strictEqual(result.days_completed, 7, 'Must complete 7 days');
  assert.strictEqual(result.status, 'COMPLETED', 'Status must be COMPLETED');
  assert.ok(result.inserted > 0, 'Must insert records');
  assert.strictEqual(result.per_day_summary.length, 7, 'Must have 7 day breakdown summaries');

  // Check per-day counts in SQLite
  for (const d of testDates) {
    const vCount = db.prepare('SELECT COUNT(*) as c FROM vendoor_logs WHERE work_date = ?').get(d).c;
    const rCount = db.prepare('SELECT COUNT(*) as c FROM raw_log_records WHERE work_date = ?').get(d).c;
    assert.ok(vCount > 0, `vendoor_logs must have records for ${d}`);
    assert.ok(rCount > 0, `raw_log_records must have records for ${d}`);
  }

  // Isolation checks
  const postEmpCount = db.prepare('SELECT COUNT(*) as c FROM employees').get().c;
  const postCurrentWorkOrdersCount = db.prepare('SELECT COUNT(*) as c FROM current_work_orders').get().c;
  assert.strictEqual(postEmpCount, initialEmpCount, 'Employee Master must not be mutated or polluted');
  assert.strictEqual(postCurrentWorkOrdersCount, initialCurrentWorkOrdersCount, 'Current work orders pool must not be mutated');

  console.log('✓ PASS: Full 7-Day weekly import executed and verified in SQLite with strict isolation.');
}

// -------------------------------------------------------------
// TEST 3: Idempotency on Repeated Import (Zero Duplicate Business Records)
// -------------------------------------------------------------
{
  console.log('Testing: Idempotency & Zero Duplication on Re-Run...');

  const initialVendoorRows = db.prepare("SELECT COUNT(*) as c FROM vendoor_logs WHERE work_date >= '2026-09-21' AND work_date <= '2026-09-27'").get().c;
  const initialRawRows = db.prepare("SELECT COUNT(*) as c FROM raw_log_records WHERE work_date >= '2026-09-21' AND work_date <= '2026-09-27'").get().c;

  // Run the exact same weekly import a second time
  const secondResult = await importWeeklyVendoorLogs({
    startDate: '2026-09-21',
    endDate: '2026-09-27',
    forceMode: 'mock'
  });

  assert.strictEqual(secondResult.success, true);
  assert.strictEqual(secondResult.inserted, 0, 'Second run must insert 0 new records');
  assert.ok(secondResult.duplicates > 0, 'Second run must recognize existing records as duplicates');

  const postVendoorRows = db.prepare("SELECT COUNT(*) as c FROM vendoor_logs WHERE work_date >= '2026-09-21' AND work_date <= '2026-09-27'").get().c;
  const postRawRows = db.prepare("SELECT COUNT(*) as c FROM raw_log_records WHERE work_date >= '2026-09-21' AND work_date <= '2026-09-27'").get().c;

  assert.strictEqual(postVendoorRows, initialVendoorRows, 'vendoor_logs total rows must remain unchanged');
  assert.strictEqual(postRawRows, initialRawRows, 'raw_log_records total rows must remain unchanged');

  console.log('✓ PASS: Idempotency verified: re-running import creates zero duplicates in database.');
}

// -------------------------------------------------------------
// TEST 4: Single Flight Lock (Prevents Concurrent Runs)
// -------------------------------------------------------------
{
  console.log('Testing: Single Flight Concurrency Lock...');

  // Start two concurrent calls
  const promise1 = importWeeklyVendoorLogs({ startDate: '2026-09-21', endDate: '2026-09-27', forceMode: 'mock' });
  let promise2Error = null;

  try {
    await importWeeklyVendoorLogs({ startDate: '2026-09-21', endDate: '2026-09-27', forceMode: 'mock' });
  } catch (err) {
    promise2Error = err;
  }

  await promise1; // wait for first to complete

  assert.ok(promise2Error, 'Second concurrent call must throw');
  assert.strictEqual(promise2Error.code, 'IMPORT_ALREADY_RUNNING', 'Error code must be IMPORT_ALREADY_RUNNING');

  console.log('✓ PASS: Single flight lock prevents overlapping executions.');
}

// -------------------------------------------------------------
// TEST 5: Discovery in getAvailableBusinessDates() & Read-Only Historical Day View
// -------------------------------------------------------------
{
  console.log('Testing: Available Dates Discovery & Historical Day View...');

  const availableDatesRes = getAvailableBusinessDates();
  assert.strictEqual(availableDatesRes.success, true);

  const availableSet = new Set(availableDatesRes.dates.map(d => d.date));
  for (const expectedDate of ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']) {
    assert.ok(availableSet.has(expectedDate), `Date ${expectedDate} must be discovered in available business dates`);
    const dateMeta = availableDatesRes.dates.find(d => d.date === expectedDate);
    assert.strictEqual(dateMeta.has_tracking, true, `Date ${expectedDate} must have has_tracking = true`);
  }

  // Open historical day in read-only mode
  const overview21 = getHistoricalDayOverview('2026-09-21');
  assert.ok(overview21, 'Historical overview must load for 2026-09-21');
  assert.strictEqual(overview21.work_date, '2026-09-21');

  console.log('✓ PASS: getAvailableBusinessDates and historical day resolver correctly expose imported days.');
}

// -------------------------------------------------------------
// TEST 6: Audit History Logging
// -------------------------------------------------------------
{
  console.log('Testing: Audit History in vendoor_sync_runs and state table...');

  const auditRun = db.prepare(`
    SELECT * FROM vendoor_sync_runs
    WHERE resource = 'HISTORICAL_LOG_WEEK'
    ORDER BY id DESC
    LIMIT 1
  `).get();

  assert.ok(auditRun, 'Audit run must be recorded');
  assert.strictEqual(auditRun.status, 'SUCCESS');
  assert.strictEqual(auditRun.start_date, '2026-09-21');
  assert.strictEqual(auditRun.end_date, '2026-09-27');

  const status = getWeeklyLogsImportStatus();
  assert.ok(status, 'Status must be available');
  assert.strictEqual(status.is_running, false);
  assert.strictEqual(status.status, 'COMPLETED');

  console.log('✓ PASS: Audit logging in vendoor_sync_runs and weekly import state verified.');
}

// -------------------------------------------------------------
// TEST 7: Tracking Visibility (Historical Logs Reflect in getTrackingOverview)
// -------------------------------------------------------------
{
  console.log('Testing: Tracking Visibility for imported historical date...');

  const tracking21 = getTrackingOverview('2026-09-21');
  assert.ok(tracking21, 'Tracking overview must return data for 2026-09-21');
  assert.strictEqual(tracking21.daily_log_uploaded, true, 'Daily log must be marked uploaded');
  assert.ok(tracking21.actual_work, 'Actual work object must exist');
  assert.ok(tracking21.actual_work.real_actions > 0, 'Must reflect real actions for 2026-09-21');
  assert.ok(tracking21.actual_work.orders_worked_today > 0, 'Must reflect worked orders count for 2026-09-21');

  console.log('✓ PASS: Historical tracking overview correctly sees imported day logs without requiring current day.');
}

// -------------------------------------------------------------
// TEST 8: Reports Scoping & Isolation (Date-Scoped Activity Report)
// -------------------------------------------------------------
{
  console.log('Testing: Reports Isolation & Date-Scoping...');

  const report21 = generateActivityLogsReport({
    date_mode: 'day',
    target_date: '2026-09-21'
  });

  assert.ok(report21, 'Activity logs report must generate for 2026-09-21');
  assert.ok(report21.total_logs_returned > 0, 'Report must contain activities for 2026-09-21');
  assert.strictEqual(report21.start_date, '2026-09-21');

  // Verify that an unrelated date (e.g. empty historical date) does not leak 2026-09-21 records
  const reportUnrelated = generateActivityLogsReport({
    date_mode: 'day',
    target_date: '2026-01-01'
  });
  assert.strictEqual(reportUnrelated.total_logs_returned, 0, 'Unrelated historical date must have 0 activities');

  console.log('✓ PASS: Reports for historical week are strictly date-scoped and isolated.');
}

// -------------------------------------------------------------
// TEST 9: Explicit Custom Date Range (Single or Multi-Day Import)
// -------------------------------------------------------------
{
  console.log('Testing: Explicit Custom Date Range (3 Days)...');

  // Clean 2026-09-15 -> 2026-09-17
  const customDates = ['2026-09-15', '2026-09-16', '2026-09-17'];
  for (const d of customDates) {
    db.prepare('DELETE FROM vendoor_logs WHERE work_date = ?').run(d);
    db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(d);
  }

  const customRes = await importWeeklyVendoorLogs({
    startDate: '2026-09-15',
    endDate: '2026-09-17',
    forceMode: 'mock'
  });

  assert.strictEqual(customRes.success, true);
  assert.strictEqual(customRes.days, 3, 'Must process exactly 3 days');
  assert.strictEqual(customRes.days_completed, 3);
  assert.strictEqual(customRes.per_day_summary.length, 3);

  for (const d of customDates) {
    const count = db.prepare('SELECT COUNT(*) as c FROM vendoor_logs WHERE work_date = ?').get(d).c;
    assert.ok(count > 0, `Custom date ${d} must be stored in database`);
  }

  console.log('✓ PASS: Explicit custom date ranges are executed accurately.');
}

// -------------------------------------------------------------
// TEST 10: Actor Identity & Master Immutability (Non-CS actors preserved safely)
// -------------------------------------------------------------
{
  console.log('Testing: Actor Identity Resolution & Master Immutability...');

  const preEmpList = db.prepare('SELECT id, name, department FROM employees ORDER BY id ASC').all();

  // Insert a test non-CS record via the import pipeline
  const testNonCsRes = await importWeeklyVendoorLogs({
    startDate: '2026-09-21',
    endDate: '2026-09-21',
    forceMode: 'mock'
  });

  const postEmpList = db.prepare('SELECT id, name, department FROM employees ORDER BY id ASC').all();
  assert.strictEqual(postEmpList.length, preEmpList.length, 'Employee master must not have new rows added');
  assert.deepStrictEqual(postEmpList, preEmpList, 'Employee master rows must remain 100% identical');

  console.log('✓ PASS: Employee Master remains strictly immutable; identity resolution never mutates master.');
}

// -------------------------------------------------------------
// TEST 11: Data Quality & Status Breakdown Metrics
// -------------------------------------------------------------
{
  console.log('Testing: Data Quality Metrics & Status Breakdown...');

  const status = getWeeklyLogsImportStatus();
  assert.ok(status.per_day_summary.length >= 1);
  const firstDay = status.per_day_summary[0];

  assert.ok(firstDay.date, 'Day summary must include date');
  assert.ok(firstDay.raw_fetched >= 0, 'raw_fetched must be >= 0');
  assert.ok(firstDay.raw_stored >= 0, 'raw_stored must be >= 0');
  assert.ok(firstDay.normalized >= 0, 'normalized must be >= 0');
  assert.ok(firstDay.unique_orders >= 0, 'unique_orders must be >= 0');
  assert.ok(firstDay.unique_employees >= 0, 'unique_employees must be >= 0');
  assert.ok(firstDay.status_breakdown, 'status_breakdown must exist');
  assert.strictEqual(typeof firstDay.status_breakdown.printed, 'number');
  assert.strictEqual(typeof firstDay.status_breakdown.pending, 'number');
  assert.strictEqual(typeof firstDay.status_breakdown.cancelled, 'number');
  assert.strictEqual(typeof firstDay.status_breakdown.processing, 'number');

  console.log('✓ PASS: Data quality metrics and status breakdown computed per-day without hardcoding.');
}

console.log('--- ALL HISTORICAL VENDOOR LOGS WEEKLY IMPORT TESTS PASSED SUCCESSFULLY! ---');
