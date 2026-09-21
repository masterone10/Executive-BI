#!/usr/bin/env node

/**
 * Enterprise Historical Vendoor Logs Import CLI
 *
 * Usage:
 *   npm run import:historical -- ./historical_logs
 *   npm run import:historical -- ./historical_logs/HISTORICAL_LOGS_2.xlsx
 *   npm run import:historical -- ./historical_logs --dry-run
 *   npm run import:historical -- --validate-only
 */

import path from 'path';
import {
  importHistoricalVendoorLogs,
  validateHistoricalDatabase,
  rebuildHistoricalPerformanceSnapshots
} from '../services/vendoor/historical_importer.js';
import { db } from '../db/index.js';

async function main() {
  const args = process.argv.slice(2);

  const isDryRun = args.includes('--dry-run');
  const isValidateOnly = args.includes('--validate-only');
  const isRebuildOnly = args.includes('--rebuild-only');

  const batchArg = args.find(a => a.startsWith('--batch-size='));
  const batchSize = batchArg ? parseInt(batchArg.split('=')[1], 10) : 2000;

  // Filter out flag options to find target paths
  const targetPaths = args.filter(a => !a.startsWith('--'));
  const inputPaths = targetPaths.length > 0 ? targetPaths : ['./historical_logs'];

  console.log('================================================================================');
  console.log('         CS EXECUTIVE BI — ENTERPRISE HISTORICAL VENDOOR LOGS IMPORTER         ');
  console.log('================================================================================');

  if (isValidateOnly) {
    console.log('\n[VALIDATION ONLY MODE] Querying current database state...\n');
    const stats = validateHistoricalDatabase(db);
    printValidationReport(stats);
    process.exit(0);
  }

  if (isRebuildOnly) {
    console.log('\n[REBUILD ONLY MODE] Rebuilding historical performance snapshots from raw_log_records...\n');
    const rebuild = rebuildHistoricalPerformanceSnapshots({ database: db });
    console.log(`✓ Snapshots rebuilt successfully for ${rebuild.daysSnapshotted} distinct dates.\n`);
    const stats = validateHistoricalDatabase(db);
    printValidationReport(stats);
    process.exit(0);
  }

  console.log(`Target Path(s):    ${JSON.stringify(inputPaths)}`);
  console.log(`Execution Mode:    ${isDryRun ? 'DRY RUN (No DB Writes)' : 'PRODUCTION IMPORT'}`);
  console.log(`Batch Size:        ${batchSize} rows/transaction`);
  console.log(`Started At:        ${new Date().toISOString()}`);
  console.log('--------------------------------------------------------------------------------');

  let lastReportTime = Date.now();

  const progressHandler = (progress) => {
    if (progress.stage === 'DATE_COMMIT') {
      console.log(
        `[COMMIT] Date: ${progress.date} | Source: ${(progress.dateSourceRows || 0).toLocaleString()} | ` +
        `CS: ${(progress.dateCs || 0).toLocaleString()} | Non-CS: ${(progress.dateNonCs || 0).toLocaleString()} | ` +
        `Imported: ${(progress.dateImported || 0).toLocaleString()} | Dupl: ${(progress.dateDuplicates || 0).toLocaleString()} | ` +
        `Duration: ${progress.durationSec}s | Rate: ${(progress.rate || 0).toLocaleString()} r/s`
      );
      return;
    }

    const now = Date.now();
    // Throttle streaming stdout reporting to once every 2 seconds
    if (now - lastReportTime >= 2000) {
      lastReportTime = now;
      console.log(
        `[PROGRESS] File: ${progress.file || 'unknown'} | Rows: ${(progress.rowsRead || 0).toLocaleString()} | ` +
        `Rate: ${(progress.rateRowsPerSec || 0).toLocaleString()} r/s | Heap: ${progress.heapUsedMb || 0} MB`
      );
    }
  };

  try {
    const result = await importHistoricalVendoorLogs({
      inputPaths,
      batchSize,
      dryRun: isDryRun,
      onProgress: progressHandler,
      database: db
    });

    console.log('\n--------------------------------------------------------------------------------');
    console.log('                       IMPORT EXECUTION SUMMARY                                 ');
    console.log('--------------------------------------------------------------------------------');
    console.log(`Status:               ${result.dryRun ? 'DRY RUN COMPLETE' : 'SUCCESSFULLY IMPORTED'}`);
    console.log(`Duration:             ${result.durationSec} seconds`);
    console.log(`Files Processed:      ${result.summary.filesProcessedCount}`);
    for (const f of result.summary.files) {
      console.log(`  • ${f.file} (${f.rowsRead.toLocaleString()} rows read, ${f.stagedRows.toLocaleString()} staged in ${f.durationSec}s)`);
    }

    console.log('\n--- ROW RECONCILIATION ---');
    console.log(`Total Source Rows:    ${result.summary.rowsRead.toLocaleString()}`);
    console.log(`Rows Imported:        ${result.summary.rowsImported.toLocaleString()}`);
    console.log(`Duplicates Skipped:   ${result.summary.duplicatesSkipped.toLocaleString()}`);
    console.log(`Rejected Rows:        ${result.summary.rejectedRows.toLocaleString()}`);
    if (result.summary.rejectedReasons) {
      for (const [reason, count] of Object.entries(result.summary.rejectedReasons)) {
        console.log(`  • Reason: ${reason} -> ${count.toLocaleString()}`);
      }
    }
    console.log(`UNACCOUNTED ROWS:     ${result.summary.unaccountedRows} (Formula: Read - (Imported + Duplicates + Rejected))`);

    console.log('\n--- CS CLASSIFICATION BREAKDOWN ---');
    console.log(`CS Operational Rows:  ${result.summary.csRows.toLocaleString()} (is_cs = 1, Eligible for Allocation)`);
    console.log(`Non-CS Audit Rows:    ${result.summary.nonCsRows.toLocaleString()} (is_cs = 0, Stored for Audit Only)`);
    console.log(`Unique Actors Found:  ${result.summary.uniqueEmployeesCount}`);
    console.log(`Historical Window:    ${result.summary.oldestDate || 'N/A'} to ${result.summary.newestDate || 'N/A'} (${result.summary.daysTouchedCount} active days)`);

    if (result.summary.dateBreakdown && result.summary.dateBreakdown.length > 0) {
      console.log('\n--- DATE-BY-DATE COMMIT BREAKDOWN ---');
      console.table(result.summary.dateBreakdown.map(d => ({
        Date: d.date,
        Source: d.sourceRows.toLocaleString(),
        CS: d.cs.toLocaleString(),
        'Non-CS': d.nonCs.toLocaleString(),
        Imported: d.imported.toLocaleString(),
        Duplicates: d.duplicates.toLocaleString(),
        Status: d.status,
        Duration: `${d.durationSec}s`,
        'Rate (r/s)': d.rate.toLocaleString()
      })));
    }

    if (result.performanceRebuild) {
      console.log(`\nPerformance Rebuild:  ${result.performanceRebuild.daysSnapshotted} daily snapshots reconstructed`);
    }

    if (result.latestProfilesSample && result.latestProfilesSample.length > 0) {
      console.log('\n--- SAMPLE REBUILT EMPLOYEE PROFILES ---');
      console.table(result.latestProfilesSample);
    }

    console.log('\n--------------------------------------------------------------------------------');
    console.log('                     POST-IMPORT DATABASE VALIDATION                            ');
    console.log('--------------------------------------------------------------------------------');
    printValidationReport(result.validation);

    console.log('\n✓ Process completed cleanly. Smart Allocation & Dispatcher isolated and untouched.\n');
  } catch (err) {
    console.error('\n[FATAL ERROR] Import failed:', err.message);
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

function printValidationReport(val) {
  if (!val) return;

  console.log('1. VENDOOR_LOGS (Authoritative Vendoor Events Archive):');
  console.log(`   • Total Records:          ${(val.vendoor_logs.total_records || 0).toLocaleString()}`);
  console.log(`   • Date Range:             ${val.vendoor_logs.min_work_date || 'N/A'} → ${val.vendoor_logs.max_work_date || 'N/A'} (${val.vendoor_logs.distinct_dates || 0} distinct days)`);
  console.log(`   • Distinct Employees:     ${val.vendoor_logs.distinct_employees || 0}`);
  console.log(`   • Distinct Orders:        ${(val.vendoor_logs.distinct_orders || 0).toLocaleString()}`);
  console.log(`   • Productive Actions:     ${(val.vendoor_logs.productive_actions || 0).toLocaleString()}`);

  console.log('\n2. RAW_LOG_RECORDS (Performance & Analytics Dataset):');
  console.log(`   • Total Records:          ${(val.raw_log_records.total_records || 0).toLocaleString()}`);
  console.log(`   • Date Range:             ${val.raw_log_records.min_work_date || 'N/A'} → ${val.raw_log_records.max_work_date || 'N/A'} (${val.raw_log_records.distinct_dates || 0} distinct days)`);
  console.log(`   • Distinct Employees:     ${val.raw_log_records.distinct_employees || 0}`);
  console.log(`   • Distinct Orders:        ${(val.raw_log_records.distinct_orders || 0).toLocaleString()}`);
  console.log(`   • CS Operational Rows:    ${(val.raw_log_records.cs_records || 0).toLocaleString()} (100% Eligible for Allocation Engine)`);
  console.log(`   • Non-CS Audit Rows:      ${(val.raw_log_records.non_cs_records || 0).toLocaleString()} (Audit Only — Excluded from Performance)`);

  console.log('\n3. PERFORMANCE_SNAPSHOTS (Daily KPI & Rolling Snapshots):');
  console.log(`   • Total Snapshots:        ${(val.performance_snapshots.total_snapshots || 0).toLocaleString()}`);
  console.log(`   • Snapshot Date Range:    ${val.performance_snapshots.min_snapshot_date || 'N/A'} → ${val.performance_snapshots.max_snapshot_date || 'N/A'} (${val.performance_snapshots.distinct_snapshot_dates || 0} days)`);
  console.log(`   • Distinct Snapshotted:   ${val.performance_snapshots.distinct_snapshot_employees || 0} employees`);
}

main();
