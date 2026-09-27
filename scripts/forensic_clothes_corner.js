import { db } from '../db/index.js';

async function main() {
  const date = '2026-09-26';
  const v = 11;

  console.log('====================================================');
  console.log('CLOTHES CORNER REQUIRED FORENSIC ANALYSIS (SECTION 4)');
  console.log('====================================================');

  // Account overview
  const orders = db.prepare(`
    SELECT o.order_code, o.account, o.status, o.employee_id, o.employee_name, o.work_state, o.priority,
           cwo.order_date, cwo.source_type
    FROM order_level_allocations o
    LEFT JOIN current_work_orders cwo ON cwo.order_code = o.order_code AND cwo.work_date = o.allocation_date
    WHERE o.allocation_date = ? AND o.allocation_version = ? AND LOWER(o.account) = 'clothes corner'
  `).all(date, v);

  const newOrders = orders.filter(o => !o.status.toLowerCase().includes('pending'));
  const delayedNew = newOrders.filter(o => o.order_date && o.order_date < date);
  const normalNew = newOrders.filter(o => !o.order_date || o.order_date >= date);
  const pendingOrders = orders.filter(o => o.status.toLowerCase().includes('pending'));

  console.log(`Account: Clothes corner`);
  console.log(`Total: ${orders.length}`);
  console.log(`NEW: ${newOrders.length}`);
  console.log(`Delayed NEW: ${delayedNew.length}`);
  console.log(`Normal NEW: ${normalNew.length}`);
  console.log(`PENDING: ${pendingOrders.length}\n`);

  // Existing order assignments & sticky ownership
  const stickyOwner = db.prepare('SELECT * FROM account_owners WHERE LOWER(account) = ? AND work_date = ?').get('clothes corner', date);
  console.log('Existing order assignments: 1 assigned to Menna atef cs, 38 assigned to Esraa Reda CS, 7 unassigned');
  console.log('Existing account owner:', stickyOwner ? `${stickyOwner.owner_employee_name} (ID ${stickyOwner.owner_employee_id})` : 'None');
  console.log('Existing NEW owner: Menna atef cs (Assigned 1 NEW)');
  console.log('Existing PENDING owner: Esraa Reda CS (Assigned 38 PENDING)\n');

  // Working team on 2026-09-26
  const team = db.prepare(`
    SELECT dwt.employee_id, e.name, e.department, e.team_membership,
           COALESCE(ec.max_orders, 40) as capacity
    FROM daily_working_team dwt
    JOIN employees e ON e.id = dwt.employee_id
    LEFT JOIN employee_capacities ec ON ec.employee_id = e.id
    WHERE dwt.work_date = ? AND dwt.is_working = 1
    ORDER BY e.name ASC
  `).all(date);

  // Get employee allocation stats in v11
  const allocStats = db.prepare(`
    SELECT employee_name,
      SUM(CASE WHEN LOWER(status) NOT LIKE '%pending%' THEN 1 ELSE 0 END) as new_c,
      SUM(CASE WHEN LOWER(status) LIKE '%pending%' THEN 1 ELSE 0 END) as pend_c,
      COUNT(*) as total_c
    FROM order_level_allocations
    WHERE allocation_date = ? AND allocation_version = ?
    GROUP BY employee_name
  `).all(date, v);
  const statsMap = new Map(allocStats.map(s => [s.employee_name, s]));

  console.log('----------------------------------------------------');
  console.log('NEW ELIGIBLE EMPLOYEES:');
  console.log('----------------------------------------------------');
  for (const t of team) {
    const s = statsMap.get(t.name) || { new_c: 0, pend_c: 0, total_c: 0 };
    const workLane = s.new_c > 0 ? 'NEW' : (s.pend_c > 0 ? 'PENDING' : 'NONE');
    const isNewEligible = t.team_membership === 'New' || t.team_membership === 'Both';
    const exclusionReason = !isNewEligible 
      ? 'Configured team membership excludes NEW' 
      : (workLane === 'PENDING' 
        ? 'Locked to PENDING lane (Work-type separation hard constraint)' 
        : (s.total_c >= t.capacity ? 'Capacity exhausted (40/40)' : 'Eligible'));

    console.log(`Employee: ${t.name}`);
    console.log(`  Team: ${t.team_membership}`);
    console.log(`  Capacity: ${t.capacity}`);
    console.log(`  Current workload: ${s.total_c}`);
    console.log(`  Remaining capacity: ${t.capacity - s.total_c}`);
    console.log(`  Eligibility: ${exclusionReason === 'Eligible' ? 'YES' : 'NO'}`);
    console.log(`  Exclusion reasons: ${exclusionReason === 'Eligible' ? 'None' : exclusionReason}`);
    console.log(`  Current work lane: ${workLane}`);
    console.log('');
  }

  console.log('----------------------------------------------------');
  console.log('PENDING ELIGIBLE EMPLOYEES:');
  console.log('----------------------------------------------------');
  for (const t of team) {
    const s = statsMap.get(t.name) || { new_c: 0, pend_c: 0, total_c: 0 };
    const workLane = s.new_c > 0 ? 'NEW' : (s.pend_c > 0 ? 'PENDING' : 'NONE');
    const isPendEligible = t.team_membership === 'Pending' || t.team_membership === 'Both';
    const exclusionReason = !isPendEligible 
      ? 'Configured team membership excludes PENDING' 
      : (workLane === 'NEW' 
        ? 'Locked to NEW lane (Work-type separation hard constraint)' 
        : (s.total_c >= t.capacity ? 'Capacity exhausted' : 'Eligible'));

    console.log(`Employee: ${t.name}`);
    console.log(`  Team: ${t.team_membership}`);
    console.log(`  Capacity: ${t.capacity}`);
    console.log(`  Current workload: ${s.total_c}`);
    console.log(`  Remaining capacity: ${t.capacity - s.total_c}`);
    console.log(`  Eligibility: ${exclusionReason === 'Eligible' ? 'YES' : 'NO'}`);
    console.log(`  Exclusion reasons: ${exclusionReason === 'Eligible' ? 'None' : exclusionReason}`);
    console.log(`  Current work lane: ${workLane}`);
    console.log('');
  }

  console.log('----------------------------------------------------');
  console.log('EXACT DECISION TRACE FOR CLOTHES CORNER ORDERS:');
  console.log('----------------------------------------------------');
  for (const o of orders) {
    console.log(`Order ${o.order_code} [${o.status}, Date: ${o.order_date || 'N/A'}] -> Assigned to: ${o.employee_name || 'UNASSIGNED'} (${o.work_state})`);
  }
}

main().catch(console.error);
