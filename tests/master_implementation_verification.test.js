import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import { getCairoBusinessDate } from '../services/time_utils.js';
import {
  evaluateStalePendingOrder,
  evaluateMerchantCodeConsistency,
  evaluatePrintedWarehouseConsistency,
  enrichOrderOperationalIntelligence,
  getOperationalExceptions
} from '../services/operational_intelligence.js';
import { getOrderTimelineAcrossAllDates } from '../services/tracking.js';
import { getCurrentOrders } from '../services/allocation.js';

test('Master Implementation Verification Suite - Locked Business Rules', async (t) => {
  const TEST_DATE = '2030-06-15';

  function cleanup() {
    db.prepare("DELETE FROM current_work_orders WHERE work_date = ? OR order_code LIKE 'TST_MSTR_%'").run(TEST_DATE);
    db.prepare("DELETE FROM vendoor_orders WHERE order_code LIKE 'TST_MSTR_%'").run();
    db.prepare("DELETE FROM order_products WHERE order_code LIKE 'TST_MSTR_%'").run();
    db.prepare("DELETE FROM order_tracking_events WHERE order_code LIKE 'TST_MSTR_%'").run();
    db.prepare("DELETE FROM raw_log_records WHERE order_code LIKE 'TST_MSTR_%'").run();
    db.prepare("DELETE FROM vendoor_logs WHERE order_code LIKE 'TST_MSTR_%'").run();
  }

  cleanup();

  t.after(() => {
    cleanup();
  });

  await t.test('1. Stale Alert: Flags Pending/Processing order with no action for >= 5 days and clears on 4 days', () => {
    // 4 days old (2030-06-11 vs 2030-06-15) -> NOT stale
    const order4Days = {
      order_code: 'TST_MSTR_STALE_4D',
      status: 'Pending',
      order_date: '2030-06-11',
      created_at_original: '2030-06-11 10:00:00'
    };
    const res4 = evaluateStalePendingOrder(order4Days, TEST_DATE);
    assert.equal(res4.is_stale, false, 'Order with last action 4 days ago must NOT be flagged as stale');
    assert.equal(res4.days_since_action, 4);

    // 5 days old (2030-06-10 vs 2030-06-15) -> STALE
    const order5Days = {
      order_code: 'TST_MSTR_STALE_5D',
      status: 'Pending',
      order_date: '2030-06-10',
      created_at_original: '2030-06-10 10:00:00'
    };
    const res5 = evaluateStalePendingOrder(order5Days, TEST_DATE);
    assert.equal(res5.is_stale, true, 'Order with last action 5 days ago must be flagged as stale');
    assert.equal(res5.days_since_action, 5);
    assert.ok(res5.alert);
    assert.equal(res5.alert.type, 'STALE_PENDING_ORDER');

    // 6 days old Processing order -> STALE
    const order6DaysProc = {
      order_code: 'TST_MSTR_STALE_6D_PROC',
      status: 'Processing',
      order_date: '2030-06-09',
      created_at_original: '2030-06-09 12:00:00'
    };
    const res6 = evaluateStalePendingOrder(order6DaysProc, TEST_DATE);
    assert.equal(res6.is_stale, true);
    assert.equal(res6.days_since_action, 6);

    // Printed / Cancelled status -> NOT active stale alert
    const orderPrintedOld = {
      order_code: 'TST_MSTR_STALE_PRINTED',
      status: 'Printed',
      order_date: '2030-06-01',
      created_at_original: '2030-06-01 10:00:00'
    };
    const resPrinted = evaluateStalePendingOrder(orderPrintedOld, TEST_DATE);
    assert.equal(resPrinted.is_stale, false, 'Printed orders must not be in active stale alert pool');
  });

  await t.test('2. Stale Alert: Resets timer immediately when a new action is logged on the order', () => {
    const code = 'TST_MSTR_STALE_RESET';
    // Insert order created 10 days ago
    db.prepare(`
      INSERT INTO vendoor_orders (order_code, status, business_date, source_date, created_at_original, is_active)
      VALUES (?, 'Pending', ?, '2030-06-05', '2030-06-05 08:00:00', 1)
    `).run(code, TEST_DATE);

    // Check before new action
    const orderObj = db.prepare('SELECT * FROM vendoor_orders WHERE order_code = ?').get(code);
    const beforeAction = evaluateStalePendingOrder(orderObj, TEST_DATE);
    assert.equal(beforeAction.is_stale, true, 'Before action, order must be stale (10 days old)');

    // Log a new customer service action 1 day ago (2030-06-14)
    db.prepare(`
      INSERT INTO order_tracking_events (tracking_id, order_code, work_date, stage, action, timestamp)
      VALUES (?, ?, ?, 'Pending', 'Customer Contacted', '2030-06-14 11:30:00')
    `).run('TRK_RESET_1', code, '2030-06-14');

    const afterAction = evaluateStalePendingOrder(orderObj, TEST_DATE);
    assert.equal(afterAction.is_stale, false, 'After new action, timer resets and order is NO LONGER stale');
    assert.equal(afterAction.days_since_action, 1);
  });

  await t.test('3. Multi-Product Integrity: Multiple distinct items with different merchant and warehouse codes', () => {
    const code = 'TST_MSTR_MULTI_PROD';
    db.prepare(`
      INSERT INTO vendoor_orders (order_code, status, business_date, is_active)
      VALUES (?, 'Printed', ?, 1)
    `).run(code, TEST_DATE);

    // Insert 2 line items: item 1 from Merchant A (Warehouse 77), item 2 from Merchant B (Warehouse 23)
    db.prepare(`
      INSERT INTO order_products (order_code, order_id, product_name, product_sku, merchant_code, merchant_name, warehouse, quantity, unit_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(code, code, 'Product Alpha (مخزن 77)', 'SKU-A', 'M-001', 'Merchant A', 'مخزن 77', 1, 150);

    db.prepare(`
      INSERT INTO order_products (order_code, order_id, product_name, product_sku, merchant_code, merchant_name, warehouse, quantity, unit_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(code, code, 'Product Beta (مخزن 23)', 'SKU-B', 'M-002', 'Merchant B', 'مخزن 23', 2, 200);

    const prods = db.prepare('SELECT * FROM order_products WHERE order_code = ? ORDER BY id ASC').all(code);
    assert.equal(prods.length, 2, 'Must preserve both line items without dropping continuation row');

    // Test merchant code consistency
    const merchEval = evaluateMerchantCodeConsistency(prods, true, code);
    assert.equal(merchEval.has_mismatch, true, 'Must detect mismatch when distinct merchant codes exist across items');
    assert.equal(merchEval.merchant_codes.length, 2);

    // Test printed warehouse consistency
    const whEval = evaluatePrintedWarehouseConsistency(prods, true, code);
    assert.equal(whEval.has_mismatch, true, 'Must detect mismatch when distinct warehouses exist on printed order');
    assert.equal(whEval.warehouses.length, 2);
  });

  await t.test('4. Universal Multi-Date Timeline: Collects events across tracking, vendoor_logs, and raw_logs', () => {
    const code = 'TST_MSTR_TIMELINE_ALL';

    // Day 1: Created in raw_log_records
    db.prepare(`
      INSERT INTO raw_log_records (work_date, order_code, employee_name, action, event_datetime, is_cs)
      VALUES ('2030-06-01', ?, 'System', 'Order Received', '2030-06-01 10:00:00', 0)
    `).run(code);

    // Day 3: Action in vendoor_logs
    db.prepare(`
      INSERT INTO vendoor_logs (work_date, order_code, employee_name, action, timestamp_str)
      VALUES ('2030-06-03', ?, 'Ahmed CS', 'Customer Called', '2030-06-03 14:15:00')
    `).run(code);

    // Day 5: Event in order_tracking_events
    db.prepare(`
      INSERT INTO order_tracking_events (work_date, order_code, tracking_id, stage, action, timestamp, employee_name)
      VALUES ('2030-06-05', ?, 'TRK_TL_1', 'Printed', 'Order Printed', '2030-06-05 16:45:00', 'Sara CS')
    `).run(code);

    const timeline = getOrderTimelineAcrossAllDates(code);
    assert.equal(timeline.length, 3, 'Must capture events from all 3 sources across all dates');
    assert.equal(timeline[0].event_timestamp, '2030-06-01 10:00:00');
    assert.equal(timeline[1].event_timestamp, '2030-06-03 14:15:00');
    assert.equal(timeline[2].event_timestamp, '2030-06-05 16:45:00');
  });

  await t.test('5. Server-Side Pagination: Verifies supported page sizes [50, 100, 150, 200, 250, 300]', () => {
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM vendoor_orders WHERE business_date = ? OR source_date = ?').run(TEST_DATE, TEST_DATE);

    // Insert 650 orders for TEST_DATE
    const insertStmt = db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
      VALUES (?, ?, 'Acc_Test', 'New', 'NEW', 'NEW')
    `);
    const tx = db.transaction(() => {
      for (let i = 1; i <= 650; i++) {
        insertStmt.run(TEST_DATE, `TST_MSTR_PAG_${String(i).padStart(4, '0')}`);
      }
    });
    tx();

    const expectedPages = [
      { size: 50, pages: 13 },
      { size: 100, pages: 7 },
      { size: 150, pages: 5 },
      { size: 200, pages: 4 },
      { size: 250, pages: 3 },
      { size: 300, pages: 3 }
    ];

    for (const ep of expectedPages) {
      const res = getCurrentOrders(TEST_DATE, { limit: ep.size, offset: 0 });
      assert.equal(res.total_count, 650, `Total count must be 650 for page size ${ep.size}`);
      assert.equal(res.total_pages, ep.pages, `Page size ${ep.size} must yield ${ep.pages} pages`);
      assert.equal(res.orders.length, Math.min(650, ep.size), `Page 0 must have exactly ${Math.min(650, ep.size)} items`);
    }
  });
});
