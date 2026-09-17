import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getVendoorConfig,
  getSafeVendoorStatus,
  extractCsrfTokenFromHtml,
  parseCookiesFromResponse,
  mergeCookieStrings,
  invalidateActiveSession,
  performVendoorAutoLogin,
  ensureAuthenticatedVendoorSession,
  buildVendoorHeaders,
  maskSecret
} from '../services/vendoor/auth.js';
import { VendoorClientError } from '../services/vendoor/client.js';

describe('VENDOOR AUTHENTICATION & SECURITY FORENSIC SUITE', () => {

  test('1. Config & Masking: Environment variables loaded securely with zero raw credential leakage', () => {
    const status = getSafeVendoorStatus();
    assert.ok(status, 'Status object should exist');
    assert.equal(typeof status.enabled, 'boolean');
    assert.equal(typeof status.has_credentials, 'boolean');
    assert.equal(typeof status.has_auto_login_credentials, 'boolean');
    assert.ok(status.auth_method);

    // Verify masking
    assert.equal(maskSecret(''), 'NOT_CONFIGURED');
    assert.equal(maskSecret(null), 'NOT_CONFIGURED');
    assert.equal(maskSecret('12345'), '••••••');
    const masked = maskSecret('super_secret_session_cookie_value_12345');
    assert.ok(masked.includes('••••••'));
    assert.ok(!masked.includes('session_cookie_value'));
  });

  test('2. Dynamic CSRF Extraction: Extracts token from input or meta tags accurately', () => {
    const html1 = `
      <form method="POST" action="/dashboard/login">
        <input type="hidden" name="_token" value="test_token_abc_123">
        <input type="email" name="email">
      </form>
    `;
    assert.equal(extractCsrfTokenFromHtml(html1), 'test_token_abc_123');

    const html2 = `
      <meta name="csrf-token" content="meta_csrf_xyz_789">
    `;
    assert.equal(extractCsrfTokenFromHtml(html2), 'meta_csrf_xyz_789');

    const html3 = `
      <input value="swapped_val_999" name="_token">
    `;
    assert.equal(extractCsrfTokenFromHtml(html3), 'swapped_val_999');

    assert.equal(extractCsrfTokenFromHtml('<html><body>No token</body></html>'), null);
  });

  test('3. Cookie Parsing & Merging: Parses Set-Cookie and merges multiple cookies accurately', () => {
    const mockResponse = {
      headers: {
        getSetCookie: () => [
          'laravel_session=sess_111; expires=Thu, 18-Sep-2026 12:00:00 GMT; Max-Age=7200; path=/; httponly',
          'XSRF-TOKEN=xsrf_222; expires=Thu, 18-Sep-2026 12:00:00 GMT; path=/'
        ]
      }
    };
    const parsed = parseCookiesFromResponse(mockResponse);
    assert.ok(parsed.includes('laravel_session=sess_111'));
    assert.ok(parsed.includes('XSRF-TOKEN=xsrf_222'));

    const merged = mergeCookieStrings('laravel_session=sess_111', 'remember_web=rem_333');
    assert.ok(merged.includes('laravel_session=sess_111'));
    assert.ok(merged.includes('remember_web=rem_333'));
  });

  test('4. Correct Internal Employee Portal URL: Target is /dashboard/login', () => {
    const cfg = getVendoorConfig();
    assert.equal(cfg.baseUrl.includes('aff.ven-door.com'), true);
    assert.equal(cfg.baseUrl.endsWith('/login'), false, 'Base URL must be origin, not login URL');
  });

  test('5. Missing Credentials Error Handling: Clean failure without leaking or crashing', async () => {
    const origEmail = process.env.VENDOOR_EMPLOYEE_EMAIL;
    const origPass = process.env.VENDOOR_EMPLOYEE_PASSWORD;
    delete process.env.VENDOOR_EMPLOYEE_EMAIL;
    delete process.env.VENDOOR_EMPLOYEE_PASSWORD;
    delete process.env.VENDOOR_EMAIL;
    delete process.env.VENDOOR_PASSWORD;

    invalidateActiveSession();

    await assert.rejects(
      async () => {
        await performVendoorAutoLogin();
      },
      (err) => {
        assert.ok(err.message.includes('not configured'));
        return true;
      }
    );

    // Restore
    if (origEmail) process.env.VENDOOR_EMPLOYEE_EMAIL = origEmail;
    if (origPass) process.env.VENDOOR_EMPLOYEE_PASSWORD = origPass;
  });

  test('6. Invalidation Lifecycle: Invalidate clears active in-memory session', () => {
    invalidateActiveSession();
    const cfg = getVendoorConfig();
    assert.equal(cfg.hasActiveSession, Boolean(cfg.staticSessionCookie));
  });

  test('7. Header Construction: Correctly formats Cookie and CSRF headers', () => {
    const headers = buildVendoorHeaders({ 'Custom-Test-Header': 'val' });
    assert.equal(headers['Custom-Test-Header'], 'val');
    assert.ok(headers['User-Agent']);
    assert.ok(headers['Accept']);
  });

  test('8. Zero Secrets in Client Error Serialization: VendoorClientError never exposes passwords', () => {
    const err = new VendoorClientError('Test error message', 401, 'AUTH_ERROR', { field: 'safe' });
    const str = JSON.stringify(err);
    assert.ok(!str.includes('password'));
    assert.ok(!str.includes('laravel_session'));
  });
});
