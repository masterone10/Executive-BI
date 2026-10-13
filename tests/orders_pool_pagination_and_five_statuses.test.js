import { test } from 'node:test';
import assert from 'node:assert';
import { db } from '../db/index.js';
import { getCurrentOrders } from '../services/allocation.js';
import { getHistoricalOrdersList, getHistoricalOrdersForDate } from '../services/historical_dates.js';

test('ORDERS POOL PAGINATION & 5 STATUSES VERIFICATION SUITE', async (t) => {
  const testDate = '2026-04-15';

  // Clean test tables for this date
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(testDate);
  db.prepare('DELETE FROM vendoor_orders WHERE source_date = ? OR business_date = ?').run(testDate, testDate);
  db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(testDate);

  await t.test('1. Populate 650 orders across all 5 statuses (New, Pending, Processing, Printed, Cancelled)', () => {
    // 200 New, 150 Pending in current_work_orders
    const insertCWO = db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, source_file_slot, work_state)
      VALUES (?, ?, ?, ?, 1, 'ASSIGNED')
    `);
    for (let i = 1; i <= 200; i++) {
      insertCWO.run(testDate, `TEST-PAG-NEW-${i}`, 'Alpha Merchant', 'New');
    }
    for (let i = 1; i <= 150; i++) {
      insertCWO.run(testDate, `TEST-PAG-PEN-${i}`, 'Beta Logistics', 'Pending');
    }

    // 100 Processing, 120 Printed in vendoor_orders
    const insertVO = db.prepare(`
      INSERT OR REPLACE INTO vendoor_orders (order_code, account, status, active_status, source_date, business_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (let i = 1; i <= 100; i++) {
      insertVO.run(`TEST-PAG-PRO-${i}`, 'Gamma Goods', 'Processing', 'Processing', testDate, testDate);
    }
    for (let i = 1; i <= 120; i++) {
      insertVO.run(`TEST-PAG-PRI-${i}`, 'Delta Retail', 'Printed', 'Printed', testDate, testDate);
    }

    // 80 Cancelled in raw_log_records
    const insertLog = db.prepare(`
      INSERT INTO raw_log_records (work_date, order_code, employee_name, action, status, is_cs)
      VALUES (?, ?, ?, ?, ?, 1)
    `);
    for (let i = 1; i <= 80; i++) {
      insertLog.run(testDate, `TEST-PAG-CAN-${i}`, 'Sara CS', 'إلغاء أوردر', 'Cancelled');
    }

    // Total: 200 + 150 + 100 + 120 + 80 = 650 orders!
    const all = getHistoricalOrdersForDate(testDate);
    assert.strictEqual(all.length, 650, 'Exactly 650 total orders resolved across all 5 statuses');
  });

  await t.test('2. Query all 5 statuses individually and verify complete accurate counts', () => {
    const newRes = getCurrentOrders(testDate, { status: 'New', limit: 300 });
    assert.strictEqual(newRes.total_count, 200, 'All 200 New orders found');
    assert.strictEqual(newRes.orders.length, 200, 'Page size 300 returns all 200');

    const penRes = getCurrentOrders(testDate, { status: 'Pending', limit: 300 });
    assert.strictEqual(penRes.total_count, 150, 'All 150 Pending orders found');
    assert.strictEqual(penRes.orders.length, 150, 'Page size 300 returns all 150');

    const proRes = getCurrentOrders(testDate, { status: 'Processing', limit: 300 });
    assert.strictEqual(proRes.total_count, 100, 'All 100 Processing orders found');
    assert.strictEqual(proRes.orders.length, 100, 'Page size 300 returns all 100');

    const priRes = getCurrentOrders(testDate, { status: 'Printed', limit: 300 });
    assert.strictEqual(priRes.total_count, 120, 'All 120 Printed orders found');
    assert.strictEqual(priRes.orders.length, 120, 'Page size 300 returns all 120');

    const canRes = getCurrentOrders(testDate, { status: 'Cancelled', limit: 300 });
    assert.strictEqual(canRes.total_count, 80, 'All 80 Cancelled orders found');
    assert.strictEqual(canRes.orders.length, 80, 'Page size 300 returns all 80');
  });

  await t.test('3. Test page size 50 across 650 total orders -> 13 pages exactly', () => {
    // Page 0 (1st page)
    const p0 = getCurrentOrders(testDate, { limit: 50, offset: 0 });
    assert.strictEqual(p0.total_count, 650, 'Total count is 650');
    assert.strictEqual(p0.total_pages, 13, 'Total pages is 13 for page size 50');
    assert.strictEqual(p0.page, 0, 'Current page is 0');
    assert.strictEqual(p0.page_size, 50, 'Page size is 50');
    assert.strictEqual(p0.orders.length, 50, 'First page has 50 items');

    // Page 12 (13th / last page)
    const p12 = getCurrentOrders(testDate, { limit: 50, offset: 12 * 50 });
    assert.strictEqual(p12.total_count, 650, 'Total count remains 650 on last page');
    assert.strictEqual(p12.page, 12, 'Current page is 12');
    assert.strictEqual(p12.orders.length, 50, '13th page has remaining 50 items');
  });

  await t.test('4. Test page size 300 across 650 total orders -> 3 pages (300, 300, 50)', () => {
    const p0 = getCurrentOrders(testDate, { limit: 300, offset: 0 });
    assert.strictEqual(p0.total_count, 650, 'Total count is 650');
    assert.strictEqual(p0.total_pages, 3, 'Total pages is 3 for page size 300');
    assert.strictEqual(p0.orders.length, 300, 'Page 1 has 300 items');

    const p1 = getCurrentOrders(testDate, { limit: 300, offset: 300 });
    assert.strictEqual(p1.orders.length, 300, 'Page 2 has 300 items');

    const p2 = getCurrentOrders(testDate, { limit: 300, offset: 600 });
    assert.strictEqual(p2.orders.length, 50, 'Page 3 has remaining 50 items');
  });

  await t.test('5. Verify supported page sizes [50, 100, 150, 200, 250, 300]', () => {
    const allowedSizes = [50, 100, 150, 200, 250, 300];
    for (const sz of allowedSizes) {
      const res = getCurrentOrders(testDate, { limit: sz, offset: 0 });
      assert.strictEqual(res.page_size, sz, `Page size ${sz} correctly configured`);
      assert.strictEqual(res.orders.length, sz, `Returns ${sz} items for page size ${sz}`);
      assert.strictEqual(res.total_pages, Math.ceil(650 / sz), `Total pages correctly calculated for ${sz}`);
    }
  });

  // Clean up
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(testDate);
  db.prepare('DELETE FROM vendoor_orders WHERE source_date = ? OR business_date = ?').run(testDate, testDate);
  db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(testDate);
});
