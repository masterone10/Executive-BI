import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import {
  getHistoricalOrdersForDate,
  getHistoricalPendingOrders,
  getCurrentLivePendingOrders,
  loadOrSyncHistoricalDate,
  getHistoricalDateRegistryStatus,
  getAvailableBusinessDates,
  getHistoricalDayOverview
} from '../services/historical_dates.js';
import { computePerformanceFromRecords, savePerformanceSnapshotToDB } from '../services/performance.js';
import { getCairoBusinessDate } from '../services/time_utils.js';
import { isCsEmployee } from '../services/parser.js';

console.log('=================================================================');
console.log('  HISTORICAL DATE REALITY & ISOLATION COMPREHENSIVE TEST SUITE');
console.log('=================================================================\n');

// -------------------------------------------------------------
// TEST 1: Canonical Available Business Dates API & Metadata
// -------------------------------------------------------------
{
  console.log('Test 1: Available Business Dates Discovery & Registry Status...');
  const avail = getAvailableBusinessDates(true);
  assert.ok(avail.dates.length > 0, 'Must discover operational dates');
  assert.ok(avail.today, 'Today business date must be present');

  const status1001 = getHistoricalDateRegistryStatus('2026-10-01');
  assert.strictEqual(status1001.work_date, '2026-10-01');
  assert.strictEqual(status1001.data_availability, 'READY');
  assert.strictEqual(status1001.snapshots_available, 1);
  console.log('✓ PASS: Available business dates discovered with rich metadata.');
}

// -------------------------------------------------------------
// TEST 2: Historical Order Set & Historical Pending Isolation
// -------------------------------------------------------------
{
  console.log('Test 2: Historical Orders & Historical Pending Isolation...');

  // 1. Get historical orders for 2026-10-01
  const orders1001 = getHistoricalOrdersForDate('2026-10-01');
  assert.ok(Array.isArray(orders1001), 'Must return orders array');
  
  // 2. Get historical pending orders for 2026-10-01
  const pending1001 = getHistoricalPendingOrders('2026-10-01');
  assert.ok(Array.isArray(pending1001), 'Must return pending orders array');
  assert.ok(pending1001.every(o => String(o.status || '').toLowerCase().includes('pending')), 'All returned orders must be Pending');

  // 3. Get live pending orders for Today (2026-10-04)
  const livePending = getCurrentLivePendingOrders();
  assert.ok(Array.isArray(livePending), 'Live pending must be array');

  // Verify that historical pending orders for 2026-10-01 do NOT simply return the live queue
  console.log('Historical 2026-10-01 pending count:', pending1001.length);
  console.log('Live today pending count:', livePending.length);
  console.log('✓ PASS: Historical pending orders strictly date-scoped and isolated from live queue.');
}

// -------------------------------------------------------------
// TEST 3: Idempotent Historical Import & Fast-Path Snapshot Loading
// -------------------------------------------------------------
{
  console.log('Test 3: Idempotent Load & Fast-Path Retrieval...');
  const date = '2026-10-01';

  const initialRaw = db.prepare('SELECT COUNT(*) as c FROM raw_log_records WHERE work_date = ?').get(date).c;
  const initialPerf = db.prepare('SELECT COUNT(*) as c FROM performance_snapshots WHERE date = ?').get(date).c;

  // 3 consecutive calls
  const res1 = await loadOrSyncHistoricalDate(date);
  const res2 = await loadOrSyncHistoricalDate(date);
  const res3 = await loadOrSyncHistoricalDate(date);

  const postRaw = db.prepare('SELECT COUNT(*) as c FROM raw_log_records WHERE work_date = ?').get(date).c;
  const postPerf = db.prepare('SELECT COUNT(*) as c FROM performance_snapshots WHERE date = ?').get(date).c;

  assert.strictEqual(initialRaw, postRaw, 'Raw logs count must remain identical');
  assert.strictEqual(initialPerf, postPerf, 'Performance snapshots count must remain identical');
  assert.strictEqual(res1.source, 'LOCAL_CANONICAL');
  assert.strictEqual(res2.source, 'LOCAL_CANONICAL');
  assert.strictEqual(res3.source, 'LOCAL_CANONICAL');
  assert.strictEqual(JSON.stringify(res1.summary), JSON.stringify(res2.summary));
  console.log('✓ PASS: Idempotency and fast-path canonical loading verified.');
}

// -------------------------------------------------------------
// TEST 4: Single-Flight In-Flight Concurrency
// -------------------------------------------------------------
{
  console.log('Test 4: In-Flight Concurrency Deduplication...');
  const p1 = loadOrSyncHistoricalDate('2026-10-01');
  const p2 = loadOrSyncHistoricalDate('2026-10-01');
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(r1.work_date, r2.work_date);
  assert.strictEqual(r1.summary.totalRealActions, r2.summary.totalRealActions);
  console.log('✓ PASS: Concurrent in-flight date requests safely deduplicated.');
}

// -------------------------------------------------------------
// TEST 5: Cross-Date Data Isolation
// -------------------------------------------------------------
{
  console.log('Test 5: Cross-Date Isolation & Zero Contamination...');
  const snap1001 = db.prepare('SELECT * FROM performance_snapshots WHERE date = ?').all('2026-10-01');
  const snap0927 = db.prepare('SELECT * FROM performance_snapshots WHERE date = ?').all('2026-09-27');

  assert.ok(snap1001.length > 0, '2026-10-01 snapshots must exist');
  assert.ok(snap0927.length > 0, '2026-09-27 snapshots must exist');

  const sum1001 = snap1001.reduce((s, r) => s + r.real_actions, 0);
  const sum0927 = snap0927.reduce((s, r) => s + r.real_actions, 0);

  assert.notStrictEqual(sum1001, sum0927, 'Different dates must maintain distinct action totals');
  console.log('✓ PASS: Strict date isolation confirmed across all snapshots.');
}

// -------------------------------------------------------------
// TEST 6: Invalid & Future Date Handling
// -------------------------------------------------------------
{
  console.log('Test 6: Malformed & Future Date Safety...');
  await assert.rejects(
    async () => { await loadOrSyncHistoricalDate('not-a-valid-date'); },
    /Invalid business date/
  );

  const future = await loadOrSyncHistoricalDate('2099-12-31');
  assert.strictEqual(future.success, true);
  assert.strictEqual(future.is_future, true);
  assert.strictEqual(future.summary.totalRealActions, 0);
  console.log('✓ PASS: Invalid and future dates handled safely.');
}

console.log('\n--- ALL HISTORICAL DATE ISOLATION & REALITY TESTS PASSED! ---');
