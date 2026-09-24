import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import {
  parseTimestamp,
  parseDate,
  normalizeDateToISO,
  getOperationalBusinessDate,
  isCsEmployee,
  isOperationallyActiveCsEmployee,
  isValidCalendarDate
} from '../services/parser.js';
import {
  assertActiveCsEmployee,
  getEmployeeLiveRealtime,
  getEmployeeTracking,
  claimOrder,
  startOrderProgress,
  completeOrder,
  cancelOrder,
  recordInternalHandoff
} from '../services/tracking.js';

test('Part 20.1: Date-only must never be misread as timezone offset', () => {
  const r1 = parseTimestamp('2026-09-24');
  assert.ok(r1 !== null, 'parseTimestamp(2026-09-24) should succeed');
  assert.strictEqual(r1.has_time, false, 'has_time should be false for date-only');
  assert.strictEqual(r1.has_explicit_offset, false, 'has_explicit_offset should be false for date-only');
  assert.strictEqual(r1.cairo_date, '2026-09-24', 'cairo_date should be 2026-09-24');

  const rInvalid = parseTimestamp('2026-09-24-24');
  assert.strictEqual(rInvalid, null, '2026-09-24-24 should be rejected as invalid');

  const rZ = parseTimestamp('2026-09-24T22:30:00Z');
  assert.ok(rZ !== null);
  assert.strictEqual(rZ.has_time, true);
  assert.strictEqual(rZ.has_explicit_offset, true);

  const rOffset = parseTimestamp('2026-09-24 22:30:00+03:00');
  assert.ok(rOffset !== null);
  assert.strictEqual(rOffset.has_time, true);
  assert.strictEqual(rOffset.has_explicit_offset, true);
});

test('Part 20.2: Strict calendar date validation rejects invalid calendar dates', () => {
  const invalidDates = [
    '2026-02-31',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-09-31',
    '2026-02-30 10:00:00',
    '2026-02-29' // 2026 is not a leap year
  ];

  for (const d of invalidDates) {
    const ts = parseTimestamp(d);
    assert.strictEqual(ts, null, `Expected parseTimestamp(${d}) to be null`);

    const iso = normalizeDateToISO(d);
    assert.strictEqual(iso, null, `Expected normalizeDateToISO(${d}) to be null`);
  }

  // Valid leap year check
  const leapValid = parseTimestamp('2024-02-29 12:00:00');
  assert.ok(leapValid !== null, '2024-02-29 is valid leap year');
  assert.strictEqual(leapValid.cairo_date, '2024-02-29');

  // Excel serial 60 (fictional 1900-02-29 in Lotus 1-2-3 bug)
  const serial60 = parseTimestamp(60);
  assert.strictEqual(serial60, null, 'Excel serial 60 should be rejected as invalid calendar date');
});

test('Part 20.3: Ambiguous strings are rejected deterministically (no arbitrary Date.parse fallback)', () => {
  const ambiguous = [
    'next monday at noon',
    'random text string',
    'invalid-2026-date',
    '2026-99-99 88:88:88'
  ];

  for (const s of ambiguous) {
    const res = parseTimestamp(s);
    assert.strictEqual(res, null, `Expected parseTimestamp("${s}") to return null`);
  }
});

test('Part 20.4: employee_id is authoritative when supplied and never falls back to name matching', () => {
  // Ensure we have a known CS employee in database
  const csEmp = db.prepare("SELECT id, name, department, active FROM employees WHERE department = 'CS' LIMIT 1").get();
  assert.ok(csEmp, 'A CS employee should exist in test DB');

  // Case 1: Existing CS employee with correct ID
  const validCheck = isCsEmployee({ employee_id: csEmp.id, name: csEmp.name });
  assert.strictEqual(validCheck, true);

  // Case 2: Non-existent employee_id with an existing CS name
  // Must NOT fall back to resolving csEmp by name!
  const fakeIdWithCsName = isCsEmployee({ employee_id: 9999999, name: csEmp.name });
  assert.strictEqual(fakeIdWithCsName, false, 'Non-existent employee_id MUST NOT fall back to matching by name');

  // Case 3: Inactive or non-CS employee with CS name attached
  const nonCsEmp = db.prepare("SELECT id, name, department FROM employees WHERE department != 'CS' LIMIT 1").get();
  if (nonCsEmp) {
    const wrongDeptCheck = isCsEmployee({ employee_id: nonCsEmp.id, name: csEmp.name });
    assert.strictEqual(wrongDeptCheck, false, 'Non-CS employee_id MUST NOT be resolved as CS even if name is CS');
  }

  // Case 4: No employee_id supplied: resolves by name
  const nameOnlyCheck = isCsEmployee({ name: csEmp.name });
  assert.strictEqual(nameOnlyCheck, true);
});

test('Part 20.5 & 20.6: Separate CS Identity from Operational Eligibility (Active Check)', () => {
  // Insert or update a test employee who is CS but INACTIVE
  db.prepare(`
    INSERT OR REPLACE INTO employees (id, name, department, team_membership, active, status)
    VALUES (88881, 'Inactive CS Tester', 'CS', 'General CS', 0, 'INACTIVE')
  `).run();

  // Test CS identity: should be true because department is CS
  const identityCheck = isCsEmployee(88881);
  assert.strictEqual(identityCheck, true, 'isCsEmployee should reflect CS department identity');

  // Test Operational CS check: should be false because active = 0
  const operationalCheck = isOperationallyActiveCsEmployee(88881);
  assert.strictEqual(operationalCheck, false, 'isOperationallyActiveCsEmployee should be false for inactive CS employee');

  // Operational assertion should throw
  assert.throws(() => {
    assertActiveCsEmployee(88881);
  }, /not active/i);

  // Clean up
  db.prepare('DELETE FROM employees WHERE id = 88881').run();
});

test('Part 20.7: Cutoff output preserves seconds in getOperationalBusinessDate', () => {
  const res1 = getOperationalBusinessDate('2026-09-23 19:59:59', { cutoff: '20:00:00' });
  assert.ok(res1 !== null);
  assert.strictEqual(res1.configured_cutoff, '20:00:00', 'configured_cutoff must preserve seconds');
  assert.strictEqual(res1.business_date, '2026-09-23');
  assert.strictEqual(res1.is_rolled_over, false);

  const res2 = getOperationalBusinessDate('2026-09-23 20:00:00', { cutoff: '20:00:00' });
  assert.strictEqual(res2.configured_cutoff, '20:00:00');
  assert.strictEqual(res2.business_date, '2026-09-24');
  assert.strictEqual(res2.is_rolled_over, true);

  const resFallback = getOperationalBusinessDate('2026-09-23', { cutoff: '20:00:00' });
  assert.strictEqual(resFallback.configured_cutoff, '20:00:00');
});
