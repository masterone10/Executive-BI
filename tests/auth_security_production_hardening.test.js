import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app } from '../server.js';
import { getDevBootstrapToken, isProductionEnvironment } from '../services/auth_guard.js';

test('Security Audit: Auth Guard Production Hardening Suite', async (t) => {
  const ephemeralServer = http.createServer(app);
  await new Promise(r => ephemeralServer.listen(0, '127.0.0.1', r));
  const port = ephemeralServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(() => {
    ephemeralServer.close();
  });

  async function api(path, method = 'GET', headers = {}, body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${baseUrl}${path}`, opts);
    let data;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  }

  await t.test('1. getDevBootstrapToken returns null in production environment', () => {
    const origEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.equal(getDevBootstrapToken(), null, 'Dev bootstrap token must strictly be null in production');
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  await t.test('2. Unauthenticated request to sensitive supervisor operation returns HTTP 401', async () => {
    const res = await api('/api/allocation/configuration/save', 'POST', {}, {
      global_settings: { allocation_mode: 'ACTIVE' }
    });
    assert.equal(res.status, 401);
    assert.equal(res.data.success, false);
    assert.equal(res.data.code, 'UNAUTHORIZED');
  });

  await t.test('3. Authenticated CS Employee token returns HTTP 403 on supervisor operation', async () => {
    const res = await api('/api/allocation/configuration/save', 'POST', {
      'Authorization': 'Bearer test_cs_token'
    }, {
      global_settings: { allocation_mode: 'ACTIVE' }
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.success, false);
    assert.equal(res.data.code, 'ROLE_PERMISSION_DENIED');
  });

  await t.test('4. Authenticated supervisor token succeeds with HTTP 200', async () => {
    const res = await api('/api/allocation/configuration', 'GET', {
      'Authorization': 'Bearer test_supervisor_token'
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
  });

  await t.test('5. Token in URL query parameter is rejected (HTTP 401)', async () => {
    const res = await api('/api/allocation/configuration/save?token=test_supervisor_token', 'POST', {}, {
      global_settings: { allocation_mode: 'ACTIVE' }
    });
    assert.equal(res.status, 401);
  });

  await t.test('6. In production environment, static test and dev tokens are strictly rejected (HTTP 401)', async () => {
    const origEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const testSupRes = await api('/api/allocation/configuration/save', 'POST', {
        'Authorization': 'Bearer test_supervisor_token'
      }, { global_settings: { allocation_mode: 'ACTIVE' } });
      assert.equal(testSupRes.status, 401);

      const devBootstrapRes = await api('/api/allocation/configuration/save', 'POST', {
        'Authorization': 'Bearer cs_dev_supervisor_bootstrap_token'
      }, { global_settings: { allocation_mode: 'ACTIVE' } });
      assert.equal(devBootstrapRes.status, 401);
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });
});
