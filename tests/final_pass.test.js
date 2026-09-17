import assert from 'assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { db, getTodayDate } = require('../db/index.js');
const allocationService = require('../services/allocation.js');
const trackingService = require('../services/tracking.js');

console.log('--- STARTING FINAL IMPLEMENTATION PASS TESTS ---');

const testDate = '2026-09-12';

// Clean up test data for testDate
db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(testDate);
db.prepare('DELETE FROM order_level_allocations WHERE allocation_date = ?').run(testDate);
db.prepare('DELETE FROM allocation_versions WHERE allocation_date = ?').run(testDate);
db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(testDate);
db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(testDate);
db.prepare('DELETE FROM account_exceptions WHERE work_date = ?').run(testDate);

// 1. TEST TEAM SETUP (Permanent Membership)
console.log('Testing: Team Setup (Permanent Membership)...');
let emp1 = db.prepare('SELECT id, name FROM employees WHERE name = ?').get('Ahmed Test 1');
if (!emp1) {
  const r = db.prepare('INSERT INTO employees (name, department, active, team_membership) VALUES (?, ?, ?, ?)').run('Ahmed Test 1', 'CS', 1, 'New');
  emp1 = { id: r.lastInsertRowid, name: 'Ahmed Test 1' };
} else {
  db.prepare('UPDATE employees SET team_membership = ?, active = 1 WHERE id = ?').run('New', emp1.id);
}

let emp2 = db.prepare('SELECT id, name FROM employees WHERE name = ?').get('Sara Test 2');
if (!emp2) {
  const r = db.prepare('INSERT INTO employees (name, department, active, team_membership) VALUES (?, ?, ?, ?)').run('Sara Test 2', 'CS', 1, 'Pending');
  emp2 = { id: r.lastInsertRowid, name: 'Sara Test 2' };
} else {
  db.prepare('UPDATE employees SET team_membership = ?, active = 1 WHERE id = ?').run('Pending', emp2.id);
}

let emp3 = db.prepare('SELECT id, name FROM employees WHERE name = ?').get('Omar Test 3');
if (!emp3) {
  const r = db.prepare('INSERT INTO employees (name, department, active, team_membership) VALUES (?, ?, ?, ?)').run('Omar Test 3', 'CS', 1, 'Both');
  emp3 = { id: r.lastInsertRowid, name: 'Omar Test 3' };
} else {
  db.prepare('UPDATE employees SET team_membership = ?, active = 1 WHERE id = ?').run('Both', emp3.id);
}

const memList = db.prepare('SELECT id, name, team_membership FROM employees WHERE id IN (?, ?, ?)').all(emp1.id, emp2.id, emp3.id);
assert.strictEqual(memList.find(e => e.id === emp1.id).team_membership, 'New');
assert.strictEqual(memList.find(e => e.id === emp2.id).team_membership, 'Pending');
assert.strictEqual(memList.find(e => e.id === emp3.id).team_membership, 'Both');
console.log('✓ PASS: Team Setup permanent membership stored correctly.');

// 2. TEST ACCOUNT CONFIGURATION (Rules & Blocked Always Wins)
console.log('Testing: Account Rules & Blocked Enforcement...');
const testAccount = 'Alpha Health Final Test';
db.prepare('DELETE FROM account_rules WHERE account_name = ?').run(testAccount);

// Add rule: Omar (emp3) is Blocked, Ahmed (emp1) is New Eligible
allocationService.saveAccountRule({
  account_name: testAccount,
  new_eligible: [emp1.id],
  pending_eligible: [emp2.id, emp3.id],
  blocked: [emp3.id], // Blocked Omar!
  active: 1,
  notes: 'High priority VIP client'
});

const rules = allocationService.getAccountRules();
const savedRule = rules.find(r => r.account_name === testAccount);
assert(savedRule, 'Account rule must be saved');
assert(savedRule.blocked.includes(emp3.id), 'Omar must be blocked in rule');
console.log('✓ PASS: Account Rule saved and retrieved with proper JSON parsing.');

// 3. Set Working Team for testDate
db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(testDate, emp1.id);
db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(testDate, emp2.id);
db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)').run(testDate, emp3.id);

// 4. TEST ELIGIBILITY IN TRACKING & ALLOCATION
console.log('Testing: getAccountDetailedData & Eligibility Hierarchy...');

// Add a specific order for testAccount
db.prepare(`
  INSERT INTO current_work_orders (work_date, order_code, account, status)
  VALUES (?, ?, ?, ?)
`).run(testDate, 'ORD-FIN-101', testAccount, 'New');

const details = trackingService.getAccountDetailedData(testDate, testAccount);
assert(details, 'Details must be returned');
assert.strictEqual(details.metrics.total_orders, 1);
assert.strictEqual(details.metrics.new_orders, 1);
assert(details.eligibility.blocked_employees.includes(emp3.name), 'Omar must be listed as blocked employee');

// Final eligible for New should include Ahmed (emp1), Omar (emp3) is blocked so Omar must NOT be eligible
assert(details.eligibility.final_eligible_new_today.includes(emp1.name), 'Ahmed must be final eligible for New');
assert(!details.eligibility.final_eligible_new_today.includes(emp3.name), 'Blocked Omar must NOT be eligible');
assert(!details.eligibility.final_eligible_pending_today.includes(emp3.name), 'Blocked Omar must NOT be eligible for Pending');
console.log('✓ PASS: Deterministic eligibility engine respects Blocked Always Wins.');

// 5. TEST ACCOUNTS DIRECTORY
console.log('Testing: getAccountsDirectory for date...');
const dir = trackingService.getAccountsDirectory(testDate);
assert(dir.accounts, 'Accounts array must be present');
const accInDir = dir.accounts.find(a => a.account_name === testAccount);
assert(accInDir, 'Account must be in directory');
assert.strictEqual(accInDir.total_orders, 1);
assert.strictEqual(accInDir.new_orders, 1);
console.log('✓ PASS: Accounts directory aggregated successfully.');

// Clean up
db.prepare('DELETE FROM account_rules WHERE account_name = ?').run(testAccount);
db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(testDate);
db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(testDate);

console.log('--- ALL FINAL PASS TESTS PASSED SUCCESSFULLY! ---');
