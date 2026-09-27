import { db } from '../db/index.js';
import { generateRoundBasedAllocation } from '../services/allocation.js';

async function main() {
  console.log('Testing generateRoundBasedAllocation for 2026-09-26...');
  // Let us run in a dry run or inspect without saving or inspect return
  const result = generateRoundBasedAllocation('2026-09-26', {
    method: 'fair_random',
    regenerate: true,
    round_number: 1
  });

  console.log('Result total assigned:', result.assigned_orders ? result.assigned_orders.length : result.assignments?.length);
  console.log('Result total unassigned:', result.unassigned_orders ? result.unassigned_orders.length : 0);

  const empCounts = new Map();
  for (const a of (result.assigned_orders || [])) {
    if (!empCounts.has(a.employee_name)) empCounts.set(a.employee_name, { new: 0, pending: 0, accounts: new Set() });
    const stat = empCounts.get(a.employee_name);
    if ((a.status || '').toLowerCase().includes('pending')) stat.pending++;
    else stat.new++;
    stat.accounts.add(a.account);
  }

  console.log('\nEmployee summary from generateRoundBasedAllocation:');
  for (const [name, s] of empCounts.entries()) {
    console.log(`${name}: NEW=${s.new}, PENDING=${s.pending}, ACCOUNTS=${s.accounts.size}`);
  }

  const cc = (result.assigned_orders || []).filter(a => a.account.toLowerCase() === 'clothes corner');
  console.log('\nClothes corner assigned:', cc.length);
  for (const a of cc) {
    console.log(`  ${a.order_code} [${a.status}] -> ${a.employee_name}`);
  }
  const ccUn = (result.unassigned_orders || []).filter(a => a.account.toLowerCase() === 'clothes corner');
  console.log('Clothes corner unassigned:', ccUn.length);
  for (const a of ccUn) {
    console.log(`  ${a.order_code} [${a.status}] reason: ${a.unassigned_reason}`);
  }
}

main().catch(console.error);
