import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app, db } from '../server.js';
import { getCairoBusinessDate, isTodayBusinessDate } from '../services/time_utils.js';
import { PROTECTED_WORK_STATES, isProtectedWorkState } from '../services/work_state_guard.js';
import { executeEnterpriseAllocation, planEnterpriseAllocation, saveAccountDaySchedule, evaluateAccountTimeStatus } from '../services/enterprise_allocation.js';
import { deleteAllocationForDate } from '../services/allocation.js';
import { extractUserIdentity, USER_ROLES } from '../services/auth_guard.js';

describe('CS Executive BI — Forensic System Hardening & Invariant Verification Suite', () => {
  const testDate = '2026-10-15';
  let server;
  let baseUrl;

  before(async () => {
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  async function apiReq(path, options = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    let data;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
    return { status: res.status, ok: res.ok, data };
  }

  it('1. Date/Time Invariant: getCairoBusinessDate returns canonical YYYY-MM-DD format in Africa/Cairo', () => {
    const cairoDate = getCairoBusinessDate();
    assert.match(cairoDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(isTodayBusinessDate(cairoDate), true);
  });

  it('2. Protected Work States Invariant: PROTECTED_WORK_STATES includes CLAIMED, IN_PROGRESS, PRINTED, COMPLETED, CANCELLED', () => {
    const expected = ['CLAIMED', 'IN_PROGRESS', 'PRINTED', 'COMPLETED', 'CANCELLED'];
    for (const state of expected) {
      assert.equal(PROTECTED_WORK_STATES.includes(state), true, `Expected ${state} to be in PROTECTED_WORK_STATES`);
      assert.equal(isProtectedWorkState(state), true, `Expected isProtectedWorkState('${state}') to return true`);
    }
  });

  it('3. Protected Work State Reset Safety: PRINTED and CANCELLED orders are NEVER reset to UNASSIGNED', () => {
    // Seed test orders with different work_states
    const emp = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND (status = 'ACTIVE' OR status IS NULL) LIMIT 1").get();
    const empId = emp ? emp.id : 1;
    const empName = emp ? emp.name : 'Test Agent';

    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(testDate);

    const ins = db.prepare(`
      INSERT INTO current_work_orders (
        order_code, work_date, account, status, work_state, assigned_employee_id, assigned_employee_name, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    ins.run('ORD_NORM_ASSIGNED', testDate, 'TestAcc', 'New', 'ASSIGNED', empId, empName);
    ins.run('ORD_PROT_PRINTED', testDate, 'TestAcc', 'New', 'PRINTED', empId, empName);
    ins.run('ORD_PROT_CLAIMED', testDate, 'TestAcc', 'Pending', 'CLAIMED', empId, empName);
    ins.run('ORD_PROT_CANCELLED', testDate, 'TestAcc', 'Cancelled', 'CANCELLED', empId, empName);

    // Run deleteAllocationForDate
    deleteAllocationForDate(testDate);

    const ordAssigned = db.prepare('SELECT * FROM current_work_orders WHERE order_code = ?').get('ORD_NORM_ASSIGNED');
    const ordPrinted = db.prepare('SELECT * FROM current_work_orders WHERE order_code = ?').get('ORD_PROT_PRINTED');
    const ordClaimed = db.prepare('SELECT * FROM current_work_orders WHERE order_code = ?').get('ORD_PROT_CLAIMED');
    const ordCancelled = db.prepare('SELECT * FROM current_work_orders WHERE order_code = ?').get('ORD_PROT_CANCELLED');

    assert.equal(ordAssigned.work_state, 'UNASSIGNED', 'Normal ASSIGNED order should be reset to UNASSIGNED');
    assert.equal(ordAssigned.assigned_employee_id, null, 'Normal ASSIGNED order should lose assigned employee');

    assert.equal(ordPrinted.work_state, 'PRINTED', 'PRINTED order must NOT be reset');
    assert.equal(ordPrinted.assigned_employee_id, empId, 'PRINTED order must retain assigned employee');

    assert.equal(ordClaimed.work_state, 'CLAIMED', 'CLAIMED order must NOT be reset');
    assert.equal(ordCancelled.work_state, 'CANCELLED', 'CANCELLED order must NOT be reset');

    // Clean up
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(testDate);
  });

  it('4. Allocation Mode OFF Safety: executeEnterpriseAllocation with mode OFF never mutates production state', () => {
    const res = executeEnterpriseAllocation(testDate, { mode: 'OFF' });
    assert.equal(res.success, false);
    assert.equal(res.mode, 'OFF');
    assert.equal(res.assigned_orders, 0);
  });

  it('5. RBAC Auth Guard: CS_EMPLOYEE role is blocked (HTTP 403) from sensitive supervisor operations', async () => {
    const res = await apiReq('/api/allocation/configuration/save', {
      method: 'POST',
      headers: {
        'x-user-role': 'CS_EMPLOYEE',
        'x-user': 'Agent User'
      },
      body: JSON.stringify({ global_settings: { allocation_mode: 'ACTIVE' } })
    });

    assert.equal(res.status, 403);
    assert.equal(res.data.success, false);
    assert.equal(res.data.code, 'ROLE_PERMISSION_DENIED');
  });

  it('6. Account Schedule Exact Boundaries: ARC NEW (18:00 - 23:00) evaluates NOT_YET_OPEN at 17:59, OPEN at 18:00, OPEN at 22:59, CLOSED at 23:00', () => {
    const testAcc = 'ARC_BOUNDARY_TEST';
    saveAccountDaySchedule({
      account: testAcc,
      status: 'NEW',
      day: 'all',
      new_start_time: '18:00',
      new_end_time: '23:00'
    });

    const status1759 = evaluateAccountTimeStatus(testAcc, 'NEW', '17:59');
    assert.equal(status1759.is_open, false);
    assert.equal(status1759.status, 'NOT_YET_OPEN');

    const status1800 = evaluateAccountTimeStatus(testAcc, 'NEW', '18:00');
    assert.equal(status1800.is_open, true);
    assert.equal(status1800.status, 'OPEN');

    const status2259 = evaluateAccountTimeStatus(testAcc, 'NEW', '22:59');
    assert.equal(status2259.is_open, true);
    assert.equal(status2259.status, 'OPEN');

    const status2300 = evaluateAccountTimeStatus(testAcc, 'NEW', '23:00');
    assert.equal(status2300.is_open, false);
    assert.equal(status2300.status, 'CLOSED');

    // Clean up
    db.prepare('DELETE FROM account_schedules WHERE account = ? COLLATE NOCASE').run(testAcc);
  });
});
