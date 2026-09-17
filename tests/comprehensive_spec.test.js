import assert from 'assert';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { db } from '../db/index.js';
import {
  saveAccountRule,
  getAccountRules,
  deleteAccountRule,
  saveAccountException,
  getAccountExceptions,
  deleteAccountException,
  generateOrderLevelAllocation,
  saveFinalOrderLevelAllocation,
  getOrderLevelAllocation,
  getAllocationVersions,
  manualOverrideOrderAllocation,
  getEmployeeAssignedOrders,
  updateEmployeeTeamMembership,
  bulkUpdateTeamMembership,
  getEmployeeTeamMemberships
} from '../services/allocation.js';
import {
  createEmployeeAllocationWorkbook,
  createAccountWorkbook,
  createZipFromEmployeeWorkbooks
} from '../export_excel.js';
import {
  getAccountsDirectory,
  getAccountDetailedData
} from '../services/tracking.js';

console.log('--- STARTING SPECIFICATION COMPLIANCE VERIFICATION TESTS ---');

async function runSpecTests() {
  const testDate = '2026-09-08';

  // 1. Test Team Membership
  console.log('Testing: Permanent Team Membership...');
  const employees = db.prepare('SELECT id, name FROM employees WHERE active = 1 LIMIT 3').all();
  assert.ok(employees.length >= 2, 'Need at least 2 active employees');

  updateEmployeeTeamMembership(employees[0].id, 'New');
  updateEmployeeTeamMembership(employees[1].id, 'Pending');

  const memberships = getEmployeeTeamMemberships();
  const m0 = memberships.find(m => m.id === employees[0].id);
  const m1 = memberships.find(m => m.id === employees[1].id);
  assert.strictEqual(m0.team_membership, 'New');
  assert.strictEqual(m1.team_membership, 'Pending');
  console.log('✓ PASS: Team membership assignments verified.');

  // 2. Test Account Rules & Exceptions
  console.log('Testing: Account Rules & Exception Overrides...');
  const rule1 = saveAccountRule({
    account: 'TestVIPAccount',
    new_eligible: [employees[0].id],
    pending_eligible: [employees[1].id],
    active: 1,
    notes: 'Rule for VIP'
  });
  assert.strictEqual(rule1.success, true);
  assert.ok(rule1.id > 0);

  const allRules = getAccountRules();
  const foundRule = allRules.find(r => r.account === 'TestVIPAccount');
  assert.ok(foundRule);
  assert.strictEqual(foundRule.active, true);
  assert.ok(foundRule.new_eligible.includes(employees[0].id));

  const exc1 = saveAccountException({
    work_date: testDate,
    account: 'TestVIPAccount',
    exception_type: 'force_assign',
    employee_id: employees[1].id,
    notes: 'Override dedicated employee for today'
  });
  assert.strictEqual(exc1.success, true);

  const allExc = getAccountExceptions(testDate);
  assert.ok(allExc.some(e => e.account === 'TestVIPAccount'));
  console.log('✓ PASS: Account Rules & Exceptions verified.');

  // 3. Test Order-Level Allocation Generation & Capacity Fairness
  console.log('Testing: Order-Level Allocation Engine...');
  // Seed sample work orders for testing allocation
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(testDate);
  const insertOrder = db.prepare(`
    INSERT INTO current_work_orders (
      work_date, order_code, account, status, source_file_slot, order_date
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (let i = 1; i <= 30; i++) {
      insertOrder.run(
        testDate,
        `ORD-SPEC-NEW-${i}`,
        i <= 10 ? 'TestVIPAccount' : (i <= 20 ? 'AccountAlpha' : 'AccountBeta'),
        'New',
        1,
        testDate
      );
    }
    for (let i = 1; i <= 20; i++) {
      insertOrder.run(
        testDate,
        `ORD-SPEC-PEND-${i}`,
        i <= 10 ? 'AccountAlpha' : 'AccountBeta',
        'Pending',
        2,
        testDate
      );
    }
  });
  tx();

  // Set working team for testDate
  db.prepare(`
    INSERT INTO daily_working_team (work_date, employee_id, is_working)
    VALUES (?, ?, 1), (?, ?, 1)
    ON CONFLICT(work_date, employee_id) DO UPDATE SET is_working = 1
  `).run(testDate, employees[0].id, testDate, employees[1].id);

  const allocResult = generateOrderLevelAllocation(testDate, {
    strategy: 'FAIR_RANDOM',
    notes: 'Unit test automated generation'
  });
  assert.strictEqual(allocResult.success, true);
  assert.strictEqual(allocResult.total_orders, 50);

  const saveRes = saveFinalOrderLevelAllocation(testDate, allocResult, 'Unit test saved allocation');
  assert.strictEqual(saveRes.success, true);
  assert.ok(saveRes.version_number >= 1);

  const orderAlloc = getOrderLevelAllocation(testDate, saveRes.version_number);
  assert.strictEqual(orderAlloc.total_orders, 50);
  assert.ok(orderAlloc.orders.length === 50);
  assert.ok(orderAlloc.by_employee.length >= 1);
  console.log('✓ PASS: Order-level allocation generated and persisted.');

  // 4. Test Manual Override & Allocation Versioning
  console.log('Testing: Manual Order Allocation Override...');
  const targetOrder = orderAlloc.orders[0];
  const overrideRes = manualOverrideOrderAllocation(testDate, saveRes.version_number, targetOrder.order_code, employees[1].id);
  assert.strictEqual(overrideRes.success, true);

  const updatedAlloc = getOrderLevelAllocation(testDate, saveRes.version_number);
  const updatedOrder = updatedAlloc.orders.find(o => o.order_code === targetOrder.order_code);
  assert.strictEqual(updatedOrder.employee_id, employees[1].id);
  assert.strictEqual(updatedOrder.is_override, 1);
  console.log('✓ PASS: Manual override verified.');

  // 5. Test Excel Workbooks Generation
  console.log('Testing: Single Employee & ZIP Export Generation...');
  const empAssigned = getEmployeeAssignedOrders(testDate, employees[1].id, saveRes.version_number);
  assert.ok(empAssigned);
  assert.strictEqual(empAssigned.employee_id, employees[1].id);
  assert.ok(empAssigned.orders.length > 0);

  const empWb = createEmployeeAllocationWorkbook(empAssigned);
  assert.ok(empWb.SheetNames.includes('Work List'));
  assert.ok(empWb.SheetNames.includes('Summary'));
  assert.ok(empWb.SheetNames.includes('Account Summary'));
  assert.ok(empWb.SheetNames.includes('Allocation Audit'));

  const employeeList = [empAssigned];
  const zipBuf = await createZipFromEmployeeWorkbooks(employeeList, testDate);
  assert.ok(Buffer.isBuffer(zipBuf));
  assert.ok(zipBuf.length > 100);
  console.log('✓ PASS: Employee Excel workbook and ZIP exports verified.');

  // 6. Test Accounts Directory & Detailed Views
  console.log('Testing: Accounts Directory & 4-Sheet Account Workbook...');
  const accDir = getAccountsDirectory(testDate);
  assert.ok(accDir && Array.isArray(accDir.accounts));
  assert.ok(accDir.accounts.length >= 3);
  assert.ok(accDir.accounts.some(a => a.account_name === 'TestVIPAccount'));

  const accDetail = getAccountDetailedData(testDate, 'TestVIPAccount');
  assert.strictEqual(accDetail.account_name, 'TestVIPAccount');
  assert.strictEqual(accDetail.metrics.total_orders, 10);
  assert.strictEqual(accDetail.orders.length, 10);

  const accWb = createAccountWorkbook(accDetail);
  assert.strictEqual(accWb.SheetNames.length, 4);
  assert.strictEqual(accWb.SheetNames[0], 'Summary');
  assert.strictEqual(accWb.SheetNames[1], 'Orders');
  assert.strictEqual(accWb.SheetNames[2], 'Employee Activity');
  assert.strictEqual(accWb.SheetNames[3], 'Timeline');
  console.log('✓ PASS: Accounts Directory and 4-Sheet Workbook verified.');

  // Clean up
  deleteAccountRule(rule1.id);
  deleteAccountException(exc1.id);

  console.log('--- ALL SPECIFICATION COMPLIANCE TESTS PASSED SUCCESSFULLY! ---');
}

runSpecTests().catch(err => {
  console.error('SPEC TEST FAILED:', err);
  process.exit(1);
});
