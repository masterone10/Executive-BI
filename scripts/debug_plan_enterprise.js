import { db } from '../db/index.js';
import { getWorkingTeam } from '../services/allocation.js';
import { evaluateEmployeeAllocationEligibility, evaluateAccountTimeStatus, isDelayedNewOrder } from '../services/enterprise_allocation.js';

async function main() {
  const workDate = '2026-09-26';
  const canonicalNowStr = `${workDate}T12:05:00Z`;

  console.log(`Checking planEnterpriseAllocation preconditions for ${workDate}...`);

  // 1. Working team
  const workingTeam = getWorkingTeam(workDate).filter(e => e.is_working);
  console.log(`Working team: ${workingTeam.length}`);

  // 2. Candidate eligibility
  const candidateDecisions = [];
  const eligibleCandidates = [];
  for (const emp of workingTeam) {
    const elig = evaluateEmployeeAllocationEligibility(emp.employee_id, workDate, {
      currentTime: canonicalNowStr,
      currentWorkload: 0,
      skip_working_team_check: false
    });
    if (elig.is_eligible) {
      eligibleCandidates.push(elig.employee);
    } else {
      candidateDecisions.push({ name: emp.name, reasons: elig.exclusion_reasons });
    }
  }
  console.log(`Eligible candidates: ${eligibleCandidates.length}, Excluded: ${candidateDecisions.length}`);
  console.log('Excluded candidates:', candidateDecisions);

  // 3. Orders in current_work_orders
  const orders = db.prepare(`SELECT * FROM current_work_orders WHERE work_date = ?`).all(workDate);
  console.log(`Total orders in current_work_orders: ${orders.length}`);

  // Check account time status
  let openCount = 0;
  let closedCount = 0;
  for (const ord of orders) {
    const isPend = (ord.status || '').toLowerCase().includes('pending') || ord.source_type === 'PENDING';
    const workType = isPend ? 'PENDING' : 'NEW';
    const status = evaluateAccountTimeStatus(ord.account, workType, canonicalNowStr);
    if (status.is_open) openCount++;
    else closedCount++;
  }
  console.log(`Orders by account time status: Open=${openCount}, Closed=${closedCount}`);
}

main().catch(console.error);
