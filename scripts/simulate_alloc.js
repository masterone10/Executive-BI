import { db } from '../db/index.js';
import { getWorkingTeam, getAccountExceptions } from '../services/allocation.js';

async function main() {
  const workDate = '2026-09-26';
  
  // Reconstruct exact state in allocation.js
  const orders = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ?').all(workDate);
  const workingTeam = getWorkingTeam(workDate).filter(e => e.is_working);

  const employeeStateMap = new Map();
  for (const emp of workingTeam) {
    employeeStateMap.set(emp.employee_id, {
      employee_id: emp.employee_id,
      employee_name: emp.name,
      team_membership: emp.permanent_team_membership || 'Both',
      allowed_new: Boolean(emp.allowed_new),
      allowed_pending: Boolean(emp.allowed_pending),
      standard_capacity: 40,
      allowed_capacity: 40,
      current_load: 0,
      round_stream_lock: null,
      assigned_orders: []
    });
  }

  // Work groups
  const accGroupMap = new Map();
  const workGroups = [];
  for (const ord of orders) {
    const isPending = (ord.status || '').toLowerCase().includes('pending') || (ord.source_type === 'PENDING');
    const stream = isPending ? 'PENDING' : 'NEW';
    const groupKey = `${ord.account.toLowerCase()}|${stream}`;
    if (!accGroupMap.has(groupKey)) {
      const grp = {
        account: ord.account,
        stream,
        has_fast_track: false,
        has_delayed: false,
        delayed_count: 0,
        orders: []
      };
      accGroupMap.set(groupKey, grp);
      workGroups.push(grp);
    }
    const targetGrp = accGroupMap.get(groupKey);
    const isDelayed = !isPending && ((ord.priority === 'FAST_TRACK') || (ord.priority === 'DELAYED') || (ord.order_date && ord.order_date < workDate));
    if (isDelayed) {
      targetGrp.has_delayed = true;
      targetGrp.delayed_count = (targetGrp.delayed_count || 0) + 1;
    }
    targetGrp.orders.push(ord);
  }

  workGroups.sort((a, b) => {
    const rankA = (a.stream === 'NEW') ? (a.has_delayed || a.has_fast_track ? 1 : 2) : (a.has_fast_track ? 3 : 4);
    const rankB = (b.stream === 'NEW') ? (b.has_delayed || b.has_fast_track ? 1 : 2) : (b.has_fast_track ? 3 : 4);
    if (rankA !== rankB) return rankA - rankB;
    if ((b.delayed_count || 0) !== (a.delayed_count || 0)) return (b.delayed_count || 0) - (a.delayed_count || 0);
    if (b.orders.length !== a.orders.length) return b.orders.length - a.orders.length;
    return a.account.localeCompare(b.account);
  });

  function isCandidateEligible(candidate, accountName, stream) {
    if (stream === 'NEW' && !candidate.allowed_new) return false;
    if (stream === 'PENDING' && !candidate.allowed_pending) return false;
    if (stream === 'NEW' && candidate.round_stream_lock === 'PENDING') return false;
    if (stream === 'PENDING' && candidate.round_stream_lock === 'NEW') return false;
    if (candidate.current_load >= candidate.allowed_capacity) return false;
    return true;
  }

  console.log('--- STARTING GROUP ALLOCATION SIMULATION ---');
  for (let gIdx = 0; gIdx < workGroups.length; gIdx++) {
    const grp = workGroups[gIdx];
    let remainingOrders = [...grp.orders];

    while (remainingOrders.length > 0) {
      const allEligible = Array.from(employeeStateMap.values()).filter(c => 
        isCandidateEligible(c, grp.account, grp.stream) && (c.allowed_capacity - c.current_load > 0)
      );

      const lockedEligible = allEligible.filter(c => c.round_stream_lock === grp.stream);
      const lockedRemainingCap = lockedEligible.reduce((s, c) => s + (c.allowed_capacity - c.current_load), 0);

      let remainingStreamDemand = 0;
      for (let i = gIdx; i < workGroups.length; i++) {
        if (workGroups[i].stream === grp.stream) remainingStreamDemand += workGroups[i].orders.length;
      }

      let eligibleCandidates = [];
      if (lockedEligible.length > 0) {
        eligibleCandidates = [...lockedEligible];
        if (lockedRemainingCap < remainingStreamDemand || !lockedEligible.some(c => (c.allowed_capacity - c.current_load) >= remainingOrders.length)) {
          eligibleCandidates.push(...allEligible.filter(c => !c.round_stream_lock));
        }
      } else {
        eligibleCandidates = allEligible;
      }

      if (eligibleCandidates.length === 0) {
        console.log(`[UNASSIGNED] Group ${grp.account} (${grp.stream}, count: ${remainingOrders.length}) -> No eligible candidate!`);
        break;
      }

      const singleCandidates = eligibleCandidates.filter(c => (c.allowed_capacity - c.current_load) >= remainingOrders.length);
      let chosenCandidate = null;
      if (singleCandidates.length > 0) {
        singleCandidates.sort((a, b) => {
          const aLocked = (a.round_stream_lock === grp.stream) ? 0 : 1;
          const bLocked = (b.round_stream_lock === grp.stream) ? 0 : 1;
          if (aLocked !== bLocked) return aLocked - bLocked;
          const aAvail = a.allowed_capacity - a.current_load;
          const bAvail = b.allowed_capacity - b.current_load;
          if (aAvail !== bAvail) return aAvail - bAvail;
          return a.current_load - b.current_load;
        });
        chosenCandidate = singleCandidates[0];
      } else {
        eligibleCandidates.sort((a, b) => {
          const aAvail = a.allowed_capacity - a.current_load;
          const bAvail = b.allowed_capacity - b.current_load;
          if (bAvail !== aAvail) return bAvail - aAvail;
          return a.current_load - b.current_load;
        });
        chosenCandidate = eligibleCandidates[0];
      }

      const avail = chosenCandidate.allowed_capacity - chosenCandidate.current_load;
      const take = Math.min(remainingOrders.length, avail);
      chosenCandidate.round_stream_lock = grp.stream;
      chosenCandidate.current_load += take;
      remainingOrders = remainingOrders.slice(take);

      if (grp.account === 'Clothes corner') {
        console.log(`[CLOTHES CORNER] ${grp.stream}: Assigned ${take} orders to ${chosenCandidate.employee_name} (Load now: ${chosenCandidate.current_load}/40, Remaining orders for CC: ${remainingOrders.length})`);
      }
    }
  }

  const newLocked = Array.from(employeeStateMap.values()).filter(c => c.round_stream_lock === 'NEW');
  const pendLocked = Array.from(employeeStateMap.values()).filter(c => c.round_stream_lock === 'PENDING');
  const uncommitted = Array.from(employeeStateMap.values()).filter(c => !c.round_stream_lock);
  console.log(`\nSimulation End:`);
  console.log(`NEW locked employees (${newLocked.length}): ${newLocked.map(c => `${c.employee_name} (${c.current_load})`).join(', ')}`);
  console.log(`PENDING locked employees (${pendLocked.length}): ${pendLocked.map(c => `${c.employee_name} (${c.current_load})`).join(', ')}`);
  console.log(`Uncommitted employees (${uncommitted.length}): ${uncommitted.map(c => c.employee_name).join(', ')}`);
}

main().catch(console.error);
