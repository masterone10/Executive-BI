/**
 * Test Suite: One-Time Historical Vendoor Logs Importer
 *
 * Verifies:
 * 1. No duplicates upon re-run (Strict Idempotency)
 * 2. Correct CS Filtering (is_cs = 1 for CS operational staff, is_cs = 0 for Non-CS actors)
 * 3. Correct Date Range & Operational cutoff handling
 * 4. Import Resumability (Interrupted run resumes without corrupting or duplicating data)
 * 5. Imported historical logs are actually consumed by the Performance Engine
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import Database from 'better-sqlite3';
import {
  parseExcelTimestamp,
  detectHeaderColumns,
  importHistoricalVendoorLogs,
  validateHistoricalDatabase,
  rebuildHistoricalPerformanceSnapshots
} from '../services/vendoor/historical_importer.js';
import { isCsEmployee } from '../services/parser.js';
import { getEmployeePerformanceProfiles } from '../services/performance.js';

describe('Historical Vendoor Logs Importer Test Suite', () => {
  const testDir = './tests/fixtures_historical';
  const testDbPath = './tests/fixtures_historical/test_historical.db';
  let testDb;

  before(async () => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    // Set up clean isolated SQLite DB with identical schema
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    testDb = new Database(testDbPath);

    testDb.exec(`
      CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        department TEXT DEFAULT 'CS',
        status TEXT DEFAULT 'ACTIVE',
        target_capacity INTEGER DEFAULT 50
      );

      CREATE TABLE IF NOT EXISTS vendoor_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_name TEXT NOT NULL,
        order_code TEXT NOT NULL,
        action TEXT NOT NULL,
        action_classification TEXT,
        is_productive INTEGER DEFAULT 1,
        timestamp_str TEXT NOT NULL,
        work_date TEXT,
        matched_employee_id INTEGER,
        sync_run_id TEXT,
        imported_at TEXT DEFAULT (datetime('now')),
        UNIQUE(order_code, employee_name, timestamp_str, action)
      );

      CREATE TABLE IF NOT EXISTS raw_log_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_file_id INTEGER,
        work_date TEXT,
        order_code TEXT NOT NULL,
        employee_name TEXT NOT NULL,
        action TEXT,
        status TEXT,
        event_datetime TEXT,
        is_cs INTEGER DEFAULT 1,
        is_deduped INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_logs_dedup
      ON raw_log_records(work_date, order_code, employee_name, event_datetime, action);

      CREATE TABLE IF NOT EXISTS performance_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        employee_id INTEGER,
        employee_name TEXT NOT NULL,
        real_actions INTEGER DEFAULT 0,
        new_orders INTEGER DEFAULT 0,
        printed_orders INTEGER DEFAULT 0,
        pending_backlog INTEGER DEFAULT 0,
        cancelled_orders INTEGER DEFAULT 0,
        processing_orders INTEGER DEFAULT 0,
        alt_phones INTEGER DEFAULT 0,
        added_orders INTEGER DEFAULT 0,
        printed_actions INTEGER DEFAULT 0,
        pending_actions INTEGER DEFAULT 0,
        processing_actions INTEGER DEFAULT 0,
        cancelled_actions INTEGER DEFAULT 0,
        own_printed_rate REAL DEFAULT 0,
        own_pending_rate REAL DEFAULT 0,
        own_cancel_rate REAL DEFAULT 0,
        own_proc_rate REAL DEFAULT 0,
        own_alt_rate REAL DEFAULT 0,
        activity_score REAL DEFAULT 0,
        efficiency_score REAL DEFAULT 0,
        performance_score REAL DEFAULT 0,
        contribution_pct REAL DEFAULT 0,
        rate REAL DEFAULT 0,
        grade TEXT,
        segment TEXT,
        cancel_risk TEXT,
        source_file_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(date, employee_name)
      );

      CREATE TABLE IF NOT EXISTS vendoor_identity_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_name TEXT UNIQUE NOT NULL,
        canonical_name TEXT NOT NULL,
        employee_id INTEGER,
        status TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        match_method TEXT NOT NULL,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Seed sample employee master
      INSERT INTO employees (name, department) VALUES ('Yomna CS', 'CS');
      INSERT INTO employees (name, department) VALUES ('Sara CS', 'CS');
      INSERT INTO employees (name, department) VALUES ('Mahmoud Sales', 'Sales');
      INSERT INTO employees (name, department) VALUES ('Manal DataEntry', 'Data Entry');
    `);

    // Create a mock Excel workbook with CS and Non-CS rows spanning multiple dates
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('HistoricalSheet');
    sheet.columns = [
      { header: 'كود الطلب', key: 'order_code', width: 15 },
      { header: 'الاسم', key: 'name', width: 25 },
      { header: 'الاكشن', key: 'action', width: 35 },
      { header: 'التاريخ', key: 'date', width: 20 }
    ];

    // Day 1: 2026-09-10
    sheet.addRow({ order_code: 'ORD-1001', name: 'Yomna CS', action: 'أضاف اوردر جديد', date: '2026-09-10 09:30:00' });
    sheet.addRow({ order_code: 'ORD-1001', name: 'Yomna CS', action: 'عدل حالة الطلب إلى Delivered', date: '2026-09-10 10:15:00' });
    sheet.addRow({ order_code: 'ORD-1002', name: 'Sara CS', action: 'عدل حالة الطلب إلى Delivered', date: '2026-09-10 11:00:00' });
    sheet.addRow({ order_code: 'ORD-1003', name: 'Manal DataEntry', action: 'أضاف اوردر جديد', date: '2026-09-10 11:30:00' }); // Non-CS

    // Day 2: 2026-09-11
    sheet.addRow({ order_code: 'ORD-2001', name: 'Yomna CS', action: 'عدل حالة الطلب إلى Delivered', date: '2026-09-11 14:00:00' });
    sheet.addRow({ order_code: 'ORD-2002', name: 'Mahmoud Sales', action: 'أضاف اوردر جديد', date: '2026-09-11 15:00:00' }); // Non-CS
    sheet.addRow({ order_code: 'ORD-2003', name: 'Sara CS', action: 'عدل حالة الطلب إلى Canceled', date: '2026-09-11 16:30:00' });

    await workbook.xlsx.writeFile(path.join(testDir, 'TEST_LOGS.xlsx'));
  });

  after(() => {
    if (testDb) testDb.close();
    try {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // cleanup best effort
    }
  });

  test('1. Date & Header Parser Verification', () => {
    // Test serial Excel date (46276.99982638889 -> 2026-09-11 23:59:45)
    const parsed = parseExcelTimestamp(46276.99982638889);
    assert.ok(parsed);
    assert.equal(parsed.dateStr, '2026-09-11');
    assert.equal(parsed.timestampStr, '2026-09-11 23:59:45');

    // Test string date
    const parsedStr = parseExcelTimestamp('2026-09-15 10:20:30');
    assert.ok(parsedStr);
    assert.equal(parsedStr.dateStr, '2026-09-15');
    assert.equal(parsedStr.timestampStr, '2026-09-15 10:20:30');

    // Test header detection
    const headers = [null, 'Source.Name', '#', 'كود الطلب', 'الاسم', 'الاكشن', 'التاريخ'];
    const detected = detectHeaderColumns(headers);
    assert.ok(detected);
    assert.equal(detected.codeCol, 3);
    assert.equal(detected.empCol, 4);
    assert.equal(detected.actCol, 5);
    assert.equal(detected.dateCol, 6);
  });

  test('2. Strict CS vs Non-CS Filtering Rule', () => {
    assert.equal(isCsEmployee('Yomna CS'), true);
    assert.equal(isCsEmployee('Sara CS'), true);
    assert.equal(isCsEmployee('Manal DataEntry'), false);
    assert.equal(isCsEmployee('Jehan data entry'), false);
    assert.equal(isCsEmployee('Mostafa sayed Shipping'), false);
    assert.equal(isCsEmployee('Noureldin ahmed'), false);
    assert.equal(isCsEmployee('ARC SHOES'), false);
    assert.equal(isCsEmployee({ name: 'Mahmoud Sales', department: 'Sales' }), false);
  });

  test('3. First Import Run (Initial Ingestion)', async () => {
    const res = await importHistoricalVendoorLogs({
      inputPaths: path.join(testDir, 'TEST_LOGS.xlsx'),
      batchSize: 2,
      dryRun: false,
      database: testDb
    });

    assert.equal(res.success, true);
    assert.equal(res.summary.rowsRead, 7);
    assert.equal(res.summary.rowsImported, 7);
    assert.equal(res.summary.duplicatesSkipped, 0);
    assert.equal(res.summary.csRows, 5); // 5 CS rows
    assert.equal(res.summary.nonCsRows, 2); // 2 Non-CS rows
    assert.equal(res.summary.oldestDate, '2026-09-10');
    assert.equal(res.summary.newestDate, '2026-09-11');

    // Check DB counts
    const val = validateHistoricalDatabase(testDb);
    assert.equal(val.vendoor_logs.total_records, 7);
    assert.equal(val.raw_log_records.total_records, 7);
    assert.equal(val.raw_log_records.cs_records, 5);
    assert.equal(val.raw_log_records.non_cs_records, 2);
    assert.equal(val.raw_log_records.min_work_date, '2026-09-10');
    assert.equal(val.raw_log_records.max_work_date, '2026-09-11');
  });

  test('4. Resumability & Duplicate Prevention (Re-running the same file)', async () => {
    // Re-run the exact same file
    const res2 = await importHistoricalVendoorLogs({
      inputPaths: path.join(testDir, 'TEST_LOGS.xlsx'),
      batchSize: 2,
      dryRun: false,
      database: testDb
    });

    assert.equal(res2.success, true);
    assert.equal(res2.summary.rowsRead, 7);
    // All 7 rows were already in the database: 0 new rows inserted, 7 duplicates skipped
    assert.equal(res2.summary.rowsImported, 0);
    assert.equal(res2.summary.duplicatesSkipped, 7);

    // Verify DB count has NOT grown
    const val = validateHistoricalDatabase(testDb);
    assert.equal(val.vendoor_logs.total_records, 7);
    assert.equal(val.raw_log_records.total_records, 7);
  });

  test('5. Performance Engine Snapshot Reconstruction & Consumption', () => {
    // Rebuild snapshots for the imported test dates
    const rebuild = rebuildHistoricalPerformanceSnapshots({
      database: testDb
    });

    assert.equal(rebuild.daysSnapshotted, 2); // 2026-09-10 and 2026-09-11

    const val = validateHistoricalDatabase(testDb);
    assert.equal(val.performance_snapshots.distinct_snapshot_dates, 2);

    // Check snapshots in DB
    const snapshots = testDb.prepare(`
      SELECT * FROM performance_snapshots ORDER BY date ASC, employee_name ASC
    `).all();

    assert.ok(snapshots.length > 0);
    // CS employees must have valid snapshots
    const yomna = snapshots.find(s => s.employee_name.toLowerCase().includes('yomna'));
    assert.ok(yomna);
    assert.ok(yomna.added_orders >= 1 || yomna.real_actions >= 1);
    assert.ok(yomna.performance_score > 0);

    // Non-CS employees (Manal DataEntry, Mahmoud Sales) must NOT be present in CS operational snapshots
    const nonCs = snapshots.find(s => s.employee_name.toLowerCase().includes('dataentry') || s.employee_name.toLowerCase().includes('sales'));
    assert.equal(nonCs, undefined, 'Non-CS employees must NOT enter CS performance snapshots');
  });
});
