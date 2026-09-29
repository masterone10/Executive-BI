import assert from 'node:assert/strict';
import { db } from '../db/index.js';

async function testLiveApiUndo() {
  const date = '2031-11-20';
  const baseUrl = 'http://localhost:3000';

  console.log('--- 1. Prepare working team and orders for live API test ---');
  // Insert test orders directly in db
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(date);
  db.prepare(`
    INSERT INTO current_work_orders (work_date, order_code, account, status, source_type, work_state)
    VALUES (?, 'TEST_LIVE_ORD1', 'Live Shop 1', 'New', 'NEW', 'UNASSIGNED'),
           (?, 'TEST_LIVE_ORD2', 'Live Shop 2', 'Pending', 'PENDING', 'UNASSIGNED')
  `).run(date, date);
  // First ensure there are CS employees
  const teamRes = await fetch(`${baseUrl}/api/working-team/${date}`).then(r => r.json());
  console.log('Initial team count:', teamRes.working_team?.length || 0);

  // Set team
  const setTeamRes = await fetch(`${baseUrl}/api/working-team/${date}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      work_date: date,
      employee_ids: [1, 2, 3]
    })
  }).then(r => r.json());
  console.log('Set team success:', setTeamRes.success);

  console.log('--- 2. Execute allocation via API ---');
  const allocRes = await fetch(`${baseUrl}/api/allocations/${date}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'ACTIVE', enterprise: true })
  }).then(r => r.json());
  console.log('Allocation result status:', allocRes.status, 'assigned:', allocRes.assigned_count ?? allocRes.assigned_orders);

  console.log('--- 3. Query latest undoable run ---');
  const latestRunRes = await fetch(`${baseUrl}/api/allocations/${date}/latest-undoable-run`).then(r => r.json());
  console.log('Latest undoable run:', latestRunRes.run ? latestRunRes.run.run_id : 'null');
  assert.ok(latestRunRes.run, 'Should have an undoable run');

  console.log('--- 4. Execute Undo via POST /api/allocations/:date/undo ---');
  const undoRes = await fetch(`${baseUrl}/api/allocations/${date}/undo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      allocation_run_id: latestRunRes.run.run_id,
      reason: 'Supervisor rejected distribution in live test'
    })
  }).then(r => r.json());

  console.log('Undo response:', undoRes);
  assert.strictEqual(undoRes.success, true);
  assert.strictEqual(undoRes.work_date, date);
  assert.strictEqual(undoRes.undone, true);
  assert.strictEqual(undoRes.allocation_run_id, latestRunRes.run.run_id);
  assert.ok(typeof undoRes.restored_orders_count === 'number');
  assert.ok(typeof undoRes.protected_orders_count === 'number');
  assert.ok(typeof undoRes.skipped_changed_orders_count === 'number');
  assert.ok(undoRes.audit_id);
  assert.ok(undoRes.message);

  console.log('--- 5. Attempt second undo on the same run ---');
  const doubleUndoRes = await fetch(`${baseUrl}/api/allocations/${date}/undo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      allocation_run_id: latestRunRes.run.run_id
    })
  }).then(r => r.json());
  console.log('Double undo rejection:', doubleUndoRes.error || doubleUndoRes.message);
  assert.strictEqual(doubleUndoRes.success, false);
  assert.ok((doubleUndoRes.error || doubleUndoRes.message).includes('already been undone'));

  console.log('--- 6. Query undo history ---');
  const historyRes = await fetch(`${baseUrl}/api/allocations/${date}/undo-history`).then(r => r.json());
  console.log('Undo history count:', historyRes.count);
  assert.strictEqual(historyRes.success, true);
  assert.ok(historyRes.count >= 1);
  assert.strictEqual(historyRes.logs[0].allocation_run_id, latestRunRes.run.run_id);

  console.log('✓ All live API undo tests passed successfully!');
}

testLiveApiUndo().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
