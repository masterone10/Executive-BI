import { db } from '../db/index.js';
import { executeDispatchCycle } from '../services/vendoor/dispatcher.js';
const TEST_DATE = '2025-10-15';

const emp = db.prepare("SELECT id FROM employees WHERE active=1 LIMIT 1").get();
const empId = emp.id;

db.prepare("DELETE FROM order_level_allocations WHERE allocation_date=?").run(TEST_DATE);

db.prepare(`
  INSERT OR REPLACE INTO order_level_allocations
  (allocation_date, order_code, account, employee_id, employee_name, status, created_at)
  VALUES (?, ?, 'TEST_ACCOUNT', ?, 'Emp One', 'assigned', CURRENT_TIMESTAMP)
`).run(TEST_DATE, 'TEST_EXISTING_ORD_999', empId);

await executeDispatchCycle({
  dryRun: true,
  workDate: TEST_DATE,
  forceRun: true
});

console.log("Found:", db.prepare("SELECT * FROM order_level_allocations WHERE order_code='TEST_EXISTING_ORD_999'").get());
