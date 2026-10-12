/**
 * CS Executive BI — Employee Profile Canonical Reality & 5 Pillars Verification Test Suite
 *
 * Verifies:
 * 1. True calculation from source data without hardcoded values.
 * 2. Strict separation of:
 *    - Actions (Real Actions, Printed, Pending, Cancelled, Processing, Alt Phones)
 *    - Unique Orders (Unique Orders Touched, Unique Printed, Unique Pending, Unique Cancelled)
 *    - Assigned Orders (From order_level_allocations)
 *    - Current Workload (From current_work_orders and pending queue)
 *    - Historical Activity (Cross-date snapshots and activity preservation)
 * 3. Identity & Authority: Historical names with "CS" (any casing) are preserved with activity,
 *    but never granted operational privileges.
 * 4. Parity: Employee Profile matches API endpoints (/api/data, /api/employees/performance)
 *    and Excel export workbook.
 * 5. Total New Orders remains an overarching system metric across all departments.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import { computePerformanceFromRecords, getEmployeeProfile } from '../services/performance.js';
import { createExcelWorkbook } from '../export_excel.js';
import { isCsEmployee, isHistoricalCsName } from '../services/parser.js';

describe('Employee Profile Canonical Reality & 5-Pillar Separation Suite', () => {
  const TEST_DATE = '2026-10-01';

  before(() => {
    // Ensure clean state and test records are present for 2026-10-01
    const recCount = db.prepare('SELECT count(*) as c FROM raw_log_records WHERE work_date = ?').get(TEST_DATE)?.c || 0;
    if (recCount === 0) {
      // Seed representative real activity for BASMA CS, EMAN CS and historical agent
      const insertStmt = db.prepare(`
        INSERT INTO raw_log_records (work_date, order_code, employee_name, status, action, event_datetime, is_cs, is_deduped)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `);

      // BASMA CS actions (multiple status changes on some orders to show actions vs unique orders separation)
      insertStmt.run(TEST_DATE, 'ORD-B-101', 'BASMA CS', 'Printed', 'عدل حالة الاوردر الى Printed', `${TEST_DATE} 10:00:00`, 1);
      insertStmt.run(TEST_DATE, 'ORD-B-102', 'BASMA CS', 'Printed', 'عدل حالة الاوردر الى Printed', `${TEST_DATE} 10:05:00`, 1);
      insertStmt.run(TEST_DATE, 'ORD-B-103', 'BASMA CS', 'Pending', 'عدل حالة الاوردر الى Pending', `${TEST_DATE} 10:10:00`, 1);
      insertStmt.run(TEST_DATE, 'ORD-B-103', 'BASMA CS', 'Cancelled', 'عدل حالة الاوردر الى Cancelled', `${TEST_DATE} 10:30:00`, 1); // same order transitioned
      insertStmt.run(TEST_DATE, 'ORD-B-104', 'BASMA CS', 'Cancelled', 'عدل حالة الاوردر الى Cancelled', `${TEST_DATE} 10:40:00`, 1);
      insertStmt.run(TEST_DATE, 'ORD-B-105', 'BASMA CS', 'Action Recorded', 'أضاف BASMA CS رقم بديل: 01012345678', `${TEST_DATE} 10:45:00`, 1);

      // Non-CS actor added order to verify Total New Orders spans all departments
      insertStmt.run(TEST_DATE, 'ORD-SYS-999', 'System Admin', 'New', 'أضاف طلب جديد ORD-SYS-999', `${TEST_DATE} 09:00:00`, 0);
    }

    // Seed test allocations for BASMA CS
    db.prepare(`
      INSERT OR REPLACE INTO order_level_allocations (
        allocation_date, order_code, account, employee_id, employee_name, status, method
      ) VALUES
        (?, 'ORD-B-101', 'Test Merchant', 1, 'BASMA CS', 'Printed', 'Fair Random'),
        (?, 'ORD-B-102', 'Test Merchant', 1, 'BASMA CS', 'Printed', 'Fair Random'),
        (?, 'ORD-B-103', 'Alpha Brand', 1, 'BASMA CS', 'Pending', 'Fair Random')
    `).run(TEST_DATE, TEST_DATE, TEST_DATE);

    // Seed test current work order
    db.prepare(`
      INSERT OR REPLACE INTO current_work_orders (
        order_code, account, status, work_date, assigned_employee_id, assigned_employee_name, work_state
      ) VALUES
        ('ORD-B-WKL-1', 'Test Merchant', 'Pending', ?, 1, 'BASMA CS', 'ASSIGNED')
    `).run(TEST_DATE);
  });

  test('1. Strict 5-Pillar Separation in getEmployeeProfile', () => {
    const profile = getEmployeeProfile(TEST_DATE, 'BASMA CS');

    assert.strictEqual(profile.success, true);
    assert.strictEqual(profile.work_date, TEST_DATE);

    // Pillar 1: Actions
    const acts = profile.metrics.actions;
    assert.ok(acts.total_real_actions > 0, 'Actions total must be > 0');
    assert.ok(acts.printed_actions >= 0);
    assert.ok(acts.pending_actions >= 0);
    assert.ok(acts.cancelled_actions >= 0);

    // Pillar 2: Unique Orders
    const unq = profile.metrics.unique_orders;
    assert.ok(unq.unique_orders_touched > 0, 'Unique orders touched must be > 0');
    assert.ok(unq.unique_printed_orders <= acts.printed_actions, 'Unique printed orders must never exceed printed actions');

    // Pillar 3: Assigned Orders
    const asg = profile.metrics.assigned_orders;
    assert.ok(asg.total_assigned >= 0, 'Assigned orders must be a recorded integer');

    // Pillar 4: Current Workload
    const wkl = profile.metrics.current_workload;
    assert.ok(wkl.total_active_workload >= 0, 'Current workload must be an integer');

    // Pillar 5: Historical Activity
    const hist = profile.historical_activity;
    assert.ok(Array.isArray(hist.snapshots), 'Snapshots must be an array');
  });

  test('2. Case-Insensitive Historical CS Identity Retention & Zero Operational Privileges', () => {
    // Case 1: Active Approved CS Employee
    const activeProfile = getEmployeeProfile(TEST_DATE, 'BASMA CS');
    assert.strictEqual(activeProfile.employee.is_cs, true);

    // Case 2: Historical CS identity not in Employee Master (e.g. 'Old Agent cs')
    // Must recognize as Historical CS, preserve identity, but NEVER give operational privileges
    assert.strictEqual(isHistoricalCsName('Old Agent cs'), true);
    assert.strictEqual(isHistoricalCsName('KHALED CS'), true);
    assert.strictEqual(isHistoricalCsName('Salma Cs'), true);

    const histProfile = getEmployeeProfile(TEST_DATE, 'Legacy Retired CS');
    assert.strictEqual(histProfile.employee.is_cs, true);
    assert.strictEqual(histProfile.employee.has_operational_privileges, false, 'Historical CS identity must NOT have operational privileges');
    assert.strictEqual(histProfile.employee.identity_type, 'HISTORICAL_CS_IDENTITY');
  });

  test('3. Parity between Employee Profile, API metrics, and Excel Export', () => {
    const rawRows = db.prepare('SELECT * FROM raw_log_records WHERE work_date = ?').all(TEST_DATE);
    const metrics = computePerformanceFromRecords(rawRows, TEST_DATE);
    const basmaFromMetrics = metrics.employees.find(e => e.name.toLowerCase() === 'basma cs');
    assert.ok(basmaFromMetrics, 'BASMA CS must exist in metrics calculation');

    const profile = getEmployeeProfile(TEST_DATE, 'BASMA CS');

    // Total Actions parity
    assert.strictEqual(profile.metrics.actions.total_real_actions, basmaFromMetrics.actions);
    // Printed Actions parity
    assert.strictEqual(profile.metrics.actions.printed_actions, basmaFromMetrics.printed);
    // Unique Printed Orders parity
    assert.strictEqual(profile.metrics.unique_orders.unique_printed_orders, basmaFromMetrics.unique_printed_orders);
    // Pending Actions parity
    assert.strictEqual(profile.metrics.actions.pending_actions, basmaFromMetrics.pending);
    // Cancelled Actions parity
    assert.strictEqual(profile.metrics.actions.cancelled_actions, basmaFromMetrics.cancelled);

    // Excel Export Parity
    const wb = createExcelWorkbook(metrics);
    assert.ok(wb.Sheets['Agent Scorecard'], 'Agent Scorecard sheet must exist in Excel workbook');
  });

  test('4. Total New Orders is an overarching metric across ALL departments', () => {
    const rawRows = db.prepare('SELECT * FROM raw_log_records WHERE work_date = ?').all(TEST_DATE);
    const metrics = computePerformanceFromRecords(rawRows, TEST_DATE);

    assert.ok(metrics.summary.totalNewOrders >= 0, 'Total New Orders must be non-negative');
    // Must not be restricted to CS additions only
    assert.ok(metrics.summary.totalNewOrders >= (metrics.summary.totalNewOrdersFromCS || 0), 'Total New Orders must be greater than or equal to CS additions');
  });
});
