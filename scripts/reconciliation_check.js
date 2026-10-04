import { db } from '../db/index.js';

console.log('=== ALL EMPLOYEES ===');
const employees = db.prepare('SELECT id, name, department, team_membership, active, status, effective_from, effective_to FROM employees').all();
console.log(JSON.stringify(employees, null, 2));

console.log('=== TARGET IDENTITY MAPPINGS ===');
const mappings = db.prepare('SELECT * FROM vendoor_identity_mappings').all();
const targetNames = [
  'Naira Yassen Shipping',
  'Nada Aaber Shipping',
  'Nawal Omran group',
  'Ebrahim Vendoor Support',
  'Cristena Shipping',
  'Super',
  'Noor',
  'Nour CS'
];
for (const t of targetNames) {
  const m = mappings.filter(x => x.vendoor_name.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(x.vendoor_name.toLowerCase()));
  console.log(`Mapping for ${t}:`, m);
}

console.log('=== RAW LOG RECORDS FOR 2026-10-01 FOR TARGET NAMES ===');
for (const t of targetNames) {
  const rows = db.prepare('SELECT id, employee_name, is_cs, action, event_datetime, order_code FROM raw_log_records WHERE work_date = ? AND employee_name = ?').all('2026-10-01', t);
  console.log(`Records for "${t}" on 2026-10-01 (${rows.length} records):`);
  for (const r of rows) {
    console.log(`  id=${r.id}, emp=${r.employee_name}, is_cs=${r.is_cs}, order=${r.order_code}, action=${r.action}, dt=${r.event_datetime}`);
  }
}

console.log('=== DAILY WORKING TEAM FOR 2026-10-01 ===');
const dwt = db.prepare('SELECT * FROM daily_working_team WHERE work_date = ?').all('2026-10-01');
console.log(dwt);

console.log('=== UPLOADED FILES & LOG STATS ===');
console.log('uploaded_files:', db.prepare('SELECT * FROM uploaded_files').all());
console.log('raw_log_records count by work_date:', db.prepare('SELECT work_date, count(*) as cnt, sum(case when is_cs=1 then 1 else 0 end) as cs_cnt FROM raw_log_records GROUP BY work_date').all());
console.log('vendoor_logs count by work_date:', db.prepare('SELECT work_date, count(*) as cnt FROM vendoor_logs GROUP BY work_date').all());
