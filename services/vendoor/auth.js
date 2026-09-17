/**
 * Vendoor Authentication & Configuration Management (Phase 1 Access Proof)
 *
 * Responsibilities:
 * - Reads environment configuration securely (VENDOOR_EMPLOYEE_EMAIL, VENDOOR_EMPLOYEE_PASSWORD)
 * - Automated session establishment via internal employee portal (/dashboard/login)
 * - In-memory session & CSRF state management with zero-leakage guarantee
 * - Provides masked/sanitized diagnostic state
 * - Constructs HTTP headers for authenticated requests
 */

let inMemorySessionCookie = null;
let inMemoryCsrfToken = null;
let inMemorySessionExpiry = 0;
let activeLoginPromise = null;

export function getVendoorConfig() {
  const isEnabled = process.env.VENDOOR_INTEGRATION_ENABLED === 'true';
  const isMockMode = process.env.VENDOOR_MOCK_MODE === 'true';
  let rawBaseUrl = process.env.VENDOOR_BASE_URL || 'https://aff.ven-door.com';
  // If user configured the full login URL as base URL, normalize it to origin
  try {
    const parsed = new URL(rawBaseUrl);
    rawBaseUrl = parsed.origin;
  } catch {
    rawBaseUrl = rawBaseUrl.replace(/\/dashboard\/login\/?$/i, '').replace(/\/+$/, '');
  }
  const baseUrl = rawBaseUrl.replace(/\/+$/, '');
  
  const employeeEmail = process.env.VENDOOR_EMPLOYEE_EMAIL || process.env.VENDOOR_EMAIL || '';
  const employeePassword = process.env.VENDOOR_EMPLOYEE_PASSWORD || process.env.VENDOOR_PASSWORD || '';
  
  const staticSessionCookie = process.env.VENDOOR_SESSION_COOKIE || '';
  const staticCsrfToken = process.env.VENDOOR_CSRF_TOKEN || process.env.VENDOOR_XSRF_TOKEN || '';
  const apiToken = process.env.VENDOOR_API_TOKEN || process.env.VENDOOR_BEARER_TOKEN || '';
  const timeoutMs = parseInt(process.env.VENDOOR_TIMEOUT_MS, 10) || 15000;

  const effectiveSessionCookie = inMemorySessionCookie || staticSessionCookie;
  const effectiveCsrfToken = inMemoryCsrfToken || staticCsrfToken;

  const hasAutoLoginCredentials = Boolean(employeeEmail && employeePassword);
  const hasCredentials = Boolean(hasAutoLoginCredentials || effectiveSessionCookie || apiToken || isMockMode);

  return {
    enabled: isEnabled,
    mockMode: isMockMode,
    baseUrl,
    employeeEmail,
    employeePassword,
    sessionCookie: effectiveSessionCookie,
    csrfToken: effectiveCsrfToken,
    staticSessionCookie,
    staticCsrfToken,
    apiToken,
    timeoutMs,
    hasAutoLoginCredentials,
    hasCredentials,
    hasActiveSession: Boolean(effectiveSessionCookie)
  };
}

/**
 * Mask sensitive credentials for safe diagnostics and UI status
 */
export function maskSecret(val) {
  if (!val) return 'NOT_CONFIGURED';
  const s = String(val).trim();
  if (s.length <= 6) return '••••••';
  return `${s.slice(0, 3)}••••••${s.slice(-3)}`;
}

/**
 * Returns safe diagnostic view of current configuration
 */
export function getSafeVendoorStatus() {
  const cfg = getVendoorConfig();
  let authMethod = 'NONE';
  if (cfg.mockMode) {
    authMethod = 'MOCK_ADAPTER';
  } else if (cfg.hasAutoLoginCredentials) {
    authMethod = 'AUTO_LOGIN';
  } else if (cfg.apiToken) {
    authMethod = 'BEARER_TOKEN';
  } else if (cfg.sessionCookie) {
    authMethod = 'SESSION_COOKIE';
  }

  return {
    enabled: cfg.enabled,
    mock_mode: cfg.mockMode,
    base_url: cfg.baseUrl,
    has_credentials: cfg.hasCredentials,
    has_auto_login_credentials: cfg.hasAutoLoginCredentials,
    has_active_session: cfg.hasActiveSession,
    auth_method: authMethod,
    email_configured: Boolean(cfg.employeeEmail),
    email_preview: cfg.employeeEmail ? `${cfg.employeeEmail.slice(0, 2)}•••@•••` : 'NOT_CONFIGURED',
    password_configured: Boolean(cfg.employeePassword),
    session_cookie_configured: Boolean(cfg.sessionCookie),
    session_cookie_preview: cfg.sessionCookie ? maskSecret(cfg.sessionCookie) : 'NOT_CONFIGURED',
    csrf_token_configured: Boolean(cfg.csrfToken),
    csrf_token_preview: cfg.csrfToken ? maskSecret(cfg.csrfToken) : 'NOT_CONFIGURED',
    api_token_configured: Boolean(cfg.apiToken),
    api_token_preview: cfg.apiToken ? maskSecret(cfg.apiToken) : 'NOT_CONFIGURED',
    timeout_ms: cfg.timeoutMs
  };
}

/**
 * Extract CSRF token from HTML markup
 */
export function extractCsrfTokenFromHtml(html) {
  if (!html || typeof html !== 'string') return null;
  // Match <input name="_token" value="...">
  const inputMatch1 = html.match(/<input[^>]*name=["']_token["'][^>]*value=["']([^"']+)["']/i);
  if (inputMatch1 && inputMatch1[1]) return inputMatch1[1];

  const inputMatch2 = html.match(/<input[^>]*value=["']([^"']+)["'][^>]*name=["']_token["']/i);
  if (inputMatch2 && inputMatch2[1]) return inputMatch2[1];

  // Match <meta name="csrf-token" content="...">
  const metaMatch = html.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i);
  if (metaMatch && metaMatch[1]) return metaMatch[1];

  return null;
}

/**
 * Parse and merge Set-Cookie header strings into a single cookie string
 */
export function parseCookiesFromResponse(response) {
  if (!response || !response.headers) return '';
  const rawSetCookie = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);

  const cookieMap = new Map();

  for (const item of rawSetCookie) {
    if (!item) continue;
    const parts = item.split(';');
    const firstPair = parts[0].trim();
    const eqIdx = firstPair.indexOf('=');
    if (eqIdx > 0) {
      const key = firstPair.slice(0, eqIdx).trim();
      const val = firstPair.slice(eqIdx + 1).trim();
      cookieMap.set(key, val);
    }
  }

  return Array.from(cookieMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * Merge new cookies with an existing cookie string
 */
export function mergeCookieStrings(existingCookies, newCookies) {
  const map = new Map();
  if (existingCookies) {
    for (const part of existingCookies.split(';')) {
      const pair = part.trim();
      const eq = pair.indexOf('=');
      if (eq > 0) map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  if (newCookies) {
    for (const part of newCookies.split(';')) {
      const pair = part.trim();
      const eq = pair.indexOf('=');
      if (eq > 0) map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Invalidate in-memory session (called upon HTTP 401/419 or session expiry)
 */
export function invalidateActiveSession() {
  inMemorySessionCookie = null;
  inMemoryCsrfToken = null;
  inMemorySessionExpiry = 0;
}

/**
 * Authenticate against Vendoor employee portal (/dashboard/login)
 * Performs dynamic CSRF extraction and in-memory session capture.
 */
export async function performVendoorAutoLogin() {
  if (activeLoginPromise) {
    return activeLoginPromise;
  }

  activeLoginPromise = (async () => {
    const cfg = getVendoorConfig();
    if (!cfg.hasAutoLoginCredentials) {
      throw new Error('Vendoor employee credentials (VENDOOR_EMPLOYEE_EMAIL / VENDOOR_EMPLOYEE_PASSWORD) are not configured.');
    }

    const loginUrl = `${cfg.baseUrl}/dashboard/login`;
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

    // Step 1: Fetch login page to capture initial CSRF token and initial session cookie
    const getRes = await fetch(loginUrl, {
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      signal: AbortSignal.timeout(cfg.timeoutMs)
    });

    if (!getRes.ok && getRes.status !== 200) {
      throw new Error(`Failed to load Vendoor login page: HTTP ${getRes.status}`);
    }

    const htmlText = await getRes.text();
    const initialCookies = parseCookiesFromResponse(getRes);
    const csrfToken = extractCsrfTokenFromHtml(htmlText);

    if (!csrfToken) {
      throw new Error('Failed to extract CSRF token from Vendoor login page.');
    }

    // Step 2: POST credentials to /dashboard/login
    const formData = new URLSearchParams();
    formData.append('_token', csrfToken);
    formData.append('email', cfg.employeeEmail);
    formData.append('password', cfg.employeePassword);
    formData.append('remember', 'on');

    const postHeaders = {
      'User-Agent': userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Origin': cfg.baseUrl,
      'Referer': loginUrl
    };
    if (initialCookies) {
      postHeaders['Cookie'] = initialCookies;
    }

    const postRes = await fetch(loginUrl, {
      method: 'POST',
      headers: postHeaders,
      body: formData.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(cfg.timeoutMs)
    });

    const postCookies = parseCookiesFromResponse(postRes);
    const mergedCookies = mergeCookieStrings(initialCookies, postCookies);

    // Analyze post response (Laravel redirects on successful login or failure)
    const status = postRes.status;
    const location = postRes.headers.get('location') || '';

    // If redirected back to login page, credentials failed
    if (location.includes('/dashboard/login') || location.endsWith('/login')) {
      throw new Error('Vendoor authentication failed: Invalid credentials or rejected login.');
    }

    // HTTP 302/301 redirecting to /dashboard or /dashboard/orders or HTTP 200 with cookies indicates success
    const isRedirectToApp = (status === 302 || status === 301) && !location.includes('/login');
    const hasLaravelSession = mergedCookies.includes('laravel_session');

    if (!isRedirectToApp && !hasLaravelSession && status !== 200) {
      throw new Error(`Vendoor authentication failed with HTTP ${status}`);
    }

    // Update in-memory state
    inMemorySessionCookie = mergedCookies;
    inMemoryCsrfToken = csrfToken;
    inMemorySessionExpiry = Date.now() + (2 * 60 * 60 * 1000); // 2 hours

    return {
      success: true,
      authMethod: 'AUTO_LOGIN',
      expiresAt: inMemorySessionExpiry
    };
  })().finally(() => {
    activeLoginPromise = null;
  });

  return activeLoginPromise;
}

/**
 * Ensure active authenticated session before dispatching or querying Vendoor
 */
export async function ensureAuthenticatedVendoorSession() {
  const cfg = getVendoorConfig();
  if (cfg.mockMode || cfg.apiToken) {
    return true;
  }
  if (inMemorySessionCookie && inMemorySessionExpiry > Date.now()) {
    return true;
  }
  if (cfg.hasAutoLoginCredentials) {
    await performVendoorAutoLogin();
    return true;
  }
  if (cfg.staticSessionCookie) {
    return true;
  }
  throw new Error('Vendoor integration requires authentication. Neither auto-login credentials nor session cookies are configured.');
}

/**
 * Build request headers for Vendoor requests
 */
export function buildVendoorHeaders(customHeaders = {}) {
  const cfg = getVendoorConfig();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    'X-Requested-With': 'XMLHttpRequest',
    ...customHeaders
  };

  const effectiveCookie = inMemorySessionCookie || cfg.sessionCookie;
  if (effectiveCookie) {
    let cookieVal = effectiveCookie.trim();
    if (!cookieVal.includes('=')) {
      cookieVal = `laravel_session=${cookieVal}`;
    }
    headers['Cookie'] = cookieVal;
  }

  const effectiveCsrf = inMemoryCsrfToken || cfg.csrfToken;
  if (effectiveCsrf) {
    headers['X-CSRF-TOKEN'] = effectiveCsrf;
    headers['X-XSRF-TOKEN'] = effectiveCsrf;
  }

  if (cfg.apiToken) {
    headers['Authorization'] = `Bearer ${cfg.apiToken}`;
  }

  return headers;
}

