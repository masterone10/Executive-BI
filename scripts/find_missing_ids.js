import { db } from '../db/index.js';

const rawRows = db.prepare("SELECT id FROM raw_log_records WHERE work_date = '2026-10-01' ORDER BY id ASC").all();
const rawIds = new Set(rawRows.map(r => r.id));

const missingIds = [];
for (let i = 1; i <= 29681; i++) {
  if (!rawIds.has(i)) {
    missingIds.push(i);
  }
}

console.log('Total missing IDs:', missingIds.length);
console.log('First 20 missing IDs:', missingIds.slice(0, 20));

// Check if those missing IDs exist anywhere in raw_log_records under another work_date
const missingInOtherDates = db.prepare(`SELECT work_date, count(*) as cnt FROM raw_log_records WHERE id IN (${missingIds.join(',')}) GROUP BY work_date`).all();
console.log('Missing IDs found in other work_dates:', missingInOtherDates);

// Check vendoor_logs IDs
const vendoorRows = db.prepare("SELECT id FROM vendoor_logs WHERE work_date = '2026-10-01' ORDER BY id ASC").all();
console.log('vendoor_logs count:', vendoorRows.length, 'max id:', Math.max(...vendoorRows.map(r => r.id)));

// Check historical_date_registry or audit or seed scripts
console.log('Historical date registry:', db.prepare("SELECT * FROM historical_date_registry").all());
