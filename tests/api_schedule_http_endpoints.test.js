import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app, db } from '../server.js';

test('HTTP API Account Day Schedule Endpoints Suite', async (t) => {
  const TEST_ACC = 'ARC_HTTP_TEST';

  // Cleanup test account in SQLite
  db.prepare('DELETE FROM account_schedules WHERE account = ? COLLATE NOCASE').run(TEST_ACC);

  // Start test server on ephemeral port
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request(path, options = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    const data = await res.json();
    return { status: res.status, ok: res.ok, data };
  }

  // Set default schedule first
  const defRes = await request('/api/allocation/schedule/day-save', {
    method: 'POST',
    body: JSON.stringify({
      account: TEST_ACC,
      status: 'NEW',
      day: 'all',
      start: '08:00',
      end: '18:00'
    })
  });
  assert.equal(defRes.status, 200);
  assert.equal(defRes.data.success, true);

  await t.test('1. POST /api/allocation/schedule/day-save saves Thursday schedule', async () => {
    const res = await request('/api/allocation/schedule/day-save', {
      method: 'POST',
      body: JSON.stringify({
        account: TEST_ACC,
        status: 'NEW',
        day: 'thursday',
        start: '10:00',
        end: '14:00'
      })
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.equal(res.data.account, TEST_ACC);
    assert.equal(res.data.day, 'thursday');
    assert.equal(res.data.day_schedules.thursday.new_start_time, '10:00');
    assert.equal(res.data.day_schedules.thursday.new_end_time, '14:00');

    // SQLite check
    const row = db.prepare('SELECT * FROM account_schedules WHERE account = ? COLLATE NOCASE').get(TEST_ACC);
    const parsed = JSON.parse(row.day_schedules_json);
    assert.equal(parsed.thursday.new_start_time, '10:00');
  });

  await t.test('2. POST /api/allocation/schedule/day-save saves Friday without wiping Thursday', async () => {
    const res = await request('/api/allocation/schedule/day-save', {
      method: 'POST',
      body: JSON.stringify({
        account: TEST_ACC,
        status: 'NEW',
        day: 'friday',
        start: '12:00',
        end: '16:00'
      })
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.ok(res.data.day_schedules.thursday, 'Thursday MUST NOT be wiped');
    assert.equal(res.data.day_schedules.thursday.new_start_time, '10:00');
    assert.ok(res.data.day_schedules.friday, 'Friday must be saved');
    assert.equal(res.data.day_schedules.friday.new_start_time, '12:00');
  });

  await t.test('3. GET /api/allocation/configuration returns both Thursday and Friday', async () => {
    const res = await request('/api/allocation/configuration');
    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);

    const acc = res.data.accounts.find(a => a.account.toLowerCase() === TEST_ACC.toLowerCase());
    assert.ok(acc);
    assert.equal(acc.day_schedules.thursday.new_start_time, '10:00');
    assert.equal(acc.day_schedules.friday.new_start_time, '12:00');
  });

  await t.test('4. GET /api/allocation/schedule/status evaluates date-specific schedules correctly', async () => {
    // 2026-10-01 is Thursday. Time 10:30 is OPEN on Thursday (10:00 - 14:00)
    const thuRes = await request(`/api/allocation/schedule/status?account=${TEST_ACC}&work_type=NEW&time=10:30&date=2026-10-01`);
    assert.equal(thuRes.status, 200);
    assert.equal(thuRes.data.status, 'OPEN');
    assert.equal(thuRes.data.day_override, 'thursday');

    // 2026-10-02 is Friday. Time 10:30 is NOT_YET_OPEN on Friday (12:00 - 16:00)
    const friRes = await request(`/api/allocation/schedule/status?account=${TEST_ACC}&work_type=NEW&time=10:30&date=2026-10-02`);
    assert.equal(friRes.status, 200);
    assert.equal(friRes.data.status, 'NOT_YET_OPEN');
    assert.equal(friRes.data.day_override, 'friday');
  });

  await t.test('5. POST /api/allocation/schedule/day-reset resets Thursday but preserves Friday', async () => {
    const res = await request('/api/allocation/schedule/day-reset', {
      method: 'POST',
      body: JSON.stringify({
        account: TEST_ACC,
        day: 'thursday'
      })
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.equal(res.data.day_schedules.thursday, undefined);
    assert.ok(res.data.day_schedules.friday, 'Friday must remain preserved in SQLite');
    assert.equal(res.data.day_schedules.friday.new_start_time, '12:00');
  });

  // Cleanup
  db.prepare('DELETE FROM account_schedules WHERE account = ? COLLATE NOCASE').run(TEST_ACC);
  await new Promise(resolve => server.close(resolve));
});
