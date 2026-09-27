import { db } from '../db/index.js';

async function main() {
  const date = '2026-09-26';
  const v = 11;

  console.log(`=== FULL FORENSIC OF VERSION 11 (${date}) ===`);

  // 1. All employees in V11 with their NEW, PENDING, and total orders
  const emps = db.prepare(`
    SELECT employee_name,
      SUM(CASE WHEN LOWER(status) NOT LIKE '%pending%' THEN 1 ELSE 0 END) as new_orders,
      SUM(CASE WHEN LOWER(status) LIKE '%pending%' THEN 1 ELSE 0 END) as pending_orders,
      COUNT(*) as total_orders
    FROM order_level_allocations
    WHERE allocation_date = ? AND allocation_version = ?
    GROUP BY employee_name
    ORDER BY new_orders DESC, pending_orders DESC
  `).all(date, v);

  console.log('\n--- Employee Lane Classification in V11 ---');
  let newOnlyCount = 0;
  let pendOnlyCount = 0;
  let bothCount = 0;
  for (const e of emps) {
    if (!e.employee_name || e.employee_name === 'UNASSIGNED') continue;
    if (e.new_orders > 0 && e.pending_orders > 0) bothCount++;
    else if (e.new_orders > 0) newOnlyCount++;
    else if (e.pending_orders > 0) pendOnlyCount++;
  }
  console.log(`NEW-only = ${newOnlyCount}, PENDING-only = ${pendOnlyCount}, BOTH = ${bothCount}`);

  // 2. Capacities of all employees in V11
  const caps = db.prepare(`
    SELECT e.id, e.name, e.team_membership, COALESCE(ec.max_orders, 40) as cap
    FROM daily_working_team dwt
    JOIN employees e ON e.id = dwt.employee_id
    LEFT JOIN employee_capacities ec ON ec.employee_id = e.id
    WHERE dwt.work_date = ? AND dwt.is_working = 1
  `).all(date);
  const capMap = new Map(caps.map(c => [c.name, c]));

  console.log('\n--- Capacities & Workloads of the 4 NEW Employees in V11 ---');
  const newEmps = emps.filter(e => e.new_orders > 0 && e.employee_name !== 'UNASSIGNED');
  for (const ne of newEmps) {
    const c = capMap.get(ne.employee_name);
    console.log(`${ne.employee_name}: Configured Cap=${c?.cap || 40}, V11 Assigned=${ne.total_orders}, Remaining=${(c?.cap || 40) - ne.total_orders}`);
  }

  console.log('\n--- Capacities & Workloads of the 21 PENDING Employees in V11 ---');
  const pendEmps = emps.filter(e => e.pending_orders > 0 && e.employee_name !== 'UNASSIGNED');
  for (const pe of pendEmps) {
    const c = capMap.get(pe.employee_name);
    console.log(`${pe.employee_name}: Configured Cap=${c?.cap || 40}, V11 Assigned=${pe.total_orders}, Remaining=${(c?.cap || 40) - pe.total_orders}`);
  }

  // 3. Clothes corner detailed order trace in V11
  console.log('\n--- Clothes Corner Orders in V11 ---');
  const ccOrders = db.prepare(`
    SELECT order_code, account, status, employee_name, work_state, rule_note, priority
    FROM order_level_allocations
    WHERE allocation_date = ? AND allocation_version = ? AND LOWER(account) = 'clothes corner'
  `).all(date, v);
  console.table(ccOrders);

  // 4. Accounts with 3+ employees in V11
  console.log('\n--- 3+ Employee Accounts Audit in V11 ---');
  const accGroupRows = db.prepare(`
    SELECT account, employee_name,
      SUM(CASE WHEN LOWER(status) NOT LIKE '%pending%' THEN 1 ELSE 0 END) as new_orders,
      SUM(CASE WHEN LOWER(status) LIKE '%pending%' THEN 1 ELSE 0 END) as pending_orders,
      COUNT(*) as total_orders
    FROM order_level_allocations
    WHERE allocation_date = ? AND allocation_version = ? AND employee_name IS NOT NULL AND employee_name != 'UNASSIGNED'
    GROUP BY account, employee_name
  `).all(date, v);

  const accDetailMap = new Map();
  for (const r of accGroupRows) {
    if (!accDetailMap.has(r.account)) {
      accDetailMap.set(r.account, { account: r.account, new_total: 0, pend_total: 0, emps: [] });
    }
    const a = accDetailMap.get(r.account);
    a.new_total += r.new_orders;
    a.pend_total += r.pending_orders;
    a.emps.push(r);
  }

  const accounts3Plus = Array.from(accDetailMap.values()).filter(a => a.emps.length >= 3);
  console.log(`Total 3+ Employee Accounts: ${accounts3Plus.length}`);
  for (const a of accounts3Plus) {
    const totalOrders = a.new_total + a.pend_total;
    const newEmpsUsed = a.emps.filter(e => e.new_orders > 0);
    const pendEmpsUsed = a.emps.filter(e => e.pending_orders > 0);
    const minNewEmpsNeeded = Math.ceil(a.new_total / 40);
    const minPendEmpsNeeded = Math.ceil(a.pend_total / 40);
    const minMathematicallyRequired = Math.max(minNewEmpsNeeded, a.new_total > 0 ? 1 : 0) + Math.max(minPendEmpsNeeded, a.pend_total > 0 ? 1 : 0);

    console.log(`\nAccount: "${a.account}"`);
    console.log(`  Total Orders: ${totalOrders} (NEW: ${a.new_total}, PENDING: ${a.pend_total})`);
    console.log(`  NEW Employees Used (${newEmpsUsed.length}): ${newEmpsUsed.map(e => `${e.employee_name} (${e.new_orders})`).join(', ') || 'None'}`);
    console.log(`  PENDING Employees Used (${pendEmpsUsed.length}): ${pendEmpsUsed.map(e => `${e.employee_name} (${e.pending_orders})`).join(', ') || 'None'}`);
    console.log(`  Total Employees Used: ${a.emps.length}`);
    console.log(`  Min Mathematically Required: ${minMathematicallyRequired} (Min NEW: ${minNewEmpsNeeded}, Min PENDING: ${minPendEmpsNeeded})`);
    console.log(`  Excess Employees: ${a.emps.length - minMathematicallyRequired}`);
  }
}

main().catch(console.error);
