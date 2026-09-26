import { db } from '../db/index.js';
import {
  planEnterpriseAllocation,
  executeEnterpriseAllocation,
  getEnterpriseAllocationConfig,
  evaluateEmployeeAllocationEligibility
} from '../services/enterprise_allocation.js';
import { getWorkingTeam } from '../services/allocation.js';
import { getCairoNow } from '../services/time_utils.js';

const workDate = '2026-09-26';

console.log('================================================================');
console.log('CS EXECUTIVE BI — PRODUCTION FORENSIC ALLOCATION VERIFICATION');
console.log('================================================================');
console.log('Audit Execution Date (Cairo):', getCairoNow());
console.log('Target Work Date:', workDate);

// -----------------------------------------------------------------------------
// SECTION 3: BEFORE SNAPSHOT
// -----------------------------------------------------------------------------
console.log('\n================================================================');
console.log('SECTION 3: PRODUCTION SNAPSHOT BEFORE EXECUTION');
console.log('================================================================');

// 3.1 Working Team
const rawTeam = db.prepare(`
  SELECT dwt.employee_id, dwt.is_working, e.name, e.department, e.status, e.active, e.team_membership, dwt.last_activity_at
  FROM daily_working_team dwt
  JOIN employees e ON dwt.employee_id = e.id
  WHERE dwt.work_date = ?
  ORDER BY dwt.employee_id ASC
`).all(workDate);

console.log(`\n--- 3.1 WORKING TEAM SNAPSHOT (${rawTeam.length} entries) ---`);
console.table(rawTeam.map(t => ({
  ID: t.employee_id,
  Name: t.name,
  Dept: t.department,
  Status: t.status,
  Active: t.active,
  Working: t.is_working,
  Membership: t.team_membership,
  LastActivity: t.last_activity_at
})));

// 3.2 Order Population
const rawOrders = db.prepare(`
  SELECT id, order_code, account, status, source_type, work_state, assigned_employee_id
  FROM current_work_orders
  WHERE work_date = ?
`).all(workDate);

const statusCounts = {};
for (const o of rawOrders) {
  statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
}
console.log('\n--- 3.2 ORDER POPULATION SUMMARY ---');
console.log('Total Orders in Work Pool:', rawOrders.length);
console.table(statusCounts);

// 3.3 Account Population
const accMap = {};
for (const o of rawOrders) {
  if (!accMap[o.account]) {
    accMap[o.account] = { total: 0, NEW: 0, PENDING: 0, other: 0, assigned: 0, unassigned: 0 };
  }
  accMap[o.account].total++;
  if (o.status === 'NEW') accMap[o.account].NEW++;
  else if (o.status === 'PENDING') accMap[o.account].PENDING++;
  else accMap[o.account].other++;

  if (o.assigned_employee_id) accMap[o.account].assigned++;
  else accMap[o.account].unassigned++;
}

// 3.4 Pre-existing Ownership
const preOwners = db.prepare('SELECT * FROM account_owners WHERE work_date = ?').all(workDate);
const preOwnerMap = new Map(preOwners.map(o => [o.account, o]));

console.log(`\n--- 3.3 & 3.4 ACCOUNT POPULATION & OWNERSHIP (Sample 15 Accounts) ---`);
console.table(Object.entries(accMap).slice(0, 15).map(([acc, data]) => ({
  Account: acc,
  Total: data.total,
  NEW: data.NEW,
  PENDING: data.PENDING,
  AssignedBefore: data.assigned,
  UnassignedBefore: data.unassigned,
  StickyOwner: preOwnerMap.get(acc)?.owner_employee_name || 'None'
})));

// -----------------------------------------------------------------------------
// SECTION 4: HIGH-VALUE FORENSIC ACCOUNTS SELECTION
// -----------------------------------------------------------------------------
console.log('\n================================================================');
console.log('SECTION 4: HIGH-VALUE FORENSIC ACCOUNTS');
console.log('================================================================');

const case1 = Object.entries(accMap).find(([_, d]) => d.NEW > 0 && d.PENDING === 0 && d.other === 0);
const case2 = Object.entries(accMap).find(([_, d]) => d.PENDING > 0 && d.NEW === 0 && d.other === 0);
const case3 = Object.entries(accMap).find(([_, d]) => d.NEW > 0 && d.PENDING > 0);
const case4 = Object.entries(accMap).find(([_, d]) => d.total >= 1 && d.total <= 15);
const case5 = Object.entries(accMap).find(([_, d]) => d.total >= 30 && d.total <= 40);
const case6 = Object.entries(accMap).find(([_, d]) => d.total > 40);
const case7 = Object.entries(accMap).find(([acc, _]) => preOwnerMap.has(acc) && preOwnerMap.get(acc).owner_employee_id !== null);
const case8 = Object.entries(accMap).find(([acc, _]) => acc.toLowerCase().includes('clothes corner'));

const highValueCases = [
  { Case: 'Case 1: Only NEW Orders', Account: case1 ? case1[0] : 'N/A', Details: case1 ? JSON.stringify(case1[1]) : '' },
  { Case: 'Case 2: Only PENDING Orders', Account: case2 ? case2[0] : 'N/A', Details: case2 ? JSON.stringify(case2[1]) : '' },
  { Case: 'Case 3: BOTH NEW and PENDING', Account: case3 ? case3[0] : 'N/A', Details: case3 ? JSON.stringify(case3[1]) : '' },
  { Case: 'Case 4: Small Account (<=15)', Account: case4 ? case4[0] : 'N/A', Details: case4 ? JSON.stringify(case4[1]) : '' },
  { Case: 'Case 5: Close to Capacity (30-40)', Account: case5 ? case5[0] : 'N/A', Details: case5 ? JSON.stringify(case5[1]) : '' },
  { Case: 'Case 6: Exceeding 1 Capacity (>40)', Account: case6 ? case6[0] : 'N/A', Details: case6 ? JSON.stringify(case6[1]) : '' },
  { Case: 'Case 7: Existing Sticky Owner', Account: case7 ? case7[0] : 'N/A', Details: case7 ? JSON.stringify(case7[1]) : '' },
  { Case: 'Case 8: Clothes corner (Target)', Account: case8 ? case8[0] : 'N/A', Details: case8 ? JSON.stringify(case8[1]) : '' }
];
console.table(highValueCases);

// -----------------------------------------------------------------------------
// SECTION 5: REAL ALLOCATION EXECUTION
// -----------------------------------------------------------------------------
console.log('\n================================================================');
console.log('SECTION 5: REAL ALLOCATION EXECUTION & TIMING');
console.log('================================================================');

const startTimestamp = new Date();
let execResult = null;
try {
  execResult = executeEnterpriseAllocation(workDate, {
    method: 'fair_random',
    regenerate: false,
    require_recent_activity: false // Evaluated across all working CS for batch
  });
} catch (err) {
  execResult = { success: false, error: err.message, stack: err.stack };
}
const endTimestamp = new Date();
const durationMs = endTimestamp.getTime() - startTimestamp.getTime();

console.log('Execution Started At:', startTimestamp.toISOString());
console.log('Execution Completed At:', endTimestamp.toISOString());
console.log('Execution Duration (ms):', durationMs);
console.log('Allocation Status:', execResult.status);
console.log('Success:', execResult.success);
console.log('Run ID:', execResult.run_id);
console.log('Assigned Count:', execResult.assigned_count ?? execResult.assigned_orders);
console.log('Unassigned Count:', execResult.unassigned_count ?? execResult.unassigned_orders);
console.log('Preserved Count:', execResult.preserved_orders_count ?? 0);
console.log('Total Orders Processed:', execResult.total_orders);

// -----------------------------------------------------------------------------
// SECTION 6: BEFORE VS AFTER RECONCILIATION
// -----------------------------------------------------------------------------
console.log('\n================================================================');
console.log('SECTION 6: BEFORE VS AFTER STATE RECONCILIATION');
console.log('================================================================');

const postOrders = db.prepare(`
  SELECT id, order_code, account, status, work_state, assigned_employee_id
  FROM current_work_orders
  WHERE work_date = ?
`).all(workDate);

const postOrderAllocs = db.prepare(`
  SELECT * FROM order_level_allocations
  WHERE allocation_date = ?
`).all(workDate);

console.log('Eligible Orders Before:', rawOrders.length);
console.log('Total Orders in DB After:', postOrders.length);
console.log('Total Order Level Allocation Records in DB After:', postOrderAllocs.length);

// Check duplicate assignments
const assignedCodes = new Map();
const duplicates = [];
for (const a of (execResult.raw_allocations || [])) {
  if (a.employee_id) {
    if (assignedCodes.has(a.order_code)) {
      duplicates.push({ order_code: a.order_code, firstEmp: assignedCodes.get(a.order_code), secondEmp: a.employee_name });
    }
    assignedCodes.set(a.order_code, a.employee_name);
  }
}
console.log('Duplicate Assignments Count:', duplicates.length);

// Check unauthorized assignments (non-CS or not in working team)
const workingCsIds = new Set(rawTeam.filter(t => t.is_working === 1 && t.department === 'CS').map(t => t.employee_id));
const unauthorized = [];
for (const a of (execResult.raw_allocations || [])) {
  if (a.employee_id && !workingCsIds.has(a.employee_id)) {
    unauthorized.push(a);
  }
}
console.log('Unauthorized Assignments Count (Non-CS / Not Working):', unauthorized.length);

// -----------------------------------------------------------------------------
// SECTION 7: NEW + PENDING FORENSIC TEST
// -----------------------------------------------------------------------------
console.log('\n================================================================');
console.log('SECTION 7: FORENSIC TEST — NEW + PENDING IN SAME ACCOUNT');
console.log('================================================================');

const postAccAssignments = {};
for (const a of (execResult.raw_allocations || [])) {
  if (!postAccAssignments[a.account]) postAccAssignments[a.account] = [];
  postAccAssignments[a.account].push(a);
}

const newPendingTable = [];
for (const [acc, d] of Object.entries(accMap)) {
  if (d.NEW > 0 && d.PENDING > 0) {
    const allocs = postAccAssignments[acc] || [];
    const assignedEmps = new Set(allocs.filter(a => a.employee_id).map(a => a.employee_name));
    const assignedNew = allocs.filter(a => a.status === 'NEW' && a.employee_id).length;
    const assignedPending = allocs.filter(a => a.status === 'PENDING' && a.employee_id).length;
    const unassigned = allocs.filter(a => !a.employee_id).length;

    newPendingTable.push({
      Account: acc,
      NEW_Orders: d.NEW,
      Assigned_NEW: assignedNew,
      PENDING_Orders: d.PENDING,
      Assigned_PENDING: assignedPending,
      Total: d.total,
      Employees_Used: assignedEmps.size,
      Employees_List: Array.from(assignedEmps).join(', ') || 'Unassigned',
      Fragmented: assignedEmps.size > 2 ? 'YES (Defect)' : (assignedEmps.size === 2 ? 'Controlled Split' : 'Unified (1 CS)')
    });
  }
}
console.table(newPendingTable);

// -----------------------------------------------------------------------------
// SECTION 8: ACCOUNT FRAGMENTATION FORENSIC TEST
// -----------------------------------------------------------------------------
console.log('\n================================================================');
console.log('SECTION 8: FORENSIC TEST — ACCOUNT FRAGMENTATION AUDIT');
console.log('================================================================');

const fragmentationStats = { unified: [], split2: [], fragmented3plus: [] };
for (const [acc, allocs] of Object.entries(postAccAssignments)) {
  const emps = new Set(allocs.filter(a => a.employee_id).map(a => a.employee_name));
  if (emps.size === 1) {
    fragmentationStats.unified.push({ account: acc, orders: allocs.length, employee: Array.from(emps)[0] });
  } else if (emps.size === 2) {
    fragmentationStats.split2.push({ account: acc, orders: allocs.length, employees: Array.from(emps).join(', ') });
  } else if (emps.size >= 3) {
    fragmentationStats.fragmented3plus.push({ account: acc, orders: allocs.length, employeeCount: emps.size, employees: Array.from(emps).join(', ') });
  }
}

console.log('Unified Accounts (Exactly 1 CS):', fragmentationStats.unified.length);
console.log('Controlled Split Accounts (Exactly 2 CS):', fragmentationStats.split2.length);
console.table(fragmentationStats.split2);
console.log('Fragmented Accounts (3+ CS — Strict Defect Flag):', fragmentationStats.fragmented3plus.length);
if (fragmentationStats.fragmented3plus.length > 0) {
  console.table(fragmentationStats.fragmented3plus);
}

// -----------------------------------------------------------------------------
// SECTION 9: CLOTHES CORNER DEDICATED REPORT
// -----------------------------------------------------------------------------
console.log('\n================================================================');
console.log('SECTION 9: FORENSIC REPORT — CLOTHES CORNER');
console.log('================================================================');

const ccOrders = rawOrders.filter(o => o.account === 'Clothes corner');
const ccAllocs = (execResult.raw_allocations || []).filter(a => a.account === 'Clothes corner');
const ccEmps = {};
for (const a of ccAllocs) {
  const empName = a.employee_name || 'UNASSIGNED';
  ccEmps[empName] = (ccEmps[empName] || 0) + 1;
}

console.log('Account: Clothes corner');
console.log('Total eligible orders:', ccOrders.length);
console.log('  - NEW:', ccOrders.filter(o => o.status === 'NEW').length);
console.log('  - PENDING:', ccOrders.filter(o => o.status === 'PENDING').length);
console.log('  - Other:', ccOrders.filter(o => o.status !== 'NEW' && o.status !== 'PENDING').length);
console.log('Pre-existing sticky owner:', preOwnerMap.get('Clothes corner')?.owner_employee_name || 'None');
console.log('Employees assigned after allocation:');
for (const [emp, count] of Object.entries(ccEmps)) {
  console.log(`  - ${emp}: ${count} orders`);
}
console.log('Fragmentation Status:', Object.keys(ccEmps).filter(k => k !== 'UNASSIGNED').length <= 2 ? 'COMPLIANT (<= 2 CS)' : 'NON-COMPLIANT (> 2 CS)');

console.log('\nOrder Breakdown for Clothes corner:');
console.table(ccAllocs.map((a, idx) => ({
  Index: idx + 1,
  Order_Code: a.order_code,
  Status: a.status,
  Assigned_Agent: a.employee_name || 'UNASSIGNED',
  Work_Type: a.work_type || a.status,
  Tracking_ID: a.tracking_id
})));

// -----------------------------------------------------------------------------
// SECTION 10: EMPLOYEE CAPACITY AUDIT
// -----------------------------------------------------------------------------
console.log('\n================================================================');
console.log('SECTION 10: FORENSIC TEST — EMPLOYEE CAPACITY AUDIT');
console.log('================================================================');

const empCapacities = db.prepare('SELECT * FROM employee_capacities').all();
const capMap = new Map(empCapacities.map(c => [c.employee_id, c.max_orders]));

const empAssignedCounts = {};
for (const a of (execResult.raw_allocations || [])) {
  if (a.employee_id) {
    empAssignedCounts[a.employee_id] = (empAssignedCounts[a.employee_id] || 0) + 1;
  }
}

const capacityAuditTable = rawTeam.filter(t => t.is_working === 1 && t.department === 'CS').map(t => {
  const cap = capMap.get(t.employee_id) || 40;
  const assigned = empAssignedCounts[t.employee_id] || 0;
  return {
    Employee_ID: t.employee_id,
    Employee_Name: t.name,
    Configured_Cap: cap,
    Final_Assigned: assigned,
    Remaining_Cap: Math.max(0, cap - assigned),
    Cap_Exceeded: assigned > cap ? 'YES (OVERFLOW)' : 'NO'
  };
});
console.table(capacityAuditTable);

// -----------------------------------------------------------------------------
// SECTION 11: STICKY OWNERSHIP AUDIT
// -----------------------------------------------------------------------------
console.log('\n================================================================');
console.log('SECTION 11: FORENSIC TEST — STICKY OWNERSHIP PRESERVATION');
console.log('================================================================');

const stickyAudit = [];
for (const [acc, owner] of preOwnerMap.entries()) {
  const allocs = postAccAssignments[acc] || [];
  const activeEmps = new Set(allocs.filter(a => a.employee_id).map(a => a.employee_id));
  stickyAudit.push({
    Account: acc,
    Sticky_Owner_ID: owner.owner_employee_id,
    Sticky_Owner_Name: owner.owner_employee_name,
    New_Owners_Present: Array.from(activeEmps).join(', '),
    Preserved: activeEmps.has(owner.owner_employee_id) ? 'YES' : (allocs.length === 0 ? 'NO ORDERS' : 'CHANGED/UNASSIGNED')
  });
}
console.table(stickyAudit.slice(0, 15));

// -----------------------------------------------------------------------------
// SECTION 12: PENDING LIFECYCLE AUDIT
// -----------------------------------------------------------------------------
console.log('\n================================================================');
console.log('SECTION 12: FORENSIC TEST — PENDING LIFECYCLE & NEW ELIGIBILITY');
console.log('================================================================');

const dailyStates = db.prepare('SELECT * FROM employee_daily_allocation_states WHERE work_date = ?').all(workDate);
console.log('Employee Daily Allocation States Count:', dailyStates.length);
console.table(dailyStates.slice(0, 10));

// -----------------------------------------------------------------------------
// SECTION 13: ALLOCATION CONTRACT AUDIT
// -----------------------------------------------------------------------------
console.log('\n================================================================');
console.log('SECTION 13: FORENSIC TEST — ALLOCATION API CONTRACT');
console.log('================================================================');

console.log('Checking required canonical fields in API response:');
const contractChecks = {
  raw_allocations: Array.isArray(execResult.raw_allocations),
  by_employee: Array.isArray(execResult.by_employee),
  assigned_orders: typeof (execResult.assigned_orders ?? execResult.assigned_count) === 'number',
  unassigned_orders: typeof (execResult.unassigned_orders ?? execResult.unassigned_count) === 'number',
  total_orders: typeof execResult.total_orders === 'number',
  version_number: execResult.version_number !== undefined || execResult.configuration_version !== undefined,
  already_saved: typeof execResult.already_saved === 'boolean' || execResult.status === 'COMMITTED',
  success: execResult.success === true,
  status: typeof execResult.status === 'string'
};
console.table(contractChecks);
