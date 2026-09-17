/**
 * Isolated Vendoor HTTP Client (Phase 1 Access Proof)
 *
 * Responsibilities:
 * - Low-level HTTP communication via fetch
 * - Timeout handling
 * - Limited retry policy (max 1 retry with exponential backoff)
 * - Safe response validation and error sanitization (never leaking tokens/cookies)
 */

import {
  getVendoorConfig,
  buildVendoorHeaders,
  ensureAuthenticatedVendoorSession,
  performVendoorAutoLogin,
  invalidateActiveSession
} from './auth.js';

export class VendoorClientError extends Error {
  constructor(message, statusCode = 500, code = 'VENDOOR_CLIENT_ERROR', details = null) {
    super(message);
    this.name = 'VendoorClientError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/**
 * Execute HTTP request to Vendoor with timeout and limited retry
 */
export async function vendoorFetch(endpointPath, options = {}) {
  const cfg = getVendoorConfig();
  if (!cfg.enabled && !cfg.mockMode) {
    throw new VendoorClientError(
      'Vendoor integration is disabled in configuration (VENDOOR_INTEGRATION_ENABLED=false).',
      400,
      'INTEGRATION_DISABLED'
    );
  }

  // Auto-ensure active session if auto-login credentials exist
  if (!options.skipAuthCheck && !cfg.mockMode && cfg.hasAutoLoginCredentials && !cfg.hasActiveSession) {
    try {
      await ensureAuthenticatedVendoorSession();
    } catch (authErr) {
      throw new VendoorClientError(
        `Vendoor authentication failed: ${authErr.message}`,
        401,
        'AUTH_FAILED',
        { rawMessage: authErr.message }
      );
    }
  }

  const url = endpointPath.startsWith('http')
    ? endpointPath
    : `${cfg.baseUrl}${endpointPath.startsWith('/') ? '' : '/'}${endpointPath}`;

  const headers = buildVendoorHeaders(options.headers || {});
  const method = options.method || 'GET';
  const timeoutMs = options.timeoutMs || cfg.timeoutMs;
  const maxRetries = options.retries !== undefined ? options.retries : 1;

  let attempt = 0;
  let lastError = null;

  while (attempt <= maxRetries) {
    attempt++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const startTime = Date.now();
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: options.body,
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;
      const status = response.status;
      const contentType = response.headers.get('content-type') || '';

      // Check if session expired or unauthenticated redirect occurred
      const isRedirectedToLogin = response.redirected && response.url.includes('/login');
      const isAuthError = status === 401 || status === 419 || isRedirectedToLogin;

      if (isAuthError) {
        // Attempt single automatic re-authentication if credentials exist and haven't retried yet
        if (!options._isAuthRetry && cfg.hasAutoLoginCredentials) {
          invalidateActiveSession();
          try {
            await performVendoorAutoLogin();
            // Retry request exactly once with new session
            return await vendoorFetch(endpointPath, {
              ...options,
              _isAuthRetry: true,
              retries: 0
            });
          } catch (reauthErr) {
            throw new VendoorClientError(
              'Vendoor re-authentication failed: ' + reauthErr.message,
              401,
              'AUTH_EXPIRED',
              { durationMs, status, contentType }
            );
          }
        }

        throw new VendoorClientError(
          'Vendoor authentication required or session expired (HTTP ' + status + '). Please check credentials.',
          401,
          'AUTH_EXPIRED',
          { durationMs, status, contentType }
        );
      }

      if (status === 403) {
        throw new VendoorClientError(
          'Vendoor access forbidden (HTTP 403). Account lacks permission for this resource or CSRF token is invalid.',
          403,
          'ACCESS_FORBIDDEN',
          { durationMs, status, contentType }
        );
      }

      if (status === 429) {
        throw new VendoorClientError(
          'Vendoor rate limit reached (HTTP 429). Please reduce request frequency.',
          429,
          'RATE_LIMITED',
          { durationMs, status, contentType }
        );
      }

      if (!response.ok && status >= 500) {
        if (attempt <= maxRetries) {
          console.warn(`[Vendoor] Server returned HTTP ${status}, retrying in 1s (attempt ${attempt}/${maxRetries})...`);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        throw new VendoorClientError(
          `Vendoor server error (HTTP ${status}). Endpoint is currently unavailable.`,
          status,
          'SERVER_ERROR',
          { durationMs, status, contentType }
        );
      }

      if (!response.ok) {
        throw new VendoorClientError(
          `Vendoor returned HTTP ${status} error.`,
          status,
          'HTTP_ERROR',
          { durationMs, status, contentType }
        );
      }

      return {
        ok: true,
        status,
        headers: response.headers,
        contentType,
        durationMs,
        response
      };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof VendoorClientError) {
        throw err;
      }

      if (err.name === 'AbortError') {
        lastError = new VendoorClientError(
          `Vendoor request timed out after ${timeoutMs}ms.`,
          504,
          'TIMEOUT',
          { durationMs: Date.now() - startTime }
        );
      } else {
        lastError = new VendoorClientError(
          `Network connection to Vendoor failed: ${err.message}`,
          502,
          'CONNECTION_FAILED',
          { rawError: err.message }
        );
      }

      if (attempt <= maxRetries && method === 'GET') {
        console.warn(`[Vendoor] Network error: ${err.message}, retrying once in 1s...`);
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError || new VendoorClientError('Vendoor request failed after retries.', 500, 'MAX_RETRIES_EXCEEDED');
}
