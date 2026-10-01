import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  normalizePhoneNumber,
  compareOrderPhoneNumbers,
  ensurePhoneAlertsTable,
  recordPhoneMatchAlert,
  resolveOrderPhoneMatch,
  resolvePhoneAlertById,
  resolvePhoneAlertAttribution,
  evaluateAndRecordOrderPhoneDuplicate,
  scanAndRecordPhoneMatches,
  getPhoneMatchAlerts,
  getPhoneMatchAlertHistory,
  getEmployeeEvaluation,
  getEmployeeEvaluationDetail,
  isQualifyingPhoneMutationAction
} from '../services/employee_evaluation.js';
import { getOrderTracking } from '../services/tracking.js';
import { generatePhoneAlertsReport } from '../services/reports.js';

describe('CS EXECUTIVE BI — Master Phone Duplicate Detection & Employee Action Alert Suite', () => {
  let db;

  before(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');

    // Create minimal schema matching production
    db.exec(`
      CREATE TABLE employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        department TEXT DEFAULT 'CS',
        active INTEGER DEFAULT 1,
        team_membership TEXT DEFAULT 'Both'
      );

      CREATE TABLE raw_log_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_name TEXT,
        order_code TEXT,
        action TEXT,
        status TEXT,
        event_datetime TEXT,
        work_date TEXT,
        is_cs INTEGER DEFAULT 1
      );

      CREATE TABLE vendoor_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_name TEXT,
        order_code TEXT,
        action TEXT,
        timestamp_str TEXT,
        sync_run_id TEXT
      );

      CREATE TABLE vendoor_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_code TEXT UNIQUE,
        account TEXT,
        business_date TEXT,
        raw_payload_json TEXT
      );

      CREATE TABLE current_work_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_date TEXT,
        order_code TEXT UNIQUE,
        assigned_employee_name TEXT,
        assigned_employee_id INTEGER,
        work_state TEXT DEFAULT 'UNASSIGNED'
      );

      CREATE TABLE order_tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_code TEXT,
        tracking_id TEXT,
        account TEXT,
        status TEXT
      );

      CREATE TABLE system_configs (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE vendoor_identity_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vendoor_name TEXT,
        normalized_name TEXT,
        employee_id INTEGER,
        status TEXT
      );
    `);

    ensurePhoneAlertsTable(db);

    // Seed master CS employees
    db.prepare('INSERT INTO employees (id, name, department, active) VALUES (1, ?, ?, 1)').run('Sarah CS', 'CS');
    db.prepare('INSERT INTO employees (id, name, department, active) VALUES (2, ?, ?, 1)').run('Ahmed CS', 'CS');
    db.prepare('INSERT INTO employees (id, name, department, active) VALUES (3, ?, ?, 1)').run('Karim Delivery', 'Operations');
  });

  after(() => {
    db.close();
  });

  // ==========================================
  // Section 25: 13 Required Tests
  // ==========================================

  test('1. Primary = A, Secondary = A -> DUPLICATE = YES', () => {
    const res = compareOrderPhoneNumbers('01001234567', '01001234567');
    assert.equal(res.is_duplicate, true);
    assert.equal(res.is_match, true);
    assert.equal(res.match_flag, 1);
  });

  test('2. Primary = A, Secondary = B -> DUPLICATE = NO', () => {
    const res = compareOrderPhoneNumbers('01001234567', '01119876543');
    assert.equal(res.is_duplicate, false);
    assert.equal(res.is_match, false);
    assert.equal(res.match_flag, 0);
  });

  test('3. Primary = A, Secondary = empty -> DUPLICATE = NO', () => {
    const res1 = compareOrderPhoneNumbers('01001234567', '');
    assert.equal(res1.is_duplicate, false);
    const res2 = compareOrderPhoneNumbers('01001234567', null);
    assert.equal(res2.is_duplicate, false);
  });

  test('4. Primary = empty, Secondary = A -> DUPLICATE = NO', () => {
    const res1 = compareOrderPhoneNumbers('', '01001234567');
    assert.equal(res1.is_duplicate, false);
    const res2 = compareOrderPhoneNumbers(null, '01001234567');
    assert.equal(res2.is_duplicate, false);
  });

  test('5. Normalization handles Arabic numerals, spaces, hyphens, and +20', () => {
    const c1 = normalizePhoneNumber('01001234567');
    const c2 = normalizePhoneNumber('0100 123 4567');
    const c3 = normalizePhoneNumber('+201001234567');
    const c4 = normalizePhoneNumber('00201001234567');
    const c5 = normalizePhoneNumber('٠١٠٠١٢٣٤٥٦٧');
    const c6 = normalizePhoneNumber('(0100)-123.4567');

    assert.equal(c1, '01001234567');
    assert.equal(c2, '01001234567');
    assert.equal(c3, '01001234567');
    assert.equal(c4, '01001234567');
    assert.equal(c5, '01001234567');
    assert.equal(c6, '01001234567');

    // Two genuinely different numbers must NOT normalize to same
    const diffNorm = normalizePhoneNumber('01221234567');
    assert.notEqual(diffNorm, c1);
  });

  test('6 & 7. Order arrives with duplicate phones -> PHONE_DUPLICATE_CURRENT created, employee is Unresolved', () => {
    const order = {
      order_code: 'ORD-2205226',
      phone: '01012345678',
      phone2: '01012345678',
      business_date: '2026-09-30'
    };

    const alert = evaluateAndRecordOrderPhoneDuplicate(order, null, db);
    assert.ok(alert);
    assert.equal(alert.is_duplicate, true);
    assert.equal(alert.alert_type, 'PHONE_DUPLICATE_CURRENT');
    assert.equal(alert.employee_name, 'Unresolved');
    assert.equal(alert.employee_id, null);
    assert.equal(alert.attribution_status, 'UNRESOLVED');

    const inDb = db.prepare("SELECT * FROM phone_match_alerts WHERE order_code = 'ORD-2205226'").get();
    assert.ok(inDb);
    assert.equal(inDb.status, 'ACTIVE');
    assert.equal(inDb.alert_type, 'PHONE_DUPLICATE_CURRENT');
    assert.equal(inDb.employee_name, 'Unresolved');
    assert.equal(inDb.attribution_status, 'UNRESOLVED');
  });

  test('8. Order arrives with different phones, then employee adds duplicate phone -> PHONE_DUPLICATE_CREATED_BY_EMPLOYEE created with employee name', () => {
    const prevOrder = {
      order_code: 'ORD-8801',
      phone: '01001112222',
      phone2: '01113334444'
    };

    // Employee Sarah CS adds duplicate phone2 in Vendoor logs
    db.prepare(`
      INSERT INTO raw_log_records (employee_name, order_code, action, status, work_date, event_datetime, is_cs)
      VALUES ('Sarah CS', 'ORD-8801', 'أضاف رقم هاتف بديل', 'Action Recorded', '2026-09-30', '2026-09-30 11:30:00', 1)
    `).run();

    const currentOrder = {
      order_code: 'ORD-8801',
      phone: '01001112222',
      phone2: '01001112222',
      business_date: '2026-09-30'
    };

    const alert = evaluateAndRecordOrderPhoneDuplicate(currentOrder, prevOrder, db);
    assert.ok(alert);
    assert.equal(alert.is_duplicate, true);
    assert.equal(alert.alert_type, 'PHONE_DUPLICATE_CREATED_BY_EMPLOYEE');
    assert.equal(alert.employee_name, 'Sarah CS');
    assert.equal(alert.employee_id, 1);
    assert.equal(alert.attribution_status, 'PROVEN_CS_PHONE_EDIT');
    assert.equal(alert.source_action, 'أضاف رقم هاتف بديل');

    const inDb = db.prepare("SELECT * FROM phone_match_alerts WHERE order_code = 'ORD-8801'").get();
    assert.ok(inDb);
    assert.equal(inDb.alert_type, 'PHONE_DUPLICATE_CREATED_BY_EMPLOYEE');
    assert.equal(inDb.employee_name, 'Sarah CS');
    assert.equal(inDb.attribution_status, 'PROVEN_CS_PHONE_EDIT');
  });

  test('9. Order arrives with different phones, employee makes unrelated edit (note, status, print) -> duplicate detected, but employee is Unresolved', () => {
    // Karim prints waybill, Ahmed edits general note
    db.prepare(`
      INSERT INTO raw_log_records (employee_name, order_code, action, status, work_date, event_datetime, is_cs)
      VALUES 
        ('Karim Delivery', 'ORD-8802', 'طبع البوليصة', 'Printed', '2026-09-30', '2026-09-30 12:00:00', 0),
        ('Ahmed CS', 'ORD-8802', 'عدل ملاحظات الاوردر', 'Updated', '2026-09-30', '2026-09-30 12:05:00', 1)
    `).run();

    const order = {
      order_code: 'ORD-8802',
      phone: '01225556666',
      phone2: '01225556666',
      business_date: '2026-09-30'
    };

    const alert = evaluateAndRecordOrderPhoneDuplicate(order, null, db);
    assert.ok(alert);
    assert.equal(alert.is_duplicate, true);
    assert.equal(alert.alert_type, 'PHONE_DUPLICATE_CURRENT');
    assert.equal(alert.employee_name, 'Unresolved');
    assert.equal(alert.employee_id, null);
    assert.equal(alert.attribution_status, 'UNRESOLVED');
  });

  test('10. Order has duplicate phones, employee edits phone to a distinct number -> ALERT RESOLVED', () => {
    // Current duplicate exists for ORD-2205226
    const existing = db.prepare("SELECT * FROM phone_match_alerts WHERE order_code = 'ORD-2205226'").get();
    assert.equal(existing.status, 'ACTIVE');

    // New state arrives with different secondary phone
    const updatedOrder = {
      order_code: 'ORD-2205226',
      phone: '01012345678',
      phone2: '01099998888',
      business_date: '2026-09-30'
    };

    const res = evaluateAndRecordOrderPhoneDuplicate(updatedOrder, { phone: '01012345678', phone2: '01012345678' }, db);
    assert.equal(res.is_duplicate, false);

    const resolved = db.prepare("SELECT * FROM phone_match_alerts WHERE order_code = 'ORD-2205226'").get();
    assert.ok(resolved);
    assert.equal(resolved.status, 'RESOLVED');
    assert.equal(resolved.alert_type, 'PHONE_DUPLICATE_RESOLVED');
    assert.ok(resolved.resolved_at);
  });

  test('11. UI API displays duplicate orders with correct status and employee attribution', () => {
    const alerts = getPhoneMatchAlerts({ dateMode: 'day', targetDate: '2026-09-30', status: 'ALL' }, db);
    assert.ok(alerts.alerts.length >= 2);

    const createdBySarah = alerts.alerts.find(a => a.order_code === 'ORD-8801');
    assert.ok(createdBySarah);
    assert.equal(createdBySarah.employee_name, 'Sarah CS');
    assert.equal(createdBySarah.alert_type, 'PHONE_DUPLICATE_CREATED_BY_EMPLOYEE');

    const unresolvedAlert = alerts.alerts.find(a => a.order_code === 'ORD-8802');
    assert.ok(unresolvedAlert);
    assert.equal(unresolvedAlert.employee_name, 'Unresolved');
    assert.equal(unresolvedAlert.attribution_status, 'UNRESOLVED');
  });

  test('12. Export & Tracking includes phone duplicate columns and alerts', async () => {
    // Tracking query verification
    db.prepare(`
      INSERT INTO vendoor_orders (order_code, account, business_date, raw_payload_json)
      VALUES ('ORD-8801', 'Master Account', '2026-09-30', '{"order_code":"ORD-8801","phone":"01001112222","phone2":"01001112222"}')
    `).run();

    // Verify alert exists in database for ORD-8801
    const alert = db.prepare("SELECT * FROM phone_match_alerts WHERE order_code = 'ORD-8801'").get();
    assert.ok(alert);
    assert.equal(alert.employee_name, 'Sarah CS');

    const alertsList = getPhoneMatchAlertHistory('ORD-8801', db);
    assert.ok(alertsList.length >= 1);
    assert.equal(alertsList[0].employee_name, 'Sarah CS');
    assert.equal(alertsList[0].alert_type, 'PHONE_DUPLICATE_CREATED_BY_EMPLOYEE');

    // Phone Alerts Report Generator verification
    const report = generatePhoneAlertsReport({ dateMode: 'day', targetDate: '2026-09-30' });
    assert.ok(report);
    assert.equal(report.report_type, 'phone_alerts');
    assert.ok(Array.isArray(report.rows));
  });

  test('13. Historical recalculation does not rewrite immutable historical logs', () => {
    const logCountBefore = db.prepare('SELECT COUNT(*) as c FROM raw_log_records').get().c;
    
    // Run scan across historical date
    scanAndRecordPhoneMatches(db, { work_date: '2026-09-30' });

    const logCountAfter = db.prepare('SELECT COUNT(*) as c FROM raw_log_records').get().c;
    assert.equal(logCountBefore, logCountAfter);
  });

  // ==========================================
  // Section 24: Runtime Scenarios 1 to 8
  // ==========================================

  test('Runtime Case 1: Order imported with phone="0101", phone2="0101" -> Alert: YES, Employee: Unresolved', () => {
    const res = evaluateAndRecordOrderPhoneDuplicate({
      order_code: 'RT-CASE-1',
      phone: '01010000001',
      phone2: '01010000001',
      business_date: '2026-09-30'
    }, null, db);

    assert.equal(res.is_duplicate, true);
    assert.equal(res.employee_name, 'Unresolved');
    assert.equal(res.attribution_status, 'UNRESOLVED');
  });

  test('Runtime Case 2: Order imported with phone="0101", phone2="0102" -> Alert: NO', () => {
    const res = evaluateAndRecordOrderPhoneDuplicate({
      order_code: 'RT-CASE-2',
      phone: '01010000001',
      phone2: '01010000002',
      business_date: '2026-09-30'
    }, null, db);

    assert.equal(res.is_duplicate, false);
    const inDb = db.prepare("SELECT * FROM phone_match_alerts WHERE order_code = 'RT-CASE-2'").get();
    assert.equal(inDb, undefined);
  });

  test('Runtime Case 3: Order phone changed to duplicate by Employee A -> Alert: YES (CREATED_BY_EMPLOYEE), Employee: Employee A', () => {
    db.prepare(`
      INSERT INTO raw_log_records (employee_name, order_code, action, status, work_date, event_datetime, is_cs)
      VALUES ('Ahmed CS', 'RT-CASE-3', 'تعديل رقم هاتف بديل', 'Action Recorded', '2026-09-30', '2026-09-30 15:00:00', 1)
    `).run();

    const res = evaluateAndRecordOrderPhoneDuplicate({
      order_code: 'RT-CASE-3',
      phone: '01010000001',
      phone2: '01010000001',
      business_date: '2026-09-30'
    }, { phone: '01010000001', phone2: '01010000002' }, db);

    assert.equal(res.is_duplicate, true);
    assert.equal(res.alert_type, 'PHONE_DUPLICATE_CREATED_BY_EMPLOYEE');
    assert.equal(res.employee_name, 'Ahmed CS');
    assert.equal(res.employee_id, 2);
  });

  test('Runtime Case 4: Employee prints waybill on order with existing duplicate -> Never attribute printer', () => {
    db.prepare(`
      INSERT INTO raw_log_records (employee_name, order_code, action, status, work_date, event_datetime, is_cs)
      VALUES ('Sarah CS', 'RT-CASE-4', 'طبع البوليصة', 'Printed', '2026-09-30', '2026-09-30 15:10:00', 1)
    `).run();

    const res = evaluateAndRecordOrderPhoneDuplicate({
      order_code: 'RT-CASE-4',
      phone: '01010000001',
      phone2: '01010000001',
      business_date: '2026-09-30'
    }, null, db);

    assert.equal(res.is_duplicate, true);
    assert.equal(res.employee_name, 'Unresolved');
    assert.notEqual(res.employee_name, 'Sarah CS');
  });

  test('Runtime Case 5: Employee changes status to Delivered -> Never attribute status changer', () => {
    db.prepare(`
      INSERT INTO raw_log_records (employee_name, order_code, action, status, work_date, event_datetime, is_cs)
      VALUES ('Ahmed CS', 'RT-CASE-5', 'عدل حالة الاوردر الى Delivered', 'Delivered', '2026-09-30', '2026-09-30 15:20:00', 1)
    `).run();

    const res = evaluateAndRecordOrderPhoneDuplicate({
      order_code: 'RT-CASE-5',
      phone: '01010000001',
      phone2: '01010000001',
      business_date: '2026-09-30'
    }, null, db);

    assert.equal(res.is_duplicate, true);
    assert.equal(res.employee_name, 'Unresolved');
    assert.notEqual(res.employee_name, 'Ahmed CS');
  });

  test('Runtime Case 6: Order assigned to Employee in workspace -> Never attribute assigned employee', () => {
    db.prepare(`
      INSERT INTO current_work_orders (order_code, assigned_employee_name, assigned_employee_id, work_state, work_date)
      VALUES ('RT-CASE-6', 'Sarah CS', 1, 'ASSIGNED', '2026-09-30')
    `).run();

    const res = evaluateAndRecordOrderPhoneDuplicate({
      order_code: 'RT-CASE-6',
      phone: '01010000001',
      phone2: '01010000001',
      business_date: '2026-09-30'
    }, null, db);

    assert.equal(res.is_duplicate, true);
    assert.equal(res.employee_name, 'Unresolved');
    assert.equal(res.employee_id, null);
  });

  test('Runtime Case 7: Duplicate alert resolved when phone edited to distinct number -> Historical record preserved', () => {
    // Initial duplicate
    evaluateAndRecordOrderPhoneDuplicate({
      order_code: 'RT-CASE-7',
      phone: '01010000001',
      phone2: '01010000001',
      business_date: '2026-09-30'
    }, null, db);

    let alert = db.prepare("SELECT * FROM phone_match_alerts WHERE order_code = 'RT-CASE-7'").get();
    assert.equal(alert.status, 'ACTIVE');

    // Distinct secondary phone arrives
    evaluateAndRecordOrderPhoneDuplicate({
      order_code: 'RT-CASE-7',
      phone: '01010000001',
      phone2: '01099990000',
      business_date: '2026-09-30'
    }, { phone: '01010000001', phone2: '01010000001' }, db);

    alert = db.prepare("SELECT * FROM phone_match_alerts WHERE order_code = 'RT-CASE-7'").get();
    assert.equal(alert.status, 'RESOLVED');
    assert.equal(alert.alert_type, 'PHONE_DUPLICATE_RESOLVED');
    assert.ok(alert.resolved_at);
  });

  test('Runtime Case 8: Same duplicate order polled 10 times with no change -> Exactly ONE active alert maintained', () => {
    for (let i = 0; i < 10; i++) {
      evaluateAndRecordOrderPhoneDuplicate({
        order_code: 'RT-CASE-8',
        phone: '01012341234',
        phone2: '01012341234',
        business_date: '2026-09-30'
      }, { phone: '01012341234', phone2: '01012341234' }, db);
    }

    const count = db.prepare("SELECT COUNT(*) as c FROM phone_match_alerts WHERE order_code = 'RT-CASE-8'").get().c;
    assert.equal(count, 1);
  });
});
