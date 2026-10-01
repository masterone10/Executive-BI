import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  normalizePhoneNumber,
  compareOrderPhoneNumbers,
  ensurePhoneAlertsTable,
  recordPhoneMatchAlert,
  scanAndRecordPhoneMatches,
  getEmployeeEvaluation,
  getPhoneMatchAlerts,
  getEmployeeEvaluationDetail
} from '../services/employee_evaluation.js';

describe('CS Executive BI — Employee Operational Evaluation & Phone Comparison Suite', () => {
  let db;

  before(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');

    // Create minimal schema
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

      CREATE TABLE vendoor_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_code TEXT UNIQUE,
        account TEXT,
        business_date TEXT,
        raw_payload_json TEXT
      );

      CREATE TABLE current_work_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_code TEXT UNIQUE,
        assigned_employee_name TEXT,
        assigned_employee_id INTEGER,
        work_state TEXT DEFAULT 'UNASSIGNED'
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

    // Seed master employees
    db.prepare('INSERT INTO employees (id, name, department, active) VALUES (1, ?, ?, 1)').run('EMAN CS', 'CS');
    db.prepare('INSERT INTO employees (id, name, department, active) VALUES (2, ?, ?, 1)').run('Ali Hamada CS', 'CS');
    db.prepare('INSERT INTO employees (id, name, department, active) VALUES (3, ?, ?, 1)').run('MOHAMED AHMED NonCS', 'Delivery');
  });

  after(() => {
    db.close();
  });

  test('1. Phone Normalization: handles formats, arabic digits, spaces, and international prefixes', () => {
    assert.equal(normalizePhoneNumber(''), '');
    assert.equal(normalizePhoneNumber(null), '');
    assert.equal(normalizePhoneNumber(undefined), '');

    // Spaces and punctuation
    assert.equal(normalizePhoneNumber('0100 123 4567'), '01001234567');
    assert.equal(normalizePhoneNumber('0100-123-4567'), '01001234567');
    assert.equal(normalizePhoneNumber('(0100) 123.4567'), '01001234567');

    // Eastern Arabic numerals
    assert.equal(normalizePhoneNumber('٠١٠٠١٢٣٤٥٦٧'), '01001234567');
    assert.equal(normalizePhoneNumber('٠١١١ ٤٥٦ ٧٨٩٠'), '01114567890');

    // International prefixes (+20, 0020, 20, 10-digit without leading 0)
    assert.equal(normalizePhoneNumber('+201001234567'), '01001234567');
    assert.equal(normalizePhoneNumber('+20 01001234567'), '01001234567');
    assert.equal(normalizePhoneNumber('00201001234567'), '01001234567');
    assert.equal(normalizePhoneNumber('002001001234567'), '01001234567');
    assert.equal(normalizePhoneNumber('201001234567'), '01001234567');
    assert.equal(normalizePhoneNumber('1001234567'), '01001234567');
  });

  test('2. Two-Field Phone Comparison: flags exact matches only when both present', () => {
    // Both present and matching after normalization
    const match1 = compareOrderPhoneNumbers('0100 123 4567', '+201001234567');
    assert.equal(match1.is_match, true);
    assert.equal(match1.match_flag, 1);
    assert.equal(match1.phone_a_normalized, '01001234567');
    assert.equal(match1.phone_b_normalized, '01001234567');

    // Both present but different
    const diff = compareOrderPhoneNumbers('01001234567', '01111234567');
    assert.equal(diff.is_match, false);
    assert.equal(diff.match_flag, 0);

    // One or both empty -> NEVER flags as match
    assert.equal(compareOrderPhoneNumbers('01001234567', '').is_match, false);
    assert.equal(compareOrderPhoneNumbers('', '01001234567').is_match, false);
    assert.equal(compareOrderPhoneNumbers('', '').is_match, false);
    assert.equal(compareOrderPhoneNumbers(null, null).is_match, false);
  });

  test('3. Phone Match Alert Recording & Deduplication', () => {
    const alert1 = {
      work_date: '2026-09-30',
      order_code: 'ORD-999',
      employee_id: 1,
      employee_name: 'EMAN CS',
      phone_a_raw: '01001234567',
      phone_b_raw: '0100 123 4567',
      phone_a_normalized: '01001234567',
      phone_b_normalized: '01001234567',
      alert_type: 'PHONE_DUPLICATED_IN_BOTH_FIELDS',
      status: 'REVIEW_REQUIRED'
    };

    assert.equal(recordPhoneMatchAlert(alert1, db), true);

    // Duplicate insert for same (date, order, employee, alert_type) should update without error or duplication
    assert.equal(recordPhoneMatchAlert(alert1, db), true);

    const count = db.prepare("SELECT COUNT(*) as c FROM phone_match_alerts WHERE order_code = 'ORD-999'").get().c;
    assert.equal(count, 1);
  });

  test('4. Employee Evaluation: counts confirmed orders, added phones and calculates match rate', () => {
    // Seed logs for EMAN CS (id 1)
    db.prepare(`
      INSERT INTO raw_log_records (employee_name, order_code, action, status, work_date, event_datetime, is_cs)
      VALUES 
        ('EMAN CS', 'ORD-101', 'عدل حالة الاوردر الى Printed', 'Printed', '2026-09-30', '2026-09-30 10:00:00', 1),
        ('EMAN CS', 'ORD-102', 'عدل حالة الاوردر الى Printed', 'Printed', '2026-09-30', '2026-09-30 10:05:00', 1),
        ('EMAN CS', 'ORD-103', 'عدل حالة الاوردر الى Printed', 'Printed', '2026-09-30', '2026-09-30 10:10:00', 1),
        ('EMAN CS', 'ORD-104', 'عدل حالة الاوردر الى Printed', 'Printed', '2026-09-30', '2026-09-30 10:15:00', 1),
        ('EMAN CS', 'ORD-101', 'أضاف رقم هاتف بديل', 'Action Recorded', '2026-09-30', '2026-09-30 10:01:00', 1),
        ('EMAN CS', 'ORD-102', 'أضاف رقم هاتف بديل', 'Action Recorded', '2026-09-30', '2026-09-30 10:06:00', 1)
    `).run();

    // Seed logs for Ali Hamada CS (id 2)
    db.prepare(`
      INSERT INTO raw_log_records (employee_name, order_code, action, status, work_date, event_datetime, is_cs)
      VALUES 
        ('Ali Hamada CS', 'ORD-201', 'عدل حالة الاوردر الى Printed', 'Printed', '2026-09-30', '2026-09-30 11:00:00', 1),
        ('Ali Hamada CS', 'ORD-202', 'عدل حالة الاوردر الى Pending', 'Pending', '2026-09-30', '2026-09-30 11:05:00', 1)
    `).run();

    // Non-CS logs should be excluded
    db.prepare(`
      INSERT INTO raw_log_records (employee_name, order_code, action, status, work_date, event_datetime, is_cs)
      VALUES 
        ('MOHAMED AHMED NonCS', 'ORD-301', 'عدل حالة الاوردر الى Printed', 'Printed', '2026-09-30', '2026-09-30 12:00:00', 0)
    `).run();

    const evaluation = getEmployeeEvaluation({ dateMode: 'day', targetDate: '2026-09-30' }, db);

    assert.ok(evaluation.summary);
    assert.equal(evaluation.summary.total_cs_employees, 2); // EMAN CS, Ali Hamada CS (NonCS excluded)
    assert.equal(evaluation.summary.total_confirmed_orders, 5); // 4 for EMAN, 1 for Ali
    assert.equal(evaluation.summary.total_added_phones, 2); // 2 for EMAN

    const eman = evaluation.employees.find(e => e.employee_name === 'EMAN CS');
    assert.ok(eman);
    assert.equal(eman.confirmed_orders, 4);
    assert.equal(eman.added_phone_numbers, 2);
    assert.equal(eman.phone_match_alerts, 1); // From previous test
    assert.equal(eman.phone_match_rate, 25.0); // 1 / 4 * 100 = 25%

    const ali = evaluation.employees.find(e => e.employee_name === 'Ali Hamada CS');
    assert.ok(ali);
    assert.equal(ali.confirmed_orders, 1);
    assert.equal(ali.added_phone_numbers, 0);
    assert.equal(ali.phone_match_alerts, 0);
    assert.equal(ali.phone_match_rate, 0.0);
  });

  test('5. Employee Detail Breakdown: returns confirmed orders and alerts list', () => {
    const detail = getEmployeeEvaluationDetail(1, { dateMode: 'day', targetDate: '2026-09-30' }, db);
    assert.ok(detail);
    assert.equal(detail.employee.name, 'EMAN CS');
    assert.equal(detail.metrics.confirmed_orders, 4);
    assert.equal(detail.metrics.added_phone_numbers, 2);
    assert.equal(detail.confirmed_orders_list.length, 4);
    assert.equal(detail.phone_additions_list.length, 2);
  });

  test('6. Causal CS Attribution: links phone alert through actual phone modification or order edit logs', () => {
    // Order ORD-501 has duplicate phones and phone addition action by Ali Hamada CS
    db.prepare(`
      INSERT INTO vendoor_orders (order_code, account, business_date, raw_payload_json)
      VALUES ('ORD-501', 'Test Acc', '2026-09-30', '{"order_code":"ORD-501","phone":"01011112222","phone2":"+20 01011112222"}')
    `).run();

    db.prepare(`
      INSERT INTO raw_log_records (employee_name, order_code, action, status, work_date, event_datetime, is_cs)
      VALUES ('Ali Hamada CS', 'ORD-501', 'أضاف رقم هاتف بديل', 'Action Recorded', '2026-09-30', '2026-09-30 14:00:00', 1)
    `).run();

    // Order ORD-502 has duplicate phones and edit phone action by EMAN CS
    db.prepare(`
      INSERT INTO vendoor_orders (order_code, account, business_date, raw_payload_json)
      VALUES ('ORD-502', 'Test Acc', '2026-09-30', '{"order_code":"ORD-502","phone":"01233334444","phone2":"01233334444"}')
    `).run();

    db.prepare(`
      INSERT INTO raw_log_records (employee_name, order_code, action, status, work_date, event_datetime, is_cs)
      VALUES ('EMAN CS', 'ORD-502', 'تعديل رقم الهاتف البديل', 'Action Recorded', '2026-09-30', '2026-09-30 14:30:00', 1)
    `).run();

    // Scan and record
    const created = scanAndRecordPhoneMatches(db, { work_date: '2026-09-30' });
    assert.ok(created >= 2);

    const alert501 = db.prepare("SELECT * FROM phone_match_alerts WHERE order_code = 'ORD-501'").get();
    assert.ok(alert501);
    assert.equal(alert501.employee_name, 'Ali Hamada CS');
    assert.equal(alert501.employee_id, 2);

    const alert502 = db.prepare("SELECT * FROM phone_match_alerts WHERE order_code = 'ORD-502'").get();
    assert.ok(alert502);
    assert.equal(alert502.employee_name, 'EMAN CS');
    assert.equal(alert502.employee_id, 1);
  });

  test('7. Anti-Fallback Rule: duplicate phones without causal CS action remain Unresolved', () => {
    // Order ORD-601 has duplicate phones, is assigned in current_work_orders to EMAN CS, but has NO causal CS action
    db.prepare(`
      INSERT INTO vendoor_orders (order_code, account, business_date, raw_payload_json)
      VALUES ('ORD-601', 'Test Acc', '2026-09-30', '{"order_code":"ORD-601","phone":"01555556666","phone2":"01555556666"}')
    `).run();

    db.prepare(`
      INSERT INTO current_work_orders (order_code, assigned_employee_name, assigned_employee_id, work_state)
      VALUES ('ORD-601', 'EMAN CS', 1, 'ASSIGNED')
    `).run();

    scanAndRecordPhoneMatches(db, { work_date: '2026-09-30' });

    const alert601 = db.prepare("SELECT * FROM phone_match_alerts WHERE order_code = 'ORD-601'").get();
    assert.ok(alert601);
    // MUST remain Unresolved; MUST NOT falsely accuse EMAN CS based on current assignment alone
    assert.equal(alert601.employee_name, 'Unresolved');
    assert.equal(alert601.employee_id, null);
    assert.equal(alert601.attribution_status, 'UNRESOLVED');
  });
});
