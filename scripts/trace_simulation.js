import { db } from '../db/index.js';
import { planEnterpriseAllocation } from '../services/enterprise_allocation.js';

async function main() {
  console.log('Running planEnterpriseAllocation on 2026-09-26...');
  const plan = planEnterpriseAllocation('2026-09-26', { mode: 'ACTIVE' });
  console.log('Plan status:', plan.status);
  console.log('Total assignments in plan:', plan.assignments.length);
  
  const empMap = new Map();
  for (const a of plan.assignments) {
    if (!empMap.has(a.employee_name)) {
      empMap.set(a.employee_name, { new: 0, pending: 0, accounts: new Set() });
    }
    const stat = empMap.get(a.employee_name);
    if (a.work_type === 'NEW') stat.new++;
    else stat.pending++;
    stat.accounts.add(a.account);
  }
  
  console.log('\nEmployee summary from plan:');
  for (const [name, s] of empMap.entries()) {
    console.log(`${name}: NEW=${s.new}, PENDING=${s.pending}, ACCOUNTS=${s.accounts.size}`);
  }

  const ccAssigned = plan.assignments.filter(a => a.account.toLowerCase() === 'clothes corner');
  console.log('\nClothes corner in plan:');
  console.table(ccAssigned.map(a => ({
    order_code: a.order_code,
    work_type: a.work_type,
    employee: a.employee_name,
    split_reason: a.split_reason
  })));

  const unassigned = plan.audit_records.filter(r => r.decision === 'BLOCKED');
  console.log(`\nBlocked / unassigned orders in plan: ${unassigned.length}`);
  const ccBlocked = unassigned.filter(r => r.reason_details && r.reason_details.toLowerCase().includes('clothes corner'));
  console.log('Clothes corner blocked:', ccBlocked);
}

main().catch(console.error);
