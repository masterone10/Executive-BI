import { db } from '../db/index.js';

async function main() {
  const date = '2026-09-26';
  // Let us check what savedOwnersMap had for Clothes corner!
  const priorOwners = db.prepare(`
    SELECT account, owner_employee_id, owner_employee_name, work_date
    FROM account_owners
    WHERE work_date < ? AND owner_employee_id IS NOT NULL
    ORDER BY work_date DESC
  `).all(date);
  console.log('Prior owners for clothes corner:', priorOwners.filter(o => o.account.toLowerCase() === 'clothes corner'));

  const sameDayOwner = db.prepare(`
    SELECT account, owner_employee_id, owner_employee_name, work_date
    FROM account_owners
    WHERE work_date = ? AND owner_employee_id IS NOT NULL
  `).all(date);
  console.log('Same day owners for clothes corner:', sameDayOwner.filter(o => o.account.toLowerCase() === 'clothes corner'));

  // What was preserved in V11?
  const v10 = db.prepare('SELECT order_code, account, status, employee_name, work_state FROM order_level_allocations WHERE allocation_date = ? AND allocation_version = 10 AND LOWER(account) = ?').all(date, 'clothes corner');
  console.log('Clothes corner in v10:');
  console.table(v10);
}

main().catch(console.error);
