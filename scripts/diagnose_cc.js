import { db } from '../db/index.js';
import { getWorkingTeam } from '../services/allocation.js';

async function main() {
  const team = getWorkingTeam('2026-09-26').filter(e => e.is_working);
  console.log(`Working team on 2026-09-26: ${team.length} employees`);
  console.table(team.map(e => ({
    id: e.id,
    name: e.name,
    permanent: e.permanent_team_membership,
    allowed_new: e.allowed_new,
    allowed_pending: e.allowed_pending
  })));

  const ccOrders = db.prepare(`SELECT order_code, account, status, source_type, employee_name, rule_note FROM order_level_allocations WHERE allocation_date = '2026-09-26' AND allocation_version = 11 AND account = 'Clothes corner'`).all();
  console.log('Clothes corner orders in V11:');
  console.table(ccOrders);
}

main().catch(console.error);
