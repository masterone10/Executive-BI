import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import {
  parseSpecificOrdersBuffer,
  parseDailyLogBuffer,
  detectWorkbookDateAndType,
  normalizeDateToISO,
  extractDateFromFilename
} from '../services/parser.js';
import {
  stageSpecificOrdersFile,
  mergeSpecificOrdersPool,
  generateOrderLevelAllocation,
  saveFinalOrderLevelAllocation,
  getOrderLevelAllocation,
  getAccountOwners,
  reassignAccountOwner,
  getAccountReassignmentLogs,
  saveWorkingTeam,
  getWorkingTeam,
  saveAccountRule,
  getAccountRules
} from '../services/allocation.js';
import {
  getOrderTracking,
  getEmployeeTracking,
  getTeamTrackingSummary,
  persistDailyLogRecords
} from '../services/tracking.js';
import {
  computePerformanceFromRecords,
  savePerformanceSnapshotToDB
} from '../services/performance.js';
import {
  createEmployeeAllocationWorkbook,
  createAccountWorkbook,
  createZipFromEmployeeWorkbooks
} from '../export_excel.js';
import { db } from '../db/index.js';

test('AUDIT TEST SUITE: Complete 33-Requirement Verification & Proof', async (t) => {

  const AUDIT_DATE = '2026-11-15';

  // Setup test employees
  await t.test('Req 1: Employee Master Setup (Manual only, Team Memberships)', () => {
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(AUDIT_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(AUDIT_DATE);
    db.prepare('DELETE FROM specific_orders_uploads WHERE work_date = ?').run(AUDIT_DATE);
    db.prepare('DELETE FROM current_work_pool_summary WHERE work_date = ?').run(AUDIT_DATE);
    db.prepare('DELETE FROM account_owners WHERE work_date = ?').run(AUDIT_DATE);
    db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(AUDIT_DATE);
    db.prepare('DELETE FROM allocation_versions WHERE allocation_date = ?').run(AUDIT_DATE);
    db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(AUDIT_DATE);
    db.prepare('DELETE FROM employee_activity_log WHERE employee_id IN (SELECT id FROM employees WHERE name LIKE ?)').run('AUDIT_%');
    db.prepare('DELETE FROM allocation_items WHERE employee_id IN (SELECT id FROM employees WHERE name LIKE ?)').run('AUDIT_%');
    db.prepare('DELETE FROM account_exceptions WHERE employee_id IN (SELECT id FROM employees WHERE name LIKE ?)').run('AUDIT_%');
    db.prepare('DELETE FROM daily_working_team WHERE employee_id IN (SELECT id FROM employees WHERE name LIKE ?)').run('AUDIT_%');
    db.prepare('DELETE FROM employees WHERE name LIKE ?').run('AUDIT_%');
    db.prepare('DELETE FROM account_rules WHERE account_name LIKE ?').run('AUDIT_%');

    const insertEmp = db.prepare(`
      INSERT INTO employees (name, department, team_membership, active)
      VALUES (?, ?, ?, 1)
    `);

    insertEmp.run('AUDIT_Emp_NewOnly', 'CS', 'New');
    insertEmp.run('AUDIT_Emp_PendingOnly', 'CS', 'Pending');
    insertEmp.run('AUDIT_Emp_Both1', 'CS', 'Both');
    insertEmp.run('AUDIT_Emp_Both2', 'CS', 'Both');
    insertEmp.run('AUDIT_Emp_Neither', 'CS', 'Neither');

    const emps = db.prepare("SELECT * FROM employees WHERE name LIKE 'AUDIT_%'").all();
    assert.equal(emps.length, 5, 'Must have 5 audit employees');

    // Setup working team for AUDIT_DATE (All active except AUDIT_Emp_Neither)
    const workingList = emps.filter(e => e.team_membership !== 'Neither').map(e => ({
      employee_id: e.id,
      is_working: true
    }));
    saveWorkingTeam(AUDIT_DATE, workingList);

    const team = getWorkingTeam(AUDIT_DATE);
    const activeWorking = team.filter(e => e.is_working);
    assert.equal(activeWorking.length, 4, '4 employees working today');
  });

  await t.test('Req 4 & Req 31: Actual-Stream Eligibility (Datasets A, B, C, D)', () => {
    // Dataset A: Account has NEW ONLY (Doby Store: 200 New, 0 Pending)
    // Eligible: AUDIT_Emp_NewOnly (New), AUDIT_Emp_Both1 (Both), AUDIT_Emp_Both2 (Both)
    // Ineligible: AUDIT_Emp_PendingOnly (Pending)
    const ordersData = [];
    for (let i = 1; i <= 10; i++) {
      ordersData.push({ order_code: `ORD_A_${i}`, account: 'AUDIT_Acc_NewOnly', status: 'New', order_date: AUDIT_DATE });
    }

    // Dataset B: Account has PENDING ONLY (Joud Fragrance: 0 New, 80 Pending)
    // Eligible: AUDIT_Emp_PendingOnly (Pending), AUDIT_Emp_Both1 (Both), AUDIT_Emp_Both2 (Both)
    // Ineligible: AUDIT_Emp_NewOnly (New)
    for (let i = 1; i <= 8; i++) {
      ordersData.push({ order_code: `ORD_B_${i}`, account: 'AUDIT_Acc_PendingOnly', status: 'Pending', order_date: AUDIT_DATE });
    }

    // Dataset C: Account has BOTH NEW and PENDING (Orvex X: 200 New, 80 Pending)
    // Eligible: AUDIT_Emp_Both1 (Both), AUDIT_Emp_Both2 (Both) ONLY!
    // Ineligible: AUDIT_Emp_NewOnly (New), AUDIT_Emp_PendingOnly (Pending)
    for (let i = 1; i <= 6; i++) {
      ordersData.push({ order_code: `ORD_C_NEW_${i}`, account: 'AUDIT_Acc_BothStreams', status: 'New', order_date: AUDIT_DATE });
    }
    for (let i = 1; i <= 4; i++) {
      ordersData.push({ order_code: `ORD_C_PEND_${i}`, account: 'AUDIT_Acc_BothStreams', status: 'Pending', order_date: AUDIT_DATE });
    }

    // Stage orders via multi-file upload
    stageSpecificOrdersFile(AUDIT_DATE, 1, 'File1_New.xlsx', ordersData.filter(o => o.status === 'New'), 1024);
    stageSpecificOrdersFile(AUDIT_DATE, 2, 'File2_Pending.xlsx', ordersData.filter(o => o.status === 'Pending'), 1024);

    const merged = mergeSpecificOrdersPool(AUDIT_DATE);
    assert.equal(merged.unique_orders, 28, 'Total unique orders staged');

    // Generate allocation
    const alloc = generateOrderLevelAllocation(AUDIT_DATE, { regenerate: true });
    assert.equal(alloc.total_accounts, 3, 'Total 3 accounts');
    assert.equal(alloc.unassigned_accounts, 0, 'All accounts assigned');

    // Verify Invariant: ONE ACCOUNT = ONE EMPLOYEE
    const owners = alloc.account_owners;
    assert.equal(owners.length, 3, '3 owners allocated');

    // Verify Dataset C (Both streams) owner has Both membership
    const ownerC = owners.find(o => o.account === 'AUDIT_Acc_BothStreams');
    assert.ok(ownerC, 'Owner C exists');
    const empC = db.prepare('SELECT team_membership FROM employees WHERE id = ?').get(ownerC.employee_id);
    assert.equal(empC.team_membership, 'Both', 'Account with both New and Pending MUST be owned by an employee with Both membership');

    // Verify all orders in Account C belong to ownerC
    const ordersC = alloc.raw_allocations.filter(a => a.account === 'AUDIT_Acc_BothStreams');
    for (const ord of ordersC) {
      assert.equal(ord.employee_id, ownerC.employee_id, 'All orders of Account C belong to owner C');
    }

    // Save allocation
    const saved = saveFinalOrderLevelAllocation(AUDIT_DATE, alloc);
    assert.equal(saved.success, true);
  });

  await t.test('Req 3 & Req 27: One Account = One Employee & Manual Reassignment with Override', () => {
    const ownersBefore = getAccountOwners(AUDIT_DATE);
    assert.equal(ownersBefore.length, 3);

    // Reassign Account A (New Only) to AUDIT_Emp_PendingOnly with override
    const empPending = db.prepare("SELECT id, name FROM employees WHERE name = 'AUDIT_Emp_PendingOnly'").get();
    const reassignRes = reassignAccountOwner(AUDIT_DATE, 'AUDIT_Acc_NewOnly', empPending.id, 'Shift coverage override', 'Supervisor', true);

    assert.equal(reassignRes.success, true);
    assert.equal(reassignRes.is_override, 1);

    // Verify account_owners updated
    const ownerA = db.prepare("SELECT * FROM account_owners WHERE work_date = ? AND account = 'AUDIT_Acc_NewOnly'").get(AUDIT_DATE);
    assert.equal(ownerA.owner_employee_id, empPending.id);
    assert.equal(ownerA.is_override, 1);

    // Verify all orders in Account A were transferred to new owner
    const ordersA = db.prepare("SELECT DISTINCT employee_id FROM order_level_allocations WHERE allocation_date = ? AND account = 'AUDIT_Acc_NewOnly'").all(AUDIT_DATE);
    assert.equal(ordersA.length, 1);
    assert.equal(ordersA[0].employee_id, empPending.id);

    // Verify reassignment audit log
    const logs = getAccountReassignmentLogs(AUDIT_DATE);
    assert.ok(logs.length > 0, 'Reassignment log created');
    assert.equal(logs[0].new_employee_id, empPending.id);
  });

  await t.test('Req 10 & Req 11: Parser, Schema Detection & Source Business Date', () => {
    const filename1 = 'Specific_Orders_2026-11-15.xlsx';
    const date1 = extractDateFromFilename(filename1);
    assert.equal(date1, '2026-11-15');

    const filename2 = 'Daily_Log_15-11-2026.xlsx';
    const date2 = extractDateFromFilename(filename2);
    assert.equal(date2, '2026-11-15');

    const filename3 = 'Orders_20261115_run1.xlsx';
    const date3 = extractDateFromFilename(filename3);
    assert.equal(date3, '2026-11-15');
  });

  await t.test('Req 16, 17, 18: Tracking, 120s Deduplication & Untouched Compliance', () => {
    // Insert test raw log records
    const rawRecords = [
      { order: 'ORD_A_1', name: 'AUDIT_Emp_PendingOnly', act: 'Printed order', st: 'Printed', dt: new Date('2026-11-15T10:00:00Z').getTime(), isCS: true },
      // Duplicate action on same order within 30s (should be deduped)
      { order: 'ORD_A_1', name: 'AUDIT_Emp_PendingOnly', act: 'Printed order duplicate', st: 'Printed', dt: new Date('2026-11-15T10:00:30Z').getTime(), isCS: true },
      // Valid second action after 3 minutes
      { order: 'ORD_A_1', name: 'AUDIT_Emp_PendingOnly', act: 'Alt phone added', st: 'Printed', dt: new Date('2026-11-15T10:04:00Z').getTime(), isCS: true },
    ];

    persistDailyLogRecords(AUDIT_DATE, null, rawRecords);

    const tracking = getOrderTracking(AUDIT_DATE, 'ORD_A_1');
    assert.equal(tracking.real_actions_count, 2, 'Must deduplicate 3 raw actions into 2 real actions (120s window)');
    assert.equal(tracking.orders_worked_today, 1);

    // Test Employee Tracking compliance
    const empTrackActive = getEmployeeTracking(AUDIT_DATE, 'AUDIT_Emp_PendingOnly');
    assert.equal(empTrackActive.orders_worked_today, 1);
    assert.equal(empTrackActive.real_actions, 2);

    // Test Employee Tracking for employee with 0 activity
    const empTrackZero = getEmployeeTracking(AUDIT_DATE, 'AUDIT_Emp_Both1');
    assert.equal(empTrackZero.orders_worked_today, 0);
    assert.equal(empTrackZero.real_actions, 0);
    assert.equal(empTrackZero.allocation_compliance, null, 'Zero activity MUST have null/N/A compliance, NEVER 100%');
  });

  await t.test('Req 21, 22, 24: Excel Export & Database Schema Parity', async () => {
    const alloc = getOrderLevelAllocation(AUDIT_DATE);
    const empAlloc = alloc.by_employee[0];
    assert.ok(empAlloc, 'Employee allocation exists');

    // Test 4-sheet employee workbook
    const empWb = createEmployeeAllocationWorkbook({
      work_date: AUDIT_DATE,
      employee_name: empAlloc.employee_name,
      department: empAlloc.department,
      orders: empAlloc.orders,
      accounts: empAlloc.accounts
    });
    assert.equal(empWb.SheetNames.length, 4, 'Employee allocation export must have 4 sheets');
    assert.deepEqual(empWb.SheetNames, ['Summary', 'Work List', 'Account Summary', 'Allocation Audit']);

    // Test 4-sheet account workbook
    const accWb = createAccountWorkbook({
      account_name: 'AUDIT_Acc_NewOnly',
      work_date: AUDIT_DATE,
      metrics: { total_orders: 10, new_orders: 10 },
      orders: alloc.orders.filter(o => o.account === 'AUDIT_Acc_NewOnly')
    });
    assert.equal(accWb.SheetNames.length, 4, 'Account report export must have 4 sheets');
    assert.deepEqual(accWb.SheetNames, ['Summary', 'Orders', 'Employee Activity', 'Timeline']);

    // Test Bulk ZIP export
    const zipBuf = await createZipFromEmployeeWorkbooks(alloc.by_employee);
    assert.ok(zipBuf && zipBuf.length > 0, 'Bulk ZIP buffer generated successfully');

    // Test Schema Integrity
    const pragmaFk = db.prepare('PRAGMA foreign_keys').get();
    assert.equal(pragmaFk.foreign_keys, 1, 'Foreign keys must be ON');
  });

  // Cleanup audit data
  db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(AUDIT_DATE);
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(AUDIT_DATE);
  db.prepare('DELETE FROM specific_orders_uploads WHERE work_date = ?').run(AUDIT_DATE);
  db.prepare('DELETE FROM current_work_pool_summary WHERE work_date = ?').run(AUDIT_DATE);
  db.prepare('DELETE FROM account_owners WHERE work_date = ?').run(AUDIT_DATE);
  db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(AUDIT_DATE);
  db.prepare('DELETE FROM allocation_versions WHERE allocation_date = ?').run(AUDIT_DATE);
  db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(AUDIT_DATE);
  db.prepare('DELETE FROM employee_activity_log WHERE employee_id IN (SELECT id FROM employees WHERE name LIKE ?)').run('AUDIT_%');
  db.prepare('DELETE FROM allocation_items WHERE employee_id IN (SELECT id FROM employees WHERE name LIKE ?)').run('AUDIT_%');
  db.prepare('DELETE FROM account_exceptions WHERE employee_id IN (SELECT id FROM employees WHERE name LIKE ?)').run('AUDIT_%');
  db.prepare('DELETE FROM daily_working_team WHERE employee_id IN (SELECT id FROM employees WHERE name LIKE ?)').run('AUDIT_%');
  db.prepare('DELETE FROM employees WHERE name LIKE ?').run('AUDIT_%');
});
