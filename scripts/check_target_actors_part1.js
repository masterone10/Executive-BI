import { db } from '../db/index.js';

const targetNames = [
  'Naira Yassen Shipping',
  'Nada Aaber Shipping',
  'Nawal Omran group',
  'Ebrahim Vendoor Support',
  'Cristena Shipping'
];

for (const t of targetNames) {
  const rows = db.prepare('SELECT id, employee_name, is_cs, action, event_datetime, order_code FROM raw_log_records WHERE work_date = ? AND employee_name = ?').all('2026-10-01', t);
  console.log(`\nRecords for "${t}" on 2026-10-01 (${rows.length} records):`);
  for (const r of rows) {
    console.log(`  id=${r.id}, is_cs=${r.is_cs}, order=${r.order_code}, dt=${r.event_datetime}, action=${r.action}`);
  }
}
