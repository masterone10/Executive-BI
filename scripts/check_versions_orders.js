import { db } from '../db/index.js';

async function main() {
  const versions = [7, 8, 9, 10, 11];
  for (const v of versions) {
    const o1 = db.prepare('SELECT order_code, account, status, employee_name, work_state FROM order_level_allocations WHERE allocation_date = ? AND allocation_version = ? AND order_code = ?').get('2026-09-26', v, '2198044');
    const o2 = db.prepare('SELECT order_code, account, status, employee_name, work_state FROM order_level_allocations WHERE allocation_date = ? AND allocation_version = ? AND order_code = ?').get('2026-09-26', v, '2197832');
    console.log(`Version ${v}: Adidas 2198044 -> ${o1 ? o1.employee_name : 'null'}, Clothes corner 2197832 -> ${o2 ? o2.employee_name : 'null'}`);
  }
}

main().catch(console.error);
