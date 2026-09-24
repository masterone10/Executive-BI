import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import {
  parseTimestamp,
  parseDate,
  normalizeDateToISO,
  getOperationalBusinessDate,
  isCsEmployee,
  isOperationallyActiveCsEmployee
} from '../services/parser.js';
import {
  getEmployeeTracking,
  getEmployeeLiveRealtime,
  getOrderTracking,
  getAccountTracking,
  getTrackingOverview,
  getRangeTracking,
  getAccountDetailedData,
  getTeamLiveStatusSummary,
  claimOrder,
  startOrderProgress,
  completeOrder,
  cancelOrder,
  recordInternalHandoff,
  logEmployeeActivity,
  assertActiveCsEmployee,
  getOperationalDashboardData
} from '../services/tracking.js';
import { getCairoBusinessDate } from '../services/time_utils.js';

describe('Part 21 & 22: Tracking Forensic Hardening & Invariant Regressions', () => {
  const TEST_DATE_TODAY = getCairoBusinessDate();
  const TEST_DATE_HISTORICAL = '2026-03-30';

  function cleanupData() {
    try {
      db.prepare(`DELETE FROM employees WHERE id BETWEEN 77000 AND 77999 OR name LIKE 'TRK_%'`).run();
      db.prepare(`DELETE FROM raw_log_records WHERE order_code LIKE 'TRK_%' OR employee_name LIKE 'TRK_%'`).run();
      db.prepare(`DELETE FROM employee_activity_log WHERE order_code LIKE 'TRK_%' OR employee_name LIKE 'TRK_%' OR employee_id BETWEEN 77000 AND 77999`).run();
      db.prepare(`DELETE FROM order_tracking_events WHERE order_code LIKE 'TRK_%' OR employee_name LIKE 'TRK_%' OR employee_id BETWEEN 77000 AND 77999`).run();
      db.prepare(`DELETE FROM current_work_orders WHERE order_code LIKE 'TRK_%'`).run();
      db.prepare(`DELETE FROM order_level_allocations WHERE order_code LIKE 'TRK_%' OR employee_id BETWEEN 77000 AND 77999`).run();
      db.prepare(`DELETE FROM daily_working_team WHERE employee_id BETWEEN 77000 AND 77999`).run();
    } catch (_) {}
  }

  beforeEach(() => {
    cleanupData();
  });

  afterEach(() => {
    cleanupData();
  });

  test('21.1 & 22.2: Last Activity vs Last Productive Activity vs Real Actions distinct computation', () => {
    const empId = 77101;
    const empName = 'TRK_CS_Act_1';
    db.prepare(`
      INSERT OR REPLACE INTO employees (id, name, department, team_membership, active, status)
      VALUES (?, ?, 'CS', 'General CS', 1, 'ACTIVE')
    `).run(empId, empName);

    const workDate = TEST_DATE_TODAY;
    const order1 = 'TRK_ORD_101';
    const order2 = 'TRK_ORD_102';

    const insLog = db.prepare(`
      INSERT OR REPLACE INTO raw_log_records (
        work_date, event_datetime, order_code, employee_name, action, is_cs
      ) VALUES (?, ?, ?, ?, ?, 1)
    `);

    insLog.run(workDate, `${workDate} 10:00:00`, order1, empName, 'عدل طلبية');
    insLog.run(workDate, `${workDate} 10:01:00`, order1, empName, 'عرض السجل');
    insLog.run(workDate, `${workDate} 10:02:00`, order2, empName, 'طباعة بوليصة');
    insLog.run(workDate, `${workDate} 10:03:00`, order2, empName, 'عرض الملاحظات');

    const empData = getEmployeeTracking(workDate, empId);
    assert.ok(empData !== null, 'Employee tracking result must exist');

    assert.strictEqual(empData.last_activity_time, `${workDate} 10:03:00`, 'Last Activity must be latest raw event time (10:03:00)');
    assert.strictEqual(empData.last_productive_activity_time, `${workDate} 10:02:00`, 'Last Productive Activity must ignore subsequent passive events (10:02:00)');
    assert.strictEqual(empData.orders_worked_today, 2, 'Orders Worked must be distinct canonical orders (2)');
  });

  test('21.3 & 22.5: Historical business date always wins (never overridden by currentTime)', () => {
    const empId = 77201;
    const empName = 'TRK_CS_Act_2';
    db.prepare(`
      INSERT OR REPLACE INTO employees (id, name, department, team_membership, active, status)
      VALUES (?, ?, 'CS', 'General CS', 1, 'ACTIVE')
    `).run(empId, empName);

    const histDate = TEST_DATE_HISTORICAL;

    db.prepare(`
      INSERT OR REPLACE INTO raw_log_records (
        work_date, event_datetime, order_code, employee_name, action, is_cs
      ) VALUES (?, ?, ?, ?, ?, 1)
    `).run(histDate, `${histDate} 10:00:00`, 'TRK_HIST_ORD_2', empName, 'عدل طلبية');

    const realtimeRes = getEmployeeLiveRealtime(histDate, {
      currentTime: `${TEST_DATE_TODAY}T12:00:00Z`
    });

    assert.strictEqual(realtimeRes.is_historical, true, 'Realtime query on historical date must report is_historical = true');
    const empRecord = realtimeRes.employees.find(e => e.employee_id === empId);
    if (empRecord) {
      assert.strictEqual(empRecord.live_status, 'HISTORICAL', 'Historical date employee live_status must be HISTORICAL');
      assert.strictEqual(empRecord.idle_seconds, null, 'Historical date idle_seconds must be null');
    }
  });

  test('21.5 & 22.7: Non-CS identities (Sales, Warehouse, random CS name) cannot enter operational Tracking', () => {
    const csEmpId = 77301;
    const salesEmpId = 77304;
    const whEmpId = 77305;

    db.prepare(`INSERT OR REPLACE INTO employees (id, name, department, team_membership, active, status) VALUES (?, 'TRK_CS_Act_3', 'CS', 'General CS', 1, 'ACTIVE')`).run(csEmpId);
    db.prepare(`INSERT OR REPLACE INTO employees (id, name, department, team_membership, active, status) VALUES (?, 'TRK_Sales_3', 'Sales', 'Sales Team', 1, 'ACTIVE')`).run(salesEmpId);
    db.prepare(`INSERT OR REPLACE INTO employees (id, name, department, team_membership, active, status) VALUES (?, 'TRK_WH_3', 'Warehouse', 'Logistics', 1, 'ACTIVE')`).run(whEmpId);

    const workDate = TEST_DATE_TODAY;
    const orderCode = 'TRK_MULTI_ACTOR_ORD_3';

    const insLog = db.prepare(`
      INSERT OR REPLACE INTO raw_log_records (
        work_date, event_datetime, order_code, employee_name, action, is_cs
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    insLog.run(workDate, `${workDate} 11:00:00`, orderCode, 'TRK_CS_Act_3', 'عدل طلبية', 1);
    insLog.run(workDate, `${workDate} 11:05:00`, orderCode, 'TRK_Sales_3', 'Sales Update', 0);
    insLog.run(workDate, `${workDate} 11:10:00`, orderCode, 'TRK_WH_3', 'Warehouse Scan', 0);
    insLog.run(workDate, `${workDate} 11:15:00`, orderCode, 'Fake CS Impostor (CS)', 'Random Action', 0);

    const orderTrk = getOrderTracking(workDate, orderCode);
    assert.ok(orderTrk !== null);
    assert.strictEqual(orderTrk.actual_employees.length, 1, 'Only genuine CS employee must be in actual_employees');
    assert.strictEqual(orderTrk.actual_employees[0], 'TRK_CS_Act_3');

    const salesTrk = getEmployeeTracking(workDate, salesEmpId);
    assert.strictEqual(salesTrk, null, 'Non-CS employee must return null from operational employee tracking');

    const warehouseTrk = getEmployeeTracking(workDate, whEmpId);
    assert.strictEqual(warehouseTrk, null, 'Warehouse employee must return null from operational employee tracking');

    const fakeTrk = getEmployeeTracking(workDate, 'Fake CS Impostor (CS)');
    assert.strictEqual(fakeTrk, null, 'Unregistered actor must return null from operational employee tracking');
  });

  test('21.6 & 22.8: employee_id is authoritative; invalid employee_id cannot fall back to name', () => {
    const csEmpId = 77401;
    const realCsName = 'TRK_CS_Act_4';
    db.prepare(`INSERT OR REPLACE INTO employees (id, name, department, team_membership, active, status) VALUES (?, ?, 'CS', 'General CS', 1, 'ACTIVE')`).run(csEmpId, realCsName);

    const workDate = TEST_DATE_TODAY;

    const resInvalidId = getEmployeeTracking(workDate, {
      employee_id: 999999,
      name: realCsName
    });
    assert.strictEqual(resInvalidId, null, 'Non-existent employee_id MUST NOT fall back to matching by name');

    const resNameOnly = getEmployeeTracking(workDate, realCsName);
    assert.ok(resNameOnly !== null, 'Lookup with valid name only should resolve');
    assert.strictEqual(resNameOnly.employee_id, csEmpId);
  });

  test('21.15 & 22.10: Operational mutations strictly reject non-CS or inactive employees', () => {
    const csActiveId = 77501;
    const csInactiveId = 77503;
    const salesId = 77504;
    const whId = 77505;

    db.prepare(`INSERT OR REPLACE INTO employees (id, name, department, team_membership, active, status) VALUES (?, 'TRK_CS_5_Act', 'CS', 'General CS', 1, 'ACTIVE')`).run(csActiveId);
    db.prepare(`INSERT OR REPLACE INTO employees (id, name, department, team_membership, active, status) VALUES (?, 'TRK_CS_5_Inact', 'CS', 'General CS', 0, 'INACTIVE')`).run(csInactiveId);
    db.prepare(`INSERT OR REPLACE INTO employees (id, name, department, team_membership, active, status) VALUES (?, 'TRK_Sales_5', 'Sales', 'Sales Team', 1, 'ACTIVE')`).run(salesId);
    db.prepare(`INSERT OR REPLACE INTO employees (id, name, department, team_membership, active, status) VALUES (?, 'TRK_WH_5', 'Warehouse', 'Logistics', 1, 'ACTIVE')`).run(whId);

    const workDate = TEST_DATE_TODAY;
    const orderCode = 'TRK_MUTATION_ORD_5';

    db.prepare(`
      INSERT OR REPLACE INTO current_work_orders (work_date, order_code, account, status)
      VALUES (?, ?, 'Test Account', 'NEW')
    `).run(workDate, orderCode);

    assert.throws(() => {
      claimOrder(workDate, orderCode, csInactiveId);
    }, /not active/i);

    assert.throws(() => {
      startOrderProgress(workDate, orderCode, salesId);
    }, /not a CS employee/i);

    assert.throws(() => {
      completeOrder(workDate, orderCode, whId);
    }, /not a CS employee/i);

    assert.throws(() => {
      recordInternalHandoff({
        work_date: workDate,
        order_code: orderCode,
        new_employee_id: csInactiveId,
        previous_employee_id: csActiveId
      });
    }, /not active/i);

    const claimRes = claimOrder(workDate, orderCode, csActiveId);
    assert.ok(claimRes.success, 'Active CS employee claim must succeed');
  });

  test('21.18 & 22.13: Allocation history versions do not inflate assigned order counts in live monitor', () => {
    const empId = 77601;
    const empName = 'TRK_CS_Act_6';
    db.prepare(`INSERT OR REPLACE INTO employees (id, name, department, team_membership, active, status) VALUES (?, ?, 'CS', 'General CS', 1, 'ACTIVE')`).run(empId, empName);

    const workDate = TEST_DATE_TODAY;
    const orderCode = 'TRK_ALLOC_HIST_ORD_6';

    db.prepare(`
      INSERT OR REPLACE INTO current_work_orders (work_date, order_code, account, status)
      VALUES (?, ?, 'Test Account', 'ASSIGNED')
    `).run(workDate, orderCode);

    const insAlloc = db.prepare(`
      INSERT OR REPLACE INTO order_level_allocations (
        allocation_date, allocation_version, order_code, account, status, employee_id, employee_name
      ) VALUES (?, ?, ?, 'Test Account', 'ASSIGNED', ?, ?)
    `);

    insAlloc.run(workDate, 1, orderCode, empId, empName);
    insAlloc.run(workDate, 2, orderCode, empId, empName);
    insAlloc.run(workDate, 3, orderCode, empId, empName);

    const realtime = getEmployeeLiveRealtime(workDate);
    const emp1 = realtime.employees.find(e => e.employee_id === empId);
    assert.ok(emp1 !== null);
    assert.strictEqual(emp1.assigned_orders, 1, 'Assigned orders must be exactly 1, not inflated to 3 by allocation history');
  });

  test('21.17 & 22.12: Orders Worked strictly counts distinct canonical orders', () => {
    const empId = 77701;
    const empName = 'TRK_CS_Act_7';
    db.prepare(`INSERT OR REPLACE INTO employees (id, name, department, team_membership, active, status) VALUES (?, ?, 'CS', 'General CS', 1, 'ACTIVE')`).run(empId, empName);

    const workDate = TEST_DATE_TODAY;
    const orderCode = 'TRK_REPEAT_ORD_7';

    const insLog = db.prepare(`
      INSERT OR REPLACE INTO raw_log_records (
        work_date, event_datetime, order_code, employee_name, action, is_cs
      ) VALUES (?, ?, ?, ?, ?, 1)
    `);

    // 5 separate activity records on the same single order
    for (let i = 1; i <= 5; i++) {
      insLog.run(workDate, `${workDate} 12:0${i}:00`, orderCode, empName, `عدل طلبية ${i}`);
    }

    const empData = getEmployeeTracking(workDate, empId);
    assert.ok(empData !== null);
    assert.strictEqual(empData.orders_worked_today, 1, '1 order with 5 events must count as 1 unique order worked');
  });

  test('21.19 & 22.15: Default business date in Dashboard uses Cairo Business Date, not UTC slice', () => {
    const cairoDate = getCairoBusinessDate();
    const dashData = getOperationalDashboardData();
    assert.ok(dashData !== null);
    assert.strictEqual(dashData.date, cairoDate, 'Dashboard default date must match Cairo business date');
  });
});
