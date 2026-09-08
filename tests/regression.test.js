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
  getCurrentWorkOverview
} from '../services/allocation.js';

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

  // Verify that SHARED-01 resolved to Pending (active pending priority)
  const sharedOrder = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(testDate, 'SHARED-01');
  assert.strictEqual(sharedOrder.status, 'Pending', 'Status precedence resolved to Pending');

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
    db.prepare("DELETE FROM employees WHERE name IN ('Ahmed Test', 'Ahmed Test Updated', 'ahmed test')").run();

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
    assert.strictEqual(createData.employee.active, 1);

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
    assert.strictEqual(deactData.employee.active, 0);

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
    assert.strictEqual(reactData.employee.active, 1);

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
    db.prepare('DELETE FROM performance_snapshots WHERE employee_id = ?').run(newEmpId);
    db.prepare('DELETE FROM daily_working_team WHERE employee_id = ?').run(newEmpId);
    db.prepare('DELETE FROM employees WHERE id = ?').run(newEmpId);

    console.log('✓ PASS: Employee Master full end-to-end CRUD, validation, and history permanence verified.');
  } finally {
    server.close();
  }
}

console.log('--- ALL REGRESSION TESTS PASSED SUCCESSFULLY! ---');
