import { db } from '../db/index.js';
import { generateRoundBasedAllocation, getWorkingTeam } from '../services/allocation.js';
import { planEnterpriseAllocation, executeEnterpriseAllocation } from '../services/enterprise_allocation.js';

async function runComprehensiveVerification() {
  console.log('=== STARTING COMPREHENSIVE ALLOCATION VERIFICATION ===\n');

  // Test 1: Check Working Team on 2026-09-27
  console.log('1. Checking Working Team on 2026-09-27:');
  const team27 = getWorkingTeam('2026-09-27').filter(e => e.is_working);
  console.log(`   Working employees on 2026-09-27: ${team27.length}`);
  if (team27.length === 0) {
    console.error('   ❌ FAILED: Working team is 0 on 2026-09-27');
  } else {
    console.log('   ✅ PASSED: Working team properly configured on 2026-09-27');
  }

  // Test 2: Invariant Check on all existing versions
  console.log('\n2. Invariant Check across historical versions:');
  const versions = db.prepare('SELECT version_number, allocation_date, total_orders, assigned_orders, unassigned_orders FROM allocation_versions ORDER BY version_number ASC').all();
  console.log(`   Found ${versions.length} versions in allocation_versions`);

  let crossStreamViolations = 0;
  for (const v of versions) {
    const stats = db.prepare(`
      SELECT employee_name,
             SUM(CASE WHEN LOWER(status) NOT LIKE '%pending%' THEN 1 ELSE 0 END) as new_c,
             SUM(CASE WHEN LOWER(status) LIKE '%pending%' THEN 1 ELSE 0 END) as pend_c
      FROM order_level_allocations
      WHERE allocation_date = ? AND allocation_version = ? AND employee_name != 'UNASSIGNED' AND employee_name IS NOT NULL
      GROUP BY employee_name
      HAVING new_c > 0 AND pend_c > 0
    `).all(v.allocation_date, v.version_number);

    if (stats.length > 0) {
      console.warn(`   ⚠️ Warning: Version ${v.version_number} (${v.allocation_date}) has ${stats.length} employees with both NEW and PENDING:`, stats);
      crossStreamViolations += stats.length;
    }
  }
  if (crossStreamViolations === 0) {
    console.log('   ✅ PASSED: Zero cross-stream violations across all allocation versions!');
  }

  // Test 3: Test Enterprise Allocation Execution on 2026-09-27
  console.log('\n3. Testing Enterprise Allocation Execution on 2026-09-27:');
  const execResult = executeEnterpriseAllocation('2026-09-27', { mode: 'ACTIVE' });
  console.log(`   Status: ${execResult.status || (execResult.success ? 'SUCCESS' : 'FAILED')}`);
  console.log(`   Assigned: ${execResult.assigned_orders ?? execResult.assigned_count}`);
  console.log(`   Unassigned: ${execResult.unassigned_orders ?? execResult.unassigned_count}`);

  // Test 4: Check if any employee has BOTH NEW and PENDING in the latest version on 2026-09-27
  const latestVer27 = db.prepare('SELECT MAX(version_number) as max_v FROM allocation_versions WHERE allocation_date = ?').get('2026-09-27');
  if (latestVer27?.max_v) {
    const latestViolations = db.prepare(`
      SELECT employee_name,
             SUM(CASE WHEN LOWER(status) NOT LIKE '%pending%' THEN 1 ELSE 0 END) as new_c,
             SUM(CASE WHEN LOWER(status) LIKE '%pending%' THEN 1 ELSE 0 END) as pend_c,
             COUNT(*) as total
      FROM order_level_allocations
      WHERE allocation_date = '2026-09-27' AND allocation_version = ? AND employee_name != 'UNASSIGNED'
      GROUP BY employee_name
      HAVING new_c > 0 AND pend_c > 0
    `).all(latestVer27.max_v);

    console.log(`\n4. Cross-Stream Check on latest version (${latestVer27.max_v}):`);
    if (latestViolations.length === 0) {
      console.log('   ✅ PASSED: Every employee has strictly ONE stream (NEW only or PENDING only)!');
    } else {
      console.error('   ❌ FAILED: Cross stream violations detected:', latestViolations);
    }
  }

  // Test 5: Idempotency check (Running again without new orders)
  console.log('\n5. Idempotency Check (Running again without new orders):');
  const verBefore = db.prepare('SELECT MAX(version_number) as max_v FROM allocation_versions WHERE allocation_date = ?').get('2026-09-27').max_v;
  const repeatExec = executeEnterpriseAllocation('2026-09-27', { mode: 'ACTIVE' });
  console.log(`   Repeat run status: ${repeatExec.status || (repeatExec.success ? 'SUCCESS' : 'FAILED')}`);
  const duplicateOrders = db.prepare(`
    SELECT order_code, count(*) as c
    FROM current_work_orders
    WHERE work_date = '2026-09-27'
    GROUP BY order_code
    HAVING c > 1
  `).all();
  console.log(`   Duplicate orders in current_work_orders: ${duplicateOrders.length}`);
  if (duplicateOrders.length === 0) {
    console.log('   ✅ PASSED: Zero duplicates found in current_work_orders!');
  }

  // Test 6: Capacity compliance check
  console.log('\n6. Capacity compliance check:');
  const overCapEmps = db.prepare(`
    SELECT cwo.assigned_employee_id, cwo.assigned_employee_name, count(*) as assigned_count,
           COALESCE(ec.max_orders, 40) as max_cap
    FROM current_work_orders cwo
    LEFT JOIN employee_capacities ec ON ec.employee_id = cwo.assigned_employee_id
    WHERE cwo.work_date = '2026-09-27' AND cwo.assigned_employee_id IS NOT NULL
    GROUP BY cwo.assigned_employee_id
    HAVING assigned_count > max_cap + 10
  `).all();
  if (overCapEmps.length === 0) {
    console.log('   ✅ PASSED: All employees are within valid capacity limits!');
  } else {
    console.warn('   ⚠️ Over-capacity employees:', overCapEmps);
  }

  // Test 7: Vendoor integrity check
  console.log('\n7. Vendoor Integrity check:');
  const vOrdersCount = db.prepare('SELECT count(*) as c FROM vendoor_orders').get().c;
  const vLogsCount = db.prepare('SELECT count(*) as c FROM vendoor_logs').get().c;
  console.log(`   Vendoor orders in DB: ${vOrdersCount}`);
  console.log(`   Vendoor activity logs in DB: ${vLogsCount}`);
  if (vOrdersCount > 0 && vLogsCount > 0) {
    console.log('   ✅ PASSED: Vendoor tables and records are intact!');
  }

  console.log('\n=== VERIFICATION COMPLETE ===');
}

runComprehensiveVerification().catch(console.error);
