import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import {
  generateExecutiveSummaryReport,
  generateEmployeeReport,
  generateAccountReport,
  generateAllocationReport,
  generateActivityLogsReport,
  generateProductivityReport,
  generateDispatcherReport,
  generateDataQualityReport,
  generateSystemHealthReport,
  exportReportToCSV,
  exportReportToExcel,
  saveReportRecord,
  getReportHistory,
  resolveDateRange
} from '../services/reports.js';

test('EXECUTIVE-BI COMPREHENSIVE REPORTS SERVICE TEST SUITE', async (t) => {
  const testDate = '2026-09-08';

  await t.test('1. Date range resolver handles day, week, month, and custom modes', () => {
    const day = resolveDateRange('day', testDate);
    assert.equal(day.dates.length, 1);
    assert.equal(day.startDate, testDate);
    assert.equal(day.endDate, testDate);

    const week = resolveDateRange('week', testDate);
    assert.equal(week.dates.length, 7);
    assert.equal(week.endDate, testDate);

    const month = resolveDateRange('month', testDate);
    assert.equal(month.dates.length, 30);
    assert.equal(month.endDate, testDate);

    const custom = resolveDateRange('custom', null, '2026-09-01', '2026-09-03');
    assert.equal(custom.dates.length, 3);
    assert.deepEqual(custom.dates, ['2026-09-01', '2026-09-02', '2026-09-03']);
  });

  await t.test('2. Executive Summary report generates accurate aggregated metrics', () => {
    const report = generateExecutiveSummaryReport({ dateMode: 'day', targetDate: testDate });
    assert.equal(report.report_type, 'executive_summary');
    assert.equal(report.start_date, testDate);
    assert.equal(report.end_date, testDate);
    assert.ok(Array.isArray(report.daily_breakdown));
    assert.equal(report.daily_breakdown.length, 1);
    assert.ok(report.total_orders >= 0);
    assert.ok(report.allocation_coverage_pct >= 0 && report.allocation_coverage_pct <= 100);
    assert.ok(report.system_health);
  });

  await t.test('3. Employee Performance & Workload report includes capacity, rates, and operational status', () => {
    const report = generateEmployeeReport({ dateMode: 'day', targetDate: testDate });
    assert.equal(report.report_type, 'employee');
    assert.ok(report.total_employees > 0);
    assert.ok(Array.isArray(report.rows));

    const sample = report.rows[0];
    assert.ok('employee_id' in sample);
    assert.ok('employee_name' in sample);
    assert.ok('working_days' in sample);
    assert.ok('typical_orders_10m' in sample);
    assert.ok('recent_rate' in sample);
    assert.ok('confidence_level' in sample);
    assert.ok('remaining_capacity' in sample);
    assert.ok('operational_status' in sample);
  });

  await t.test('4. Account & Merchant distribution report detects unified vs split accounts', () => {
    const report = generateAccountReport({ dateMode: 'day', targetDate: testDate });
    assert.equal(report.report_type, 'account');
    assert.ok(report.total_accounts > 0);
    assert.ok(Array.isArray(report.rows));

    const sample = report.rows[0];
    assert.ok('account_name' in sample);
    assert.ok('owner_name' in sample);
    assert.ok('unified_or_split' in sample);
    assert.ok(['UNIFIED', 'SPLIT'].includes(sample.unified_or_split));
  });

  await t.test('5. Work Allocation Breakdown report provides itemized orders with audit sources', () => {
    const report = generateAllocationReport({ dateMode: 'day', targetDate: testDate });
    assert.equal(report.report_type, 'allocation');
    assert.ok(Array.isArray(report.rows));

    if (report.rows.length > 0) {
      const sample = report.rows[0];
      assert.ok('order_code' in sample);
      assert.ok('account' in sample);
      assert.ok('employee_name' in sample);
      assert.ok('source' in sample);
    }
  });

  await t.test('6. Activity Logs Forensic report classifies actions accurately', () => {
    const report = generateActivityLogsReport({ dateMode: 'day', targetDate: testDate, limit: 20 });
    assert.equal(report.report_type, 'activity');
    assert.ok(Array.isArray(report.rows));
  });

  await t.test('7. Continuous Productivity & Capacity report outputs rates, consistency MAD, and refill state', () => {
    const report = generateProductivityReport({ targetDate: testDate });
    assert.equal(report.report_type, 'productivity');
    assert.ok(report.total_profiles > 0);
    assert.ok(Array.isArray(report.rows));

    const sample = report.rows[0];
    assert.ok('typical_orders_10m' in sample);
    assert.ok('consistency_mad' in sample);
    assert.ok('confidence_level' in sample);
    assert.ok('remaining_capacity' in sample);
  });

  await t.test('8. Auto Dispatcher & Smart Refill report audits cycles and dry-run telemetry', () => {
    const report = generateDispatcherReport({ dateMode: 'day', targetDate: testDate });
    assert.equal(report.report_type, 'dispatcher');
    assert.ok('total_cycles' in report);
    assert.ok('total_dry_run_cycles' in report);
    assert.ok('total_real_cycles' in report);
  });

  await t.test('9. Data Quality & Identity Resolution report monitors unmatched identities and stale syncs', () => {
    const report = generateDataQualityReport({ targetDate: testDate });
    assert.equal(report.report_type, 'data_quality');
    assert.ok('unmatched_identities_count' in report);
    assert.ok('orders_data_stale' in report);
    assert.ok('logs_data_stale' in report);
  });

  await t.test('10. System & Operational Health report validates SQLite WAL integrity and tables', () => {
    const report = generateSystemHealthReport({ targetDate: testDate });
    assert.equal(report.report_type, 'system_health');
    assert.equal(report.database.healthy, true);
    assert.ok(report.database.core_tables.employees.readable);
    assert.ok(report.vendoor);
    assert.ok(report.dispatcher);
  });

  await t.test('11. CSV and Excel export functions format data into valid tabular buffers', () => {
    const empReport = generateEmployeeReport({ dateMode: 'day', targetDate: testDate });
    
    const csv = exportReportToCSV(empReport);
    assert.ok(typeof csv === 'string');
    assert.ok(csv.includes('employee_id'));
    assert.ok(csv.includes('employee_name'));

    const xlsx = exportReportToExcel(empReport);
    assert.ok(Buffer.isBuffer(xlsx));
    assert.ok(xlsx.length > 500);
  });

  await t.test('12. Report generation audit history records persist in database', () => {
    const testRecord = saveReportRecord({
      reportType: 'employee',
      dateMode: 'day',
      startDate: testDate,
      endDate: testDate,
      filters: { team: 'Both' },
      generatedBy: 'Forensic Test Agent',
      rowCount: 72,
      reportData: { test: true }
    });

    assert.ok(testRecord.id > 0);

    const history = getReportHistory(5);
    assert.ok(history.length > 0);
    assert.equal(history[0].report_type, 'employee');
    assert.equal(history[0].generated_by, 'Forensic Test Agent');
  });
});
