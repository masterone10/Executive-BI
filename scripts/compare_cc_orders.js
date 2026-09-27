import { db } from '../db/index.js';

async function main() {
  const cwo = db.prepare(`SELECT * FROM current_work_orders WHERE LOWER(account) = 'clothes corner' AND LOWER(status) NOT LIKE '%pending%' AND work_date = '2026-09-26'`).all();
  console.log('--- current_work_orders (2026-09-26) Clothes corner NEW: ---');
  console.table(cwo);

  const ola = db.prepare(`SELECT * FROM order_level_allocations WHERE LOWER(account) = 'clothes corner' AND LOWER(status) NOT LIKE '%pending%' AND allocation_date = '2026-09-26' AND allocation_version = 11`).all();
  console.log('--- order_level_allocations (v11) Clothes corner NEW: ---');
  console.table(ola);
}

main().catch(console.error);
