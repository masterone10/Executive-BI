import { db } from '../db/index.js';

console.log('--- Noor in raw_log_records ---');
console.log(db.prepare("SELECT work_date, count(*) as cnt, is_cs FROM raw_log_records WHERE employee_name = 'Noor' GROUP BY work_date, is_cs").all());

console.log('--- Nour CS in raw_log_records ---');
console.log(db.prepare("SELECT work_date, count(*) as cnt, is_cs FROM raw_log_records WHERE employee_name = 'Nour CS' GROUP BY work_date, is_cs").all());

console.log('--- Noor actions breakdown ---');
console.log(db.prepare("SELECT action, count(*) as cnt FROM raw_log_records WHERE employee_name = 'Noor' GROUP BY action").all());

console.log('--- Nour CS actions breakdown ---');
console.log(db.prepare("SELECT action, count(*) as cnt FROM raw_log_records WHERE employee_name = 'Nour CS' GROUP BY action").all());

console.log('--- Noor in merchants / marketers ---');
console.log('Merchants:', db.prepare("SELECT * FROM merchants WHERE name LIKE '%Noor%' OR name LIKE '%Nour%'").all());
console.log('Marketers:', db.prepare("SELECT * FROM marketers WHERE name LIKE '%Noor%' OR name LIKE '%Nour%'").all());
