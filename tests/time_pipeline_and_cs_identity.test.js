import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { db } from '../db/index.js';
import {
  parseTimestamp,
  parseDate,
  normalizeDateToISO,
  getOperationalBusinessDate,
  resolveOperationalBusinessDate,
  isCsEmployee,
  parseDailyLogBuffer,
  parseAnyUploadedBuffer,
  CANONICAL_TIMEZONE
} from '../services/parser.js';
import {
  persistDailyLogRecords,
  getTeamTrackingSummary
} from '../services/tracking.js';
import { processAutoDetectedUpload } from '../services/allocation.js';
import { getCairoBusinessDate } from '../services/time_utils.js';

describe('Canonical Time Pipeline & Authoritative CS Identity Validation Suite', () => {
  const originalTz = process.env.TZ;
  const originalNodeEnv = process.env.NODE_ENV;

  before(() => {
    // Ensure clean state for test assertions
    db.prepare('DELETE FROM employees WHERE name IN (?, ?, ?, ?)').run(
      'Yomna CS Authoritative',
      'Mahmoud Sales Authoritative',
      'Sara CS Authoritative',
      'Hassan Untrusted'
    );

    db.prepare(`
      INSERT INTO employees (name, department, status)
      VALUES
        ('Yomna CS Authoritative', 'CS', 'ACTIVE'),
        ('Sara CS Authoritative', 'CS', 'ACTIVE'),
        ('Mahmoud Sales Authoritative', 'Sales', 'ACTIVE')
    `).run();
  });

  after(() => {
    process.env.TZ = originalTz;
    process.env.NODE_ENV = originalNodeEnv;
    db.prepare('DELETE FROM employees WHERE name IN (?, ?, ?, ?)').run(
      'Yomna CS Authoritative',
      'Mahmoud Sales Authoritative',
      'Sara CS Authoritative',
      'Hassan Untrusted'
    );
  });

  // Test 1
  test('1. "2026-09-23 17:42:35" preserves 17:42:35', () => {
    const raw = '2026-09-23 17:42:35';
    const ts = parseTimestamp(raw);
    assert.ok(ts, 'Should successfully parse');
    assert.strictEqual(ts.is_valid, true);
    assert.strictEqual(ts.has_time, true);
    assert.strictEqual(ts.cairo_date, '2026-09-23');
    assert.strictEqual(ts.cairo_time, '17:42:35');
    assert.strictEqual(ts.cairo_datetime, '2026-09-23 17:42:35');
    assert.strictEqual(ts.cairo_hour, 17);
    assert.strictEqual(ts.cairo_minute, 42);
    assert.strictEqual(ts.cairo_second, 35);

    // parseDate() must return timestamp preserving exact instant (not zeroed out)
    const ms = parseDate(raw);
    assert.ok(ms && !isNaN(ms), 'parseDate should return valid numeric epoch ms');
    const verifyTs = parseTimestamp(ms);
    assert.strictEqual(verifyTs.cairo_time, '17:42:35', 'parseDate must preserve 17:42:35 without destroying time');
  });

  // Test 2
  test('2. "2026-09-23T17:42:35Z" preserves exact instant', () => {
    const raw = '2026-09-23T17:42:35Z';
    const ts = parseTimestamp(raw);
    assert.ok(ts, 'Should successfully parse UTC instant');
    assert.strictEqual(ts.has_explicit_offset, true);
    assert.strictEqual(ts.instant_iso, '2026-09-23T17:42:35.000Z');
    assert.strictEqual(ts.instant_utc_ms, Date.UTC(2026, 8, 23, 17, 42, 35));

    // In September, Cairo is UTC+3: 17:42:35 UTC = 20:42:35 Cairo
    assert.strictEqual(ts.cairo_hour, 20);
    assert.strictEqual(ts.cairo_minute, 42);
    assert.strictEqual(ts.cairo_second, 35);
    assert.strictEqual(ts.cairo_datetime, '2026-09-23 20:42:35');
  });

  // Test 3
  test('3. "2026-09-23T17:42:35+03:00" preserves exact instant', () => {
    const raw = '2026-09-23T17:42:35+03:00';
    const ts = parseTimestamp(raw);
    assert.ok(ts, 'Should successfully parse instant with explicit +03:00 offset');
    assert.strictEqual(ts.has_explicit_offset, true);
    // Instant is 14:42:35 UTC
    assert.strictEqual(ts.instant_utc_ms, Date.UTC(2026, 8, 23, 14, 42, 35));
    // In Cairo (+03:00), wall-clock is 17:42:35
    assert.strictEqual(ts.cairo_time, '17:42:35');
    assert.strictEqual(ts.cairo_datetime, '2026-09-23 17:42:35');
  });

  // Test 4
  test('4. Server timezone changes do not change Cairo business date', () => {
    const testTimezones = ['America/New_York', 'UTC', 'Asia/Tokyo', 'Australia/Sydney', 'Europe/London'];
    const rawEvent = '2026-09-23 19:30:00';

    for (const tz of testTimezones) {
      process.env.TZ = tz;
      const op = getOperationalBusinessDate(rawEvent, '20:00');
      assert.strictEqual(
        op.business_date,
        '2026-09-23',
        `Server timezone ${tz} must not shift Cairo operational business date`
      );
      assert.strictEqual(op.calendar_date, '2026-09-23');
      assert.strictEqual(op.is_rolled_over, false);
    }
  });

  // Test 5
  test('5. Browser timezone changes do not change Cairo business date', () => {
    // The server-side canonical timestamp pipeline is authoritative in Africa/Cairo
    // regardless of simulated client offsets.
    const clientOffsets = [-300, 0, 120, 180, 540]; // various browser getTimezoneOffset() minutes
    for (const offset of clientOffsets) {
      // Input event in Cairo wall clock
      const rawEvent = '2026-09-23 15:00:00';
      const op = getOperationalBusinessDate(rawEvent, '20:00');
      assert.strictEqual(op.business_date, '2026-09-23', `Client offset ${offset} must not affect Cairo business date`);
    }
  });

  // Test 6
  test('6. Excel serial date works', () => {
    // Excel serial 46288 corresponds to 2026-09-23
    const serial = 46288;
    const ts = parseTimestamp(serial);
    assert.ok(ts, 'Excel serial date should parse');
    assert.strictEqual(ts.has_time, false);
    assert.strictEqual(ts.cairo_date, '2026-09-23');

    const iso = normalizeDateToISO(serial);
    assert.strictEqual(iso, '2026-09-23');
  });

  // Test 7
  test('7. Excel serial datetime preserves time', () => {
    // 2026-09-23 17:42:35 in Excel serial:
    // Day serial: 46288
    // Time fraction: (17*3600 + 42*60 + 35) / 86400 = 63755 / 86400 ≈ 0.7379050925925926
    const serial = 46288 + 63755 / 86400;
    const ts = parseTimestamp(serial);
    assert.ok(ts, 'Excel serial datetime should parse');
    assert.strictEqual(ts.has_time, true);
    assert.strictEqual(ts.cairo_date, '2026-09-23');
    assert.strictEqual(ts.cairo_hour, 17);
    assert.strictEqual(ts.cairo_minute, 42);
    assert.strictEqual(ts.cairo_second, 35);
    assert.strictEqual(ts.cairo_datetime, '2026-09-23 17:42:35');
  });

  // Test 8
  test('8. Unix milliseconds are never interpreted as Excel serial', () => {
    // Unix millisecond timestamp for 2026-09-23 14:42:35 UTC (17:42:35 Cairo)
    const unixMs = Date.UTC(2026, 8, 23, 14, 42, 35); // 1790174555000
    assert.ok(unixMs > 100000, 'Unix ms is > 100,000 threshold');

    const ts = parseTimestamp(unixMs);
    assert.ok(ts, 'Should parse Unix milliseconds');
    // If it were wrongly parsed as an Excel serial, year would be in year 4,900,000+
    assert.strictEqual(ts.cairo_year, 2026, 'Year must be 2026, not distorted by Excel serial conversion');
    assert.strictEqual(ts.cairo_date, '2026-09-23');
    assert.strictEqual(ts.cairo_time, '17:42:35');

    const iso = normalizeDateToISO(unixMs);
    assert.strictEqual(iso, '2026-09-23');
  });

  // Test 9
  test('9. Event at cutoff boundary follows configured cutoff exactly', () => {
    const cutoff = '20:00';

    // 19:59:59 -> 1 second before cutoff -> same business date
    const before = getOperationalBusinessDate('2026-09-23 19:59:59', cutoff);
    assert.strictEqual(before.business_date, '2026-09-23');
    assert.strictEqual(before.is_rolled_over, false);

    // 20:00:00 -> exactly at cutoff -> rolls over to next business date
    const at = getOperationalBusinessDate('2026-09-23 20:00:00', cutoff);
    assert.strictEqual(at.business_date, '2026-09-24');
    assert.strictEqual(at.is_rolled_over, true);

    // 20:00:01 -> 1 second after cutoff -> rolls over
    const afterCutoff = getOperationalBusinessDate('2026-09-23 20:00:01', cutoff);
    assert.strictEqual(afterCutoff.business_date, '2026-09-24');
    assert.strictEqual(afterCutoff.is_rolled_over, true);
  });

  // Test 10
  test('10. Event imported after midnight keeps event business date', () => {
    // Event occurred at 15:30 on 2026-09-23
    const eventTime = '2026-09-23 15:30:00';
    // Upload occurs on next day after midnight (e.g. 2026-09-24 03:00:00)
    const op = getOperationalBusinessDate(eventTime, '20:00');
    assert.strictEqual(
      op.business_date,
      '2026-09-23',
      'The actual event timestamp, not import time, must determine business date'
    );
  });

  // Test 11
  test('11. Historical date never uses current live timestamp', () => {
    const historicalString = '2026-09-10 11:30:00';
    const ts = parseTimestamp(historicalString);
    assert.strictEqual(ts.cairo_date, '2026-09-10');
    assert.strictEqual(ts.cairo_datetime, '2026-09-10 11:30:00');

    const op = getOperationalBusinessDate(historicalString, '20:00');
    assert.strictEqual(op.business_date, '2026-09-10');
    assert.strictEqual(op.calendar_date, '2026-09-10');
    assert.notStrictEqual(op.business_date, getCairoBusinessDate(), 'Historical date must not equal today');
  });

  // Test 12
  test('12. A non-CS raw actor never becomes a CS employee', () => {
    // Actors that are not CS employees in Employee Master
    const rawNonCsActors = [
      'Mahmoud Sales Authoritative', // Sales in DB
      'Driver Ali Shipping',        // Not in DB
      'ARC SHOES',                  // Merchant name
      'AutoBot System Worker',      // System actor
      'Warehouse Guy'               // Warehouse worker
    ];

    for (const actor of rawNonCsActors) {
      const isCs = isCsEmployee(actor);
      assert.strictEqual(
        isCs,
        false,
        `Raw actor "${actor}" must not be classified as a CS employee`
      );
    }
  });

  // Test 13
  test('13. A fake object with department="CS" cannot bypass Employee Master', () => {
    // 1. Fake user not in Employee Master at all
    const fakeUnknown = { name: 'Hassan Untrusted', department: 'CS' };
    assert.strictEqual(
      isCsEmployee(fakeUnknown),
      false,
      'Untrusted object with department="CS" must NOT bypass Employee Master'
    );

    // 2. Existing user in Employee Master whose authoritative department is Sales
    const fakeSalesOverride = { name: 'Mahmoud Sales Authoritative', department: 'CS' };
    assert.strictEqual(
      isCsEmployee(fakeSalesOverride),
      false,
      'Caller-provided department="CS" must NOT override authoritative master department (Sales)'
    );

    // 3. Genuine CS employee from Employee Master
    const genuineCs = { name: 'Yomna CS Authoritative' };
    assert.strictEqual(
      isCsEmployee(genuineCs),
      true,
      'Authoritative CS employee in Master must be identified as CS'
    );
  });

  // Real End-to-End Path Verification
  test('14. Full runtime path: Excel Upload -> Parser -> Database -> Tracking API', async () => {
    const testDir = path.join(process.cwd(), 'tests', 'fixtures_time_pipeline');
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'pipeline_verification.xlsx');

    // Create workbook with precise timestamps and CS vs non-CS actors
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Log');
    sheet.columns = [
      { header: 'كود الطلب', key: 'order_code', width: 15 },
      { header: 'الاسم', key: 'name', width: 25 },
      { header: 'الاكشن', key: 'action', width: 35 },
      { header: 'التاريخ', key: 'date', width: 20 }
    ];

    // Order 1: Yomna CS (CS) - before cutoff (17:42:35) -> business date 2026-09-23
    sheet.addRow({
      order_code: 'TEST-ORD-001',
      name: 'Yomna CS Authoritative',
      action: 'عدل حالة الطلب إلى Delivered',
      date: '2026-09-23 17:42:35'
    });

    // Order 2: Yomna CS (CS) - after cutoff (20:15:00) -> rolls over to business date 2026-09-24
    sheet.addRow({
      order_code: 'TEST-ORD-002',
      name: 'Yomna CS Authoritative',
      action: 'عدل حالة الطلب إلى Delivered',
      date: '2026-09-23 20:15:00'
    });

    // Order 3: Mahmoud Sales (Non-CS) -> is_cs = 0
    sheet.addRow({
      order_code: 'TEST-ORD-003',
      name: 'Mahmoud Sales Authoritative',
      action: 'أضاف اوردر جديد',
      date: '2026-09-23 18:00:00'
    });

    await workbook.xlsx.writeFile(testFile);
    const fileBuffer = fs.readFileSync(testFile);

    // 1. Universal auto-detected upload processor
    const uploadRes = processAutoDetectedUpload(fileBuffer, 'pipeline_verification.xlsx', null, fileBuffer.length);
    assert.ok(uploadRes.success, 'Upload processing must succeed');

    // 2. Verify in Database (raw_log_records)
    const rawRows = db.prepare(`
      SELECT order_code, employee_name, work_date, event_datetime, is_cs
      FROM raw_log_records
      WHERE order_code LIKE 'TEST-ORD-%'
      ORDER BY order_code ASC
    `).all();

    assert.strictEqual(rawRows.length, 3, 'Must have persisted 3 raw log records');

    // TEST-ORD-001: Yomna, 17:42:35 -> work_date = 2026-09-23, is_cs = 1, event_datetime = 2026-09-23 17:42:35
    const r1 = rawRows.find(r => r.order_code === 'TEST-ORD-001');
    assert.strictEqual(r1.work_date, '2026-09-23');
    assert.strictEqual(r1.event_datetime, '2026-09-23 17:42:35');
    assert.strictEqual(r1.is_cs, 1);

    // TEST-ORD-002: Yomna, 20:15:00 -> rolled over to work_date = 2026-09-24, is_cs = 1
    const r2 = rawRows.find(r => r.order_code === 'TEST-ORD-002');
    assert.strictEqual(r2.work_date, '2026-09-24');
    assert.strictEqual(r2.event_datetime, '2026-09-23 20:15:00');
    assert.strictEqual(r2.is_cs, 1);

    // TEST-ORD-003: Mahmoud Sales -> is_cs = 0 (Authoritative Employee Master check)
    const r3 = rawRows.find(r => r.order_code === 'TEST-ORD-003');
    assert.strictEqual(r3.is_cs, 0);

    // 3. Verify Tracking API (getTeamTrackingSummary)
    // Non-CS employees must NOT appear in the CS employee tracking roster!
    const tracking23 = getTeamTrackingSummary('2026-09-23');
    const employees23 = tracking23.employees || [];

    const foundSalesInTracking = employees23.some(e => e.employee_name === 'Mahmoud Sales Authoritative');
    assert.strictEqual(
      foundSalesInTracking,
      false,
      'Non-CS employee (Mahmoud Sales) must NEVER appear in CS employee tracking table'
    );

    const foundYomna = employees23.find(e => e.employee_name === 'Yomna CS Authoritative');
    assert.ok(foundYomna, 'CS employee Yomna must appear in CS tracking table');
    assert.strictEqual(foundYomna.orders_worked_today, 1, 'Yomna must have 1 order worked on 2026-09-23');

    // 4. Verify Tracking on Rolled Over Date 2026-09-24
    const tracking24 = getTeamTrackingSummary('2026-09-24');
    const employees24 = tracking24.employees || [];
    const foundYomna24 = employees24.find(e => e.employee_name === 'Yomna CS Authoritative');
    assert.ok(foundYomna24, 'Rolled-over order must appear on 2026-09-24 for Yomna');
    assert.strictEqual(foundYomna24.orders_worked_today, 1);

    // Clean up test files
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    if (fs.existsSync(testDir)) fs.rmdirSync(testDir);
  });
});
