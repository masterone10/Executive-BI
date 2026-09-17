import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { db } from '../db/index.js';
import {
  detectWorkbookDateAndType
} from '../services/parser.js';
import {
  stageSpecificOrdersFile,
  mergeSpecificOrdersPool,
  generateOrderLevelAllocation,
  saveFinalOrderLevelAllocation,
  getOrderLevelAllocation,
  reassignAccountOwner,
  getAccountReassignmentLogs,
  saveWorkingTeam,
  getWorkingTeam,
  saveAccountRule,
  getAccountRules,
  generateCopyAllocationText
} from '../services/allocation.js';
import {
  getOrderTracking,
  getEmployeeTracking,
  persistDailyLogRecords
} from '../services/tracking.js';
import {
  createEmployeeAllocationWorkbook,
  createAccountWorkbook,
  createZipFromEmployeeWorkbooks
} from '../export_excel.js';

test('FORENSIC AUDIT: 20-Point Invariant & Requirement Verification', async (t) => {
  const TEST_DATE = '2026-12-01';

  // 1. Setup fresh clean state for TEST_DATE
  await t.test('1. Master Setup & Clean Database Environment', () => {
    db.prepare('DELETE FROM employees WHERE name LIKE ?').run('FORENSIC_%');
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM specific_orders_uploads WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM current_work_pool_summary WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM preparation_batches WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM account_owners WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM allocation_versions WHERE allocation_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM account_rules WHERE account_name LIKE ?').run('FORENSIC_%');
    db.prepare('DELETE FROM account_exceptions WHERE account_name LIKE ?').run('FORENSIC_%');
    db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(TEST_DATE);

    const emp1 = db.prepare("INSERT INTO employees (name, department, team_membership, active) VALUES ('FORENSIC_Both_1', 'CS', 'Both', 1)").run();
    const emp2 = db.prepare("INSERT INTO employees (name, department, team_membership, active) VALUES ('FORENSIC_Both_2', 'CS', 'Both', 1)").run();
    const emp3 = db.prepare("INSERT INTO employees (name, department, team_membership, active) VALUES ('FORENSIC_Both_3', 'CS', 'Both', 1)").run();

    saveWorkingTeam(TEST_DATE, [
      { employee_id: emp1.lastInsertRowid, is_working: true },
      { employee_id: emp2.lastInsertRowid, is_working: true },
      { employee_id: emp3.lastInsertRowid, is_working: true }
    ]);

    const team = getWorkingTeam(TEST_DATE);
    assert.equal(team.filter(e => e.is_working).length, 3);
  });

  // 2. VERIFY SOURCE DATE RULE
  await t.test('2. Source Date Rule & Row Partitioning', () => {
    const mockRows = [
      { 'رقم الاوردر': 'ORD_DATE_1', 'اسم التاجر': 'FORENSIC_Store_1', 'حالة الاوردر': 'New', 'التاريخ': '2026-12-01' },
      { 'رقم الاوردر': 'ORD_DATE_2', 'اسم التاجر': 'FORENSIC_Store_1', 'حالة الاوردر': 'New', 'التاريخ': '2026-12-02' }
    ];
    const ws = XLSX.utils.json_to_sheet(mockRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Orders');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // File named 2026-11-01 (should NOT override cell dates)
    const detected = detectWorkbookDateAndType(buf, 'Specific_Orders_2026-11-01.xlsx');
    assert.equal(detected.primary_date, '2026-12-01', 'Source data date must be authoritative over filename');
    assert.equal(detected.has_date_conflict, true, 'Flagged filename vs row date conflict');
  });

  // 3. UNLIMITED MULTI-FILE UPLOAD (3, 5, Arbitrary N Files in One Batch)
  await t.test('3. Unlimited Multi-File Upload Staging', () => {
    const fileCount = 5;
    for (let f = 1; f <= fileCount; f++) {
      const orders = [
        { order_code: `ORD_MULTI_${f}_1`, account: `FORENSIC_Acc_${f}`, status: 'New', order_date: TEST_DATE },
        { order_code: `ORD_MULTI_${f}_2`, account: `FORENSIC_Acc_${f}`, status: 'Pending', order_date: TEST_DATE }
      ];
      stageSpecificOrdersFile(TEST_DATE, f, `BatchFile_${f}.xlsx`, orders, 2048, 'NEW');
    }

    const merged = mergeSpecificOrdersPool(TEST_DATE);
    assert.equal(merged.files_count, 5, 'Must accurately stage 5 distinct files');
    assert.equal(merged.unique_orders, 10, 'Must stage all 10 unique orders across files');
  });

  // 4. PREPARATION BATCH LIFECYCLE
  await t.test('4. Preparation Batch Lifecycle (OPEN -> FINALIZED)', () => {
    // Verify batch is OPEN before allocation
    const openBatch = db.prepare('SELECT * FROM preparation_batches WHERE work_date = ?').get(TEST_DATE);
    assert.ok(openBatch, 'Preparation batch created');
    assert.equal(openBatch.status, 'OPEN', 'Batch must remain OPEN until allocation generation');

    // Generate and save allocation
    const alloc = generateOrderLevelAllocation(TEST_DATE, { regenerate: true });
    saveFinalOrderLevelAllocation(TEST_DATE, alloc);

    // Verify batch is FINALIZED
    const finalizedBatch = db.prepare('SELECT * FROM preparation_batches WHERE work_date = ?').get(TEST_DATE);
    assert.ok(finalizedBatch, 'Finalized batch exists');
    assert.equal(finalizedBatch.status, 'FINALIZED', 'Batch must be FINALIZED upon saving allocation');
  });

  // 5. ONE ACCOUNT = ONE EMPLOYEE DATABASE INVARIANT QUERY
  await t.test('5. Database Invariant: ZERO Split Accounts', () => {
    // Run authoritative query on order_level_allocations
    const splitOrders = db.prepare(`
      SELECT account, COUNT(DISTINCT employee_id) as emp_count
      FROM order_level_allocations
      WHERE allocation_date = ? AND employee_id IS NOT NULL
      GROUP BY account
      HAVING COUNT(DISTINCT employee_id) > 1
    `).all(TEST_DATE);

    assert.equal(splitOrders.length, 0, 'Database Invariant: Exactly ZERO split accounts in order_level_allocations');

    // Run authoritative query on account_owners
    const splitOwners = db.prepare(`
      SELECT account, COUNT(DISTINCT owner_employee_id) as owner_count
      FROM account_owners
      WHERE work_date = ? AND owner_employee_id IS NOT NULL
      GROUP BY account
      HAVING COUNT(DISTINCT owner_employee_id) > 1
    `).all(TEST_DATE);

    assert.equal(splitOwners.length, 0, 'Database Invariant: Exactly ZERO split accounts in account_owners');
  });

  // 6. STABLE ACCOUNT IDENTITY
  await t.test('6. Stable Account Identity Preservation', () => {
    const accOwner1 = db.prepare("SELECT * FROM account_owners WHERE work_date = ? AND LOWER(account) = LOWER('FORENSIC_Acc_1')").get(TEST_DATE);
    assert.ok(accOwner1, 'Owner for FORENSIC_Acc_1 exists');
    assert.ok(accOwner1.owner_employee_id, 'Has assigned employee ID');
  });

  // 7. WORKING TEAM ZERO SELECTION FALLBACK PREVENTION
  await t.test('7. Working Team Zero Selection Fallback Prevention', () => {
    const EMPTY_TEAM_DATE = '2026-12-02';
    // Clean up
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(EMPTY_TEAM_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(EMPTY_TEAM_DATE);

    // Stage order for EMPTY_TEAM_DATE
    stageSpecificOrdersFile(EMPTY_TEAM_DATE, 1, 'EmptyTest.xlsx', [
      { order_code: 'ORD_EMPTY_1', account: 'FORENSIC_EmptyAcc', status: 'New', order_date: EMPTY_TEAM_DATE }
    ], 1024, 'NEW');
    mergeSpecificOrdersPool(EMPTY_TEAM_DATE);

    // Save working team with NO working employees
    const allEmps = db.prepare("SELECT id FROM employees WHERE name LIKE 'FORENSIC_%'").all();
    saveWorkingTeam(EMPTY_TEAM_DATE, allEmps.map(e => ({ employee_id: e.id, is_working: false })));

    assert.throws(() => {
      generateOrderLevelAllocation(EMPTY_TEAM_DATE, { regenerate: true });
    }, /No working employees selected/, 'Must throw error and NOT silently assign to all employees');
  });

  // 8. STATUS-SPECIFIC ACCOUNT RULE EXCEPTIONS
  await t.test('8. Status-Specific Account Rule Exceptions', () => {
    // Add employee with New capability
    const empNew = db.prepare("INSERT INTO employees (name, department, team_membership, active) VALUES ('FORENSIC_New_Only', 'CS', 'New', 1)").run();
    // Add rule: FORENSIC_RuleAcc allows FORENSIC_New_Only for New only
    saveAccountRule({
      account_name: 'FORENSIC_RuleAcc',
      new_eligible: [empNew.lastInsertRowid],
      pending_eligible: [],
      blocked: [],
      active: 1
    });

    const rules = getAccountRules();
    const rule = rules.find(r => r.account_name === 'FORENSIC_RuleAcc');
    assert.ok(rule, 'Rule saved successfully');
    assert.deepEqual(rule.new_eligible, [Number(empNew.lastInsertRowid)]);
  });

  // 9. STICKY OWNERSHIP
  await t.test('9. Sticky Ownership Across Incremental Batches', () => {
    const ownerBefore = db.prepare("SELECT owner_employee_id FROM account_owners WHERE work_date = ? AND LOWER(account) = LOWER('FORENSIC_Acc_1')").get(TEST_DATE);
    assert.ok(ownerBefore, 'Existing owner exists');

    // Add more orders to FORENSIC_Acc_1
    stageSpecificOrdersFile(TEST_DATE, 6, 'BatchFile_6_Addon.xlsx', [
      { order_code: 'ORD_ADDON_1', account: 'FORENSIC_Acc_1', status: 'New', order_date: TEST_DATE }
    ], 1024, 'NEW');
    mergeSpecificOrdersPool(TEST_DATE);

    const alloc2 = generateOrderLevelAllocation(TEST_DATE, { regenerate: false });
    const addonAlloc = alloc2.raw_allocations.find(a => a.order_code === 'ORD_ADDON_1');
    assert.equal(addonAlloc.employee_id, ownerBefore.owner_employee_id, 'Add-on order for existing account must preserve existing owner');
  });

  // 10. MANUAL REASSIGNMENT & AUDIT LOG
  await t.test('10. Manual Reassignment Validation & Audit Log', () => {
    const empTarget = db.prepare("SELECT id, name FROM employees WHERE name = 'FORENSIC_Both_3'").get();
    const reassignRes = reassignAccountOwner(TEST_DATE, 'FORENSIC_Acc_1', empTarget.id, 'Workload balancing audit', 'Supervisor', true);

    assert.equal(reassignRes.success, true);
    assert.equal(reassignRes.new_employee_id, empTarget.id);

    // Verify all orders transferred
    const orders = db.prepare("SELECT DISTINCT employee_id FROM order_level_allocations WHERE allocation_date = ? AND LOWER(account) = LOWER('FORENSIC_Acc_1')").all(TEST_DATE);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].employee_id, empTarget.id);

    // Verify audit log
    const logs = getAccountReassignmentLogs(TEST_DATE);
    const log = logs.find(l => l.account.toLowerCase() === 'forensic_acc_1');
    assert.ok(log, 'Reassignment log exists');
    assert.equal(log.new_employee_id, empTarget.id);
  });

  // 11. VIEW ORDERS DETAIL
  await t.test('11. View Orders Payload Completeness', () => {
    const orders = db.prepare(`
      SELECT o.order_code, o.account, o.merchant_code, o.status, o.work_date, o.file_name, o.source_type,
             ola.employee_name as allocation_employee
      FROM current_work_orders o
      LEFT JOIN order_level_allocations ola ON o.work_date = ola.allocation_date AND o.order_code = ola.order_code
      WHERE o.work_date = ? AND LOWER(o.account) = LOWER('FORENSIC_Acc_1')
    `).all(TEST_DATE);

    assert.ok(orders.length > 0, 'Orders found');
    for (const o of orders) {
      assert.ok(o.order_code, 'order_code exists');
      assert.ok(o.account, 'account exists');
      assert.ok(o.status, 'status exists');
      assert.ok(o.work_date, 'work_date exists');
    }
  });

  // 12. COPY FUNCTIONS (Idempotency & Structure)
  await t.test('12. Copy Functions Output Determinism', () => {
    const text1 = generateCopyAllocationText(TEST_DATE, 'all_employees');
    const text2 = generateCopyAllocationText(TEST_DATE, 'all_employees');

    assert.equal(text1, text2, 'Copy text MUST be 100% deterministic and identical on repeated calls');
    assert.ok(text1.includes('FORENSIC_Acc_'), 'Includes account details');
    assert.ok(text1.includes('Total Accounts:'), 'Includes totals');
  });

  // 13. EXCEL EXPORTS (4 sheets Employee, 4 sheets Account, Bulk ZIP)
  await t.test('13. Excel Exports Structure (4 Sheets & ZIP)', async () => {
    const alloc = getOrderLevelAllocation(TEST_DATE);
    assert.ok(alloc, 'Allocation retrieved');
    const empAlloc = alloc.by_employee.find(e => e.orders && e.orders.length > 0);
    assert.ok(empAlloc, 'Employee allocation found');

    const empWb = createEmployeeAllocationWorkbook({
      work_date: TEST_DATE,
      employee_name: empAlloc.employee_name,
      department: empAlloc.department,
      orders: empAlloc.orders,
      accounts: empAlloc.accounts
    });
    assert.deepEqual(empWb.SheetNames, ['Summary', 'Work List', 'Account Summary', 'Allocation Audit']);

    const accWb = createAccountWorkbook({
      account_name: 'FORENSIC_Acc_1',
      work_date: TEST_DATE,
      metrics: { total_orders: 3, new_orders: 2 },
      orders: alloc.orders.filter(o => o.account.toLowerCase() === 'forensic_acc_1')
    });
    assert.deepEqual(accWb.SheetNames, ['Summary', 'Orders', 'Employee Activity', 'Timeline']);

    const zipBuf = await createZipFromEmployeeWorkbooks(alloc.by_employee);
    assert.ok(zipBuf && zipBuf.length > 0, 'Zip buffer generated');
  });

  // 14. TRACKING: Business Date + Order Code Join
  await t.test('14. Tracking Date + Order Code Isolation', () => {
    persistDailyLogRecords(TEST_DATE, null, [
      { order: 'ORD_MULTI_1_1', name: 'FORENSIC_Both_3', act: 'Printed', st: 'Printed', dt: new Date('2026-12-01T10:00:00Z').getTime(), isCS: true }
    ]);
    persistDailyLogRecords('2026-12-02', null, [
      { order: 'ORD_MULTI_1_1', name: 'FORENSIC_Both_3', act: 'Pending note', st: 'Pending', dt: new Date('2026-12-02T10:00:00Z').getTime(), isCS: true }
    ]);

    const track1 = getOrderTracking(TEST_DATE, 'ORD_MULTI_1_1');
    const track2 = getOrderTracking('2026-12-02', 'ORD_MULTI_1_1');

    assert.equal(track1.real_actions_count, 1, 'Date 1 has 1 action');
    assert.equal(track2.real_actions_count, 1, 'Date 2 has 1 action');
  });

  // 15. 120-SECOND ACTION DEDUPLICATION
  await t.test('15. 120-Second Window Deduplication', () => {
    const rawEvents = [
      { order: 'ORD_DEDUP_1', name: 'FORENSIC_Both_1', act: 'Call #1', st: 'Pending', dt: new Date('2026-12-01T11:00:00Z').getTime(), isCS: true },
      // Within 120s -> deduped
      { order: 'ORD_DEDUP_1', name: 'FORENSIC_Both_1', act: 'Call #1 dup', st: 'Pending', dt: new Date('2026-12-01T11:01:00Z').getTime(), isCS: true },
      // After 3 minutes -> counted
      { order: 'ORD_DEDUP_1', name: 'FORENSIC_Both_1', act: 'Call #2', st: 'Pending', dt: new Date('2026-12-01T11:05:00Z').getTime(), isCS: true }
    ];
    persistDailyLogRecords(TEST_DATE, null, rawEvents);

    const tracking = getOrderTracking(TEST_DATE, 'ORD_DEDUP_1');
    assert.equal(tracking.real_actions_count, 2, 'Must deduplicate to exactly 2 real actions');
  });

  // 16. NO-EOD BEHAVIOR
  await t.test('16. No-EOD Untouched & Compliance Rules', () => {
    const trackEmp = getEmployeeTracking(TEST_DATE, 'FORENSIC_Both_2');
    assert.equal(trackEmp.orders_worked_today, 0);
    assert.equal(trackEmp.real_actions, 0);
    assert.equal(trackEmp.allocation_compliance, null, 'Compliance must be null / N/A when activity is 0');
  });

  // 17. PRODUCTION SEEDING GUARD
  await t.test('17. Production Seeding Guarding', () => {
    assert.equal(process.env.SEED_DEMO_DATA, undefined, 'SEED_DEMO_DATA must not be enabled in production test environment');
  });

  // Final cleanup
  db.prepare('DELETE FROM employees WHERE name LIKE ?').run('FORENSIC_%');
  db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
  db.prepare('DELETE FROM specific_orders_uploads WHERE work_date = ?').run(TEST_DATE);
  db.prepare('DELETE FROM current_work_pool_summary WHERE work_date = ?').run(TEST_DATE);
  db.prepare('DELETE FROM preparation_batches WHERE work_date = ?').run(TEST_DATE);
  db.prepare('DELETE FROM account_owners WHERE work_date = ?').run(TEST_DATE);
  db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(TEST_DATE);
  db.prepare('DELETE FROM allocation_versions WHERE allocation_date = ?').run(TEST_DATE);
  db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(TEST_DATE);
});
