import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { app } from '../server.js';
import { db } from '../db/index.js';
import { createSessionToken, USER_ROLES } from '../services/auth_guard.js';

test('HTTP API ORDERS POOL PAGINATION & METADATA CONTRACT', async () => {
  const testDate = '2026-04-18';

  // Seed DB with 650 orders
  db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(testDate);
  db.prepare('DELETE FROM vendoor_orders WHERE source_date = ? OR business_date = ?').run(testDate, testDate);
  db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(testDate);

  const insertCWO = db.prepare(`
    INSERT INTO current_work_orders (work_date, order_code, account, status, source_file_slot, work_state)
    VALUES (?, ?, ?, ?, 1, 'ASSIGNED')
  `);
  for (let i = 1; i <= 350; i++) {
    insertCWO.run(testDate, `HTTP-PAG-NEW-${i}`, 'Alpha Merchant', 'New');
  }
  for (let i = 1; i <= 300; i++) {
    insertCWO.run(testDate, `HTTP-PAG-PEN-${i}`, 'Beta Logistics', 'Pending');
  }

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const supervisorToken = createSessionToken({
    userId: 'sup-page-test',
    name: 'Admin Supervisor',
    role: USER_ROLES.SUPERVISOR
  });

  async function request(path) {
    return new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${port}${path}`, {
        headers: {
          'Cookie': `auth_session=${supervisorToken}`
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch (e) {
            resolve({ status: res.statusCode, body });
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  try {
    // 1. Default page size (50)
    const res50 = await request(`/api/orders/current/${testDate}`);
    assert.strictEqual(res50.status, 200);
    assert.strictEqual(res50.data.total_count, 650);
    assert.strictEqual(res50.data.total_pages, 13);
    assert.strictEqual(res50.data.page, 0);
    assert.strictEqual(res50.data.page_size, 50);
    assert.strictEqual(res50.data.orders.length, 50);

    // 2. Page size 300, page 1
    const res300p1 = await request(`/api/orders/current/${testDate}?page=1&limit=300`);
    assert.strictEqual(res300p1.status, 200);
    assert.strictEqual(res300p1.data.total_count, 650);
    assert.strictEqual(res300p1.data.total_pages, 3);
    assert.strictEqual(res300p1.data.page, 1);
    assert.strictEqual(res300p1.data.orders.length, 300);

    // 3. Page size 300, page 2 (last page, remaining 50)
    const res300p2 = await request(`/api/orders/current/${testDate}?page=2&limit=300`);
    assert.strictEqual(res300p2.status, 200);
    assert.strictEqual(res300p2.data.total_count, 650);
    assert.strictEqual(res300p2.data.page, 2);
    assert.strictEqual(res300p2.data.orders.length, 50);

    // 4. Status filter 'Pending'
    const resPending = await request(`/api/orders/current/${testDate}?status=Pending&limit=100`);
    assert.strictEqual(resPending.status, 200);
    assert.strictEqual(resPending.data.total_count, 300);
    assert.strictEqual(resPending.data.total_pages, 3);
    assert.strictEqual(resPending.data.orders.length, 100);
    assert.strictEqual(resPending.data.filters_applied.status, 'Pending');

  } finally {
    server.close();
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(testDate);
  }
});
