import { db } from '../db/index.js';

async function main() {
  const workDate = '2026-09-26';
  const vNum = 11;

  console.log(`=== AUDIT V11 FORENSICS FOR ${workDate} (v${vNum}) ===`);

  // 1. Employee totals in v11
  const empStats = db.prepare(`
    SELECT employee_name,
      SUM(CASE WHEN LOWER(status) NOT LIKE '%pending%' THEN 1 ELSE 0 END) as new_orders,
      SUM(CASE WHEN LOWER(status) LIKE '%pending%' THEN 1 ELSE 0 END) as pending_orders,
      COUNT(*) as total_orders
    FROM order_level_allocations
    WHERE allocation_date = ? AND allocation_version = ?
    GROUP BY employee_name
    ORDER BY total_orders DESC
  `).all(workDate, vNum);

  console.log('\n--- Employee Allocations in V11 ---');
  console.table(empStats);

  // 2. Capacities of employees
  const caps = db.prepare(`
    SELECT e.id, e.name, e.team_membership, COALESCE(ec.max_orders, 40) as configured_cap
    FROM employees e
    LEFT JOIN employee_capacities ec ON ec.employee_id = e.id
    WHERE e.active = 1
  `).all();
  const capMap = new Map(caps.map(c => [c.name, c]));

  // Compare each employee's assigned vs configured_cap
  console.log('\n--- Employee Capacities vs V11 Assigned ---');
  for (const s of empStats) {
    if (s.employee_name === 'UNASSIGNED' || !s.employee_name) continue;
    const c = capMap.get(s.employee_name);
    const cap = c ? c.configured_cap : 40;
    console.log(`${s.employee_name}: Assigned=${s.total_orders} (NEW=${s.new_orders}, PEND=${s.pending_orders}), Cap=${cap}, Rem=${cap - s.total_orders}`);
  }

  // 3. Clothes corner orders in v11
  console.log('\n--- Clothes Corner Orders in V11 ---');
  const ccRows = db.prepare(`
    SELECT order_code, account, status, employee_name, work_state, rule_note, priority
    FROM order_level_allocations
    WHERE allocation_date = ? AND allocation_version = ? AND LOWER(account) = 'clothes corner'
  `).all(workDate, vNum);
  console.table(ccRows);

  // 4. Accounts breakdown in v11: 1-emp, 2-emp, 3+-emp
  const accRows = db.prepare(`
    SELECT account, employee_name, COUNT(*) as cnt
    FROM order_level_allocations
    WHERE allocation_date = ? AND allocation_version = ? AND employee_name IS NOT NULL AND employee_name != 'UNASSIGNED'
    GROUP BY account, employee_name
  `).all(workDate, vNum);

  const accMap = new Map();
  for (const r of accRows) {
    if (!accMap.has(r.account)) accMap.set(r.account, []);
    accMap.get(r.account).push({ employee: r.employee_name, count: r.cnt });
  }

  const accounts1 = [];
  const accounts2 = [];
  const accounts3Plus = [];

  for (const [acc, emps] of accMap.entries()) {
    if (emps.length === 1) accounts1.push({ acc, emps });
    else if (emps.length === 2) accounts2.push({ acc, emps });
    else accounts3Plus.push({ acc, emps });
  }

  console.log(`\nAccount Fragmentation Summary in V11:`);
  console.log(`1 employee: ${accounts1.length}`);
  console.log(`2 employees: ${accounts2.length}`);
  console.log(`3+ employees: ${accounts3Plus.length}`);

  console.log('\n--- Accounts with 3+ employees in V11 ---');
  for (const item of accounts3Plus) {
    const totalOrders = item.emps.reduce((s, e) => s + e.count, 0);
    console.log(`Account "${item.acc}": Total Assigned=${totalOrders}, Employees (${item.emps.length}):`);
    for (const e of item.emps) {
      console.log(`  - ${e.employee}: ${e.count}`);
    }
  }

  // Unassigned / unresolved accounts
  const unassignedRows = db.prepare(`
    SELECT account, count(*) as cnt
    FROM order_level_allocations
    WHERE allocation_date = ? AND allocation_version = ? AND (employee_name IS NULL OR employee_name = 'UNASSIGNED')
    GROUP BY account
  `).all(workDate, vNum);
  console.log(`\nUnassigned Accounts in V11 (${unassignedRows.length}):`);
  console.table(unassignedRows);
}

main().catch(console.error);
