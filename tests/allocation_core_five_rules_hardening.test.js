import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import { planEnterpriseAllocation, getEnterpriseAllocationConfig } from '../services/enterprise_allocation.js';
import { saveAccountRule } from '../services/allocation.js';

test('Enterprise Allocation Core Five Rules Verification Suite', async (t) => {
  const TEST_DATE = '2029-05-20';

  function cleanup() {
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM enterprise_allocation_runs WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM employee_activity_log WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM employee_daily_allocation_states WHERE work_date = ?').run(TEST_DATE);
    db.prepare('DELETE FROM account_rules WHERE account_name LIKE ?').run('TEST_ALLOC_%');
    db.prepare('DELETE FROM account_exceptions WHERE account_name LIKE ?').run('TEST_ALLOC_%');
  }

  cleanup();

  function ensureEmp(name, teamMem = 'Both') {
    let emp = db.prepare('SELECT id, name FROM employees WHERE name = ?').get(name);
    if (!emp) {
      const r = db.prepare("INSERT INTO employees (name, department, team_membership, active, status) VALUES (?, 'CS', ?, 1, 'ACTIVE')").run(name, teamMem);
      emp = { id: r.lastInsertRowid, name };
    } else {
      db.prepare("UPDATE employees SET active = 1, status = 'ACTIVE', team_membership = ? WHERE id = ?").run(teamMem, emp.id);
    }
    return emp;
  }

  const basma = ensureEmp('TEST_BASMA CS', 'Both');
  const sara = ensureEmp('TEST_SARA CS', 'Both');
  const mohamed = ensureEmp('TEST_MOHAMED CS', 'Both');

  const nowIso = new Date().toISOString();
  for (const emp of [basma, sara, mohamed]) {
    db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working, last_activity_at) VALUES (?, ?, 1, ?)').run(TEST_DATE, emp.id, nowIso);
    db.prepare("INSERT INTO employee_activity_log (work_date, employee_id, employee_name_snapshot, timestamp, action) VALUES (?, ?, ?, ?, 'STATUS_CHANGE')").run(TEST_DATE, emp.id, emp.name, nowIso);
    db.prepare('INSERT OR REPLACE INTO employee_capacities (employee_id, max_orders, per_distribution_limit) VALUES (?, 40, 40)').run(emp.id);
  }

  t.after(() => {
    cleanup();
  });

  await t.test('1. Pending grouped by account to minimize employee fragmentation', () => {
    const ordersPending = [];
    for (let i = 1; i <= 30; i++) {
      ordersPending.push({
        order_code: 'ORD_PEND_A_' + i,
        account: 'TEST_ALLOC_ACC_A',
        status: 'Pending',
        source_type: 'PENDING',
        work_state: 'NEW',
        created_at: '2029-05-20T08:' + String(i).padStart(2, '0') + ':00Z'
      });
    }
    for (let i = 1; i <= 20; i++) {
      ordersPending.push({
        order_code: 'ORD_PEND_B_' + i,
        account: 'TEST_ALLOC_ACC_B',
        status: 'Pending',
        source_type: 'PENDING',
        work_state: 'NEW',
        created_at: '2029-05-20T09:' + String(i).padStart(2, '0') + ':00Z'
      });
    }

    const plan = planEnterpriseAllocation(TEST_DATE, 'ACTIVE', { orders: ordersPending });
    assert.equal(plan.assigned_count, 50);

    const accAAssignees = new Set(plan.assignments.filter(a => a.account === 'TEST_ALLOC_ACC_A').map(a => a.employee_id));
    assert.equal(accAAssignees.size, 1, 'All 30 orders of account A must be assigned to single agent to minimize fragmentation');
  });

  await t.test('2. New orders prioritized by arrival time in system (FIFO)', () => {
    const ordersNew = [
      { order_code: 'ORD_NEW_LATE', account: 'TEST_ALLOC_ACC_C', status: 'New', source_type: 'NEW', work_state: 'NEW', created_at: '2029-05-20T11:00:00Z', order_date: '2029-05-20' },
      { order_code: 'ORD_NEW_EARLY', account: 'TEST_ALLOC_ACC_C', status: 'New', source_type: 'NEW', work_state: 'NEW', created_at: '2029-05-20T08:00:00Z', order_date: '2029-05-20' }
    ];
    const plan = planEnterpriseAllocation(TEST_DATE, 'ACTIVE', { orders: ordersNew });
    assert.equal(plan.assignments[0].order_code, 'ORD_NEW_EARLY', 'Early arriving NEW order must be prioritized before late arriving order');
  });

  await t.test('3. Accounts restricted to female employees respect account rules', () => {
    saveAccountRule({
      account_name: 'TEST_ALLOC_FEMALE',
      new_eligible: [basma.id, sara.id],
      pending_eligible: [basma.id, sara.id],
      blocked: [mohamed.id]
    });
    const ordersFemale = [];
    for (let i = 1; i <= 10; i++) {
      ordersFemale.push({ order_code: 'ORD_FEM_' + i, account: 'TEST_ALLOC_FEMALE', status: 'New', source_type: 'NEW', work_state: 'NEW' });
    }
    const plan = planEnterpriseAllocation(TEST_DATE, 'ACTIVE', { orders: ordersFemale });
    assert.equal(plan.assigned_count, 10);
    const assignedEmp = plan.assignments[0].employee_id;
    assert.ok(assignedEmp === basma.id || assignedEmp === sara.id);
    assert.notEqual(assignedEmp, mohamed.id);
  });

  await t.test('4. Maximum 40 orders per distribution cap enforced', () => {
    const batch1Orders = [];
    for (let i = 1; i <= 40; i++) {
      batch1Orders.push({
        order_code: 'ORD_BATCH1_' + i,
        account: 'TEST_ALLOC_BATCH',
        status: 'New',
        source_type: 'NEW',
        work_state: 'ASSIGNED',
        assigned_employee_id: basma.id,
        assigned_employee_name: basma.name
      });
    }
    for (const bo of batch1Orders) {
      db.prepare('INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state, assigned_employee_id, assigned_employee_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(TEST_DATE, bo.order_code, bo.account, bo.status, bo.source_type, bo.work_state, bo.assigned_employee_id, bo.assigned_employee_name);
    }

    const cfg = getEnterpriseAllocationConfig(TEST_DATE);
    const empCap = cfg.employees.find(e => e.employee_id === basma.id);
    assert.equal(empCap.current_workload, 40);
    assert.equal(empCap.remaining_capacity, 0);
  });

  await t.test('5. New batch can be distributed immediately after previous batch completes', () => {
    db.prepare("UPDATE current_work_orders SET work_state = 'COMPLETED' WHERE work_date = ? AND assigned_employee_id = ?").run(TEST_DATE, basma.id);
    const cfg = getEnterpriseAllocationConfig(TEST_DATE);
    const empCap = cfg.employees.find(e => e.employee_id === basma.id);
    assert.equal(empCap.current_workload, 0);
    assert.equal(empCap.remaining_capacity, 40);

    const batch2Orders = [];
    for (let i = 1; i <= 20; i++) {
      batch2Orders.push({ order_code: 'ORD_BATCH2_' + i, account: 'TEST_ALLOC_BATCH2', status: 'New', source_type: 'NEW', work_state: 'NEW' });
    }
    const plan = planEnterpriseAllocation(TEST_DATE, 'ACTIVE', { orders: batch2Orders, targetEmployeeId: basma.id });
    assert.equal(plan.assigned_count, 20);
    assert.equal(plan.assignments[0].employee_id, basma.id);
  });
});
