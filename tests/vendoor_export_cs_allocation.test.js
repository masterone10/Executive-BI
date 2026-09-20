import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import db from '../db/index.js';
import {
  generateOrderLevelAllocation,
  saveWorkingTeam,
  reassignAccountOwner,
  manualOverrideOrderAllocation,
  saveFinalOrderLevelAllocation,
  isCSDepartment
} from '../services/allocation.js';
import { exportAndParseVendoorOrders } from '../services/vendoor/export_sync.js';

describe('VENDOOR EXPORT INGESTION & CS-ONLY ALLOCATION TEST SUITE', () => {
  const testDate = '2026-09-20';

  it('1. Department CS validation helper', () => {
    assert.equal(isCSDepartment('CS'), true);
    assert.equal(isCSDepartment('cs'), true);
    assert.equal(isCSDepartment(' CS '), true);
    assert.equal(isCSDepartment('Data Entry'), false);
    assert.equal(isCSDepartment('Operation'), false);
    assert.equal(isCSDepartment(null), false);
    assert.equal(isCSDepartment(undefined), false);
  });

  it('2. Auto Fair Allocation selects CS employees and excludes DATA ENTRY employees from candidate pool', () => {
    const allEmps = db.prepare('SELECT id, name, department FROM employees WHERE active = 1').all();
    const dataEntryEmp = allEmps.find(e => e.department === 'Data Entry');
    const csEmps = allEmps.filter(e => e.department === 'CS').slice(0, 10);

    assert.ok(dataEntryEmp, 'Data Entry employee must exist in employee master');
    assert.ok(csEmps.length > 0, 'CS employees must exist in employee master');

    // Configure today working team with BOTH Data Entry and CS employees
    const mixedTeam = [
      { employee_id: dataEntryEmp.id, is_working: true },
      ...csEmps.map(e => ({ employee_id: e.id, is_working: true }))
    ];
    saveWorkingTeam(testDate, mixedTeam);

    // Run auto fair allocation
    const allocResult = generateOrderLevelAllocation(testDate, { is_regenerate: true });

    assert.ok(allocResult.raw_allocations.length > 0, 'Should have allocated orders');
    
    // Validate every assigned order
    let dataEntryAssignedOrders = 0;
    let nonCSAssignedOrders = 0;

    for (const alloc of allocResult.raw_allocations) {
      if (alloc.employee_id) {
        const emp = db.prepare('SELECT department FROM employees WHERE id = ?').get(alloc.employee_id);
        if (emp.department === 'Data Entry') dataEntryAssignedOrders++;
        if (emp.department !== 'CS') nonCSAssignedOrders++;
      }
    }

    assert.equal(dataEntryAssignedOrders, 0, 'Zero orders may be assigned to Data Entry workers');
    assert.equal(nonCSAssignedOrders, 0, 'Zero orders may be assigned to any non-CS workers');

    // Validate every account owner
    let dataEntryAccountOwners = 0;
    for (const owner of (allocResult.account_owners || [])) {
      if (owner.owner_employee_id) {
        const emp = db.prepare('SELECT department FROM employees WHERE id = ?').get(owner.owner_employee_id);
        if (emp.department === 'Data Entry') dataEntryAccountOwners++;
      }
    }
    assert.equal(dataEntryAccountOwners, 0, 'Zero account owners may be Data Entry workers');
  });

  it('3. Manual Account Reassignment strictly rejects non-CS employees and accepts CS employees', () => {
    const allEmps = db.prepare('SELECT id, name, department FROM employees WHERE active = 1').all();
    const dataEntryEmp = allEmps.find(e => e.department === 'Data Entry');
    const csEmp = allEmps.find(e => e.department === 'CS');

    const sampleAccountRow = db.prepare('SELECT account FROM current_work_orders WHERE work_date = ? LIMIT 1').get(testDate);
    const targetAccount = sampleAccountRow ? sampleAccountRow.account : 'Test Account';

    // Attempting to reassign account to Data Entry worker must throw an error
    assert.throws(
      () => {
        reassignAccountOwner(testDate, targetAccount, dataEntryEmp.id, 'Test invalid assignment', 'Supervisor', false);
      },
      (err) => {
        return err.message.includes('Work Allocation requires CS employees only');
      },
      'Must reject reassignment of non-CS worker'
    );

    // Reassigning to CS worker must succeed
    const successRes = reassignAccountOwner(testDate, targetAccount, csEmp.id, 'Valid CS assignment', 'Supervisor', false);
    assert.equal(successRes.success, true);
    assert.equal(successRes.account, targetAccount);
  });

  it('4. Single Order Override strictly rejects non-CS employees and accepts CS employees', () => {
    const allEmps = db.prepare('SELECT id, name, department FROM employees WHERE active = 1').all();
    const dataEntryEmp = allEmps.find(e => e.department === 'Data Entry');
    const csEmp = allEmps.find(e => e.department === 'CS');

    const sampleOrder = db.prepare('SELECT order_code FROM order_level_allocations WHERE allocation_date = ? LIMIT 1').get(testDate);
    if (sampleOrder) {
      // Attempting to override order to Data Entry worker must throw an error
      assert.throws(
        () => {
          manualOverrideOrderAllocation(testDate, 1, sampleOrder.order_code, dataEntryEmp.id, false);
        },
        (err) => {
          return err.message.includes('Work Allocation requires CS employees only');
        },
        'Must reject order override to non-CS worker'
      );

      // Overriding to CS worker must succeed
      const successRes = manualOverrideOrderAllocation(testDate, 1, sampleOrder.order_code, csEmp.id, false);
      assert.equal(successRes.success, true);
      assert.equal(successRes.new_employee_id, csEmp.id);
    }
  });
});
