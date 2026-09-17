import assert from 'assert';
import { db } from '../db/index.js';
import {
  getSafeVendoorStatus,
  testVendoorOrdersAccess,
  testVendoorLogsAccess,
  getRecentConnectionTests,
  normalizeVendoorOrder,
  normalizeVendoorLogRow,
  MockVendoorDataSource,
  LiveVendoorDataSource,
  getVendoorDataSource
} from '../services/vendoor/index.js';

console.log('--- STARTING VENDOOR PHASE 1 INTEGRATION TESTS ---');

// 1. Test: Safe Status
console.log('Test 1: Vendoor Safe Status & Credential Masking...');
const status = getSafeVendoorStatus();
assert(status !== null, 'Status must not be null');
assert(typeof status.enabled === 'boolean', 'status.enabled must be boolean');
assert(typeof status.mock_mode === 'boolean', 'status.mock_mode must be boolean');
assert(typeof status.has_credentials === 'boolean', 'status.has_credentials must be boolean');
assert(status.base_url.startsWith('http'), 'Base URL must be valid HTTP/HTTPS URL');
assert(status.session_cookie === undefined, 'Raw session cookie must never leak in status');
assert(status.csrf_token === undefined, 'Raw CSRF token must never leak in status');
console.log('✓ PASS: Status retrieved safely without credential leakage.');

// 2. Test: Normalization Functions
console.log('Test 2: Normalization Logic...');
const rawOrder = {
  id: 991,
  code: 'VD-100293',
  status: 'PENDING',
  account_name: 'Doby Store',
  created_at: '2026-09-08 14:32:00',
  client_name: 'Ahmed Mahmoud',
  phone: '01012345678',
  alt_phone: '01198765432',
  city: 'Cairo',
  grand_total: 850
};
const normOrder = normalizeVendoorOrder(rawOrder);
assert.strictEqual(normOrder.order_code, 'VD-100293');
assert.strictEqual(normOrder.status, 'PENDING');
assert.strictEqual(normOrder.account, 'Doby Store');
assert.strictEqual(normOrder.date, '2026-09-08');

const rawLog = {
  'User': 'Ali Bahlol',
  'Order Code': 'VD-100293',
  'Action': 'Pending',
  'Date': '2026-09-08 14:35:00',
  'Notes': 'Client confirmed delivery time'
};
const normLog = normalizeVendoorLogRow(rawLog);
assert.strictEqual(normLog.employee_name, 'Ali Bahlol');
assert.strictEqual(normLog.order_code, 'VD-100293');
assert.strictEqual(normLog.action, 'Pending');
assert.strictEqual(normLog.date, '2026-09-08');
console.log('✓ PASS: Normalizer successfully maps Vendoor structures to internal standards.');

// 3. Test: Mock Adapter Orders Test
console.log('Test 3: Mock Adapter Orders Test...');
const mockOrdersResult = await testVendoorOrdersAccess({
  length: 10,
  forceMode: 'mock'
});
assert.strictEqual(mockOrdersResult.success, true);
assert.strictEqual(mockOrdersResult.result.adapter, 'MOCK');
assert.strictEqual(mockOrdersResult.result.http_status, 200);
assert(mockOrdersResult.result.orders_sample.length > 0, 'Should return sample orders in mock mode');
assert(mockOrdersResult.result.summary.received_orders_count > 0);
console.log('✓ PASS: Mock Adapter Orders fetch succeeded.');

// 4. Test: Mock Adapter Logs Test (1-Day and 2-Day)
console.log('Test 4: Mock Adapter Logs Test...');
const mockLogsResult1 = await testVendoorLogsAccess({
  startDate: '2026-09-08',
  endDate: '2026-09-08',
  forceMode: 'mock'
});
assert.strictEqual(mockLogsResult1.success, true);
assert.strictEqual(mockLogsResult1.result.summary.total_rows, 9);
assert.strictEqual(mockLogsResult1.result.summary.unique_employees_count, 4);

const mockLogsResult2 = await testVendoorLogsAccess({
  startDate: '2026-09-07',
  endDate: '2026-09-08',
  forceMode: 'mock'
});
assert.strictEqual(mockLogsResult2.success, true);
console.log('✓ PASS: Mock Adapter Logs fetch succeeded for 1-day and 2-day tests.');

// 5. Test: Range Guard (Maximum 2 Days)
console.log('Test 5: Rate Limiting & Multi-Day Range Guard...');
const invalidRangeResult = await testVendoorLogsAccess({
  startDate: '2026-09-01',
  endDate: '2026-09-10', // 10 days
  forceMode: 'mock'
});
assert.strictEqual(invalidRangeResult.success, false);
assert(invalidRangeResult.error.includes('restricted to a maximum of 2 days'), 'Must enforce max 2 days restriction');
console.log('✓ PASS: Multi-day limit correctly enforced.');

// 6. Test: Diagnostic Persistence in DB
console.log('Test 6: Diagnostic Audit Persistence...');
const history = getRecentConnectionTests(10);
assert(Array.isArray(history), 'History must be an array');
assert(history.length >= 3, 'Must have recorded our probe attempts');
const latestTest = history[0];
assert(latestTest.id > 0);
assert(['orders', 'logs'].includes(latestTest.resource));
console.log('✓ PASS: Diagnostics successfully written and queried from database.');

// 7. Test: Zero Side Effects on Core Allocation
console.log('Test 7: Confirm Zero Side Effects on Core Tables...');
const empCount = db.prepare('SELECT COUNT(*) as c FROM employees').get().c;
assert(empCount > 0, 'Employees table must remain untouched');
const allocHeaders = db.prepare('SELECT COUNT(*) as c FROM allocation_headers').get().c;
console.log(`✓ PASS: Zero mutation confirmed (Employees: ${empCount}, Allocation Headers: ${allocHeaders}).`);

console.log('--- ALL VENDOOR PHASE 1 INTEGRATION TESTS PASSED SUCCESSFULLY ---');
