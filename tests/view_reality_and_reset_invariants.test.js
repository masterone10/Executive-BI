import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import { deleteAllocationForDate } from '../services/allocation.js';
import { getTrackingOverview, getEmployeeTracking } from '../services/tracking.js';

describe('View Reality & Reset Invariants Verification Suite', () => {
  const TEST_DATE = '2030-08-15';
  let testEmp1 = null;
  let testEmp2 = null;
  let testEmp3 = null;

  before(() => {
    // Setup clean test employees
    db.prepare("DELETE FROM employees WHERE name LIKE 'TEST_VR_%'").run();

    db.prepare(`
      INSERT INTO employees (name, department, active, status, team_membership)
      VALUES ('TEST_VR_Ahmed', 'CS', 1, 'ACTIVE', 'Both')
    `).run();
    testEmp1 = db.prepare("SELECT * FROM employees WHERE name = 'TEST_VR_Ahmed'").get();

    db.prepare(`
      INSERT INTO employees (name, department, active, status, team_membership)
      VALUES ('TEST_VR_Sara', 'CS', 1, 'ACTIVE', 'Both')
    `).run();
    testEmp2 = db.prepare("SELECT * FROM employees WHERE name = 'TEST_VR_Sara'").get();

    db.prepare(`
      INSERT INTO employees (name, department, active, status, team_membership)
      VALUES ('TEST_VR_9999', 'CS', 1, 'ACTIVE', 'Both')
    `).run();
    testEmp3 = db.prepare("SELECT * FROM employees WHERE name = 'TEST_VR_9999'").get();
  });

  after(() => {
    // Clean up
    deleteAllocationForDate(TEST_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare("DELETE FROM employees WHERE name LIKE 'TEST_VR_%'").run();
  });

  beforeEach(() => {
    deleteAllocationForDate(TEST_DATE);
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(TEST_DATE);
  });

  // ============================================================
  // 1. VIEW REALITY REQUIREMENTS
  // ============================================================
  describe('1. View Reality Parameter & Resolution Hardening', () => {
    test('1.1. Overview includes employee_id in employees_outside_allocation and employee_tracking', () => {
      // Create an order assigned to testEmp1 for STORE_A
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, work_state, assigned_employee_id, assigned_employee_name)
        VALUES (?, 'ORD-VR-01', 'STORE_A', 'New', 'ASSIGNED', ?, ?)
      `).run(TEST_DATE, testEmp1.id, testEmp1.name);

      db.prepare(`
        INSERT INTO allocation_headers (allocation_date, notes) VALUES (?, 'Test Header')
      `).run(TEST_DATE);
      const hdr = db.prepare('SELECT id FROM allocation_headers WHERE allocation_date = ?').get(TEST_DATE);
      db.prepare(`
        INSERT INTO allocation_items (allocation_header_id, employee_id, account, status)
        VALUES (?, ?, 'STORE_A', 'New')
      `).run(hdr.id, testEmp1.id);

      // Raw log shows testEmp1 worked on STORE_B (outside allocation!)
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, work_state)
        VALUES (?, 'ORD-VR-02', 'STORE_B', 'New', 'UNASSIGNED')
      `).run(TEST_DATE);

      db.prepare(`
        INSERT INTO raw_log_records (work_date, order_code, employee_name, action, status, event_datetime, is_cs)
        VALUES (?, 'ORD-VR-02', ?, 'Called customer', 'Printed', '2030-08-15 10:00:00', 1)
      `).run(TEST_DATE, testEmp1.name);

      const overview = getTrackingOverview(TEST_DATE);
      assert.ok(overview, 'Overview must be generated');
      assert.ok(Array.isArray(overview.employees_outside_allocation), 'employees_outside_allocation must be an array');
      
      const outsideEmp = overview.employees_outside_allocation.find(e => e.employee_name === testEmp1.name);
      assert.ok(outsideEmp, 'testEmp1 must be detected in employees_outside_allocation');
      assert.strictEqual(outsideEmp.employee_id, testEmp1.id, 'employees_outside_allocation must include correct numeric employee_id');

      const empTracking = overview.employee_tracking.find(e => e.employee_name === testEmp1.name);
      assert.ok(empTracking, 'testEmp1 must be in employee_tracking');
      assert.strictEqual(empTracking.employee_id, testEmp1.id, 'employee_tracking must include correct numeric employee_id');
    });

    test('1.2. View Reality: Employee ID lookup returns the exact employee even when name differs from ID', () => {
      const trackingResult = getEmployeeTracking(TEST_DATE, testEmp1.id);
      assert.ok(trackingResult, 'Tracking result must exist');
      assert.strictEqual(trackingResult.employee_id, testEmp1.id, 'Resolved employee ID must match');
      assert.strictEqual(trackingResult.employee_name, testEmp1.name, 'Resolved employee Name must match');

      // Test with string representation of ID
      const trackingResultStr = getEmployeeTracking(TEST_DATE, String(testEmp1.id));
      assert.ok(trackingResultStr, 'Tracking result with string ID must exist');
      assert.strictEqual(trackingResultStr.employee_id, testEmp1.id);
    });

    test('1.3. View Reality: Missing or invalid employee ID handles safely without errors or bogus requests', () => {
      assert.strictEqual(getEmployeeTracking(TEST_DATE, null), null, 'null ID must safely return null');
      assert.strictEqual(getEmployeeTracking(TEST_DATE, undefined), null, 'undefined ID must safely return null');
      assert.strictEqual(getEmployeeTracking(TEST_DATE, ''), null, 'empty string must safely return null');
      assert.strictEqual(getEmployeeTracking(TEST_DATE, 99999999), null, 'non-existent numeric ID must safely return null');
    });
  });

  // ============================================================
  // 2. RESET ALL & PROTECTED STATES REQUIREMENTS
  // ============================================================
  describe('2. Reset All & Protected Order Invariants', () => {
    test('2.1. UNASSIGNED & eligible orders remain UNASSIGNED and ready for reallocation', () => {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, work_state, assigned_employee_id, assigned_employee_name)
        VALUES (?, 'ORD-UNASSIGNED-1', 'STORE_A', 'New', 'UNASSIGNED', NULL, 'UNASSIGNED')
      `).run(TEST_DATE);

      const res = deleteAllocationForDate(TEST_DATE);
      assert.ok(res.success);

      const ord = db.prepare("SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = 'ORD-UNASSIGNED-1'").get(TEST_DATE);
      assert.strictEqual(ord.work_state, 'UNASSIGNED');
      assert.strictEqual(ord.assigned_employee_id, null);
    });

    test('2.2. ASSIGNED unprotected orders are properly reset to UNASSIGNED', () => {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, work_state, assigned_employee_id, assigned_employee_name)
        VALUES (?, 'ORD-ASSIGNED-1', 'STORE_A', 'New', 'ASSIGNED', ?, ?)
      `).run(TEST_DATE, testEmp1.id, testEmp1.name);

      db.prepare(`
        INSERT INTO order_level_allocations (allocation_date, allocation_version, order_code, account, status, employee_id, employee_name, work_state)
        VALUES (?, 1, 'ORD-ASSIGNED-1', 'STORE_A', 'New', ?, ?, 'ASSIGNED')
      `).run(TEST_DATE, testEmp1.id, testEmp1.name);

      const res = deleteAllocationForDate(TEST_DATE);
      assert.ok(res.success);
      assert.strictEqual(res.reset_orders_count, 1, 'Should have reset 1 unworked order');

      const ord = db.prepare("SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = 'ORD-ASSIGNED-1'").get(TEST_DATE);
      assert.strictEqual(ord.work_state, 'UNASSIGNED', 'work_state must be reset to UNASSIGNED');
      assert.strictEqual(ord.assigned_employee_id, null, 'assigned_employee_id must be null');
      assert.strictEqual(ord.assigned_employee_name, 'UNASSIGNED', 'assigned_employee_name must be UNASSIGNED');

      const allocRow = db.prepare("SELECT * FROM order_level_allocations WHERE allocation_date = ? AND order_code = 'ORD-ASSIGNED-1'").get(TEST_DATE);
      assert.strictEqual(allocRow, undefined, 'order_level_allocations for unprotected order must be cleared');
    });

    test('2.3. CLAIMED orders are PROTECTED: employee, work_state, and allocations are preserved', () => {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, work_state, assigned_employee_id, assigned_employee_name, claimed_at)
        VALUES (?, 'ORD-CLAIMED-1', 'STORE_A', 'New', 'CLAIMED', ?, ?, '2030-08-15 09:30:00')
      `).run(TEST_DATE, testEmp1.id, testEmp1.name);

      db.prepare(`
        INSERT INTO order_level_allocations (allocation_date, allocation_version, order_code, account, status, employee_id, employee_name, work_state)
        VALUES (?, 1, 'ORD-CLAIMED-1', 'STORE_A', 'New', ?, ?, 'CLAIMED')
      `).run(TEST_DATE, testEmp1.id, testEmp1.name);

      const res = deleteAllocationForDate(TEST_DATE);
      assert.ok(res.success);

      const ord = db.prepare("SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = 'ORD-CLAIMED-1'").get(TEST_DATE);
      assert.strictEqual(ord.work_state, 'CLAIMED', 'CLAIMED order work_state must NOT change');
      assert.strictEqual(ord.assigned_employee_id, testEmp1.id, 'CLAIMED order assigned_employee_id must NOT change');
      assert.strictEqual(ord.assigned_employee_name, testEmp1.name, 'CLAIMED order assigned_employee_name must NOT change');

      const allocRow = db.prepare("SELECT * FROM order_level_allocations WHERE allocation_date = ? AND order_code = 'ORD-CLAIMED-1'").get(TEST_DATE);
      assert.ok(allocRow, 'order_level_allocations record for CLAIMED order must be preserved');
      assert.strictEqual(allocRow.employee_id, testEmp1.id);
    });

    test('2.4. IN_PROGRESS orders are PROTECTED: employee and state are preserved', () => {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, work_state, assigned_employee_id, assigned_employee_name)
        VALUES (?, 'ORD-INPROGRESS-1', 'STORE_A', 'New', 'IN_PROGRESS', ?, ?)
      `).run(TEST_DATE, testEmp2.id, testEmp2.name);

      db.prepare(`
        INSERT INTO order_level_allocations (allocation_date, allocation_version, order_code, account, status, employee_id, employee_name, work_state)
        VALUES (?, 1, 'ORD-INPROGRESS-1', 'STORE_A', 'New', ?, ?, 'IN_PROGRESS')
      `).run(TEST_DATE, testEmp2.id, testEmp2.name);

      const res = deleteAllocationForDate(TEST_DATE);
      assert.ok(res.success);

      const ord = db.prepare("SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = 'ORD-INPROGRESS-1'").get(TEST_DATE);
      assert.strictEqual(ord.work_state, 'IN_PROGRESS');
      assert.strictEqual(ord.assigned_employee_id, testEmp2.id);

      const allocRow = db.prepare("SELECT * FROM order_level_allocations WHERE allocation_date = ? AND order_code = 'ORD-INPROGRESS-1'").get(TEST_DATE);
      assert.ok(allocRow);
      assert.strictEqual(allocRow.employee_id, testEmp2.id);
    });

    test('2.5. PRINTED orders are PROTECTED: terminal operational status preserved', () => {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, work_state, assigned_employee_id, assigned_employee_name)
        VALUES (?, 'ORD-PRINTED-1', 'STORE_A', 'Printed', 'ASSIGNED', ?, ?)
      `).run(TEST_DATE, testEmp1.id, testEmp1.name);

      db.prepare(`
        INSERT INTO order_level_allocations (allocation_date, allocation_version, order_code, account, status, employee_id, employee_name, work_state)
        VALUES (?, 1, 'ORD-PRINTED-1', 'STORE_A', 'Printed', ?, ?, 'ASSIGNED')
      `).run(TEST_DATE, testEmp1.id, testEmp1.name);

      const res = deleteAllocationForDate(TEST_DATE);
      assert.ok(res.success);

      const ord = db.prepare("SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = 'ORD-PRINTED-1'").get(TEST_DATE);
      assert.strictEqual(ord.status, 'Printed');
      assert.strictEqual(ord.assigned_employee_id, testEmp1.id, 'Printed order assigned employee must NOT be cleared');

      const allocRow = db.prepare("SELECT * FROM order_level_allocations WHERE allocation_date = ? AND order_code = 'ORD-PRINTED-1'").get(TEST_DATE);
      assert.ok(allocRow, 'Printed order allocation record must NOT be deleted');
    });

    test('2.6. COMPLETED orders are PROTECTED: finalized state preserved', () => {
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, work_state, assigned_employee_id, assigned_employee_name, completed_at)
        VALUES (?, 'ORD-COMPLETED-1', 'STORE_A', 'Completed', 'COMPLETED', ?, ?, '2030-08-15 11:00:00')
      `).run(TEST_DATE, testEmp2.id, testEmp2.name);

      db.prepare(`
        INSERT INTO order_level_allocations (allocation_date, allocation_version, order_code, account, status, employee_id, employee_name, work_state)
        VALUES (?, 1, 'ORD-COMPLETED-1', 'STORE_A', 'Completed', ?, ?, 'COMPLETED')
      `).run(TEST_DATE, testEmp2.id, testEmp2.name);

      const res = deleteAllocationForDate(TEST_DATE);
      assert.ok(res.success);

      const ord = db.prepare("SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = 'ORD-COMPLETED-1'").get(TEST_DATE);
      assert.strictEqual(ord.work_state, 'COMPLETED');
      assert.strictEqual(ord.assigned_employee_id, testEmp2.id);

      const allocRow = db.prepare("SELECT * FROM order_level_allocations WHERE allocation_date = ? AND order_code = 'ORD-COMPLETED-1'").get(TEST_DATE);
      assert.ok(allocRow);
    });

    test('2.7. Reset idempotency: Repeated Reset calls produce NO duplicates, NO state corruption, and 0 side effects', () => {
      // Setup mixed batch: 2 unworked ASSIGNED, 1 CLAIMED, 1 COMPLETED
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, work_state, assigned_employee_id, assigned_employee_name)
        VALUES 
          (?, 'ORD-IDEMP-1', 'STORE_A', 'New', 'ASSIGNED', ?, ?),
          (?, 'ORD-IDEMP-2', 'STORE_A', 'New', 'ASSIGNED', ?, ?),
          (?, 'ORD-IDEMP-3', 'STORE_A', 'New', 'CLAIMED', ?, ?),
          (?, 'ORD-IDEMP-4', 'STORE_A', 'Completed', 'COMPLETED', ?, ?)
      `).run(
        TEST_DATE, testEmp1.id, testEmp1.name,
        TEST_DATE, testEmp2.id, testEmp2.name,
        TEST_DATE, testEmp1.id, testEmp1.name,
        TEST_DATE, testEmp2.id, testEmp2.name
      );

      // Run 1
      const res1 = deleteAllocationForDate(TEST_DATE);
      assert.ok(res1.success);
      assert.strictEqual(res1.reset_orders_count, 2, 'First reset must unassign 2 orders');

      // Run 2 (Immediately without intermediate changes)
      const res2 = deleteAllocationForDate(TEST_DATE);
      assert.ok(res2.success);
      assert.strictEqual(res2.reset_orders_count, 0, 'Second reset must find 0 remaining unworked orders to unassign');

      // Verify final counts
      const unassigned = db.prepare("SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ? AND work_state = 'UNASSIGNED'").get(TEST_DATE).c;
      const claimed = db.prepare("SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ? AND work_state = 'CLAIMED'").get(TEST_DATE).c;
      const completed = db.prepare("SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ? AND work_state = 'COMPLETED'").get(TEST_DATE).c;

      assert.strictEqual(unassigned, 2);
      assert.strictEqual(claimed, 1);
      assert.strictEqual(completed, 1);
    });

    test('2.8. Forced failure triggers 100% transactional atomic rollback with ZERO partial state mutations', () => {
      // Insert initial order state
      db.prepare(`
        INSERT INTO current_work_orders (work_date, order_code, account, status, work_state, assigned_employee_id, assigned_employee_name)
        VALUES (?, 'ORD-TX-01', 'STORE_A', 'New', 'ASSIGNED', ?, ?)
      `).run(TEST_DATE, testEmp1.id, testEmp1.name);

      db.prepare(`
        INSERT INTO order_level_allocations (allocation_date, allocation_version, order_code, account, status, employee_id, employee_name, work_state)
        VALUES (?, 1, 'ORD-TX-01', 'STORE_A', 'New', ?, ?, 'ASSIGNED')
      `).run(TEST_DATE, testEmp1.id, testEmp1.name);

      // Execute transactional failure simulation
      assert.throws(() => {
        db.transaction(() => {
          db.prepare(`
            UPDATE current_work_orders
            SET assigned_employee_id = null, work_state = 'UNASSIGNED'
            WHERE work_date = ? AND order_code = 'ORD-TX-01'
          `).run(TEST_DATE);

          // Force failure
          throw new Error('SIMULATED_TRANSACTION_CRASH');
        })();
      }, /SIMULATED_TRANSACTION_CRASH/);

      // Check state: ORD-TX-01 MUST still be ASSIGNED with testEmp1 intact!
      const ord = db.prepare("SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = 'ORD-TX-01'").get(TEST_DATE);
      assert.strictEqual(ord.work_state, 'ASSIGNED', 'State must be rolled back on error');
      assert.strictEqual(ord.assigned_employee_id, testEmp1.id, 'Assigned employee must be restored');
    });
  });
});
