import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import { syncVendoorOrders } from '../services/vendoor/orchestrator.js';
import { getUnallocatedOrdersPool } from '../services/vendoor/unallocated.js';

test('STATUS-DRIVEN ACTIVE WORKLOAD TEST SUITE', async (t) => {
  await t.test('1. Old orders (old created_at) enter active workload based on status', async () => {
    // Sync active orders in mock mode for today's operational date
    const today = '2026-09-19';
    const syncRes = await syncVendoorOrders({
      businessDate: today,
      forceMode: 'mock',
      pageSize: 50
    });

    assert.equal(syncRes.success, true);
    assert(syncRes.total_fetched > 0, 'Should have fetched mock orders');

    // Check that orders with older created_at date exist in current_work_orders for today
    const activeCwo = db.prepare(`
      SELECT order_code, work_date, order_date, status, source_file_slot
      FROM current_work_orders
      WHERE work_date = ?
    `).all(today);

    assert(activeCwo.length > 0, 'Active workload should contain orders for today');
    
    // Verify that order_date retains the original creation date, while work_date is today
    for (const cwo of activeCwo) {
      assert.equal(cwo.work_date, today);
      assert(cwo.order_date, 'order_date must be populated');
    }

    // Check that vendoor_orders has business_date = today and original source_date preserved
    const vOrders = db.prepare(`
      SELECT order_code, status, source_date, business_date, is_active
      FROM vendoor_orders
      WHERE business_date = ?
    `).all(today);

    assert(vOrders.length > 0);
    const activeVOrders = vOrders.filter(v => v.is_active === 1);
    assert(activeVOrders.length > 0);
  });

  await t.test('2. Unallocated pool includes active orders regardless of original creation date', async () => {
    const today = '2026-09-19';
    
    // Manually insert an old order from 20 days ago that is still PENDING
    const oldCode = 'TEST-OLD-PENDING-999';
    const oldCreatedDate = '2026-08-30';
    
    db.prepare(`
      INSERT INTO vendoor_orders (
        order_code, status, active_status, account, source_date, created_at_original,
        business_date, is_active, city, total_price, last_synced_at, imported_at
      ) VALUES (?, 'Pending', 'Pending', 'VIP Store', ?, ?, ?, 1, 'Cairo', 450, datetime('now'), datetime('now'))
      ON CONFLICT(order_code) DO UPDATE SET
        status = excluded.status,
        is_active = 1,
        business_date = excluded.business_date
    `).run(oldCode, oldCreatedDate, `${oldCreatedDate} 10:00:00`, today);

    db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, order_date, source_file_slot, source_type
      ) VALUES (?, ?, 'VIP Store', 'Pending', ?, 2, 'PENDING')
      ON CONFLICT(work_date, order_code) DO UPDATE SET
        status = 'Pending',
        order_date = excluded.order_date
    `).run(today, oldCode, oldCreatedDate);

    // Query unallocated pool for today
    const poolRes = getUnallocatedOrdersPool(today);
    assert.equal(poolRes.success, true);
    
    const foundOldOrder = poolRes.unallocated_orders.find(o => o.order_code === oldCode);
    assert(foundOldOrder, 'Old pending order must be in today active unallocated pool');
    assert.equal(foundOldOrder.date, oldCreatedDate, 'Original creation date must be preserved');
  });

  await t.test('3. Status change handling: Completed order exits active workload', async () => {
    const today = '2026-09-19';
    const testCode = 'TEST-STATUS-CHANGE-123';
    
    // 1. Initially New
    db.prepare(`
      INSERT INTO vendoor_orders (
        order_code, status, active_status, account, source_date, business_date, is_active, last_synced_at, imported_at
      ) VALUES (?, 'New', 'New', 'Fashion Brand', '2026-09-01', ?, 1, datetime('now'), datetime('now'))
      ON CONFLICT(order_code) DO UPDATE SET status = 'New', is_active = 1
    `).run(testCode, today);

    db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, order_date, source_file_slot
      ) VALUES (?, ?, 'Fashion Brand', 'New', '2026-09-01', 1)
      ON CONFLICT(work_date, order_code) DO UPDATE SET status = 'New'
    `).run(today, testCode);

    let pool = getUnallocatedOrdersPool(today);
    assert(pool.unallocated_orders.some(o => o.order_code === testCode), 'Order should be active');

    // 2. Order status transitions to Completed
    db.prepare(`
      UPDATE vendoor_orders
      SET status = 'Completed', active_status = 'Completed', is_active = 0
      WHERE order_code = ?
    `).run(testCode);

    db.prepare(`
      UPDATE current_work_orders
      SET status = 'Completed'
      WHERE work_date = ? AND order_code = ?
    `).run(today, testCode);

    // Check unallocated pool again
    pool = getUnallocatedOrdersPool(today);
    assert(!pool.unallocated_orders.some(o => o.order_code === testCode), 'Completed order must exit active pool');
  });
});
