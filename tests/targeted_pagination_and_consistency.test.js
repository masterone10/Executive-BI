import { test } from 'node:test';
import assert from 'node:assert';
import { db } from '../db/index.js';
import { syncVendoorOrders } from '../services/vendoor/orchestrator.js';
import { fetchAllVendoorOrders, fetchVendoorOrdersPage } from '../services/vendoor/orders.js';
import { getOperationalDashboardData } from '../services/tracking.js';
import { getDispatcherConfig, attachEligibleArrivedOrders } from '../services/vendoor/dispatcher.js';

test('PROBLEM 1: Vendoor Orders Pagination (300 per page + Automatic Next Page)', async () => {
  const testDate = '2026-03-02';

  // 1. Verify single page fetch parameters
  const page1 = await fetchVendoorOrdersPage({
    fromDate: testDate,
    toDate: testDate,
    statusFilter: 'New',
    start: 0,
    length: 300,
    forceMode: 'mock'
  });

  assert.strictEqual(page1.success, true, 'Page 1 fetch succeeded');
  assert.strictEqual(page1.pagination.length, 300, 'Page length is strictly 300');
  assert.strictEqual(page1.orders.length, 300, 'First page returns maximum 300 rows');
  assert.strictEqual(page1.pagination.records_filtered, 350, 'Total New records available is 350');

  // Fetch page 2
  const page2 = await fetchVendoorOrdersPage({
    fromDate: testDate,
    toDate: testDate,
    statusFilter: 'New',
    start: 300,
    length: 300,
    forceMode: 'mock'
  });
  assert.strictEqual(page2.success, true, 'Page 2 fetch succeeded');
  assert.strictEqual(page2.orders.length, 50, 'Second page returns remaining 50 rows');

  // 2. Test full fetch for NEW orders (350 orders across 2 pages)
  const newOrdersResult = await fetchAllVendoorOrders({
    fromDate: testDate,
    toDate: testDate,
    statusFilter: 'New',
    pageSize: 300,
    forceMode: 'mock'
  });

  assert.strictEqual(newOrdersResult.total_orders, 350, 'All 350 New orders retrieved across pages');
  assert.strictEqual(newOrdersResult.pages_fetched, 2, '2 pages fetched for 350 orders with 300/page');

  // 3. Test full fetch for PENDING orders (620 orders across 3 pages)
  const pendingOrdersResult = await fetchAllVendoorOrders({
    fromDate: testDate,
    toDate: testDate,
    statusFilter: 'Pending',
    pageSize: 300,
    forceMode: 'mock'
  });

  assert.strictEqual(pendingOrdersResult.total_orders, 620, 'All 620 Pending orders retrieved across pages');
  assert.strictEqual(pendingOrdersResult.pages_fetched, 3, '3 pages fetched for 620 orders with 300/page');

  // 4. Test full multi-status orchestrator sync (New + Pending)
  // Clean DB for test date
  db.prepare('DELETE FROM vendoor_orders WHERE source_date = ?').run(testDate);
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(testDate);
  db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(testDate);

  const syncResult = await syncVendoorOrders({
    fromDate: testDate,
    toDate: testDate,
    pageSize: 300,
    forceMode: 'mock'
  });

  assert.strictEqual(syncResult.success, true, 'Sync run succeeded');
  assert.strictEqual(syncResult.total_fetched, 970, 'Fetched 350 New + 620 Pending = 970 orders total');
  assert.strictEqual(syncResult.pages_processed, 5, 'Processed 2 pages of New + 3 pages of Pending = 5 pages total');
  assert.strictEqual(syncResult.page_size, 300, 'Page size enforced at 300');

  // Verify persistence in SQLite
  const dbOrders = db.prepare('SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ?').get(testDate);
  assert.strictEqual(dbOrders.c, 970, 'All 970 unique orders stored into current_work_orders');

  const dbNew = db.prepare("SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ? AND status = 'New'").get(testDate);
  assert.strictEqual(dbNew.c, 350, '350 New orders stored in DB');

  const dbPending = db.prepare("SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ? AND status = 'Pending'").get(testDate);
  assert.strictEqual(dbPending.c, 620, '620 Pending orders stored in DB');

  // Verify no orders dropped at page boundary (e.g. order 300 and 301 exist)
  const order300 = db.prepare("SELECT order_code FROM current_work_orders WHERE work_date = ? AND order_code = 'VD-NEW-100300'").get(testDate);
  const order301 = db.prepare("SELECT order_code FROM current_work_orders WHERE work_date = ? AND order_code = 'VD-NEW-100301'").get(testDate);
  assert.ok(order300, 'Boundary order 300 is present');
  assert.ok(order301, 'Boundary order 301 is present');

  // Clean up
  db.prepare('DELETE FROM vendoor_orders WHERE source_date = ?').run(testDate);
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(testDate);
});

test('PROBLEM 2: Dashboard KPI Data-Scope Consistency from SQLite', async () => {
  const consistencyDate = '2026-03-05';

  // Clean DB for consistency test date
  db.prepare('DELETE FROM vendoor_orders WHERE source_date = ?').run(consistencyDate);
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(consistencyDate);
  db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(consistencyDate);

  // 1. When empty, returns clean 0s with exists: false (NEVER data.json 40,410 / 29,671)
  const emptyDashboard = getOperationalDashboardData(consistencyDate);
  assert.strictEqual(emptyDashboard.exists, false, 'Empty date exists = false');
  assert.strictEqual(emptyDashboard.hr.tot_new, 0, 'No new orders');
  assert.strictEqual(emptyDashboard.status_totals.Printed, 0, '0 Printed');
  assert.strictEqual(emptyDashboard.status_totals.Pending, 0, '0 Pending');
  assert.strictEqual(emptyDashboard.status_totals.Cancelled, 0, '0 Cancelled');
  assert.strictEqual(emptyDashboard.log_totals.actions, 0, '0 Real actions');

  // 2. Insert controlled known orders and log activity into SQLite
  // Insert 45 New orders, 25 Pending orders
  const insertOrder = db.prepare(`
    INSERT INTO current_work_orders (work_date, order_code, account, status, source_file_slot)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (let i = 1; i <= 45; i++) {
    insertOrder.run(consistencyDate, `TEST-NEW-${i}`, 'Alpha Merchant', 'New', 1);
  }
  for (let i = 1; i <= 25; i++) {
    insertOrder.run(consistencyDate, `TEST-PEN-${i}`, 'Beta Logistics', 'Pending', 2);
  }

  // Insert 10 log records: 6 Printed, 3 Cancelled, 1 Processing
  const insertLog = db.prepare(`
    INSERT INTO raw_log_records (work_date, employee_name, action, status, order_code)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (let i = 1; i <= 6; i++) {
    insertLog.run(consistencyDate, 'Ahmed Test', 'طباعة بوليصة الشحن', 'Printed', `TEST-NEW-${i}`);
  }
  for (let i = 1; i <= 3; i++) {
    insertLog.run(consistencyDate, 'Sara Test', 'إلغاء أوردر', 'Cancelled', `TEST-PEN-${i}`);
  }
  insertLog.run(consistencyDate, 'Ahmed Test', 'تجهيز أوردر', 'Processing', 'TEST-NEW-7');

  // 3. Query operational dashboard data
  const populatedDashboard = getOperationalDashboardData(consistencyDate);

  assert.strictEqual(populatedDashboard.exists, true, 'Populated date exists = true');
  assert.strictEqual(populatedDashboard.hr.tot_new, 45, 'Total New orders matches exactly 45');
  assert.strictEqual(populatedDashboard.status_totals.Pending, 25, 'Pending backlog matches exactly 25');
  assert.strictEqual(populatedDashboard.status_totals.Printed, 6, 'Printed orders matches exactly 6');
  assert.strictEqual(populatedDashboard.status_totals.Cancelled, 3, 'Cancelled orders matches exactly 3');
  assert.strictEqual(populatedDashboard.status_totals.Processing, 1, 'Processing orders matches exactly 1');
  assert.strictEqual(populatedDashboard.log_totals.actions, 10, 'Real actions matches exactly 10 (6 + 3 + 1)');

  // Cancel rate = 3 / 10 = 30.0%
  assert.strictEqual(populatedDashboard.team_cancel_rate, 30.0, 'Team cancel rate calculated precisely');

  // Performer verification
  assert.ok(populatedDashboard.employees.length >= 2, 'Employees listed');
  const ahmed = populatedDashboard.employees.find(e => e.name === 'Ahmed Test');
  assert.ok(ahmed, 'Ahmed is in employee roster');
  assert.strictEqual(ahmed.actions, 7, 'Ahmed has 7 actions (6 printed + 1 processing)');
  assert.strictEqual(ahmed.printed, 6, 'Ahmed has 6 printed');

  const sara = populatedDashboard.employees.find(e => e.name === 'Sara Test');
  assert.ok(sara, 'Sara is in employee roster');
  assert.strictEqual(sara.actions, 3, 'Sara has 3 actions (3 cancelled)');
  assert.strictEqual(sara.cancelled, 3, 'Sara has 3 cancelled');

  // Clean up
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(consistencyDate);
  db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(consistencyDate);
});

test('PROBLEM 3: Smart Dispatcher (Adds eligible work, Never steals work)', () => {
  const dispatchDate = '2026-03-08';

  // Cleanup
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(dispatchDate);
  db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(dispatchDate);
  db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(dispatchDate);
  db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(dispatchDate);

  // 1. Ensure employee in DB and in active daily_working_team
  let emp = db.prepare("SELECT id, name FROM employees WHERE name = 'Ziad Active'").get();
  if (!emp) {
    const res = db.prepare("INSERT INTO employees (name, active) VALUES ('Ziad Active', 1)").run();
    emp = { id: res.lastInsertRowid, name: 'Ziad Active' };
  }
  db.prepare('INSERT OR REPLACE INTO daily_working_team (work_date, employee_id) VALUES (?, ?)').run(dispatchDate, emp.id);

  // 2. Set an existing allocated order for Account 'Delta Store' to Ziad Active
  db.prepare(`
    INSERT INTO current_work_orders (work_date, order_code, account, status)
    VALUES (?, 'DELTA-001', 'Delta Store', 'New')
  `).run(dispatchDate);

  db.prepare(`
    INSERT INTO order_level_allocations (
      allocation_date, allocation_version, order_code, account, status, employee_id, employee_name, method
    ) VALUES (?, 1, 'DELTA-001', 'Delta Store', 'New', ?, 'Ziad Active', 'Initial')
  `).run(dispatchDate, emp.id);

  // 3. Simulate newly arrived order for 'Delta Store'
  db.prepare(`
    INSERT INTO current_work_orders (work_date, order_code, account, status)
    VALUES (?, 'DELTA-002', 'Delta Store', 'New')
  `).run(dispatchDate);

  // 4. Simulate a completed order that should never be reassigned
  db.prepare(`
    INSERT INTO current_work_orders (work_date, order_code, account, status)
    VALUES (?, 'DELTA-COMPLETED', 'Delta Store', 'Printed')
  `).run(dispatchDate);
  db.prepare(`
    INSERT INTO raw_log_records (work_date, employee_name, action, status, order_code)
    VALUES (?, 'Ziad Active', 'طباعة بوليصة الشحن', 'Printed', 'DELTA-COMPLETED')
  `).run(dispatchDate);

  // 5. Run attachEligibleArrivedOrders
  const attachResult = attachEligibleArrivedOrders(dispatchDate);
  assert.ok(attachResult.attached_count >= 1, 'At least 1 newly arrived order was attached to account owner');

  // Verify DELTA-002 was attached to Ziad Active
  const alloc = db.prepare(`
    SELECT employee_name, method
    FROM order_level_allocations
    WHERE allocation_date = ? AND order_code = 'DELTA-002'
  `).get(dispatchDate);

  assert.ok(alloc, 'DELTA-002 has allocation record');
  assert.strictEqual(alloc.employee_name, 'Ziad Active', 'DELTA-002 was assigned to Ziad Active (sticky account owner)');
  assert.strictEqual(alloc.method, 'Smart Dispatcher', 'Allocation method is Smart Dispatcher');

  // Verify completed order DELTA-COMPLETED was not touched
  const compAlloc = db.prepare(`
    SELECT * FROM order_level_allocations
    WHERE allocation_date = ? AND order_code = 'DELTA-COMPLETED'
  `).get(dispatchDate);
  assert.strictEqual(compAlloc, undefined, 'Completed order was untouched and not reallocated');

  // Clean up
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(dispatchDate);
  db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(dispatchDate);
  db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(dispatchDate);
  db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(dispatchDate);
});

