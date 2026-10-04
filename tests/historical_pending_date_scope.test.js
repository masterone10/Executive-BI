import assert from 'node:assert';
import { describe, it } from 'node:test';
import { db } from '../db/index.js';
import {
  getHistoricalOrdersForDate,
  getHistoricalPendingOrders,
  getCurrentLivePendingOrders,
  getHistoricalDateRegistryStatus,
  loadOrSyncHistoricalDate
} from '../services/historical_dates.js';
import { computePerformanceFromRecords } from '../services/performance.js';
import { getCairoBusinessDate } from '../services/time_utils.js';

describe('Historical Pending Date Scope Verification Suite', () => {

  it('1. Historical Pending Orders must be strictly date-scoped to selected date D', () => {
    const p1001 = getHistoricalPendingOrders('2026-10-01');
    assert(Array.isArray(p1001), 'Pending orders for 2026-10-01 must be an array');
    assert.ok(p1001.length > 0, '2026-10-01 must return historical pending orders');

    for (const order of p1001) {
      const st = String(order.status || '').toLowerCase();
      assert(st.includes('pending') || st.includes('معلق'), `Order ${order.order_code} must have pending status`);
      if (order.order_date) {
        assert.strictEqual(order.order_date, '2026-10-01', `Order ${order.order_code} date must be 2026-10-01`);
      }
    }
  });

  it('2. Different historical dates must return their own distinct pending sets without crosstalk', () => {
    const p0927 = getHistoricalPendingOrders('2026-09-27');
    const p1001 = getHistoricalPendingOrders('2026-10-01');

    assert.ok(p0927.length > 0, '2026-09-27 must have pending orders');
    assert.ok(p1001.length > 0, '2026-10-01 must have pending orders');

    const set0927 = new Set(p0927.map(o => o.order_code));
    const set1001 = new Set(p1001.map(o => o.order_code));

    // Ensure zero overlap between distinct historical dates
    const overlap0927_1001 = [...set0927].filter(c => set1001.has(c));
    assert.strictEqual(overlap0927_1001.length, 0, 'Zero overlap between 2026-09-27 and 2026-10-01 pending orders');
  });

  it('3. Current Live Pending Queue is separate and does not contaminate historical dates', () => {
    const live = getCurrentLivePendingOrders();
    assert.ok(live.length > 0, 'Live pending queue must contain active pool');

    // Selecting historical date 2026-09-27 must NOT return the live pending orders
    const p0927 = getHistoricalPendingOrders('2026-09-27');
    assert.ok(p0927.length > 0, 'Historical date 2026-09-27 returns its historical pending orders');
    assert.notStrictEqual(p0927.length, live.length, 'Historical pending must not equal live pending queue size');
  });

  it('4. Real order belonging to Date A that is still Pending today is isolated to Date A & Live, never Date B', () => {
    // Ensure test order 2206889 is present with source_date 2026-10-01 and active today
    const todayStr = getCairoBusinessDate();
    db.prepare(`
      INSERT OR REPLACE INTO current_work_orders (id, work_date, order_code, account, status, order_date, source_file_slot)
      VALUES (870, ?, '2206889', 'ARC SHOES', 'Pending', '2026-10-01', 2)
    `).run(todayStr);
    db.prepare(`
      INSERT OR REPLACE INTO vendoor_orders (id, order_code, status, account, source_date, business_date, is_active)
      VALUES (870, '2206889', 'Pending', 'ARC SHOES', '2026-10-01', ?, 1)
    `).run(todayStr);

    const p1001 = getHistoricalPendingOrders('2026-10-01');
    const p0927 = getHistoricalPendingOrders('2026-09-27');
    const live = getCurrentLivePendingOrders();

    const in1001 = p1001.some(o => o.order_code === '2206889');
    const in0927 = p0927.some(o => o.order_code === '2206889');
    const inLive = live.some(o => o.order_code === '2206889');

    assert.strictEqual(in1001, true, 'Order 2206889 must appear when 2026-10-01 is selected');
    assert.strictEqual(in0927, false, 'Order 2206889 must NOT appear when 2026-09-27 is selected');
    assert.strictEqual(inLive, true, 'Order 2206889 appears in Live Pending because it is currently pending today');
  });

  it('5. Undated orders are NEVER assigned to a selected historical date', () => {
    const testId = 99999999;
    db.prepare(`
      INSERT OR REPLACE INTO vendoor_orders (id, order_code, status, account, business_date, source_date, is_active)
      VALUES (?, 'TEST_UNDATED_PENDING', 'Pending', 'TestAcc', NULL, NULL, 1)
    `).run(testId);

    try {
      const p1001 = getHistoricalPendingOrders('2026-10-01');
      const found = p1001.some(o => o.order_code === 'TEST_UNDATED_PENDING');
      assert.strictEqual(found, false, 'Undated pending order must NEVER appear in 2026-10-01 historical pending');

      const p0927 = getHistoricalPendingOrders('2026-09-27');
      const found0927 = p0927.some(o => o.order_code === 'TEST_UNDATED_PENDING');
      assert.strictEqual(found0927, false, 'Undated pending order must NEVER appear in 2026-09-27 historical pending');
    } finally {
      db.prepare('DELETE FROM vendoor_orders WHERE id = ?').run(testId);
    }
  });

  it('6. Canonical KPI Parity & CS Performance Isolation are preserved', () => {
    const rawRecords = db.prepare('SELECT * FROM raw_log_records WHERE work_date = ?').all('2026-10-01');
    const perf = computePerformanceFromRecords(rawRecords, '2026-10-01');

    // Canonical CS-only metrics in perf.summary
    assert.strictEqual(perf.summary.totalRealActions, 2153, 'CS total real actions must be 2153 (non-CS excluded)');
    assert.strictEqual(perf.summary.printedActions, 1212, 'CS printed actions must be 1212');
    assert.strictEqual(perf.summary.pendingActions, 605, 'CS pending actions must be 605');
    assert.strictEqual(perf.summary.processingActions, 57, 'CS processing actions must be 57');
    assert.strictEqual(perf.summary.cancelledActions, 279, 'CS cancelled actions must be 279');
    assert.strictEqual(perf.summary.totalAltPhones, 367, 'CS alt phones must be 367');
    assert.strictEqual(perf.summary.totalNewOrders, 1739, 'New orders must be 1739');
    assert.strictEqual(perf.summary.rawStatusCount, 6458, 'CS raw status count must be 6458');
    assert.strictEqual(perf.dedup?.removed, 4305, 'Dedup removed must be 4305');
  });

});
