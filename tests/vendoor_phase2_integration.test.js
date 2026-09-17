import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { db } from '../db/index.js';
import {
  classifyVendoorAction,
  ACTION_CLASSIFICATIONS,
  isProductiveVendoorAction
} from '../services/vendoor/actions.js';
import {
  resolveEmployeeIdentity,
  saveIdentityMapping,
  getIdentityMappings,
  getUnmatchedEmployeesQueue,
  MATCH_STATUS
} from '../services/vendoor/identity.js';
import {
  computeHistoricalProductivity,
  getFullEmployeeProductivityProfiles,
  getProductivityConfig
} from '../services/vendoor/productivity.js';
import {
  syncVendoorOrders,
  syncVendoorLogs,
  getSyncRunsHistory
} from '../services/vendoor/orchestrator.js';

describe('PHASE 2 VENDOOR INTEGRATION & PRODUCTIVITY ENGINE TEST SUITE', () => {
  const TEST_DATE = '2026-12-10';

  let emp1, emp2, emp3;

  before(() => {
    // Setup clean master employees
    db.prepare("DELETE FROM employees WHERE name LIKE 'P2_TEST_%'").run();
    db.prepare("DELETE FROM vendoor_identity_mappings WHERE vendoor_name LIKE 'P2_%'").run();
    db.prepare('DELETE FROM vendoor_sync_runs').run();
    db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(TEST_DATE);

    const ins = db.prepare("INSERT INTO employees (name, department, team_membership, active) VALUES (?, 'CS', 'Both', 1)");
    emp1 = db.prepare('SELECT * FROM employees WHERE id = ?').get(ins.run('P2_TEST_Hossam').lastInsertRowid);
    emp2 = db.prepare('SELECT * FROM employees WHERE id = ?').get(ins.run('P2_TEST_Mariam').lastInsertRowid);
    emp3 = db.prepare('SELECT * FROM employees WHERE id = ?').get(ins.run('P2_TEST_Ahmed').lastInsertRowid);
  });

  after(() => {
    db.prepare("DELETE FROM employees WHERE name LIKE 'P2_TEST_%'").run();
    db.prepare("DELETE FROM vendoor_identity_mappings WHERE vendoor_name LIKE 'P2_%'").run();
    db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(TEST_DATE);
  });

  test('1. Action Classification: Canceled and Unknown do NOT count as productive', () => {
    assert.strictEqual(classifyVendoorAction('Printed').classification, ACTION_CLASSIFICATIONS.VALID_PRODUCTIVE_ACTION);
    assert.strictEqual(classifyVendoorAction('Pending').classification, ACTION_CLASSIFICATIONS.VALID_PRODUCTIVE_ACTION);
    assert.strictEqual(classifyVendoorAction('Alt Phone Added').classification, ACTION_CLASSIFICATIONS.VALID_PRODUCTIVE_ACTION);
    assert.strictEqual(classifyVendoorAction('Cancelled').classification, ACTION_CLASSIFICATIONS.CANCELED_ACTION);
    assert.strictEqual(classifyVendoorAction('Random Unknown Event').classification, ACTION_CLASSIFICATIONS.UNKNOWN_ACTION);

    assert.strictEqual(isProductiveVendoorAction('Printed'), true);
    assert.strictEqual(isProductiveVendoorAction('Pending'), true);
    assert.strictEqual(isProductiveVendoorAction('Cancelled'), false);
    assert.strictEqual(isProductiveVendoorAction('Unknown'), false);
  });

  test('2. Deterministic Identity Resolution: Exact match vs Unmatched', () => {
    // Exact match
    const match1 = resolveEmployeeIdentity('P2_TEST_Hossam');
    assert.strictEqual(match1.status, MATCH_STATUS.EXACT_MATCH);
    assert.strictEqual(match1.employee_id, emp1.id);

    // Unmatched unknown employee -> goes to UNMATCHED
    const match2 = resolveEmployeeIdentity('P2_UNKNOWN_AGENT_XYZ');
    assert.strictEqual(match2.status, MATCH_STATUS.UNMATCHED);
    assert.strictEqual(match2.employee_id, null);

    // Verify it appears in the Unmatched Queue
    const queue = getUnmatchedEmployeesQueue();
    const queued = queue.find(q => q.vendoor_name === 'P2_UNKNOWN_AGENT_XYZ');
    assert.ok(queued, 'Unmatched agent must be listed in Unmatched Queue');
    assert.strictEqual(queued.status, 'UNMATCHED');
  });

  test('3. Explicit Identity Mapping persists and resolves correctly', () => {
    // Save explicit mapping for P2_NICKNAME -> Mariam
    saveIdentityMapping('P2_NICKNAME_MIMI', emp2.id, 'Verified nickname by supervisor');

    const resolved = resolveEmployeeIdentity('P2_NICKNAME_MIMI');
    assert.strictEqual(resolved.status, MATCH_STATUS.EXPLICIT_MAPPING);
    assert.strictEqual(resolved.employee_id, emp2.id);
    assert.strictEqual(resolved.employee_name, 'P2_TEST_Mariam');
  });

  test('3b. Ambiguous Collision in Master produces NEEDS_REVIEW, never picks arbitrarily', () => {
    // Insert two master employees with identical normalized names (e.g. whitespace variations)
    const ins = db.prepare("INSERT INTO employees (name, department, team_membership, active) VALUES (?, 'CS', 'Both', 1)");
    const c1 = ins.run('P2_TEST_Twin Collision').lastInsertRowid;
    const c2 = ins.run('P2_TEST_Twin   Collision').lastInsertRowid;

    // Resolving should detect multiple exact matches and return NEEDS_REVIEW
    const resolved = resolveEmployeeIdentity('P2_TEST_Twin Collision');
    assert.strictEqual(resolved.status, MATCH_STATUS.NEEDS_REVIEW, 'Ambiguous candidates must return NEEDS_REVIEW');
    assert.strictEqual(resolved.employee_id, null, 'Must NOT pick an employee arbitrarily');

    // Clean up twin records
    db.prepare('DELETE FROM employees WHERE id IN (?, ?)').run(c1, c2);
  });

  test('4. Vendoor Sync Orchestration (Mock Mode): Orders & Logs', async () => {
    const ordersRes = await syncVendoorOrders({ forceMode: 'mock', maxPages: 2, pageSize: 10 });
    assert.strictEqual(ordersRes.success, true);
    assert.ok(ordersRes.summary.total_fetched > 0);
    assert.ok(ordersRes.sync_run_id);

    const logsRes = await syncVendoorLogs({ startDate: TEST_DATE, endDate: TEST_DATE, forceMode: 'mock' });
    assert.strictEqual(logsRes.success, true);
    assert.ok(logsRes.summary.total_rows > 0);

    const history = getSyncRunsHistory();
    assert.ok(history.length >= 2);
  });

  test('5. Historical Productivity Engine: Deduping, Tumbling Windows, Median Rates', () => {
    // Insert test logs for Hossam
    const ins = db.prepare(`
      INSERT INTO raw_log_records (order_code, employee_name, status, action, event_datetime, work_date, is_cs, is_deduped)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1)
    `);

    // Window 1 (09:00): 4 unique orders
    for (let i = 1; i <= 4; i++) {
      ins.run(`ORD_P2_H_${i}`, 'P2_TEST_Hossam', 'Printed', 'Action Done', `2026-12-10 09:0${i}:00`, TEST_DATE);
    }
    // Window 2 (09:10): 4 unique orders
    for (let i = 5; i <= 8; i++) {
      ins.run(`ORD_P2_H_${i}`, 'P2_TEST_Hossam', 'Pending', 'Action Done', `2026-12-10 09:1${i-4}:00`, TEST_DATE);
    }
    // Window 3 (09:20): Canceled orders (should be EXCLUDED from productivity)
    for (let i = 9; i <= 12; i++) {
      ins.run(`ORD_P2_H_${i}`, 'P2_TEST_Hossam', 'Cancelled', 'Action Canceled', `2026-12-10 09:2${i-8}:00`, TEST_DATE);
    }

    const prodMap = computeHistoricalProductivity(TEST_DATE);
    const hossamProd = prodMap.get(emp1.id);

    console.log("HOSSAM ID:", emp1.id, "KEYS:", Array.from(prodMap.keys())); assert.ok(hossamProd, 'Hossam productivity record must exist');
    assert.strictEqual(hossamProd.unique_orders_worked, 8, 'Only the 8 valid non-canceled orders must be counted');
    assert.strictEqual(hossamProd.window_count, 2, 'Canceled-only window must not count as productive');
    assert.strictEqual(hossamProd.typical_orders_per_10m, 4, 'Median of [4, 4] is 4');
  });

  test('6. Full Employee Productivity Profile & Dynamic Remaining Capacity', () => {
    const profiles = getFullEmployeeProductivityProfiles(TEST_DATE);
    const hossamProf = profiles.find(p => p.employee_id === emp1.id);

    assert.ok(hossamProf, 'Hossam profile must exist');
    assert.strictEqual(hossamProf.typical_orders_per_10m, 4);
    assert.strictEqual(hossamProf.typical_orders_per_hour, 24);
    assert.ok(hossamProf.estimated_capacity > 50, 'Derived capacity must scale with high throughput');
    assert.strictEqual(hossamProf.current_load, 0);
    assert.strictEqual(hossamProf.remaining_capacity, hossamProf.estimated_capacity);
  });
});
