import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app, db } from '../server.js';
import { isHistoricalCsName, isCsEmployee } from '../services/parser.js';
import { evaluateAccountTimeStatus, saveAccountDaySchedule } from '../services/enterprise_allocation.js';
import { importHistoricalLogsFromExcel } from '../services/excel_importer.js';
import { evaluateSecondPhoneQuality, evaluateAddressQuality, computeCustomerDeliveryRate } from '../services/operational_intelligence.js';
import XLSX from 'xlsx';

test('COMPREHENSIVE FINAL VERIFICATION SUITE — CS Executive BI / Vendoor', async (suite) => {

  // =========================================================================
  // 1. SECTION A: Historical CS Identity & Operational Separation
  // =========================================================================
  await suite.test('A1. Historical CS Name Detection (/cs/i)', () => {
    // True positives: any casing and surrounding text
    assert.equal(isHistoricalCsName('CS'), true);
    assert.equal(isHistoricalCsName('cs'), true);
    assert.equal(isHistoricalCsName('Cs'), true);
    assert.equal(isHistoricalCsName('cS'), true);
    assert.equal(isHistoricalCsName('Ahmed CS'), true);
    assert.equal(isHistoricalCsName('cs_sarah'), true);
    assert.equal(isHistoricalCsName('Mostafa cs agent'), true);
    assert.equal(isHistoricalCsName('  Fatma CS  '), true);

    // True negatives: Non-CS names
    assert.equal(isHistoricalCsName('Ahmed Ali'), false);
    assert.equal(isHistoricalCsName('Warehouse 1'), false);
    assert.equal(isHistoricalCsName('Driver Amr'), false);
    assert.equal(isHistoricalCsName('Finance Manager'), false);
    assert.equal(isHistoricalCsName(''), false);
    assert.equal(isHistoricalCsName(null), false);
  });

  await suite.test('A2. Strict Separation: Historical Name NEVER Grants Operational Privileges', () => {
    // When strictMaster is true (operational mutations like allocation / claim / cancel)
    // A name with 'CS' that does not exist in Employee Master must return false
    const historicalActorOnly = 'Unknown Historical CS Agent';
    assert.equal(isHistoricalCsName(historicalActorOnly), true, 'Is recognized historically');
    
    // In operational mode (strictMaster: true), must be rejected
    const operationalEligibility = isCsEmployee(historicalActorOnly, null, { strictMaster: true });
    assert.equal(operationalEligibility, false, 'Historical name strictly forbidden from operational privileges');
  });

  // =========================================================================
  // 2. SECTION C: Cairo Business Date Isolation
  // =========================================================================
  await suite.test('C1 & C2. Cairo Business Date Isolation & Event Time Preservation', () => {
    // Schedule check with date evaluates corresponding day of the week
    const acc = 'VERIFY_CAIRO_SCHEDULE';
    db.prepare('DELETE FROM account_schedules WHERE account = ? COLLATE NOCASE').run(acc);

    saveAccountDaySchedule({ account: acc, day: 'thursday', start: '10:00', end: '14:00', status: 'NEW', enabled: true, operator: 'Auditor' });
    saveAccountDaySchedule({ account: acc, day: 'friday', start: '12:00', end: '16:00', status: 'NEW', enabled: true, operator: 'Auditor' });

    // 2026-10-01 is Thursday
    const thuCheck = evaluateAccountTimeStatus(acc, 'NEW', '11:00', '2026-10-01');
    assert.equal(thuCheck.status, 'OPEN');
    assert.equal(thuCheck.day_override, 'thursday');

    // 2026-10-02 is Friday. At 11:00 Friday is NOT_YET_OPEN
    const friCheck = evaluateAccountTimeStatus(acc, 'NEW', '11:00', '2026-10-02');
    assert.equal(friCheck.status, 'NOT_YET_OPEN');
    assert.equal(friCheck.day_override, 'friday');

    db.prepare('DELETE FROM account_schedules WHERE account = ? COLLATE NOCASE').run(acc);
  });

  // =========================================================================
  // 3. SECTION D: Account Day Schedule Clearing & No Reverting
  // =========================================================================
  await suite.test('D1 & D2. Autosave and Clearing Time Window Never Reverts', () => {
    const acc = 'AUTOSAVE_NO_REVERT_TEST';
    db.prepare('DELETE FROM account_schedules WHERE account = ? COLLATE NOCASE').run(acc);

    // Initial save with explicit start/end
    saveAccountDaySchedule({ account: acc, day: 'monday', start: '09:00', end: '17:00', status: 'NEW', enabled: true, operator: 'Supervisor' });
    let status = evaluateAccountTimeStatus(acc, 'NEW', '10:00', 'monday');
    assert.equal(status.status, 'OPEN');
    assert.equal(status.start_time, '09:00');

    // User clears start and end times to empty string "" (requesting ALL_DAY without reverting)
    saveAccountDaySchedule({ account: acc, day: 'monday', start: '', end: '', status: 'NEW', enabled: true, operator: 'Supervisor' });
    status = evaluateAccountTimeStatus(acc, 'NEW', '05:00', 'monday');
    assert.equal(status.status, 'ALL_DAY', 'Empty time window MUST mean ALL_DAY, never revert to 09:00-17:00');
    assert.equal(status.is_open, true);

    db.prepare('DELETE FROM account_schedules WHERE account = ? COLLATE NOCASE').run(acc);
  });

  // =========================================================================
  // 4. SECTION E: Historical Excel Importer, Safe Dates & Quarantine
  // =========================================================================
  await suite.test('E1-E4. Historical Log Import with Quarantine & Parameter Parity', () => {
    // Construct test workbook with valid row and quarantined rows
    const wb = XLSX.utils.book_new();
    const testData = [
      { 'كود الطلب': 'ORD_VALID_CS_01', 'اسم الموظف': 'Sarah CS', 'الاكشن': 'تأكيد أوردر', 'التاريخ': '2026-09-15 10:30:00', 'الحالة': 'Printed' },
      { 'كود الطلب': '', 'اسم الموظف': 'Sarah CS', 'الاكشن': 'تأكيد', 'التاريخ': '2026-09-15 11:00:00', 'الحالة': 'Printed' }, // Missing code
      { 'كود الطلب': 'ORD_NO_EMP_02', 'اسم الموظف': '', 'الاكشن': 'تأكيد', 'التاريخ': '2026-09-15 11:15:00', 'الحالة': 'Printed' }, // Missing emp
      { 'كود الطلب': 'ORD_BAD_TIME_03', 'اسم الموظف': 'Nour CS', 'الاكشن': 'تأكيد', 'التاريخ': 'INVALID_TIMESTAMP_STRING', 'الحالة': 'Printed' } // Bad time
    ];
    const ws = XLSX.utils.json_to_sheet(testData);
    XLSX.utils.book_append_sheet(wb, ws, 'Logs');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const result = importHistoricalLogsFromExcel(buf, 'test_comprehensive.xlsx');
    assert.ok(result.success);
    assert.equal(result.quarantined_rows, 3, 'Must quarantine the 3 corrupted rows');
    assert.equal(result.logs_inserted >= 1, true, 'Must insert the 1 valid row');

    // Verify quarantine table in SQLite
    const quarantined = db.prepare('SELECT * FROM import_quarantine_records WHERE file_name = ?').all('test_comprehensive.xlsx');
    assert.equal(quarantined.length, 3);
    const reasons = quarantined.map(q => q.rejection_reason);
    assert.ok(reasons.includes('Missing Order Code'));
    assert.ok(reasons.includes('Missing Employee Name'));
    assert.ok(reasons.includes('Invalid or missing timestamp'));

    // Cleanup
    db.prepare('DELETE FROM import_quarantine_records WHERE file_name = ?').run('test_comprehensive.xlsx');
    db.prepare('DELETE FROM raw_log_records WHERE order_code = ?').run('ORD_VALID_CS_01');
  });

  // =========================================================================
  // 5. SECTION F: Operational Intelligence & Phone/Address/Delivery Quality
  // =========================================================================
  await suite.test('F1. Strict Phone Quality Validation', () => {
    // 123 or dummy phone numbers MUST be marked ALT_PHONE_INVALID
    const dummyCheck = evaluateSecondPhoneQuality('01012345678', '123', true);
    assert.equal(dummyCheck.status, 'ALT_PHONE_INVALID');
    assert.equal(dummyCheck.is_valid, false);

    // Repeated identical primary phone MUST be ALT_PHONE_DUPLICATE_PRIMARY
    const dupCheck = evaluateSecondPhoneQuality('01012345678', '01012345678', true);
    assert.equal(dupCheck.status, 'ALT_PHONE_DUPLICATE_PRIMARY');

    // Missing second phone
    const missCheck = evaluateSecondPhoneQuality('01012345678', '', true);
    assert.equal(missCheck.status, 'ALT_PHONE_MISSING');

    // Valid distinct Egyptian numbers
    const validCheck = evaluateSecondPhoneQuality('01012345678', '01198765432', true);
    assert.equal(validCheck.status, 'ALT_PHONE_ADDED');
    assert.equal(validCheck.is_valid, true);
  });

  await suite.test('F2. Address Quality Business Rule Enforcement', () => {
    // Empty or symbols
    assert.equal(evaluateAddressQuality('').status, 'INVALID');
    assert.equal(evaluateAddressQuality('... --- !!!').status, 'INVALID');

    // English address rejected
    assert.equal(evaluateAddressQuality('123 Main Street Cairo Egypt').status, 'INVALID');

    // Mixed Arabic and English rejected
    assert.equal(evaluateAddressQuality('شارع الهرم Building 4 Cairo').status, 'INVALID');

    // Arabic address with <= 3 words rejected
    assert.equal(evaluateAddressQuality('شارع فيصل الجيزة').status, 'INVALID');

    // Arabic address with >= 4 words accepted
    const validAddr = evaluateAddressQuality('شارع الهرم الرئيسي بجوار المحطة');
    assert.equal(validAddr.status, 'VALID');
    assert.equal(validAddr.is_valid, true);
  });

  await suite.test('F3. Customer Delivery Rate Handling', () => {
    // Delivery rate below 70%
    const lowRate = computeCustomerDeliveryRate({ delivery_rate: 55 });
    assert.equal(lowRate.status, 'DELIVERY_RATE_LOW');

    // Delivery rate >= 70%
    const okRate = computeCustomerDeliveryRate({ delivery_rate: 85 });
    assert.equal(okRate.status, 'DELIVERY_RATE_OK');

    // Missing or zero orders should be UNKNOWN, avoiding false 0% alert
    const unknownRate1 = computeCustomerDeliveryRate({ total_orders: 0 });
    assert.equal(unknownRate1.status, 'DELIVERY_RATE_UNKNOWN');

    const unknownRate2 = computeCustomerDeliveryRate(null);
    assert.equal(unknownRate2.status, 'DELIVERY_RATE_UNKNOWN');
  });

  // =========================================================================
  // 6. SECTION G & H: Security, Authorization & Server Endpoints
  // =========================================================================
  await suite.test('G & H. HTTP Security, Authentication & Export Endpoints', async () => {
    const baseUrl = 'http://127.0.0.1:3000';

    // 1. Unauthenticated request to sensitive endpoints is rejected with 401
    const unauthExport = await fetch(`${baseUrl}/api/export/excel`);
    assert.equal(unauthExport.status, 401, 'Protected report download must require authentication');

    // 2. Fallback static access to Excel report is blocked (403 forbidden to protect data)
    const staticCheck = await fetch(`${baseUrl}/Executive_Report_v3.xlsx`);
    assert.equal(staticCheck.status, 403, 'Static access to private Excel report must be blocked');

    // 3. Fake role header without authenticated token is rejected
    const spoofReq = await fetch(`${baseUrl}/api/allocation/schedule/day-save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-role': 'supervisor'
      },
      body: JSON.stringify({ account: 'TEST', day: 'monday', start: '10:00' })
    });
    assert.equal(spoofReq.status, 401, 'Role header spoofing without token MUST be rejected');
  });

});
