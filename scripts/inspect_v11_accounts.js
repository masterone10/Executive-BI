import { db } from '../db/index.js';

async function main() {
  const rows = db.prepare('SELECT id, order_code, account, status, employee_name, work_state FROM order_level_allocations WHERE allocation_date = ? AND allocation_version = 11 ORDER BY id ASC').all('2026-09-26');
  console.log('Total rows in v11:', rows.length);
  const newRows = rows.filter(r => !(r.status || '').toLowerCase().includes('pending'));
  console.log('NEW rows in v11:', newRows.length);
  const byAcc = new Map();
  for (const r of newRows) {
    if (!byAcc.has(r.account)) byAcc.set(r.account, []);
    byAcc.get(r.account).push(r);
  }
  for (const [acc, ords] of byAcc.entries()) {
    const emps = Array.from(new Set(ords.map(o => o.employee_name)));
    console.log(`Account "${acc}": ${ords.length} orders -> [${emps.join(', ')}]`);
  }
}

main().catch(console.error);
