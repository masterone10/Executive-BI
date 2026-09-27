import { db } from '../db/index.js';
import { planEnterpriseAllocation, executeEnterpriseAllocation } from '../services/enterprise_allocation.js';

async function main() {
  const dates = ['2026-09-26', '2026-09-27'];

  for (const d of dates) {
    console.log(`\n========================================`);
    console.log(`TESTING ORDER-LEVEL ALLOCATION FOR ${d}`);
    console.log(`========================================`);

    const plan = planEnterpriseAllocation(d, 'ACTIVE', { regenerate: true });
    console.log('Plan status:', plan.status);
    console.log('Total assigned in plan:', plan.assignments.length);

    const empMap = new Map();
    for (const a of plan.assignments) {
      if (!empMap.has(a.employee_name)) empMap.set(a.employee_name, { new: 0, pending: 0, total: 0 });
      const stat = empMap.get(a.employee_name);
      if (a.work_type === 'NEW') stat.new++;
      else stat.pending++;
      stat.total++;
    }

    console.log(`\nEmployee Breakdown (${empMap.size} working):`);
    let newOnly = 0, pendOnly = 0, both = 0;
    for (const [name, s] of empMap.entries()) {
      if (s.new > 0 && s.pending > 0) both++;
      else if (s.new > 0) newOnly++;
      else if (s.pending > 0) pendOnly++;
      console.log(`  ${name}: Total=${s.total}, NEW=${s.new}, PENDING=${s.pending}`);
    }
    console.log(`Lanes: NEW-only=${newOnly}, PENDING-only=${pendOnly}, BOTH=${both}`);

    // Check Clothes corner
    const cc = plan.assignments.filter(a => a.account.toLowerCase() === 'clothes corner');
    console.log(`\nClothes corner assigned (${cc.length} orders):`);
    const ccEmps = new Map();
    for (const a of cc) {
      if (!ccEmps.has(a.employee_name)) ccEmps.set(a.employee_name, { new: 0, pending: 0, total: 0 });
      const s = ccEmps.get(a.employee_name);
      if (a.work_type === 'NEW') s.new++;
      else s.pending++;
      s.total++;
    }
    for (const [name, s] of ccEmps.entries()) {
      console.log(`  * ${name}: ${s.total} (NEW: ${s.new}, PENDING: ${s.pending})`);
    }

    // Check Delayed NEW
    const delayedNewAssigned = plan.assignments.filter(a => a.work_type === 'NEW' && a.is_delayed);
    const blockedNew = plan.audit_records.filter(r => r.decision === 'BLOCKED' && r.reason_details?.includes('NEW'));
    console.log(`\nDelayed NEW Assigned: ${delayedNewAssigned.length}, Blocked/Unassigned NEW: ${blockedNew.length}`);
  }
}

main().catch(console.error);
