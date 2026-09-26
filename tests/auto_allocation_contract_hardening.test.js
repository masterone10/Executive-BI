import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import {
  validateAllocationPayload,
  saveFinalOrderLevelAllocation,
  generateOrderLevelAllocation
} from '../services/allocation.js';
import {
  executeEnterpriseAllocation,
  planEnterpriseAllocation
} from '../services/enterprise_allocation.js';

describe('Auto Allocation Contract Hardening & Defensive Validation Suite', () => {
  const TEST_DATE = '2030-05-20';

  before(() => {
    // Setup clean environment for test date
    db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM allocation_versions WHERE allocation_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
  });

  after(() => {
    db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM allocation_versions WHERE allocation_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
  });

  // -------------------------------------------------------------
  // 1. validateAllocationPayload Defensive Validation
  // -------------------------------------------------------------
  test('1. validateAllocationPayload rejects null or undefined with clear diagnostic error', () => {
    assert.throws(
      () => validateAllocationPayload(TEST_DATE, null),
      (err) => {
        assert.ok(err.message.includes('[ALLOCATION CONTRACT VALIDATION ERROR]'));
        assert.ok(err.message.includes('Expected a non-null object or array, received "null"'));
        assert.ok(err.message.includes(TEST_DATE));
        return true;
      }
    );

    assert.throws(
      () => validateAllocationPayload(TEST_DATE, undefined),
      (err) => {
        assert.ok(err.message.includes('[ALLOCATION CONTRACT VALIDATION ERROR]'));
        assert.ok(err.message.includes('Expected a non-null object or array, received "undefined"'));
        return true;
      }
    );
  });

  test('2. validateAllocationPayload rejects primitive types with descriptive error', () => {
    assert.throws(
      () => validateAllocationPayload(TEST_DATE, 'invalid_payload_string'),
      (err) => {
        assert.ok(err.message.includes('Expected a non-null object or array, received "string"'));
        return true;
      }
    );
  });

  test('3. validateAllocationPayload rejects objects missing allocation records array', () => {
    assert.throws(
      () => validateAllocationPayload(TEST_DATE, { foo: 'bar', timestamp: 12345 }),
      (err) => {
        assert.ok(err.message.includes('Missing required allocation records array'));
        assert.ok(err.message.includes('foo, timestamp'));
        return true;
      }
    );
  });

  test('4. validateAllocationPayload accepts valid non-empty raw_allocations', () => {
    const payload = {
      method: 'Fair Random',
      raw_allocations: [
        { order_code: 'ORD-101', account: 'Test Store', status: 'New', employee_id: 1, employee_name: 'Agent A' },
        { order_code: 'ORD-102', account: 'Test Store', status: 'New', employee_id: 1, employee_name: 'Agent A' }
      ]
    };

    const res = validateAllocationPayload(TEST_DATE, payload);
    assert.equal(res.isValid, true);
    assert.equal(res.isEmpty, false);
    assert.equal(res.records.length, 2);
    assert.equal(res.method, 'Fair Random');
  });

  test('5. validateAllocationPayload accepts polymorphic keys (allocations, orderLevelAllocations, direct array)', () => {
    // allocations alias
    const p1 = {
      allocations: [{ order_code: 'ORD-201', account: 'Acc A', status: 'New', employee_id: 2 }]
    };
    const r1 = validateAllocationPayload(TEST_DATE, p1);
    assert.equal(r1.records.length, 1);

    // orderLevelAllocations alias
    const p2 = {
      orderLevelAllocations: [{ order_code: 'ORD-202', account: 'Acc B', status: 'Pending', employee_id: 3 }]
    };
    const r2 = validateAllocationPayload(TEST_DATE, p2);
    assert.equal(r2.records.length, 1);

    // Direct root array
    const p3 = [
      { order_code: 'ORD-203', account: 'Acc C', status: 'New', employee_id: 4 }
    ];
    const r3 = validateAllocationPayload(TEST_DATE, p3);
    assert.equal(r3.records.length, 1);
  });

  test('6. validateAllocationPayload handles valid empty allocation without error', () => {
    const emptyPayload = {
      raw_allocations: [],
      by_employee: []
    };

    const res = validateAllocationPayload(TEST_DATE, emptyPayload);
    assert.equal(res.isValid, true);
    assert.equal(res.isEmpty, true);
    assert.equal(res.records.length, 0);
  });

  test('7. validateAllocationPayload rejects malformed records inside array', () => {
    // Missing order_code
    assert.throws(
      () => validateAllocationPayload(TEST_DATE, {
        raw_allocations: [{ account: 'Store A', status: 'New' }]
      }),
      (err) => {
        assert.ok(err.message.includes('Missing or non-string "order_code"'));
        return true;
      }
    );

    // Missing account
    assert.throws(
      () => validateAllocationPayload(TEST_DATE, {
        raw_allocations: [{ order_code: 'ORD-301', status: 'New' }]
      }),
      (err) => {
        assert.ok(err.message.includes('Missing or non-string "account"'));
        return true;
      }
    );
  });

  // -------------------------------------------------------------
  // 2. saveFinalOrderLevelAllocation Contract & Persistence
  // -------------------------------------------------------------
  test('8. saveFinalOrderLevelAllocation saves non-empty payload successfully', () => {
    const payload = {
      method: 'Smart Fair Test',
      raw_allocations: [
        { order_code: 'TEST-ORD-01', account: 'Account Alpha', status: 'New', employee_id: 10, employee_name: 'Agent 10' },
        { order_code: 'TEST-ORD-02', account: 'Account Alpha', status: 'New', employee_id: 10, employee_name: 'Agent 10' },
        { order_code: 'TEST-ORD-03', account: 'Account Beta', status: 'Pending', employee_id: null, employee_name: 'UNASSIGNED' }
      ],
      by_employee: [
        { employee_id: 10, employee_name: 'Agent 10', accounts: [{ account: 'Account Alpha', status: 'New', count: 2 }], total_orders: 2 }
      ]
    };

    const saved = saveFinalOrderLevelAllocation(TEST_DATE, payload, 'Test Run');
    assert.equal(saved.success, true);
    assert.equal(saved.total_orders, 3);
    assert.equal(saved.assigned_orders, 2);
    assert.equal(saved.unassigned_orders, 1);
    assert.ok(saved.version_number >= 1);

    // Verify written to database
    const dbRows = db.prepare('SELECT * FROM order_level_allocations WHERE allocation_date = ? AND allocation_version = ?')
      .all(TEST_DATE, saved.version_number);
    assert.equal(dbRows.length, 3);
  });

  test('9. saveFinalOrderLevelAllocation handles valid empty allocation cleanly', () => {
    const emptyPayload = {
      raw_allocations: [],
      by_employee: []
    };

    const saved = saveFinalOrderLevelAllocation(TEST_DATE, emptyPayload, 'Empty Batch');
    assert.equal(saved.success, true);
    assert.equal(saved.is_empty, true);
    assert.equal(saved.total_orders, 0);
    assert.equal(saved.assigned_orders, 0);
    assert.equal(saved.unassigned_orders, 0);
  });

  // -------------------------------------------------------------
  // 3. executeEnterpriseAllocation Canonical Contract Compatibility
  // -------------------------------------------------------------
  test('10. executeEnterpriseAllocation returns full canonical contract matching UI expectations', () => {
    // Seed an employee and order
    const emp = db.prepare("SELECT id, name FROM employees WHERE department = 'CS' LIMIT 1").get();
    if (!emp) return;

    db.prepare(`
      INSERT INTO daily_working_team (work_date, employee_id, is_working, last_activity_at)
      VALUES (?, ?, 1, '2030-05-20 18:05:00')
      ON CONFLICT(work_date, employee_id) DO UPDATE SET is_working = 1, last_activity_at = '2030-05-20 18:05:00'
    `).run(TEST_DATE, emp.id);

    db.prepare(`
      INSERT OR REPLACE INTO current_work_orders (work_date, order_code, account, status, source_type, tracking_id)
      VALUES (?, 'CANONICAL-ORD-1', 'Doby Store', 'New', 'NEW', 'TRK-CANONICAL-1')
    `).run(TEST_DATE);

    const plan = planEnterpriseAllocation(TEST_DATE, 'ACTIVE', { currentTime: '2030-05-20T18:10:00Z' });
    const result = executeEnterpriseAllocation(plan);

    assert.equal(result.success, true);
    assert.equal(result.status, 'COMMITTED');

    // Canonical fields required by UI and API:
    assert.ok(Array.isArray(result.raw_allocations), 'raw_allocations must be an array');
    assert.ok(Array.isArray(result.allocations), 'allocations alias must be an array');
    assert.ok(Array.isArray(result.orderLevelAllocations), 'orderLevelAllocations alias must be an array');
    assert.ok(Array.isArray(result.by_employee), 'by_employee must be an array');
    assert.equal(typeof result.assigned_orders, 'number', 'assigned_orders must be a number');
    assert.equal(typeof result.assigned_count, 'number', 'assigned_count must be a number');
    assert.equal(typeof result.unassigned_orders, 'number', 'unassigned_orders must be a number');
    assert.equal(typeof result.total_orders, 'number', 'total_orders must be a number');
    assert.equal(result.already_saved, true, 'already_saved flag must be true');

    // UI access test: res.by_employee.length must never crash
    assert.doesNotThrow(() => {
      const len = result.by_employee.length;
      assert.ok(len >= 0);
    });
  });
});
