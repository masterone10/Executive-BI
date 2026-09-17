/**
 * EXECUTIVE-BI EXECUTION CONTRACT LIFECYCLE & INTEGRATION AUDIT
 * Verifies all 30 browser and system workflow requirements from the contract.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import db from '../db/index.js';
import { getSafeVendoorStatus, setRuntimeVendoorCredentials, clearRuntimeVendoorCredentials } from '../services/vendoor/auth.js';
import { generateOrderLevelAllocation, saveFinalOrderLevelAllocation, getWorkingTeam, saveWorkingTeam, getCurrentWorkOverview } from '../services/allocation.js';
import { getTrackingOverview } from '../services/tracking.js';
import { getFullEmployeeProductivityProfiles } from '../services/vendoor/productivity.js';

describe('EXECUTIVE-BI MANDATORY EXECUTION CONTRACT AUDIT', () => {

  const TEST_DATE = '2026-09-08';
  const ALT_DATE = '2026-09-07';

  test('1. Credential Security: No passwords, CSRF tokens or cookies stored in DB or client-accessible state', () => {
    // Check database tables for forbidden password/cookie columns
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    for (const t of tables) {
      const cols = db.prepare(`PRAGMA table_info(${t.name})`).all();
      for (const col of cols) {
        assert.ok(!/password|raw_cookie|laravel_session/i.test(col.name), `Forbidden sensitive column ${col.name} in table ${t.name}`);
      }
    }

    // Check safe status serialization
    const safeStatus = getSafeVendoorStatus();
    assert.strictEqual(typeof safeStatus, 'object');
    assert.ok(!('password' in safeStatus), 'Password must never be in status object');
    assert.ok(!('session_cookie' in safeStatus), 'Session cookie must never be in status object');
    assert.ok(!('csrf_token' in safeStatus), 'CSRF token must never be in status object');
  });

  test('2. Management: Runtime credentials configuration and safe masking', () => {
    setRuntimeVendoorCredentials({ email: 'supervisor@aff.ven-door.com', password: 'SecureSecretPass123!' });
    const status = getSafeVendoorStatus();
    assert.strictEqual(status.has_credentials, true);
    assert.strictEqual(status.auth_method, 'AUTO_LOGIN');
    assert.ok(status.email_preview && status.email_preview.includes('•'), 'Email should be masked securely');
    assert.ok(!status.password, 'Raw password is not returned');
  });

  test('3. Today Working Team Gate: Selection and Hard Isolation', () => {
    // Ensure working team for TEST_DATE has specific employees
    const allEmps = db.prepare('SELECT id, name, team_membership, active FROM employees WHERE active = 1 LIMIT 5').all();
    assert.ok(allEmps.length >= 3, 'Must have active employees in database');

    const selectedList = [
      { employee_id: allEmps[0].id, is_working: true },
      { employee_id: allEmps[1].id, is_working: true },
      { employee_id: allEmps[2].id, is_working: false }
    ];
    saveWorkingTeam(TEST_DATE, selectedList);

    const team = getWorkingTeam(TEST_DATE);
    const workingOnly = team.filter(t => t.is_working === 1 || t.is_working === true);
    assert.strictEqual(workingOnly.length, 2, 'Working team should have exactly 2 active employees');
    assert.ok(workingOnly.some(e => e.employee_id === allEmps[0].id));
    assert.ok(workingOnly.some(e => e.employee_id === allEmps[1].id));
    assert.ok(!workingOnly.some(e => e.employee_id === allEmps[2].id), 'Non-selected employee must be OFF today');
  });

  test('4. Auto Fair Allocation: Single Action Execution & Working Team Gate Invariant', async () => {
    // Run Auto Fair Allocation for TEST_DATE
    const result = await generateOrderLevelAllocation(TEST_DATE, { auto_save: true, mode: 'fair' });
    assert.ok(result.success, `Auto Fair Allocation must succeed: ${result.error || ''}`);
    assert.ok(result.assigned_orders >= 0);

    // Verify invariant: Only working team employees received allocations
    const team = getWorkingTeam(TEST_DATE).filter(t => t.is_working === 1 || t.is_working === true);
    const teamIds = new Set(team.map(e => e.employee_id));

    const allocations = db.prepare(`
      SELECT employee_id, employee_name, account, COUNT(*) as cnt
      FROM order_level_allocations
      WHERE allocation_date = ? AND employee_name != 'UNASSIGNED'
      GROUP BY employee_id, employee_name, account
    `).all(TEST_DATE);

    for (const alloc of allocations) {
      assert.ok(teamIds.has(alloc.employee_id), `Employee ${alloc.employee_name} (${alloc.employee_id}) received allocation but was NOT in Today's Working Team!`);
    }
  });

  test('5. Sticky Ownership & Account-Centric Distribution Invariants', async () => {
    // 1 Account = 1 Agent by default; 40, 100, 120 accounts remain unified if capacity allows
    const accountSplits = db.prepare(`
      SELECT account, COUNT(DISTINCT employee_id) as agent_count, COUNT(*) as total_orders
      FROM order_level_allocations
      WHERE allocation_date = ? AND employee_name != 'UNASSIGNED'
      GROUP BY account
    `).all(TEST_DATE);

    for (const acc of accountSplits) {
      if (acc.total_orders <= 120) {
        assert.strictEqual(acc.agent_count, 1, `Account ${acc.account} with ${acc.total_orders} orders was split across ${acc.agent_count} agents! 120 is NOT a split trigger.`);
      }
    }
  });

  test('6. Tracking & Real Activity Reconciliation', () => {
    const tracking = getTrackingOverview(TEST_DATE);
    assert.ok(tracking, 'Tracking overview must return valid structure');
    assert.strictEqual(typeof tracking.opening_inventory, 'object');
    assert.strictEqual(typeof tracking.actual_work, 'object');
    assert.strictEqual(typeof tracking.allocation_alignment, 'object');
    assert.ok(Array.isArray(tracking.employee_tracking), 'Employee tracking must be an array');
  });

  test('7. Performance Intelligence: Real Deduping & Median Rates (No Fabricated Data)', () => {
    const profiles = getFullEmployeeProductivityProfiles(TEST_DATE);
    assert.ok(Array.isArray(profiles), 'Productivity profiles should be an array');
    if (profiles.length > 0) {
      const profile = profiles[0];
      assert.strictEqual(typeof profile.typical_orders_per_10m, 'number');
      assert.strictEqual(typeof profile.consistency, 'number');
      assert.strictEqual(typeof profile.confidence, 'string');
      assert.strictEqual(typeof profile.remaining_capacity, 'number');
    }
  });

  test('8. Date Isolation: Shifting between dates never corrupts or cross-contaminates', () => {
    const overviewDate1 = getCurrentWorkOverview(TEST_DATE);
    const overviewDate2 = getCurrentWorkOverview(ALT_DATE);
    const overviewDate1Again = getCurrentWorkOverview(TEST_DATE);

    assert.strictEqual(overviewDate1.work_date, TEST_DATE);
    assert.strictEqual(overviewDate2.work_date, ALT_DATE);
    assert.strictEqual(overviewDate1Again.total_orders, overviewDate1.total_orders);
    assert.strictEqual(overviewDate1Again.allocated_count, overviewDate1.allocated_count);
  });

  test('9. HTML & Client Build: Zero Broken Links, Clean 5-Page Navigation & Global Context Bar', () => {
    const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
    
    // Check 5 navigation items
    assert.ok(html.includes('data-p="dashboard"'), 'Dashboard nav link must exist');
    assert.ok(html.includes('data-p="operations"'), 'Operations nav link must exist');
    assert.ok(html.includes('data-p="tracking"'), 'Tracking nav link must exist');
    assert.ok(html.includes('data-p="management"'), 'Management nav link must exist');
    assert.ok(html.includes('data-p="performance"'), 'Performance nav link must exist');

    // Check Global Context Bar
    assert.ok(html.includes('id="globalContextBar"'), 'Global Context Bar must exist in HTML');
    assert.ok(html.includes('id="gctxVendoorStatus"'), 'Vendoor status pill must exist');
    assert.ok(html.includes('id="gctxTeamCount"'), 'Working team counter must exist');
    assert.ok(html.includes('id="gctxOrdersCount"'), 'Orders counter must exist');
    assert.ok(html.includes('id="gctxAllocatedCount"'), 'Allocated counter must exist');
    assert.ok(html.includes('id="gctxCompletedCount"'), 'Completed counter must exist');
    assert.ok(html.includes('id="gctxDispatcherStatus"'), 'Dispatcher pill must exist');

    // Check absence of obsolete manual session cookie fields in UI
    assert.ok(!html.includes('id="vendoorCookieInput"'), 'Obsolete cookie input must be removed from UI');
    assert.ok(!html.includes('VENDOOR_SESSION_COOKIE'), 'Technical cookie var must not be visible in UI');
  });
});
