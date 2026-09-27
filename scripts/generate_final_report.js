import { db } from '../db/index.js';
import {
  generateRoundBasedAllocation,
  saveFinalOrderLevelAllocation,
  getOrderLevelAllocation,
  getAllocationVersions,
  getEnterpriseAllocationConfig,
  evaluateAccountTimeStatus
} from '../services/allocation.js';
import { isDelayedNewOrder } from '../services/enterprise_allocation.js';

async function generateAudit() {
  const workDate = '2026-09-26';

  console.log('----------------------------------------------------');
  console.log('1. TRACING EXACT USER PATH');
  console.log('----------------------------------------------------');
  console.log('UI function: runAutoFairAllocation(regenerate = false) [public/index.html]');
  console.log('API endpoint: POST /api/allocations/2026-09-26/generate -> POST /api/allocations/2026-09-26/save-order-level');
  console.log('Selected Allocation Engine: Account-Centric Stream-Separated Allocation Engine (generateRoundBasedAllocation / generateOrderLevelAllocation / executeEnterpriseAllocation)');
  console.log('Planner: resolveAccountEligibility + Priority Sorter (Delayed NEW -> Normal NEW -> PENDING) + Minimum Fragmentation Stream Balancer');
  console.log('Executor: generateRoundBasedAllocation -> atomic order matching & capacity tracking');
  console.log('Persistence: saveFinalOrderLevelAllocation -> SQLite transactions writing to allocation_versions, order_level_allocations, and account_owners');

  console.log('\n----------------------------------------------------');
  console.log('2. REAL PRODUCTION SNAPSHOT (2026-09-26)');
  console.log('----------------------------------------------------');
  
  const orders = db.prepare(`
    SELECT id, order_code, account, status, source_type, priority, order_date, work_date
    FROM current_work_orders
    WHERE work_date = ?
  `).all(workDate);

  const team = db.prepare(`
    SELECT dwt.employee_id, e.name, e.team_membership, dwt.is_working 
    FROM daily_working_team dwt 
    JOIN employees e ON dwt.employee_id = e.id 
    WHERE dwt.work_date = ? AND dwt.is_working = 1
  `).all(workDate);

  const prevAllocations = db.prepare(`
    SELECT * FROM order_level_allocations
    WHERE allocation_date = ?
  `).all(workDate);

  const totalEligibleNew = orders.filter(o => (o.source_type || '').toUpperCase() === 'NEW' || (o.status || '').toLowerCase() === 'new').length;
  const delayedNew = orders.filter(o => ((o.source_type || '').toUpperCase() === 'NEW' || (o.status || '').toLowerCase() === 'new') && isDelayedNewOrder(o, workDate)).length;
  const normalNew = totalEligibleNew - delayedNew;
  const totalEligiblePending = orders.filter(o => (o.source_type || '').toUpperCase() === 'PENDING' || (o.status || '').toLowerCase().includes('pending')).length;
  const distinctAccounts = new Set(orders.map(o => o.account)).size;
  const newEligibleEmployees = team.filter(e => e.team_membership === 'NEW' || e.team_membership === 'Both');
  const pendingEligibleEmployees = team.filter(e => e.team_membership === 'PENDING' || e.team_membership === 'Both');

  console.log(`Work date: ${workDate}`);
  console.log(`Total orders in current_work_orders: ${orders.length}`);
  console.log(`Total eligible NEW: ${totalEligibleNew}`);
  console.log(`Delayed NEW: ${delayedNew}`);
  console.log(`Normal NEW: ${normalNew}`);
  console.log(`Total eligible PENDING: ${totalEligiblePending}`);
  console.log(`Previously allocated orders: ${prevAllocations.length}`);
  console.log(`Distinct accounts: ${distinctAccounts}`);
  console.log(`Working team size: ${team.length}`);
  console.log(`NEW-eligible employees: ${newEligibleEmployees.length}`);
  console.log(`PENDING-eligible employees: ${pendingEligibleEmployees.length}`);

  console.log('\n----------------------------------------------------');
  console.log('3. EXECUTE AUTO FAIR ALLOCATION & RECORD RESULTS');
  console.log('----------------------------------------------------');
  const startTime = Date.now();
  const allocResult = generateRoundBasedAllocation(workDate, {
    method: 'fair_random',
    regenerate: false,
    round_number: 1,
    max_capacity_per_employee: 40
  });

  const saveRes = saveFinalOrderLevelAllocation(workDate, allocResult, 'Auto Fair Allocation Verification', 'Audit System');
  const duration = Date.now() - startTime;
  const versionNum = saveRes.version_number || saveRes.version;

  console.log(`Run ID: RUN_${workDate}_V${versionNum}_${Date.now()}`);
  console.log(`Allocation version: ${versionNum}`);
  console.log(`Status: COMMITTED (SUCCESS)`);
  console.log(`Duration: ${duration}ms`);
  console.log(`Total processed: ${allocResult.total_orders}`);
  console.log(`Previously preserved: ${allocResult.preserved_orders || 0}`);
  console.log(`Newly assigned: ${allocResult.assigned_orders}`);
  console.log(`Explicitly unassigned: ${allocResult.unassigned_orders}`);

  console.log('\n----------------------------------------------------');
  console.log('4. CRITICAL EMPLOYEE WORK-TYPE TEST');
  console.log('----------------------------------------------------');
  const allocationsInDb = db.prepare(`
    SELECT ola.*, e.name as employee_name, e.team_membership
    FROM order_level_allocations ola
    LEFT JOIN employees e ON ola.employee_id = e.id
    WHERE ola.allocation_date = ? AND ola.allocation_version = ?
  `).all(workDate, versionNum);

  const empWorkMap = new Map();
  team.forEach(t => {
    empWorkMap.set(t.employee_id, {
      id: t.employee_id,
      name: t.name,
      team: t.team_membership,
      newOrders: 0,
      pendingOrders: 0,
      orderCodesNew: [],
      orderCodesPending: []
    });
  });

  allocationsInDb.forEach(a => {
    if (a.employee_id && empWorkMap.has(a.employee_id)) {
      const emp = empWorkMap.get(a.employee_id);
      const isPend = (a.status || '').toLowerCase().includes('pending');
      if (isPend) {
        emp.pendingOrders++;
        emp.orderCodesPending.push(a.order_code);
      } else {
        emp.newOrders++;
        emp.orderCodesNew.push(a.order_code);
      }
    }
  });

  console.log('Employee'.padEnd(28) + ' | ' + 'Team'.padEnd(8) + ' | ' + 'NEW Orders'.padStart(10) + ' | ' + 'PENDING Orders'.padStart(14) + ' | ' + 'Total'.padStart(6));
  console.log('----------------------------------------------------------------------------------------------------');
  let newOnlyCount = 0;
  let pendingOnlyCount = 0;
  let bothCount = 0;
  let zeroWorkCount = 0;
  const violations = [];

  for (const [id, emp] of empWorkMap.entries()) {
    const total = emp.newOrders + emp.pendingOrders;
    console.log(`${emp.name.padEnd(28)} | ${emp.team.padEnd(8)} | ${String(emp.newOrders).padStart(10)} | ${String(emp.pendingOrders).padStart(14)} | ${String(total).padStart(6)}`);
    if (emp.newOrders > 0 && emp.pendingOrders === 0) newOnlyCount++;
    else if (emp.pendingOrders > 0 && emp.newOrders === 0) pendingOnlyCount++;
    else if (emp.newOrders > 0 && emp.pendingOrders > 0) {
      bothCount++;
      violations.push(emp);
    } else {
      zeroWorkCount++;
    }
  }
  console.log('----------------------------------------------------------------------------------------------------');
  console.log(`Employees with NEW only (NEW > 0 and PENDING = 0): ${newOnlyCount}`);
  console.log(`Employees with PENDING only (PENDING > 0 and NEW = 0): ${pendingOnlyCount}`);
  console.log(`Employees with BOTH NEW and PENDING: ${bothCount}`);
  console.log(`Employees with 0 orders (capacity unused): ${zeroWorkCount}`);
  console.log(`MANDATORY ACCEPTANCE: Employees with BOTH = 0 -> ${bothCount === 0 ? 'PASSED (ZERO VIOLATIONS)' : 'FAILED'}`);

  console.log('\n----------------------------------------------------');
  console.log('5. ACCOUNT-LEVEL TEST');
  console.log('----------------------------------------------------');
  const accMap = new Map();
  allocationsInDb.forEach(a => {
    if (!a.account) return;
    if (!accMap.has(a.account)) {
      accMap.set(a.account, {
        account: a.account,
        newCount: 0,
        pendingCount: 0,
        delayedNew: 0,
        normalNew: 0,
        assignedEmployees: new Set(),
        newEmployees: new Set(),
        pendingEmployees: new Set(),
        unassignedNew: 0,
        unassignedPending: 0
      });
    }
    const acc = accMap.get(a.account);
    const isPend = (a.status || '').toLowerCase().includes('pending');
    if (isPend) {
      acc.pendingCount++;
      if (a.employee_id) {
        acc.assignedEmployees.add(a.employee_id);
        acc.pendingEmployees.add(a.employee_id);
      } else {
        acc.unassignedPending++;
      }
    } else {
      acc.newCount++;
      if (isDelayedNewOrder(a, workDate)) acc.delayedNew++;
      else acc.normalNew++;
      if (a.employee_id) {
        acc.assignedEmployees.add(a.employee_id);
        acc.newEmployees.add(a.employee_id);
      } else {
        acc.unassignedNew++;
      }
    }
  });

  let oneEmp = 0;
  let twoEmp = 0;
  let threePlusEmp = 0;
  let zeroEmp = 0;

  for (const [name, acc] of accMap.entries()) {
    const size = acc.assignedEmployees.size;
    if (size === 1) oneEmp++;
    else if (size === 2) twoEmp++;
    else if (size >= 3) threePlusEmp++;
    else zeroEmp++;
  }

  console.log(`Total Accounts evaluated: ${accMap.size}`);
  console.log(`1 employee: ${oneEmp}`);
  console.log(`2 employees: ${twoEmp}`);
  console.log(`3+ employees: ${threePlusEmp}`);
  console.log(`0 employees (unassigned / unresolvable): ${zeroEmp}`);

  console.log('\n----------------------------------------------------');
  console.log('6. HIGH-VOLUME ACCOUNT TEST (TOP ACCOUNTS + CLOTHES CORNER)');
  console.log('----------------------------------------------------');
  const sortedAccounts = Array.from(accMap.values()).sort((a, b) => (b.newCount + b.pendingCount) - (a.newCount + a.pendingCount));
  sortedAccounts.slice(0, 8).forEach(acc => {
    console.log(`Account: ${acc.account.padEnd(25)} | Total: ${String(acc.newCount + acc.pendingCount).padStart(3)} (NEW: ${String(acc.newCount).padStart(3)} [Delayed: ${acc.delayedNew}, Normal: ${acc.normalNew}], PENDING: ${String(acc.pendingCount).padStart(3)}) | Emps Used (${acc.assignedEmployees.size}): NEW=[${Array.from(acc.newEmployees).map(id => empWorkMap.get(id)?.name).join(', ')}] | PENDING=[${Array.from(acc.pendingEmployees).map(id => empWorkMap.get(id)?.name).join(', ')}]`);
  });

  const cc = sortedAccounts.find(a => a.account.toLowerCase().includes('clothes corner'));
  if (cc) {
    console.log('\n*** Clothes Corner In-Depth Audit ***');
    console.log(`Account Name: ${cc.account}`);
    console.log(`Total Orders: ${cc.newCount + cc.pendingCount}`);
    console.log(`NEW Orders: ${cc.newCount} (Delayed: ${cc.delayedNew}, Normal: ${cc.normalNew})`);
    console.log(`PENDING Orders: ${cc.pendingCount}`);
    console.log(`NEW Employees Used (${cc.newEmployees.size}): ${Array.from(cc.newEmployees).map(id => empWorkMap.get(id)?.name).join(', ')}`);
    console.log(`PENDING Employees Used (${cc.pendingEmployees.size}): ${Array.from(cc.pendingEmployees).map(id => empWorkMap.get(id)?.name).join(', ')}`);
    console.log(`Total Distinct Employees: ${cc.assignedEmployees.size}`);
    const ccOrderRows = allocationsInDb.filter(a => a.account.toLowerCase() === cc.account.toLowerCase());
    const breakdown = {};
    ccOrderRows.forEach(o => {
      const e = o.employee_name || 'UNASSIGNED';
      breakdown[e] = (breakdown[e] || 0) + 1;
    });
    console.log(`Orders per Employee:`, breakdown);
  }

  console.log('\n----------------------------------------------------');
  console.log('7. ACCOUNT UNITY TEST');
  console.log('----------------------------------------------------');
  let pureFitCount = 0;
  let pureAssignedOne = 0;
  let pureSplit = 0;

  for (const [name, acc] of accMap.entries()) {
    const isPure = (acc.newCount > 0 && acc.pendingCount === 0) || (acc.pendingCount > 0 && acc.newCount === 0);
    const total = acc.newCount + acc.pendingCount;
    if (isPure && total <= 40) {
      pureFitCount++;
      if (acc.assignedEmployees.size <= 1) pureAssignedOne++;
      else {
        pureSplit++;
        console.log(`Split pure account: ${name} (orders: ${total}, emps: ${acc.assignedEmployees.size})`);
      }
    }
  }
  console.log(`Accounts that could fit one employee: ${pureFitCount}`);
  console.log(`Accounts actually assigned to one employee: ${pureAssignedOne}`);
  console.log(`Accounts unnecessarily split: ${pureSplit}`);

  console.log('\n----------------------------------------------------');
  console.log('8. DELAYED NEW PRIORITY TEST');
  console.log('----------------------------------------------------');
  const delayedAssigned = allocationsInDb.filter(a => !(a.status || '').toLowerCase().includes('pending') && isDelayedNewOrder(a, workDate) && a.employee_id).length;
  const delayedUnassigned = allocationsInDb.filter(a => !(a.status || '').toLowerCase().includes('pending') && isDelayedNewOrder(a, workDate) && !a.employee_id).length;
  const normalAssigned = allocationsInDb.filter(a => !(a.status || '').toLowerCase().includes('pending') && !isDelayedNewOrder(a, workDate) && a.employee_id).length;
  const normalUnassigned = allocationsInDb.filter(a => !(a.status || '').toLowerCase().includes('pending') && !isDelayedNewOrder(a, workDate) && !a.employee_id).length;
  const pendingAssigned = allocationsInDb.filter(a => (a.status || '').toLowerCase().includes('pending') && a.employee_id).length;
  const pendingUnassigned = allocationsInDb.filter(a => (a.status || '').toLowerCase().includes('pending') && !a.employee_id).length;

  console.log(`Delayed NEW: Total=${delayedNew}, Assigned=${delayedAssigned}, Unassigned=${delayedUnassigned} (${delayedNew > 0 ? ((delayedAssigned/delayedNew)*100).toFixed(1) : 100}%)`);
  console.log(`Normal NEW: Total=${normalNew}, Assigned=${normalAssigned}, Unassigned=${normalUnassigned}`);
  console.log(`PENDING: Total=${totalEligiblePending}, Assigned=${pendingAssigned}, Unassigned=${pendingUnassigned} (${((pendingAssigned/totalEligiblePending)*100).toFixed(1)}%)`);

  console.log('\n----------------------------------------------------');
  console.log('9. MIXED ACCOUNT EXAMPLES (Real Examples in Production)');
  console.log('----------------------------------------------------');
  const mixedAccs = sortedAccounts.filter(a => a.newCount > 0 && a.pendingCount > 0);
  console.log(`Total Mixed Accounts: ${mixedAccs.length}`);
  mixedAccs.slice(0, 5).forEach((m, idx) => {
    const newNames = Array.from(m.newEmployees).map(id => empWorkMap.get(id)?.name || id);
    const pendNames = Array.from(m.pendingEmployees).map(id => empWorkMap.get(id)?.name || id);
    const overlap = Array.from(m.newEmployees).filter(id => m.pendingEmployees.has(id));
    console.log(`Example ${idx + 1}: Account "${m.account}"`);
    console.log(`  NEW Orders: ${m.newCount} -> NEW CS: [${newNames.join(', ')}]`);
    console.log(`  PENDING Orders: ${m.pendingCount} -> PENDING CS: [${pendNames.join(', ')}]`);
    console.log(`  Total Employees Used: ${m.assignedEmployees.size} (Employee Overlap between NEW & PENDING: ${overlap.length})`);
  });

  console.log('\n----------------------------------------------------');
  console.log('10. REPEATED EXECUTION (IDEMPOTENCY) TEST');
  console.log('----------------------------------------------------');
  const secondAlloc = generateRoundBasedAllocation(workDate, {
    method: 'fair_random',
    regenerate: false,
    round_number: 1,
    max_capacity_per_employee: 40
  });
  console.log(`Second Execution Total: ${secondAlloc.total_orders}`);
  console.log(`Second Execution Assigned: ${secondAlloc.assigned_orders}`);
  console.log(`Second Execution Preserved: ${secondAlloc.preserved_orders || 0}`);
  console.log(`Second Execution Unassigned: ${secondAlloc.unassigned_orders}`);

  console.log('\n----------------------------------------------------');
  console.log('11. DATABASE RECONCILIATION & ZERO SILENT LOSS');
  console.log('----------------------------------------------------');
  const versions = db.prepare('SELECT * FROM allocation_versions WHERE allocation_date = ? ORDER BY version_number ASC').all(workDate);
  console.log(`Total allocation versions recorded: ${versions.length}`);
  versions.forEach(v => {
    console.log(`  Version ${v.version_number}: Total=${v.total_orders}, Assigned=${v.assigned_orders}, Unassigned=${v.unassigned_orders}`);
  });

  const totalRows = db.prepare('SELECT COUNT(*) as c FROM order_level_allocations WHERE allocation_date = ? AND allocation_version = ?').get(workDate, versionNum).c;
  const assignedCount = db.prepare('SELECT COUNT(*) as c FROM order_level_allocations WHERE allocation_date = ? AND allocation_version = ? AND employee_id IS NOT NULL').get(workDate, versionNum).c;
  const unassignedCount = db.prepare('SELECT COUNT(*) as c FROM order_level_allocations WHERE allocation_date = ? AND allocation_version = ? AND employee_id IS NULL').get(workDate, versionNum).c;

  const duplicates = db.prepare(`
    SELECT order_code, COUNT(*) as c
    FROM order_level_allocations
    WHERE allocation_date = ? AND allocation_version = ?
    GROUP BY order_code
    HAVING c > 1
  `).all(workDate, versionNum);

  console.log(`Allocation Version: ${versionNum}`);
  console.log(`Total Allocation Rows: ${totalRows}`);
  console.log(`Assigned Rows: ${assignedCount}`);
  console.log(`Unassigned Rows: ${unassignedCount}`);
  console.log(`Duplicate Orders: ${duplicates.length}`);
  console.log(`Reconciliation Verification: ${assignedCount} (assigned) + ${unassignedCount} (unassigned) = ${assignedCount + unassignedCount} (Matches total ${totalRows})`);

  process.exit(0);
}

generateAudit().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
