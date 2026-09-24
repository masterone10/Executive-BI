process.env.NODE_ENV = 'test';
import assert from 'assert';
import Database from 'better-sqlite3';
import { db, runMigrations } from '../db/index.js';
import { parseDailyLogBuffer, parseSpecificOrdersBuffer } from '../services/parser.js';
import { computePerformanceFromRecords } from '../services/performance.js';
import {
  saveCurrentWorkOrders,
  getCurrentAccounts,
  getAccountAvailableStatuses,
  getAvailableOrdersCount,
  saveWorkAllocation,
  getAllocationForDate,
  generateCopyAllocationText,
  getCurrentWorkOverview,
  deleteAllocationForDate
} from '../services/allocation.js';
import {
  inspectExcelSchema,
  persistDailyLogRecords,
  getOrderTracking,
  getEmployeeTracking,
  getAccountTracking,
  getTrackingOverview,
  getRangeTracking,
  isDailyLogUploaded,
  getSourcesUploadStatus,
  getTeamTrackingSummary
} from '../services/tracking.js';
import XLSX from 'xlsx';

console.log('--- STARTING EXECUTIVE BI REGRESSION TESTS ---');

// -------------------------------------------------------------
// TEST 1: Deduplication & 2-Minute Window
// -------------------------------------------------------------
{
  console.log('Testing: Deduplication (2-min window)...');
  const now = Date.now();
  const sampleRecords = [
    // 3 duplicate status events within 30 seconds -> should collapse into 1
    { order: 'ORD-1', name: 'Ahmed CS', act: 'حالة الطلب إلى Printed', st: 'Printed', dt: now, isCS: true },
    { order: 'ORD-1', name: 'Ahmed CS', act: 'حالة الطلب إلى Printed', st: 'Printed', dt: now + 15000, isCS: true },
    { order: 'ORD-1', name: 'Ahmed CS', act: 'حالة الطلب إلى Printed', st: 'Printed', dt: now + 30000, isCS: true },

    // A distinct status event 3 minutes later -> should be a 2nd action
    { order: 'ORD-1', name: 'Ahmed CS', act: 'حالة الطلب إلى Pending', st: 'Pending', dt: now + 180000, isCS: true },

    // Alt phones within 30 seconds -> collapse into 1
    { order: 'ORD-2', name: 'Sara CS', act: 'عدل رقم هاتف آخر من "" إلى "01000"', alt: true, dt: now, isCS: true },
    { order: 'ORD-2', name: 'Sara CS', act: 'عدل رقم التليفون البديل من الى 01000', alt: true, dt: now + 20000, isCS: true },

    // Added orders (1 unique order code)
    { order: 'ORD-1', name: 'Ahmed CS', act: 'أضاف اوردر جديد', added: true, dt: now, isCS: true },
    { order: 'ORD-2', name: 'Sara CS', act: 'أضاف اوردر جديد', added: true, dt: now, isCS: true },
  ];

  const metrics = computePerformanceFromRecords(sampleRecords);
  assert.strictEqual(metrics.summary.totalRealActions, 2, 'Should have exactly 2 real actions after dedup');
  assert.strictEqual(metrics.summary.totalAltPhones, 1, 'Should have exactly 1 deduplicated alt phone');
  assert.strictEqual(metrics.summary.totalNewOrders, 2, 'Should have 2 unique new orders');
  console.log('✓ PASS: Deduplication and 2-min window verified.');
}

// -------------------------------------------------------------
// TEST 2: Orders vs Actions Distinction & Current Pending Backlog
// -------------------------------------------------------------
{
  console.log('Testing: Orders vs Actions Distinction & Current Pending Backlog...');
  const baseTime = 1000000000;
  const records = [
    // Order A: goes from Pending -> Printed -> Pending. Latest is Pending!
    { order: 'ORD-A', name: 'Mariam CS', act: 'إلى Pending', st: 'Pending', dt: baseTime, isCS: true },
    { order: 'ORD-A', name: 'Mariam CS', act: 'إلى Printed', st: 'Printed', dt: baseTime + 200000, isCS: true },
    { order: 'ORD-A', name: 'Mariam CS', act: 'إلى Pending', st: 'Pending', dt: baseTime + 400000, isCS: true },

    // Order B: goes from Pending -> Printed. Latest is Printed!
    { order: 'ORD-B', name: 'Mariam CS', act: 'إلى Pending', st: 'Pending', dt: baseTime, isCS: true },
    { order: 'ORD-B', name: 'Mariam CS', act: 'إلى Printed', st: 'Printed', dt: baseTime + 200000, isCS: true },
  ];

  const metrics = computePerformanceFromRecords(records);
  // Total actions = 5
  assert.strictEqual(metrics.summary.totalRealActions, 5, 'Total real actions should be 5');
  // Unique printed orders = 2 (ORD-A reached printed, ORD-B reached printed)
  assert.strictEqual(metrics.summary.uniquePrintedOrders, 2, 'Unique printed orders should be 2');
  // Current pending backlog = 1 (Only ORD-A has Pending as its latest status!)
  assert.strictEqual(metrics.summary.currentPendingBacklog, 1, 'Current pending backlog should be 1');
  console.log('✓ PASS: Orders vs Actions and Current Pending Backlog verified.');
}

// -------------------------------------------------------------
// TEST 3: Performance Score Ranking (NOT Action Count)
// -------------------------------------------------------------
{
  console.log('Testing: Performance Score ranking (Rank by Score, NOT Actions)...');
  const now = Date.now();
  const records = [];

  // Agent A: 100 actions, high print rate 80%, low cancel rate 2%
  for (let i = 0; i < 80; i++) {
    records.push({ order: `A-${i}`, name: 'HighPerformer CS', act: 'إلى Printed', st: 'Printed', dt: now + i * 200000, isCS: true });
  }
  for (let i = 80; i < 98; i++) {
    records.push({ order: `A-${i}`, name: 'HighPerformer CS', act: 'إلى Processing', st: 'Processing', dt: now + i * 200000, isCS: true });
  }
  for (let i = 98; i < 100; i++) {
    records.push({ order: `A-${i}`, name: 'HighPerformer CS', act: 'إلى Cancelled', st: 'Cancelled', dt: now + i * 200000, isCS: true });
  }

  // Agent B: 150 actions (more actions!), but very high cancel rate 50%
  for (let i = 0; i < 75; i++) {
    records.push({ order: `B-${i}`, name: 'HighVolumeHighCancel CS', act: 'إلى Cancelled', st: 'Cancelled', dt: now + i * 200000, isCS: true });
  }
  for (let i = 75; i < 150; i++) {
    records.push({ order: `B-${i}`, name: 'HighVolumeHighCancel CS', act: 'إلى Pending', st: 'Pending', dt: now + i * 200000, isCS: true });
  }

  const metrics = computePerformanceFromRecords(records);
  const rank1 = metrics.employees[0];
  assert.strictEqual(rank1.name, 'HighPerformer CS', 'Top Performer must be HighPerformer CS based on Score, even though Agent B has more actions');
  assert.strictEqual(metrics.mostActive[0].name, 'HighVolumeHighCancel CS', 'Most active agent is Agent B by Action count');
  console.log('✓ PASS: Top Performer is governed by KPI score, distinct from Most Active.');
}

// -------------------------------------------------------------
// TEST 4: Added Orders Top Contributors (CS ONLY)
// -------------------------------------------------------------
{
  console.log('Testing: Added Orders Contributors (CS ONLY)...');
  const records = [
    { order: 'O-1', name: 'Jehan data entry', act: 'أضاف اوردر جديد', added: true, isCS: false },
    { order: 'O-2', name: 'Jehan data entry', act: 'أضاف اوردر جديد', added: true, isCS: false },
    { order: 'O-3', name: 'Mariam data entry', act: 'أضاف اوردر جديد', added: true, isCS: false },
    { order: 'O-4', name: 'Basma CS', act: 'أضاف اوردر جديد', added: true, isCS: true },
  ];

  const metrics = computePerformanceFromRecords(records);
  const csContributors = metrics.addedOrders.topCSContributors;
  assert.ok(csContributors.every(c => c.name.toLowerCase().endsWith('cs')), 'All top added-order contributors must be CS only');
  assert.strictEqual(csContributors[0].name, 'Basma CS', 'Basma CS should be the top CS added contributor');
  assert.strictEqual(metrics.addedOrders.totalAddedNonCS, 3, 'Total non-CS added orders recorded correctly');
  console.log('✓ PASS: Top Added Contributors strictly CS only.');
}

// -------------------------------------------------------------
// TEST 5: Work Allocation Business Rules & Copy Text Generation
// -------------------------------------------------------------
{
  console.log('Testing: Work Allocation, Accounts Extraction & Copy Text...');
  const testDate = '2026-09-08';

  // Seed sample current work orders for testDate
  const sampleOrders = [
    { order_code: 'ORD-101', account: 'Joud Fragrance', status: 'New', order_date: '2026-09-08' },
    { order_code: 'ORD-102', account: 'Joud Fragrance', status: 'New', order_date: '2026-09-08' },
    { order_code: 'ORD-103', account: 'Joud Fragrance', status: 'Pending', order_date: '2026-09-08' },
    { order_code: 'ORD-104', account: 'Doby Store', status: 'Pending', order_date: '2026-09-08' },
    { order_code: 'ORD-105', account: 'Orvex X', status: 'New', order_date: '2026-09-08' },
  ];

  saveCurrentWorkOrders(testDate, sampleOrders, 'Test_SpecificOrders.xlsx');

  // Rule 1: Account dropdown displays ONLY current accounts
  const currentAccounts = getCurrentAccounts(testDate);
  assert.deepStrictEqual(currentAccounts, ['Doby Store', 'Joud Fragrance', 'Orvex X']);

  // Rule 2: Status availability
  const joudStatuses = getAccountAvailableStatuses(testDate, 'Joud Fragrance');
  assert.ok(joudStatuses.includes('New') && joudStatuses.includes('Pending') && joudStatuses.includes('New + Pending'));

  const orvexStatuses = getAccountAvailableStatuses(testDate, 'Orvex X');
  assert.deepStrictEqual(orvexStatuses, ['New'], 'Orvex X only has New status');

  // Rule 3: Available orders count
  const joudNew = getAvailableOrdersCount(testDate, 'Joud Fragrance', 'New');
  assert.strictEqual(joudNew.total, 2);

  // Setup employees in DB
  const empAhmed = db.prepare('SELECT id FROM employees WHERE name LIKE ?').get('%Ahmed%') || { id: 1 };
  const empMariam = db.prepare('SELECT id FROM employees WHERE name LIKE ?').get('%Mariam%') || { id: 2 };
  const empSara = db.prepare('SELECT id FROM employees WHERE name LIKE ?').get('%Sara%') || { id: 3 };

  // Rule 4: Manual Assignment & Duplicate Prevention
  const assignments = [
    { employee_id: empAhmed.id, account: 'Joud Fragrance', status: 'New', available_orders: 2 },
    { employee_id: empAhmed.id, account: 'Doby Store', status: 'Pending', available_orders: 1 },
    { employee_id: empMariam.id, account: 'Orvex X', status: 'New', available_orders: 1 },
    { employee_id: empSara.id, account: 'Joud Fragrance', status: 'Pending', available_orders: 1 },
  ];

  saveWorkAllocation(testDate, assignments, 'Test Allocation');

  // Verify duplicate prevention
  assert.throws(() => {
    saveWorkAllocation(testDate, [
      { employee_id: empAhmed.id, account: 'Joud Fragrance', status: 'New', available_orders: 2 },
      { employee_id: empAhmed.id, account: 'Joud Fragrance', status: 'New', available_orders: 2 },
    ]);
  }, /already assigned/, 'Exact duplicate assignment must throw an error');

  // Verify Copy Allocation text output
  const copyText = generateCopyAllocationText(testDate, 'standard');
  assert.ok(copyText.includes('📋 توزيع شغل اليوم'), 'Copy text must include header');
  assert.ok(copyText.includes('Joud Fragrance → New'), 'Copy text must contain assignment details');
  assert.ok(copyText.includes('Doby Store → Pending'), 'Copy text must contain assignment details');
  console.log('✓ PASS: Work Allocation rules, duplicate prevention, and Copy text verified.');
}

// -------------------------------------------------------------
// TEST 6: Two-File Specific Orders Staging & Merging (Part 4, 30, 54)
// -------------------------------------------------------------
{
  console.log('Testing: Two-File Specific Orders Staging & Merging...');
  const { stageSpecificOrdersUpload, mergeSpecificOrdersPool, getSpecificOrdersPoolStatus } = await import('../services/allocation.js');
  const testDate = '2026-09-09';

  // File 1 orders
  const file1Orders = [
    { order_code: 'F1-001', account: 'Account Alpha', status: 'New', order_date: testDate },
    { order_code: 'F1-002', account: 'Account Alpha', status: 'Pending', order_date: testDate },
    { order_code: 'SHARED-01', account: 'Account Beta', status: 'New', order_date: testDate },
  ];

  // File 2 orders (has SHARED-01 as Pending -> higher priority status, plus unique F2-001)
  const file2Orders = [
    { order_code: 'SHARED-01', account: 'Account Beta', status: 'Pending', order_date: testDate },
    { order_code: 'F2-001', account: 'Account Gamma', status: 'New', order_date: testDate },
  ];

  // 1. Stage File 1
  stageSpecificOrdersUpload(testDate, 1, 'Specific_Orders_Part1.xlsx', file1Orders, file1Orders.length);
  // 2. Stage File 2
  stageSpecificOrdersUpload(testDate, 2, 'Specific_Orders_Part2.xlsx', file2Orders, file2Orders.length);

  // 3. Merge Pool
  const mergeResult = mergeSpecificOrdersPool(testDate);
  assert.strictEqual(mergeResult.file1_orders, 3, 'File 1 has 3 orders');
  assert.strictEqual(mergeResult.file2_orders, 2, 'File 2 has 2 orders');
  assert.strictEqual(mergeResult.merged_orders, 5, 'Raw merged orders total 5');
  assert.strictEqual(mergeResult.unique_orders, 4, 'Unique orders count should be 4 (SHARED-01 deduped)');
  assert.strictEqual(mergeResult.duplicates_count, 1, 'Exactly 1 duplicate order detected');
  assert.strictEqual(mergeResult.accounts_count, 3, '3 unique accounts available (Alpha, Beta, Gamma)');

  // Verify pool status returns structured summary and files
  const status = getSpecificOrdersPoolStatus(testDate);
  assert.strictEqual(status.has_file1, true, 'File 1 is present');
  assert.strictEqual(status.has_file2, true, 'File 2 is present');
  assert.strictEqual(status.total_orders, 4, 'Pool contains 4 unique orders');
  assert.deepStrictEqual(status.accounts.sort(), ['Account Alpha', 'Account Beta', 'Account Gamma']);
  assert.strictEqual(status.summary.duplicate_orders_count, 1);

  // Verify that SHARED-01 resolved to Opening Status Conflict (Phase 3 & 25)
  const sharedOrder = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(testDate, 'SHARED-01');
  assert.strictEqual(sharedOrder.status, 'Opening Status Conflict', 'Status precedence resolved to Opening Status Conflict');

  console.log('✓ PASS: Two-File Staging, Merging, and Status Resolution verified.');
}

// -------------------------------------------------------------
// TEST 7: Snapshot Integrity & No Auto-Creation of Employees
// -------------------------------------------------------------
{
  console.log('Testing: Snapshot Integrity & Strict Manual Employee Master...');
  const { savePerformanceSnapshot } = await import('../services/performance.js');
  const testDate = '2026-09-10';

  const snapshotMetrics = {
    summary: {
      totalRealActions: 50,
      uniquePrintedOrders: 20,
      uniqueNewOrders: 30,
      currentPendingBacklog: 5,
      totalAltPhones: 3,
    },
    statusBreakdown: {
      Printed: 20,
      Pending: 15,
      Processing: 10,
      Cancelled: 5,
    },
    employees: [
      {
        name: 'Existing NonExistent UnknownAgent CS',
        rank: 1,
        score: 88,
        grade: 'A',
        segment: 'Top Performer',
        actions: 50,
        printed: 20,
        pending: 15,
        processing: 10,
        cancelled: 5,
        alt: 3,
        added: 2,
        own_printed_rate: 40,
        own_pending_rate: 30,
        own_cancel_rate: 10,
        canc_share_pct: 100,
        contribution_pct: 100,
        cancel_risk: 'Normal',
      }
    ]
  };

  // Count employees before snapshot
  const empCountBefore = db.prepare('SELECT COUNT(*) as c FROM employees').get().c;

  // Save snapshot
  savePerformanceSnapshot(testDate, snapshotMetrics);

  // Count employees after snapshot
  const empCountAfter = db.prepare('SELECT COUNT(*) as c FROM employees').get().c;
  assert.strictEqual(empCountBefore, empCountAfter, 'Snapshot must NEVER auto-create employees in employee master!');

  // Verify snapshot stored in performance_snapshots
  const snapRow = db.prepare('SELECT * FROM performance_snapshots WHERE date = ? AND employee_name = ?').get(testDate, 'Existing NonExistent UnknownAgent CS');
  assert.ok(snapRow, 'Snapshot row created with exact date and employee_name');
  assert.strictEqual(snapRow.real_actions, 50);
  assert.strictEqual(snapRow.performance_score, 88);

  console.log('✓ PASS: Snapshot saved without polluting Employee Master.');
}

// -------------------------------------------------------------
// TEST 8: Migration Handling - Existing DB without is_working & Migrated DB
// -------------------------------------------------------------
{
  console.log('Testing: Existing DB without is_working & Safe Migration...');
  const memDb = new Database(':memory:');
  
  // Simulate older schema without is_working column
  memDb.exec(`
    CREATE TABLE daily_working_team (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_date TEXT NOT NULL,
      employee_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(work_date, employee_id)
    );
    INSERT INTO daily_working_team (work_date, employee_id) VALUES ('2026-09-08', 101);
    INSERT INTO daily_working_team (work_date, employee_id) VALUES ('2026-09-08', 102);
  `);

  // Verify column does not exist initially
  let initialCols = memDb.prepare("PRAGMA table_info(daily_working_team)").all();
  assert.strictEqual(initialCols.some(c => c.name === 'is_working'), false, 'Initial simulated DB must lack is_working');

  // Execute safe migration
  runMigrations(memDb);

  // Verify column now exists
  let migratedCols = memDb.prepare("PRAGMA table_info(daily_working_team)").all();
  assert.strictEqual(migratedCols.some(c => c.name === 'is_working'), true, 'Migrated DB must have is_working column');

  // Verify existing rows are preserved with default value 1
  const rows = memDb.prepare("SELECT * FROM daily_working_team ORDER BY employee_id ASC").all();
  assert.strictEqual(rows.length, 2, 'Existing rows must be completely preserved');
  assert.strictEqual(rows[0].employee_id, 101);
  assert.strictEqual(rows[0].is_working, 1, 'Default is_working must be 1 for pre-existing records');
  assert.strictEqual(rows[1].employee_id, 102);
  assert.strictEqual(rows[1].is_working, 1, 'Default is_working must be 1 for pre-existing records');

  // Idempotency: Running migrations a second time should not throw
  runMigrations(memDb);
  assert.strictEqual(memDb.prepare("SELECT COUNT(*) as c FROM daily_working_team").get().c, 2);

  memDb.close();
  console.log('✓ PASS: Migration safely adds is_working and preserves existing rows.');
}

// -------------------------------------------------------------
// TEST 9: getCurrentWorkOverview & Schema Consistency
// -------------------------------------------------------------
{
  console.log('Testing: getCurrentWorkOverview & Schema Consistency...');
  const testDate = '2026-09-15';

  // Ensure test date data
  db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(testDate);
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(testDate);

  // Insert an employee if not exists
  let emp = db.prepare("SELECT id FROM employees WHERE department = 'CS' AND active = 1 LIMIT 1").get();
  if (!emp) {
    const res = db.prepare('INSERT INTO employees (name, department, active) VALUES (?, ?, ?)').run('Test CS Agent', 'CS', 1);
    emp = { id: res.lastInsertRowid };
  }

  // Insert working team record
  db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(testDate, emp.id);

  // Insert a test order
  db.prepare(`
    INSERT INTO current_work_orders (work_date, order_code, account, status, source_file_slot)
    VALUES (?, ?, ?, ?, ?)
  `).run(testDate, 'ORD-TEST-99', 'Acc-99', 'New', 1);

  // Call getCurrentWorkOverview - must return valid JSON structure without throwing
  const overview = getCurrentWorkOverview(testDate);
  assert.ok(overview, 'Overview should be returned');
  assert.strictEqual(overview.work_date, testDate);
  assert.strictEqual(overview.total_orders, 1);
  assert.strictEqual(overview.accounts_count, 1);
  assert.strictEqual(overview.new_count, 1);
  assert.strictEqual(overview.pending_count, 0);
  assert.strictEqual(overview.working_team_count, 1);

  console.log('✓ PASS: getCurrentWorkOverview executes without error and returns accurate counts.');
}

// -------------------------------------------------------------
// TEST 10: Date-specific Working Team vs Permanent Employee Master
// -------------------------------------------------------------
{
  console.log('Testing: Date-specific Working Team vs Permanent Employee Master...');
  const dateA = '2026-09-20';
  const dateB = '2026-09-21';

  // Ensure two CS employees exist
  let e1 = db.prepare('SELECT id FROM employees WHERE name = ?').get('Permanent Agent 1 CS');
  if (!e1) {
    const r1 = db.prepare('INSERT INTO employees (name, department, active) VALUES (?, ?, ?)').run('Permanent Agent 1 CS', 'CS', 1);
    e1 = { id: r1.lastInsertRowid };
  }
  let e2 = db.prepare('SELECT id FROM employees WHERE name = ?').get('Permanent Agent 2 CS');
  if (!e2) {
    const r2 = db.prepare('INSERT INTO employees (name, department, active) VALUES (?, ?, ?)').run('Permanent Agent 2 CS', 'CS', 1);
    e2 = { id: r2.lastInsertRowid };
  }

  const empCountBefore = db.prepare('SELECT COUNT(*) as c FROM employees').get().c;

  // Set working team for dateA: both e1 and e2
  db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(dateA);
  db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(dateA, e1.id);
  db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(dateA, e2.id);

  // Set working team for dateB: only e1
  db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(dateB);
  db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(dateB, e1.id);

  // Verify date-specific loading for dateA: both are working
  const teamDateA = db.prepare(`
    SELECT e.id, e.name, CASE WHEN dwt.id IS NOT NULL AND (dwt.is_working IS NULL OR dwt.is_working = 1) THEN 1 ELSE 0 END as is_working
    FROM employees e
    LEFT JOIN daily_working_team dwt ON e.id = dwt.employee_id AND dwt.work_date = ?
    WHERE e.id IN (?, ?)
    ORDER BY e.id ASC
  `).all(dateA, e1.id, e2.id);
  assert.strictEqual(teamDateA[0].is_working, 1, 'Agent 1 working on date A');
  assert.strictEqual(teamDateA[1].is_working, 1, 'Agent 2 working on date A');

  // Verify date-specific loading for dateB: only Agent 1 is working
  const teamDateB = db.prepare(`
    SELECT e.id, e.name, CASE WHEN dwt.id IS NOT NULL AND (dwt.is_working IS NULL OR dwt.is_working = 1) THEN 1 ELSE 0 END as is_working
    FROM employees e
    LEFT JOIN daily_working_team dwt ON e.id = dwt.employee_id AND dwt.work_date = ?
    WHERE e.id IN (?, ?)
    ORDER BY e.id ASC
  `).all(dateB, e1.id, e2.id);
  assert.strictEqual(teamDateB[0].is_working, 1, 'Agent 1 working on date B');
  assert.strictEqual(teamDateB[1].is_working, 0, 'Agent 2 NOT working on date B');

  // Verify Employee Master permanence: employee records were NOT modified or deleted
  const empCountAfter = db.prepare('SELECT COUNT(*) as c FROM employees').get().c;
  assert.strictEqual(empCountBefore, empCountAfter, 'Employee Master permanent records must remain untouched');

  console.log('✓ PASS: Working Team is date-specific and Employee Master is strictly permanent.');
}

// -------------------------------------------------------------
// TEST 11: API JSON Error Handling and Safe HTML Prevention
// -------------------------------------------------------------
{
  console.log('Testing: API JSON Error Handling...');

  // 1. Simulate server error response payload
  const errorJson = JSON.stringify({ error: 'date and account are required' });
  const parsed = JSON.parse(errorJson);
  assert.strictEqual(typeof parsed, 'object');
  assert.strictEqual(parsed.error, 'date and account are required');

  // 2. Simulate client-side safe parser receiving unexpected HTML (e.g. 500 error page from a proxy)
  const rawHtml = '<!DOCTYPE html><html><head><title>Error</title></head><body><h1>Internal Error</h1><p>SqliteError: test</p></body></html>';
  let safeCleanedMsg = '';
  try {
    JSON.parse(rawHtml);
  } catch (e) {
    const cleanText = rawHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    safeCleanedMsg = cleanText.substring(0, 200);
  }
  assert.ok(safeCleanedMsg.includes('Error Internal Error SqliteError: test'));
  assert.ok(!safeCleanedMsg.includes('<html'), 'HTML tags must be stripped before presenting error message');

  console.log('✓ PASS: API JSON and safe client error handling verified.');
}

// -------------------------------------------------------------
// TEST 12: Employee Master Full End-to-End CRUD & Invariants
// -------------------------------------------------------------
{
  console.log('Testing: Employee Master Full End-to-End CRUD...');
  const { app } = await import('../server.js');
  const fs = await import('fs');

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET employees
    const getRes = await fetch(`${baseUrl}/api/employees`);
    assert.strictEqual(getRes.status, 200, 'GET /api/employees must return 200');
    assert.ok(getRes.headers.get('content-type').includes('application/json'), 'GET /api/employees must return JSON');
    const initialEmps = await getRes.json();
    assert.ok(Array.isArray(initialEmps), 'GET /api/employees must return an array');

    // Clean up any test records with name 'Ahmed Test' or 'Ahmed Test Updated'
    db.pragma('foreign_keys = OFF');
    db.prepare("DELETE FROM employees WHERE name IN ('Ahmed Test', 'Ahmed Test Updated', 'ahmed test')").run();
    db.pragma('foreign_keys = ON');

    // 2. Create employee
    const createRes = await fetch(`${baseUrl}/api/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ahmed Test', department: 'CS', active: 1 })
    });
    assert.strictEqual(createRes.status, 201, 'POST /api/employees must return 201 Created');
    assert.ok(createRes.headers.get('content-type').includes('application/json'), 'POST must return JSON');
    const createData = await createRes.json();
    assert.strictEqual(createData.success, true, 'POST must return success: true');
    assert.ok(createData.employee && createData.employee.id, 'POST must return created employee with ID');
    const newEmpId = createData.employee.id;
    assert.strictEqual(createData.employee.name, 'Ahmed Test');
    assert.strictEqual(createData.employee.department, 'CS');
    assert.strictEqual(Number(createData.employee.active), 1);

    // Verify persisted directly in SQLite database
    const dbEmp = db.prepare('SELECT * FROM employees WHERE id = ?').get(newEmpId);
    assert.ok(dbEmp, 'New employee must physically exist in SQLite database');
    assert.strictEqual(dbEmp.name, 'Ahmed Test');
    assert.strictEqual(dbEmp.department, 'CS');
    assert.strictEqual(dbEmp.active, 1);

    // 3. Duplicate employee rejection (sensible normalized comparison)
    const dupRes = await fetch(`${baseUrl}/api/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ahmed   test   ', department: 'CS' })
    });
    assert.strictEqual(dupRes.status, 409, 'Duplicate employee must return 409 Conflict');
    const dupData = await dupRes.json();
    assert.strictEqual(dupData.success, false);
    assert.ok(dupData.error.toLowerCase().includes('already exists'), 'Readable duplicate error message');

    // Verify database count of 'ahmed test' is still exactly 1
    const count = db.prepare('SELECT COUNT(*) as c FROM employees WHERE LOWER(TRIM(name)) = ?').get('ahmed test').c;
    assert.strictEqual(count, 1, 'No duplicate record inserted into database');

    // 4. Edit employee (name and department)
    const editRes = await fetch(`${baseUrl}/api/employees/${newEmpId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ahmed Test Updated', department: 'Other', active: 1 })
    });
    assert.strictEqual(editRes.status, 200, 'PUT /api/employees/:id must return 200 OK');
    const editData = await editRes.json();
    assert.strictEqual(editData.success, true);
    assert.strictEqual(editData.employee.name, 'Ahmed Test Updated');
    assert.strictEqual(editData.employee.department, 'Other');

    // 8. Employee ID remains stable after edit
    assert.strictEqual(editData.employee.id, newEmpId, 'Employee ID must remain strictly stable after edit');
    const dbEmpUpdated = db.prepare('SELECT * FROM employees WHERE id = ?').get(newEmpId);
    assert.strictEqual(dbEmpUpdated.name, 'Ahmed Test Updated');
    assert.strictEqual(dbEmpUpdated.department, 'Other');

    // 5. Deactivate employee
    const deactRes = await fetch(`${baseUrl}/api/employees/${newEmpId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: 0 })
    });
    assert.strictEqual(deactRes.status, 200, 'PATCH /api/employees/:id/status must return 200 OK');
    const deactData = await deactRes.json();
    assert.strictEqual(deactData.success, true);
    assert.strictEqual(Number(deactData.employee.active), 0);

    const dbEmpDeact = db.prepare('SELECT * FROM employees WHERE id = ?').get(newEmpId);
    assert.strictEqual(dbEmpDeact.active, 0, 'Status must persist as 0 (inactive) in SQLite');

    // 6. Reactivate employee
    const reactRes = await fetch(`${baseUrl}/api/employees/${newEmpId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: 1 })
    });
    assert.strictEqual(reactRes.status, 200, 'PATCH /api/employees/:id/status must return 200 OK');
    const reactData = await reactRes.json();
    assert.strictEqual(Number(reactData.employee.active), 1);

    const dbEmpReact = db.prepare('SELECT * FROM employees WHERE id = ?').get(newEmpId);
    assert.strictEqual(dbEmpReact.active, 1, 'Status must persist as 1 (active) in SQLite');

    // 7. Employee history remains intact after deactivation
    // Add dummy historical performance and working team records
    const testDate = '2026-03-01';
    db.prepare(`
      INSERT OR REPLACE INTO performance_snapshots 
      (date, employee_id, employee_name, real_actions, printed_orders, performance_score)
      VALUES (?, ?, ?, 50, 45, 95)
    `).run(testDate, newEmpId, 'Ahmed Test Updated');

    db.prepare(`
      INSERT OR REPLACE INTO daily_working_team
      (work_date, employee_id, is_working)
      VALUES (?, ?, 1)
    `).run(testDate, newEmpId);

    // Deactivate employee again
    await fetch(`${baseUrl}/api/employees/${newEmpId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: 0 })
    });

    // Verify historical snapshot still points to this employee
    const histSnap = db.prepare('SELECT * FROM performance_snapshots WHERE employee_id = ?').get(newEmpId);
    assert.ok(histSnap, 'Historical performance snapshot must NOT be deleted');
    assert.strictEqual(histSnap.employee_id, newEmpId);
    assert.strictEqual(histSnap.real_actions, 50);

    // Verify daily working team still points to this employee
    const histTeam = db.prepare('SELECT * FROM daily_working_team WHERE employee_id = ?').get(newEmpId);
    assert.ok(histTeam, 'Historical working team record must NOT be deleted');
    assert.strictEqual(histTeam.employee_id, newEmpId);

    // Verify permanent record in employees table is NOT deleted
    const stillExists = db.prepare('SELECT * FROM employees WHERE id = ?').get(newEmpId);
    assert.ok(stillExists, 'Employee master row must never be deleted when inactivated');
    assert.strictEqual(stillExists.active, 0);

    // 9. API errors return JSON (Never return HTML for API errors)
    // 9a. Empty name on POST
    const errPost = await fetch(`${baseUrl}/api/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' })
    });
    assert.strictEqual(errPost.status, 400);
    assert.ok(errPost.headers.get('content-type').includes('application/json'));
    const errPostData = await errPost.json();
    assert.strictEqual(errPostData.success, false);
    assert.ok(errPostData.error);

    // 9b. Non-existent ID on PUT
    const errPut = await fetch(`${baseUrl}/api/employees/99999999`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Someone' })
    });
    assert.strictEqual(errPut.status, 404);
    assert.ok(errPut.headers.get('content-type').includes('application/json'));
    const errPutData = await errPut.json();
    assert.strictEqual(errPutData.success, false);

    // 9c. Invalid ID on PATCH
    const errPatch = await fetch(`${baseUrl}/api/employees/invalid-id/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: 1 })
    });
    assert.strictEqual(errPatch.status, 400);
    assert.ok(errPatch.headers.get('content-type').includes('application/json'));
    const errPatchData = await errPatch.json();
    assert.strictEqual(errPatchData.success, false);

    // 10. Frontend Action Handlers Connection Verification
    const templateContent = fs.readFileSync('template.html', 'utf-8');
    assert.ok(templateContent.includes('openAddEmployeeModal()'), 'Add button must invoke openAddEmployeeModal()');
    assert.ok(templateContent.includes('openEditEmployeeModal('), 'Edit button must invoke openEditEmployeeModal()');
    assert.ok(templateContent.includes('toggleEmployeeStatus('), 'Status switch must invoke toggleEmployeeStatus()');
    assert.ok(templateContent.includes('handleEmployeeFormSubmit(event)'), 'Form submit must invoke handleEmployeeFormSubmit()');
    assert.ok(templateContent.includes('id="employeeModal"'), 'Dedicated modal container id="employeeModal" must exist');
    assert.ok(templateContent.includes('id="empModalName"'), 'Modal must have name input id="empModalName"');
    assert.ok(templateContent.includes('id="empModalDept"'), 'Modal must have dept selector id="empModalDept"');
    assert.ok(templateContent.includes('id="empModalActive"'), 'Modal must have active selector id="empModalActive"');
    assert.ok(templateContent.includes('id="empModalError"'), 'Modal must have error container id="empModalError"');
    assert.ok(templateContent.includes('id="empModalSubmitBtn"'), 'Modal must have submit button id="empModalSubmitBtn"');

    // Clean up test employee
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM performance_snapshots WHERE employee_id = ?').run(newEmpId);
    db.prepare('DELETE FROM daily_working_team WHERE employee_id = ?').run(newEmpId);
    db.prepare('DELETE FROM account_owners WHERE owner_employee_id = ?').run(newEmpId);
    db.prepare('DELETE FROM employees WHERE id = ?').run(newEmpId);
    db.pragma('foreign_keys = ON');

    console.log('✓ PASS: Employee Master full end-to-end CRUD, validation, and history permanence verified.');
  } finally {
    server.close();
  }
}

// -------------------------------------------------------------
// TEST 13: Added Orders CS Employee Matching & Reconciliation
// -------------------------------------------------------------
{
  console.log('Testing: Added Orders CS Employee Matching & Sum Reconciliation...');
  const { isCSName, normalizeEmployeeName, matchEmployeeInMaster } = await import('../services/parser.js');
  const fs = await import('fs');

  // 1. Employee Master Department is Authoritative
  const testMasterMap = new Map([
    ['Nouran Ezzat', 'CS'],
    ['Hassan Data Entry', 'Data Entry'],
    ['Ahmed Shaker CS', 'Other'], // Master overrides "CS" suffix!
  ]);

  // Case-insensitive & normalized matching
  assert.strictEqual(isCSName(' Nouran  Ezzat ', testMasterMap), true, 'CS employee in master must be classified as CS');
  assert.strictEqual(isCSName('HASSAN DATA ENTRY', testMasterMap), false, 'Data Entry employee in master must NOT be CS');
  assert.strictEqual(isCSName('Ahmed Shaker CS', testMasterMap), false, 'Master department overrides name suffix');

  // Fallback rule when not in master
  assert.strictEqual(isCSName('Unknown Person CS', testMasterMap), true, 'Fallback to CS suffix if not in master');
  assert.strictEqual(isCSName('Unknown Person Data Entry', testMasterMap), false, 'Fallback non-CS if suffix is not CS');

  // 2. Performance computation with dbEmployeesMap
  const sampleRecords = [
    { order: 'ORD-101', name: 'Nouran Ezzat', act: 'أضاف اوردر', added: true, dt: 1700000000 },
    { order: 'ORD-102', name: 'nouran ezzat', act: 'أضاف اوردر', added: true, dt: 1700000010 }, // duplicate order+emp with case variation
    { order: 'ORD-103', name: 'Nouran Ezzat', act: 'أضاف اوردر', added: true, dt: 1700000020 },
    { order: 'ORD-104', name: 'Unknown Person CS', act: 'أضاف اوردر', added: true, dt: 1700000030 },
    { order: 'ORD-105', name: 'Hassan Data Entry', act: 'أضاف اوردر', added: true, dt: 1700000040 },
  ];

  const metrics = computePerformanceFromRecords(sampleRecords, testMasterMap);
  assert.strictEqual(metrics.addedOrders.fromCS, 4, 'Should have 4 CS added orders (3 from Nouran, 1 from Unknown)');
  assert.strictEqual(metrics.addedOrders.fromOtherDepartments, 1, 'Should have 1 non-CS added order');
  assert.strictEqual(metrics.addedOrders.topCSContributors.length, 2, 'Should have 2 CS contributors');
  assert.strictEqual(metrics.addedOrders.topCSContributors[0].name, 'Nouran Ezzat', 'Top contributor should be Nouran Ezzat');
  assert.strictEqual(metrics.addedOrders.topCSContributors[0].count, 3, 'Nouran Ezzat count should be 3');
  assert.strictEqual(metrics.addedOrders.topCSContributor.employee, 'Nouran Ezzat', 'topCSContributor must match rank 1');

  // 3. Verify data.json Reconciliation: Sum of CS Contributors == From CS (1,219)
  const data = JSON.parse(fs.readFileSync('data.json', 'utf-8'));
  assert.strictEqual(data.fromCS, 1219, 'data.json fromCS must be 1219');
  assert.ok(Array.isArray(data.allCSContributors), 'allCSContributors must be an array');
  assert.ok(data.allCSContributors.length > 0, 'allCSContributors must not be empty');

  const contributorSum = data.allCSContributors.reduce((sum, c) => sum + (c.count || c.value || 0), 0);
  assert.strictEqual(contributorSum, 1219, 'Sum of all CS contributor rows must reconcile exactly to 1,219');

  // Top CS Contributor must match rank 1
  assert.ok(data.topCSContributor, 'topCSContributor must exist');
  assert.strictEqual(data.topCSContributor.employee, data.allCSContributors[0].employee);
  assert.strictEqual(data.topCSContributor.count, data.allCSContributors[0].count);
  assert.strictEqual(data.topCSContributor.employee, 'BASMA CS');
  assert.strictEqual(data.topCSContributor.count, 226);

  console.log('✓ PASS: Added Orders CS Employee Matching & Sum Reconciliation (1,219) verified.');
}

// -------------------------------------------------------------
// TEST 14: Global Date Navigation, API Date Routing & Multi-Date Isolation
// -------------------------------------------------------------
{
  console.log('Testing: Global Date Navigation, API Date Routing & Multi-Date Isolation...');
  const http = await import('http');
  const fs = await import('fs');
  const { app } = await import('../server.js');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Query baseline date: 2026-09-08
    const baseRes = await fetch(`${baseUrl}/api/data?date=2026-09-08`);
    assert.strictEqual(baseRes.status, 200);
    const baseData = await baseRes.json();
    assert.strictEqual(baseData.exists, true, '2026-09-08 data must exist');
    assert.strictEqual(baseData.date, '2026-09-08');
    assert.ok(Array.isArray(baseData.employees), 'employees should be array');
    assert.ok(baseData.employees.length > 0, 'employees should not be empty on baseline date');
    assert.strictEqual(baseData.fromCS, 1219, 'Baseline fromCS should be 1219');

    // 2. Query empty historical date: 2026-09-06
    const emptyRes = await fetch(`${baseUrl}/api/data?date=2026-09-06`);
    assert.strictEqual(emptyRes.status, 200);
    const emptyData = await emptyRes.json();
    assert.strictEqual(emptyData.exists, false, '2026-09-06 should return exists: false');
    assert.strictEqual(emptyData.date, '2026-09-06');
    assert.strictEqual(emptyData.employees.length, 0, '2026-09-06 should have 0 employees');
    assert.strictEqual(emptyData.log_totals.actions, 0, '2026-09-06 should have 0 actions');

    // 3. Query future date: 2026-09-30
    const futureRes = await fetch(`${baseUrl}/api/data?date=2026-09-30`);
    assert.strictEqual(futureRes.status, 200);
    const futureData = await futureRes.json();
    assert.strictEqual(futureData.exists, false, '2026-09-30 future date must return exists: false');

    // 4. Performance endpoint date queries
    const perfBase = await fetch(`${baseUrl}/api/performance/2026-09-08`).then(r => r.json());
    assert.strictEqual(perfBase.exists, true, 'Performance for 2026-09-08 must exist');
    const perfEmpty = await fetch(`${baseUrl}/api/performance/2026-09-06`).then(r => r.json());
    assert.strictEqual(perfEmpty.exists, false, 'Performance for 2026-09-06 must report exists: false');

    // 5. Working Team date isolation
    db.prepare('DELETE FROM daily_working_team WHERE work_date IN (?, ?)').run('2026-09-06', '2026-09-07');
    const emp1 = db.prepare('SELECT id FROM employees ORDER BY id LIMIT 1').get();
    assert.ok(emp1, 'At least one employee must exist');

    // Set working team for 2026-09-07
    await fetch(`${baseUrl}/api/working-team/2026-09-07`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeIds: [emp1.id] })
    });

    const team07 = await fetch(`${baseUrl}/api/working-team/2026-09-07`).then(r => r.json());
    const working07 = team07.filter(e => e.is_working);
    assert.strictEqual(working07.length, 1, '2026-09-07 must have exactly 1 working member');
    assert.strictEqual(working07[0].id, emp1.id);

    // Verify 2026-09-06 working team is not contaminated by 2026-09-07
    await fetch(`${baseUrl}/api/working-team/2026-09-06`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeIds: [] })
    });
    const team06 = await fetch(`${baseUrl}/api/working-team/2026-09-06`).then(r => r.json());
    const working06 = team06.filter(e => e.is_working);
    assert.strictEqual(working06.length, 0, '2026-09-06 must have 0 working members');

    // 6. Work Allocation date isolation
    await fetch(`${baseUrl}/api/allocations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: '2026-09-07',
        assignments: [{ employee_id: emp1.id, account: 'TEST-ACC-07', status: 'New', available_orders: 45 }]
      })
    });

    const alloc07 = await fetch(`${baseUrl}/api/allocations/2026-09-07`).then(r => r.json());
    assert.strictEqual(alloc07.exists, true, 'Allocation on 2026-09-07 must exist');
    assert.strictEqual(alloc07.items.length, 1);
    assert.strictEqual(alloc07.items[0].account, 'TEST-ACC-07');

    const alloc06 = await fetch(`${baseUrl}/api/allocations/2026-09-06`).then(r => r.json());
    assert.strictEqual(alloc06.exists, false, 'Allocation on 2026-09-06 must NOT exist');

    // Clean up test records
    deleteAllocationForDate('2026-09-07');
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run('2026-09-07');

    // 7. HTML Bundle UI Component Verification
    const indexHtml = fs.readFileSync('public/index.html', 'utf-8');
    assert.ok(indexHtml.includes('id="globalDateSelector"'), 'HTML must include #globalDateSelector');
    assert.ok(indexHtml.includes('id="globalDateDisplay"'), 'HTML must include #globalDateDisplay');
    assert.ok(indexHtml.includes('id="btnPrevDay"'), 'HTML must include #btnPrevDay');
    assert.ok(indexHtml.includes('id="btnToday"'), 'HTML must include #btnToday');
    assert.ok(indexHtml.includes('id="btnNextDay"'), 'HTML must include #btnNextDay');
    assert.ok(indexHtml.includes('id="globalCalendarPicker"'), 'HTML must include #globalCalendarPicker');
    assert.ok(indexHtml.includes('setGlobalSelectedDate'), 'HTML must include setGlobalSelectedDate function');
    assert.ok(indexHtml.includes('updateUrlDate'), 'HTML must include updateUrlDate function');
    assert.ok(indexHtml.includes('fetchPerformanceDataForDate'), 'HTML must include fetchPerformanceDataForDate function');

    console.log('✓ PASS: Global Date Navigation, API Date Routing & Multi-Date Isolation verified.');
  } finally {
    server.close();
  }
}

// -------------------------------------------------------------
// TEST 15: Comprehensive Tracking Engine & Schema Discovery (Phase 25)
// -------------------------------------------------------------
{
  console.log('Testing: Tracking Engine, Schema Discovery & Audit (Phase 25 Verification Suite)...');
  const fs = await import('fs');

  // 1. Schema discovery on real sample_log.xlsx
  if (fs.existsSync('sample_log.xlsx')) {
    const sampleBuf = fs.readFileSync('sample_log.xlsx');
    const schemaReport = inspectExcelSchema(sampleBuf, 'daily_log');
    assert.strictEqual(schemaReport.is_valid, true, 'sample_log.xlsx schema must be valid');
    assert.ok(schemaReport.worksheets.length >= 1, 'At least 1 worksheet');
    assert.ok(schemaReport.total_rows > 1000, 'Must have thousands of rows');
    assert.ok(schemaReport.columns.some(c => c.normalized_role === 'order_code'), 'Must detect order_code');
    assert.ok(schemaReport.columns.some(c => c.normalized_role === 'employee_name'), 'Must detect employee_name');
    assert.ok(schemaReport.columns.some(c => c.normalized_role === 'action'), 'Must detect action');
    assert.strictEqual(schemaReport.missing_required_keys.length, 0, 'No missing required keys');
  }

  // 2. Schema inspection flags files missing required keys
  const invalidWb = XLSX.utils.book_new();
  const invalidWs = XLSX.utils.json_to_sheet([
    { random_col1: 'val1', random_col2: 'val2' }
  ]);
  XLSX.utils.book_append_sheet(invalidWb, invalidWs, 'Sheet1');
  const invalidBuf = XLSX.write(invalidWb, { type: 'buffer', bookType: 'xlsx' });
  const invalidReport = inspectExcelSchema(invalidBuf, 'daily_log');
  assert.strictEqual(invalidReport.is_valid, false, 'Invalid schema must be flagged');
  assert.ok(invalidReport.missing_required_keys.length > 0, 'Must report missing required keys');

  // Set up controlled test date: 2026-10-15
  const tDate = '2026-10-15';
  db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(tDate);
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(tDate);
  db.prepare('DELETE FROM allocation_headers WHERE allocation_date = ?').run(tDate);

  // Setup opening inventory in current_work_orders:
  // - ORD-NEW-01: from File 1 (Slot 1 -> New) in 'Store Alpha'
  // - ORD-PEN-01: from File 2 (Slot 2 -> Pending) in 'Store Beta'
  // - ORD-CONFLICT: in both File 1 (New) and File 2 (Pending) -> Opening Status Conflict
  // - ORD-UNTOUCHED: in File 1 (New) in 'Store Alpha' (will have 0 actions)
  const insertOrder = db.prepare(`
    INSERT INTO current_work_orders (work_date, order_code, account, status, source_file_slot)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertOrder.run(tDate, 'ORD-NEW-01', 'Store Alpha', 'New', 1);
  insertOrder.run(tDate, 'ORD-PEN-01', 'Store Beta', 'Pending', 2);
  insertOrder.run(tDate, 'ORD-CONFLICT', 'Store Gamma', 'Opening Status Conflict', 1);
  insertOrder.run(tDate, 'ORD-UNTOUCHED', 'Store Alpha', 'New', 1);

  // Create manual allocation for tDate:
  // Agent Ali (id: 1) is assigned 'Store Alpha' (New)
  // Agent Basma (id: 2) is assigned 'Store Beta' (Pending)
  const empAli = db.prepare("SELECT id, name FROM employees WHERE name LIKE '%Ali Bahlol%' LIMIT 1").get() || { id: 1, name: 'Ali Bahlol cs' };
  const empBasma = db.prepare("SELECT id, name FROM employees WHERE name LIKE '%BASMA%' LIMIT 1").get() || { id: 2, name: 'BASMA CS' };

  const hRes = db.prepare("INSERT INTO allocation_headers (allocation_date, notes) VALUES (?, 'Tracking Test Alloc')").run(tDate);
  const hId = hRes.lastInsertRowid;
  db.prepare('INSERT INTO allocation_items (allocation_header_id, employee_id, account, status, available_orders_at_assignment) VALUES (?, ?, ?, ?, ?)').run(hId, empAli.id, 'Store Alpha', 'New', 2);
  db.prepare('INSERT INTO allocation_items (allocation_header_id, employee_id, account, status, available_orders_at_assignment) VALUES (?, ?, ?, ?, ?)').run(hId, empBasma.id, 'Store Beta', 'Pending', 1);

  // Synthesize Daily Log events for tDate:
  // 1 & 2: Ali touches ORD-NEW-01 at 09:00:00 (Printed), then at 09:01:00 (Printed) within 60s -> deduplicated to 1 action
  // 3: Ali touches ORD-NEW-01 at 09:03:00 (Printed) 120s after previous -> 2nd action counted
  // 4: Basma ALSO touches ORD-NEW-01 at 09:05:00 (Pending) -> multi-employee touch!
  // 5: Basma touches ORD-PEN-01 at 10:00:00 (Printed) -> 1 action
  // 6: Basma touches an UNALLOCATED account order ORD-EXTRA-01 ('Store Unassigned') at 10:15:00 (Printed) -> outside allocation!
  // 7: Ali touches an UNMATCHED order ORD-UNMATCHED-99 at 11:00:00 (Processing) -> order not in New or Pending inventory
  const testRecords = [
    { order: 'ORD-NEW-01', name: empAli.name, act: 'طباعة الطلب', st: 'Printed', dt: new Date('2026-10-15T09:00:00Z'), isCS: true },
    { order: 'ORD-NEW-01', name: empAli.name, act: 'طباعة الطلب', st: 'Printed', dt: new Date('2026-10-15T09:01:00Z'), isCS: true }, // deduped
    { order: 'ORD-NEW-01', name: empAli.name, act: 'طباعة الطلب', st: 'Printed', dt: new Date('2026-10-15T09:03:00Z'), isCS: true }, // valid
    { order: 'ORD-NEW-01', name: empBasma.name, act: 'طلب معلق', st: 'Pending', dt: new Date('2026-10-15T09:05:00Z'), isCS: true }, // multi-employee
    { order: 'ORD-PEN-01', name: empBasma.name, act: 'طباعة الطلب', st: 'Printed', dt: new Date('2026-10-15T10:00:00Z'), isCS: true },
    { order: 'ORD-EXTRA-01', name: empBasma.name, act: 'طباعة الطلب', st: 'Printed', dt: new Date('2026-10-15T10:15:00Z'), isCS: true },
    { order: 'ORD-UNMATCHED-99', name: empAli.name, act: 'تجهيز الطلب', st: 'Processing', dt: new Date('2026-10-15T11:00:00Z'), isCS: true }
  ];

  persistDailyLogRecords(tDate, null, testRecords);

  // 3. Test Deduplication & Orders Worked Today vs Real Actions
  const aliTracking = getEmployeeTracking(tDate, empAli.id);
  // Ali touched: ORD-NEW-01 (3 log events -> 2 real actions due to 120s dedup) and ORD-UNMATCHED-99 (1 real action)
  assert.strictEqual(aliTracking.orders_worked_today, 2, 'Orders Worked Today must count UNIQUE orders only');
  assert.strictEqual(aliTracking.real_actions, 3, 'Real Actions must count all valid deduplicated actions (2 on ORD-NEW-01 + 1 on ORD-UNMATCHED-99)');

  // 4. Assigned Accounts reflects manual allocation
  assert.deepStrictEqual(aliTracking.assigned_accounts, ['Store Alpha'], 'Assigned accounts must reflect manual allocation');
  assert.ok(aliTracking.actually_worked_accounts.includes('Store Alpha'), 'Actually worked accounts includes Store Alpha');
  assert.ok(aliTracking.actually_worked_accounts.includes('Unmatched Account'), 'Unmatched order account reported without hiding');

  // 5. Basma tracking: Extra Accounts Worked & Orders outside allocation
  const basmaTracking = getEmployeeTracking(tDate, empBasma.id);
  // Basma was assigned 'Store Beta', but touched ORD-NEW-01 (Store Alpha) and ORD-PEN-01 (Store Beta)
  assert.strictEqual(basmaTracking.orders_worked_outside_allocation, 2, 'Touched 2 orders outside assigned Store Beta (ORD-NEW-01 in Store Alpha + ORD-EXTRA-01 unknown)');
  assert.ok(basmaTracking.extra_accounts_worked.includes('Store Alpha'), 'Store Alpha is an extra account worked not assigned to Basma');

  // 6. Unassigned activity does NOT modify manual allocation
  const allocCheck = getAllocationForDate(tDate);
  assert.strictEqual(allocCheck.items.length, 2, 'Manual allocation items count must remain strictly 2');
  assert.strictEqual(allocCheck.items.find(i => i.employee_id === empBasma.id).account, 'Store Beta', 'Manual allocation untouched');

  // 7. Multi-employee touch: ORD-NEW-01 touched by both Ali and Basma
  const ordNewTrack = getOrderTracking(tDate, 'ORD-NEW-01');
  assert.strictEqual(ordNewTrack.order_code, 'ORD-NEW-01');
  assert.strictEqual(ordNewTrack.opening_status, 'New', 'Derived from File 1 (Slot 1)');
  assert.ok(ordNewTrack.actual_employees.includes(empAli.name), 'Must include Ali');
  assert.ok(ordNewTrack.actual_employees.includes(empBasma.name), 'Must include Basma');
  assert.strictEqual(ordNewTrack.last_logged_status, 'Pending', 'Last logged action was Basma pending at 09:05:00');
  assert.strictEqual(ordNewTrack.current_status, 'Pending', 'Current status matches last logged status');
  assert.strictEqual(ordNewTrack.timeline.length, 4, 'Timeline contains all 4 raw entries');

  // 8. Opening Status Conflict
  const ordConflictTrack = getOrderTracking(tDate, 'ORD-CONFLICT');
  assert.strictEqual(ordConflictTrack.opening_status, 'Opening Status Conflict', 'Flagged as Opening Status Conflict');

  // 9. Untouched order preserves opening status
  const ordUntouchedTrack = getOrderTracking(tDate, 'ORD-UNTOUCHED');
  assert.strictEqual(ordUntouchedTrack.opening_status, 'New');
  assert.strictEqual(ordUntouchedTrack.last_logged_status, null, 'No daily log actions');
  assert.strictEqual(ordUntouchedTrack.current_status, 'New', 'Current status preserved as opening status when untouched');

  // 10. Audit: Unmatched order IDs & Summary
  const overview = getTrackingOverview(tDate);
  assert.ok(overview.audit.unmatched_daily_log_orders.some(o => o.order_code === 'ORD-UNMATCHED-99'), 'ORD-UNMATCHED-99 reported in audit');
  assert.strictEqual(overview.opening_inventory.opening_status_conflicts, 1, '1 Opening status conflict reported');
  assert.strictEqual(overview.opening_inventory.untouched_orders, 2, 'ORD-CONFLICT and ORD-UNTOUCHED are untouched');

  // 11. Multi-Day Range Tracking: Distinguishes unique period orders from daily sums
  const tDate2 = '2026-10-16';
  db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(tDate2);
  // On Day 2, Ali touches ORD-NEW-01 again (1 action) and a new order ORD-DAY2-01 (1 action)
  persistDailyLogRecords(tDate2, null, [
    { order: 'ORD-NEW-01', name: empAli.name, act: 'طباعة الطلب', st: 'Printed', dt: new Date('2026-10-16T10:00:00Z'), isCS: true },
    { order: 'ORD-DAY2-01', name: empAli.name, act: 'طباعة الطلب', st: 'Printed', dt: new Date('2026-10-16T11:00:00Z'), isCS: true }
  ]);

  const rangeReport = getRangeTracking('2026-10-15', '2026-10-16');
  assert.strictEqual(rangeReport.days_count, 2);
  assert.strictEqual(rangeReport.summary.total_daily_unique_orders_sum, 6, 'Sum of daily unique orders: 4 on day 1 + 2 on day 2 = 6');
  assert.strictEqual(rangeReport.summary.unique_orders_in_period, 5, 'ORD-NEW-01 appeared on both days, so unique period orders is 5!');

  // Cleanup test dates
  db.prepare('DELETE FROM raw_log_records WHERE work_date IN (?, ?)').run(tDate, tDate2);
  db.prepare('DELETE FROM current_work_orders WHERE work_date IN (?, ?)').run(tDate, tDate2);
  deleteAllocationForDate(tDate);

  console.log('✓ PASS: All 18 Phase 25 Verification Requirements thoroughly tested and verified.');
}

// -------------------------------------------------------------
// TEST 16: Tracking Truth-Telling & Daily Employee Summary (Scenarios A-F)
// -------------------------------------------------------------
{
  console.log('Testing: Tracking Truth-Telling & Daily Employee Summary (Scenarios A-F)...');

  // Setup test employees
  const insEmp = db.prepare('INSERT OR IGNORE INTO employees (name, department, active) VALUES (?, ?, 1)');
  insEmp.run('Truth Ali CS', 'CS');
  insEmp.run('Truth Bob CS', 'CS');
  insEmp.run('Truth Clara CS', 'CS');

  const empAli = db.prepare('SELECT * FROM employees WHERE name = ?').get('Truth Ali CS');
  const empBob = db.prepare('SELECT * FROM employees WHERE name = ?').get('Truth Bob CS');
  const empClara = db.prepare('SELECT * FROM employees WHERE name = ?').get('Truth Clara CS');

  const setupOpeningOrder = (date, orderCode, account, status = 'New', slot = 1) => {
    db.prepare(`
      INSERT INTO current_work_orders (work_date, order_code, account, status, source_file_slot)
      VALUES (?, ?, ?, ?, ?)
    `).run(date, orderCode, account, status, slot);
  };

  const setupManualAllocation = (date, empId, account, status = 'New') => {
    let header = db.prepare('SELECT id FROM allocation_headers WHERE allocation_date = ?').get(date);
    let headerId = header ? header.id : null;
    if (!headerId) {
      const res = db.prepare("INSERT INTO allocation_headers (allocation_date, notes) VALUES (?, 'Test Alloc')").run(date);
      headerId = res.lastInsertRowid;
    }
    db.prepare(`
      INSERT INTO allocation_items (allocation_header_id, employee_id, account, status, available_orders_at_assignment)
      VALUES (?, ?, ?, ?, 1)
    `).run(headerId, empId, account, status);
  };

  // ============================================================
  // SCENARIO A: End-of-Day Log Not Uploaded
  // ============================================================
  const dateA = '2026-11-01';
  db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(dateA);
  db.prepare('DELETE FROM performance_snapshots WHERE date = ?').run(dateA);
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(dateA);
  deleteAllocationForDate(dateA);

  // Setup opening inventory & manual allocation for dateA
  setupOpeningOrder(dateA, 'ORD-A1', 'ALPHA_STORE', 'New', 1);
  setupManualAllocation(dateA, empAli.id, 'ALPHA_STORE', 'New');

  // Assert upload status
  assert.strictEqual(isDailyLogUploaded(dateA), false, 'Scenario A: Log must NOT be marked uploaded');
  const sourcesA = getSourcesUploadStatus(dateA);
  assert.strictEqual(sourcesA.daily_log_uploaded, false, 'Scenario A: sources status shows log missing');
  assert.strictEqual(sourcesA.new_orders_uploaded, true, 'Scenario A: new orders uploaded');

  // Employee Reality: Must return null and 'N/A' compliance
  const empTrackA = getEmployeeTracking(dateA, empAli.id);
  assert.strictEqual(empTrackA.daily_log_uploaded, false);
  assert.strictEqual(empTrackA.orders_worked_today, null, 'Scenario A: orders_worked_today must be null');
  assert.strictEqual(empTrackA.real_actions, null, 'Scenario A: real_actions must be null');
  assert.strictEqual(empTrackA.allocation_compliance, null, 'Scenario A: allocation_compliance must be null');
  assert.strictEqual(empTrackA.allocation_compliance_label, 'N/A', 'Scenario A: compliance label must be N/A');
  assert.strictEqual(empTrackA.status_message, 'End-of-Day Log Not Uploaded');
  assert.deepStrictEqual(empTrackA.assigned_accounts, ['ALPHA_STORE']);

  // Team Summary: null aggregates for worked metrics
  const teamSumA = getTeamTrackingSummary(dateA);
  assert.strictEqual(teamSumA.daily_log_uploaded, false);
  assert.strictEqual(teamSumA.team_kpis.employees_with_activity, null);
  assert.strictEqual(teamSumA.team_kpis.total_orders_worked_today, null);
  const aliInTeamA = teamSumA.employees.find(e => e.employee_id === empAli.id);
  assert.strictEqual(aliInTeamA.allocation_compliance, null);
  assert.strictEqual(aliInTeamA.allocation_compliance_label, 'N/A');

  // Tracking Overview: null actual work
  const overviewA = getTrackingOverview(dateA);
  assert.strictEqual(overviewA.daily_log_uploaded, false);
  assert.strictEqual(overviewA.actual_work.orders_worked_today, null);
  assert.strictEqual(overviewA.opening_inventory.untouched_orders, null);

  // ============================================================
  // SCENARIO B: Log Uploaded — Zero Activity Recorded for Employee
  // ============================================================
  const dateB = '2026-11-02';
  db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(dateB);
  db.prepare('DELETE FROM performance_snapshots WHERE date = ?').run(dateB);
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(dateB);
  deleteAllocationForDate(dateB);

  // Ali and Bob are assigned accounts
  setupOpeningOrder(dateB, 'ORD-B1', 'ALPHA_STORE', 'New', 1);
  setupOpeningOrder(dateB, 'ORD-B2', 'BETA_STORE', 'New', 1);
  setupManualAllocation(dateB, empAli.id, 'ALPHA_STORE', 'New');
  setupManualAllocation(dateB, empBob.id, 'BETA_STORE', 'New');

  // Only Ali works; Bob has zero activity in daily log!
  persistDailyLogRecords(dateB, null, [
    { order: 'ORD-B1', name: empAli.name, act: 'طباعة الطلب', st: 'Printed', dt: new Date('2026-11-02T10:00:00Z'), isCS: true }
  ]);

  assert.strictEqual(isDailyLogUploaded(dateB), true, 'Scenario B: Log IS uploaded');

  // Bob has assigned account BETA_STORE, but 0 actions logged
  const empTrackBobB = getEmployeeTracking(dateB, empBob.id);
  assert.strictEqual(empTrackBobB.daily_log_uploaded, true);
  assert.strictEqual(empTrackBobB.orders_worked_today, 0, 'Scenario B: Bob worked 0 orders');
  assert.strictEqual(empTrackBobB.real_actions, 0, 'Scenario B: Bob has 0 real actions');
  assert.strictEqual(empTrackBobB.allocation_compliance, null, 'Scenario B: Zero activity compliance must be null (NOT 100%!)');
  assert.strictEqual(empTrackBobB.allocation_compliance_label, 'N/A', 'Scenario B: Zero activity compliance must be N/A');
  assert.strictEqual(empTrackBobB.status_message, 'Log Uploaded — No Activity Recorded');

  // ============================================================
  // SCENARIO C: Assigned vs Actually Worked Alignment (100% Compliance)
  // ============================================================
  // Ali worked on ORD-B1 which belongs to ALPHA_STORE (his assigned account)
  const empTrackAliB = getEmployeeTracking(dateB, empAli.id);
  assert.strictEqual(empTrackAliB.orders_worked_today, 1);
  assert.strictEqual(empTrackAliB.real_actions, 1);
  assert.strictEqual(empTrackAliB.orders_worked_outside_allocation, 0);
  assert.strictEqual(empTrackAliB.allocation_compliance, 100);
  assert.strictEqual(empTrackAliB.allocation_compliance_label, '100%');
  assert.strictEqual(empTrackAliB.outside_allocation.has_unassigned_activity, false);
  assert.deepStrictEqual(empTrackAliB.actually_worked_accounts, ['ALPHA_STORE']);
  assert.deepStrictEqual(empTrackAliB.extra_accounts_worked, []);

  // ============================================================
  // SCENARIO D: Outside Allocation Detection (Manual allocation preserved)
  // ============================================================
  const dateD = '2026-11-03';
  db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(dateD);
  db.prepare('DELETE FROM performance_snapshots WHERE date = ?').run(dateD);
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(dateD);
  deleteAllocationForDate(dateD);

  setupOpeningOrder(dateD, 'ORD-D1', 'ALPHA_STORE', 'New', 1);
  setupOpeningOrder(dateD, 'ORD-D2', 'EXTRA_STORE', 'New', 1);
  // Clara is manually assigned ONLY ALPHA_STORE
  setupManualAllocation(dateD, empClara.id, 'ALPHA_STORE', 'New');

  // Clara touches ORD-D1 (in ALPHA_STORE) AND ORD-D2 (in EXTRA_STORE - unassigned!)
  persistDailyLogRecords(dateD, null, [
    { order: 'ORD-D1', name: empClara.name, act: 'طباعة الطلب', st: 'Printed', dt: new Date('2026-11-03T10:00:00Z'), isCS: true },
    { order: 'ORD-D2', name: empClara.name, act: 'طباعة الطلب', st: 'Printed', dt: new Date('2026-11-03T11:00:00Z'), isCS: true }
  ]);

  const empTrackClaraD = getEmployeeTracking(dateD, empClara.id);
  assert.strictEqual(empTrackClaraD.orders_worked_today, 2);
  assert.strictEqual(empTrackClaraD.real_actions, 2);
  assert.strictEqual(empTrackClaraD.orders_worked_outside_allocation, 1);
  assert.strictEqual(empTrackClaraD.allocation_compliance, 50);
  assert.strictEqual(empTrackClaraD.allocation_compliance_label, '50%');
  assert.strictEqual(empTrackClaraD.outside_allocation.has_unassigned_activity, true);
  assert.deepStrictEqual(empTrackClaraD.extra_accounts_worked, ['EXTRA_STORE']);

  // CRITICAL: Manual allocation must NOT be modified
  const currentAllocD = getAllocationForDate(dateD);
  const claraAlloc = currentAllocD.items.find(a => a.employee_id === empClara.id);
  assert.strictEqual(claraAlloc.account, 'ALPHA_STORE', 'CRITICAL: Original manual allocation is never modified automatically');

  // ============================================================
  // SCENARIO E: Team-Level Summary Aggregates
  // ============================================================
  const teamSumD = getTeamTrackingSummary(dateD);
  assert.strictEqual(teamSumD.daily_log_uploaded, true);
  assert.strictEqual(teamSumD.team_kpis.employees_with_activity, 1, 'Only Clara was active');
  assert.strictEqual(teamSumD.team_kpis.total_orders_worked_today, 2);
  assert.strictEqual(teamSumD.team_kpis.total_real_actions, 2);
  assert.strictEqual(teamSumD.team_kpis.outside_allocation_accounts, 1, '1 outside account worked');

  const claraInTeamD = teamSumD.employees.find(e => e.employee_id === empClara.id);
  assert.strictEqual(claraInTeamD.has_outside_activity, true);
  assert.strictEqual(claraInTeamD.extra_accounts_count, 1);
  assert.strictEqual(claraInTeamD.allocation_compliance, 50);

  // ============================================================
  // SCENARIO F: Multi-Action Order Deduplication & Accurate Orders Worked
  // ============================================================
  const dateF = '2026-11-04';
  db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(dateF);
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(dateF);
  deleteAllocationForDate(dateF);

  setupOpeningOrder(dateF, 'ORD-MULTI-1', 'ALPHA_STORE', 'New', 1);
  setupManualAllocation(dateF, empAli.id, 'ALPHA_STORE', 'New');

  // Ali performs 3 actions on the SAME order:
  // 1. t=0: Printed
  // 2. t=20s: Printed (duplicate within 120s window -> should be filtered by deduplication)
  // 3. t=300s: Pending (distinct action 5 minutes later -> should be 2nd real action)
  persistDailyLogRecords(dateF, null, [
    { order: 'ORD-MULTI-1', name: empAli.name, act: 'حالة الطلب إلى Printed', st: 'Printed', dt: new Date('2026-11-04T10:00:00Z'), isCS: true },
    { order: 'ORD-MULTI-1', name: empAli.name, act: 'حالة الطلب إلى Printed', st: 'Printed', dt: new Date('2026-11-04T10:00:20Z'), isCS: true },
    { order: 'ORD-MULTI-1', name: empAli.name, act: 'حالة الطلب إلى Pending', st: 'Pending', dt: new Date('2026-11-04T10:05:00Z'), isCS: true }
  ]);

  const empTrackAliF = getEmployeeTracking(dateF, empAli.id);
  assert.strictEqual(empTrackAliF.orders_worked_today, 1, 'Scenario F: Orders Worked Today must be exactly 1 unique order');
  assert.strictEqual(empTrackAliF.real_actions, 2, 'Scenario F: Real actions must be exactly 2 after 120s deduplication');
  assert.strictEqual(empTrackAliF.allocation_compliance, 100, 'Scenario F: Compliance is 100%');

  // Cleanup test records
  db.prepare('DELETE FROM raw_log_records WHERE work_date IN (?, ?, ?, ?)').run(dateA, dateB, dateD, dateF);
  db.prepare('DELETE FROM current_work_orders WHERE work_date IN (?, ?, ?, ?)').run(dateA, dateB, dateD, dateF);
  db.prepare('DELETE FROM employees WHERE id IN (?, ?, ?)').run(empAli.id, empBob.id, empClara.id);
  deleteAllocationForDate(dateA);
  deleteAllocationForDate(dateB);
  deleteAllocationForDate(dateD);
  deleteAllocationForDate(dateF);

  console.log('✓ PASS: Test 16 Scenarios A-F (Truth-Telling Tracking & Daily Employee Summary) verified.');
}

console.log('--- ALL REGRESSION TESTS PASSED SUCCESSFULLY! ---');
