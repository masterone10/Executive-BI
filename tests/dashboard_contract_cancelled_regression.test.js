import assert from 'assert';
import { getOperationalDashboardData } from '../services/tracking.js';
import { db } from '../db/index.js';

console.log('--- Testing Dashboard Contract & Cancelled Regression ---');

// 1. Test empty date
const emptyData = getOperationalDashboardData('1999-01-01');
assert.ok(emptyData, 'Empty date should return dashboard data object');
assert.strictEqual(emptyData.date, '1999-01-01');
assert.ok(emptyData.log_totals, 'log_totals must exist on empty date');
assert.strictEqual(typeof emptyData.log_totals.cancelled, 'number', 'log_totals.cancelled must be a number');
assert.strictEqual(typeof emptyData.log_totals.actions, 'number', 'log_totals.actions must be a number');
assert.strictEqual(typeof emptyData.log_totals.printed, 'number', 'log_totals.printed must be a number');
assert.strictEqual(typeof emptyData.log_totals.pending, 'number', 'log_totals.pending must be a number');

assert.ok(emptyData.status_totals, 'status_totals must exist on empty date');
assert.strictEqual(typeof emptyData.status_totals.Cancelled, 'number', 'status_totals.Cancelled must be a number');

assert.ok(emptyData.rankings, 'rankings must exist on empty date');
assert.ok(Array.isArray(emptyData.rankings.cancelled), 'rankings.cancelled must be an array');
assert.ok(Array.isArray(emptyData.rankings.printed), 'rankings.printed must be an array');
assert.ok(Array.isArray(emptyData.rankings.pending), 'rankings.pending must be an array');
assert.ok(Array.isArray(emptyData.cancel_rate_rank), 'cancel_rate_rank must be an array');

console.log('✓ Test 1: Empty date dashboard contract passed.');

// 2. Test partial snapshot from daily_metrics_snapshots
const partialDate = '2099-12-31';
db.prepare('INSERT OR REPLACE INTO daily_metrics_snapshots (work_date, metrics_json) VALUES (?, ?)').run(
  partialDate,
  JSON.stringify({
    summary: { totalOrders: 100 },
    employees: [
      { name: 'Test Agent 1 CS', actions: 50, printed: 30, pending: 10, cancelled: 5, own_cancel_rate: 10 },
      { name: 'Test Agent 2 CS', actions: 50, printed: 20, pending: 20, cancelled: 10, own_cancel_rate: 20 }
    ]
  })
);

const partialData = getOperationalDashboardData(partialDate);
assert.ok(partialData, 'Partial date should return dashboard data object');
assert.strictEqual(partialData.date, partialDate);
assert.ok(partialData.log_totals, 'log_totals must exist for partial snapshot date');
assert.strictEqual(partialData.log_totals.cancelled, 15, 'log_totals.cancelled must be aggregated correctly');
assert.strictEqual(partialData.log_totals.actions, 100, 'log_totals.actions must be aggregated correctly');
assert.strictEqual(partialData.log_totals.printed, 50, 'log_totals.printed must be aggregated correctly');
assert.strictEqual(partialData.log_totals.pending, 30, 'log_totals.pending must be aggregated correctly');

assert.ok(partialData.rankings, 'rankings must exist for partial snapshot date');
assert.ok(Array.isArray(partialData.rankings.cancelled), 'rankings.cancelled must be an array');
assert.strictEqual(partialData.rankings.cancelled.length, 2, 'rankings.cancelled must contain ranked employees');
assert.strictEqual(partialData.rankings.cancelled[0].name, 'Test Agent 2 CS', 'Highest cancelled employee should rank first');

assert.ok(Array.isArray(partialData.cancel_rate_rank), 'cancel_rate_rank must be an array');
assert.strictEqual(partialData.cancel_rate_rank[0].name, 'Test Agent 2 CS');

// Clean up
db.prepare('DELETE FROM daily_metrics_snapshots WHERE work_date = ?').run(partialDate);

console.log('✓ Test 2: Partial snapshot normalization passed.');

// 3. Test baseline date (2026-09-08)
const baseData = getOperationalDashboardData('2026-09-08');
assert.ok(baseData, 'Base date should return dashboard data');
assert.ok(baseData.log_totals, 'baseData.log_totals must exist');
assert.strictEqual(typeof baseData.log_totals.cancelled, 'number');
assert.ok(baseData.rankings, 'baseData.rankings must exist');
assert.ok(Array.isArray(baseData.rankings.cancelled), 'baseData.rankings.cancelled must be an array');
console.log('✓ Test 3: Baseline date 2026-09-08 contract verified.');

console.log('ALL DASHBOARD CONTRACT & CANCELLED REGRESSION TESTS PASSED!');
