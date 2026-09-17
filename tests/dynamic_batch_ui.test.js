import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import db from '../db/index.js';
import {
  stageSpecificOrdersFile,
  deleteSpecificOrdersFile,
  mergeSpecificOrdersPool,
  getCurrentOrders,
  getCurrentAccountsWithCounts,
  saveWorkAllocation,
  getAllocationForDate
} from '../services/allocation.js';

test('Dynamic Multi-File Staging and Detailed Account Data Suite', async (t) => {
  const testDate = '2026-09-18';

  // Clean test date
  db.prepare('DELETE FROM specific_orders_uploads WHERE work_date = ?').run(testDate);
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(testDate);
  db.prepare('DELETE FROM current_work_pool_summary WHERE work_date = ?').run(testDate);
  db.prepare('DELETE FROM allocation_items WHERE allocation_header_id IN (SELECT id FROM allocation_headers WHERE allocation_date = ?)').run(testDate);
  db.prepare('DELETE FROM allocation_headers WHERE allocation_date = ?').run(testDate);

  await t.test('1. Stage File #1 (300 orders) and File #2 (290 orders) -> 590 Unique Orders', () => {
    // Generate 300 orders for File 1 across Account Alpha and Account Beta
    const file1Rows = [];
    for (let i = 1; i <= 300; i++) {
      file1Rows.push({
        order_code: `ORD-F1-${String(i).padStart(4, '0')}`,
        account: i <= 200 ? 'Account Alpha' : 'Account Beta',
        status: 'New'
      });
    }

    // Generate 290 orders for File 2 across Account Beta and Account Gamma
    const file2Rows = [];
    for (let i = 1; i <= 290; i++) {
      file2Rows.push({
        order_code: `ORD-F2-${String(i).padStart(4, '0')}`,
        account: i <= 150 ? 'Account Beta' : 'Account Gamma',
        status: 'New'
      });
    }

    const stage1 = stageSpecificOrdersFile(testDate, 1, 'SpecificOrders_Batch1.xlsx', file1Rows);
    assert.equal(stage1.valid_orders_count, 300);

    const stage2 = stageSpecificOrdersFile(testDate, 2, 'SpecificOrders_Batch2.xlsx', file2Rows);
    assert.equal(stage2.valid_orders_count, 290);

    const mergeResult = mergeSpecificOrdersPool(testDate);
    assert.equal(mergeResult.unique_orders, 590, '300 + 290 should equal 590 unique orders in pool');
    assert.equal(mergeResult.accounts_count, 3, 'Should consolidate 3 unique accounts');
  });

  await t.test('2. Verify detailed account breakdown (accounts-detailed)', () => {
    const detailed = getCurrentAccountsWithCounts(testDate);
    assert.equal(detailed.length, 3);

    const alpha = detailed.find(a => a.account === 'Account Alpha');
    assert.ok(alpha);
    assert.equal(alpha.total_orders, 200);
    assert.equal(alpha.new_orders, 200);
    assert.equal(alpha.pending_orders, 0);

    const beta = detailed.find(a => a.account === 'Account Beta');
    assert.ok(beta);
    // 100 from File 1 + 150 from File 2 = 250
    assert.equal(beta.total_orders, 250);
    assert.equal(beta.new_orders, 250);

    const gamma = detailed.find(a => a.account === 'Account Gamma');
    assert.ok(gamma);
    assert.equal(gamma.total_orders, 140);
    assert.equal(gamma.new_orders, 140);
  });

  await t.test('3. Allocation Preservation: Prior allocations remain intact during pool operations', () => {
    // Ensure an employee exists for testing
    let emp = db.prepare('SELECT id FROM employees LIMIT 1').get();
    if (!emp) {
      db.prepare("INSERT INTO employees (name, department, email) VALUES ('Test Agent', 'CS', 'test@example.com')").run();
      emp = db.prepare('SELECT id FROM employees LIMIT 1').get();
    }

    // Save initial allocation for Account Alpha
    saveWorkAllocation(testDate, [
      { employee_id: emp.id, account: 'Account Alpha', status: 'NEW', available_orders: 200 }
    ], 'Preservation test note');

    const allocBefore = getAllocationForDate(testDate);
    assert.ok(allocBefore);
    assert.equal(allocBefore.items.length, 1);
    assert.equal(allocBefore.items[0].account, 'Account Alpha');

    // Stage File #3 (50 orders for Delta)
    const file3Rows = [];
    for (let i = 1; i <= 50; i++) {
      file3Rows.push({
        order_code: `ORD-F3-${String(i).padStart(4, '0')}`,
        account: 'Account Delta',
        status: 'New'
      });
    }
    stageSpecificOrdersFile(testDate, 3, 'SpecificOrders_Batch3.xlsx', file3Rows);
    mergeSpecificOrdersPool(testDate);

    // Verify existing allocation was preserved and NOT cleared
    const allocAfter = getAllocationForDate(testDate);
    assert.ok(allocAfter);
    assert.equal(allocAfter.items.length, 1);
    assert.equal(allocAfter.items[0].account, 'Account Alpha');
    assert.equal(allocAfter.items[0].available_orders_at_assignment, 200);

    // Verify pool now has 590 + 50 = 640 orders
    const pool = getCurrentOrders(testDate, { limit: 1000 }).orders;
    assert.equal(pool.length, 640);
  });

  await t.test('4. Dynamic File Removal: Removing File #3 reduces pool accurately', () => {
    const removal = deleteSpecificOrdersFile(testDate, 3);
    assert.equal(removal.success, true);
    assert.equal(removal.unique_orders, 590);

    // Verify pool reflects removal
    const pool = getCurrentOrders(testDate, { limit: 1000 }).orders;
    assert.equal(pool.length, 590);
    assert.ok(!pool.some(o => o.account === 'Account Delta'));
  });

  await t.test('5. Frontend Template Verification', () => {
    const templatePath = path.join(process.cwd(), 'template.html');
    const content = fs.readFileSync(templatePath, 'utf8');

    assert.ok(content.includes('uploadSpecificOrdersBatch'), 'UI includes batch upload handler');
    assert.ok(content.includes('removeStagedFile'), 'UI includes staged file removal handler');
    assert.ok(content.includes('/api/work/accounts-detailed'), 'UI fetches detailed account counts');
    assert.ok(content.includes('openOrderLevelModal(targetAcc'), 'openOrderLevelModal supports targeted account filtering');
  });

  // Clean up
  db.prepare('DELETE FROM specific_orders_uploads WHERE work_date = ?').run(testDate);
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(testDate);
  db.prepare('DELETE FROM current_work_pool_summary WHERE work_date = ?').run(testDate);
  db.prepare('DELETE FROM allocation_items WHERE allocation_header_id IN (SELECT id FROM allocation_headers WHERE allocation_date = ?)').run(testDate);
  db.prepare('DELETE FROM allocation_headers WHERE allocation_date = ?').run(testDate);
});
