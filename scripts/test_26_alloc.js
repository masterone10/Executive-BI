import { db } from '../db/index.js';
import { generateRoundBasedAllocation } from '../services/allocation.js';

async function main() {
  console.log('Running generateRoundBasedAllocation on 2026-09-26...');
  const res = generateRoundBasedAllocation('2026-09-26', {
    method: 'fair_random',
    regenerate: true,
    round_number: 1
  });

  const vNum = res.version_number;
  console.log('Generated version:', vNum);

  const stats = db.prepare(`
    SELECT employee_name,
      SUM(CASE WHEN LOWER(status) NOT LIKE '%pending%' THEN 1 ELSE 0 END) as new_orders,
      SUM(CASE WHEN LOWER(status) LIKE '%pending%' THEN 1 ELSE 0 END) as pending_orders,
      COUNT(*) as total_orders
    FROM order_level_allocations
    WHERE allocation_date = '2026-09-26' AND allocation_version = ?
    GROUP BY employee_name
    ORDER BY total_orders DESC
  `).all(vNum);
  console.table(stats);

  const cc = db.prepare(`
    SELECT order_code, account, status, employee_name, work_state, rule_note
    FROM order_level_allocations
    WHERE allocation_date = '2026-09-26' AND allocation_version = ? AND account = 'Clothes corner'
  `).all(vNum);
  console.log('Clothes corner:');
  console.table(cc);
}

main().catch(console.error);
