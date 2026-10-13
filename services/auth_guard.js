/**
 * CS Executive BI — Enterprise Edition
 * Authentication & Authorization (RBAC) Layer
 * 
 * Provides verified role-based access control distinguishing
 * Supervisors/Managers from operational CS Employees.
 */

export const USER_ROLES = Object.freeze({
  SUPERVISOR: 'SUPERVISOR',
  MANAGER: 'MANAGER',
  ADMIN: 'ADMIN',
  CS_EMPLOYEE: 'CS_EMPLOYEE',
  ANONYMOUS: 'ANONYMOUS'
});

export const ROLE_PERMISSIONS = Object.freeze({
  SUPERVISOR: [
    'allocation:plan',
    'allocation:execute',
    'allocation:undo',
    'allocation:reset',
    'allocation:override',
    'allocation:reassign',
    'configuration:read',
    'configuration:write',
    'schedule:write',
    'team:write',
    'employees:write',
    'vendoor:config',
    'vendoor:sync',
    'system:backup',
    'system:restore',
    'orders:read',
    'orders:claim',
    'orders:work',
    'reports:read',
    'exports:create'
  ],
  MANAGER: [
    'allocation:plan',
    'allocation:execute',
    'allocation:undo',
    'allocation:reset',
    'allocation:override',
    'allocation:reassign',
    'configuration:read',
    'configuration:write',
    'schedule:write',
    'team:write',
    'employees:write',
    'vendoor:config',
    'vendoor:sync',
    'system:backup',
    'system:restore',
    'orders:read',
    'orders:claim',
    'orders:work',
    'reports:read',
    'exports:create'
  ],
  ADMIN: [
    '*'
  ],
  CS_EMPLOYEE: [
    'orders:read',
    'orders:claim',
    'orders:work',
    'tracking:write',
    'reports:read_self',
    'exports:create'
  ],
  ANONYMOUS: [
    'public:read'
  ]
});

// Configured system tokens from environment
const isProd = process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production';
const VALID_TOKENS = new Map();

// Dynamic sessions store for authenticated logins
const ACTIVE_SESSIONS = new Map();

export function registerSystemToken(token, user, role, employeeId = null) {
  if (!token || typeof token !== 'string') return;
  const clean = token.trim();
  if (!clean) return;
  VALID_TOKENS.set(clean, {
    user: user || 'System User',
    role: role || USER_ROLES.SUPERVISOR,
    employeeId: employeeId ? parseInt(employeeId, 10) : null
  });
}

export function createSessionToken(user, role, employeeId = null, ttlMs = 24 * 60 * 60 * 1000) {
  const crypto = globalThis.crypto;
  const token = crypto && crypto.randomUUID 
    ? 'cs_sess_' + crypto.randomUUID().replace(/-/g, '') 
    : 'cs_sess_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  
  ACTIVE_SESSIONS.set(token, {
    user: user || (role === USER_ROLES.CS_EMPLOYEE ? 'CS Employee' : 'Supervisor'),
    role,
    employeeId: employeeId ? parseInt(employeeId, 10) : null,
    expiresAt: Date.now() + ttlMs
  });
  return token;
}

export function revokeSessionToken(token) {
  if (token) ACTIVE_SESSIONS.delete(token);
}

// Load env tokens
if (process.env.ADMIN_API_TOKEN && process.env.ADMIN_API_TOKEN.trim()) {
  registerSystemToken(process.env.ADMIN_API_TOKEN, 'Admin User', USER_ROLES.ADMIN);
}
if (process.env.SUPERVISOR_API_TOKEN && process.env.SUPERVISOR_API_TOKEN.trim()) {
  registerSystemToken(process.env.SUPERVISOR_API_TOKEN, 'Supervisor User', USER_ROLES.SUPERVISOR);
}
if (process.env.CS_AGENT_API_TOKEN && process.env.CS_AGENT_API_TOKEN.trim()) {
  registerSystemToken(process.env.CS_AGENT_API_TOKEN, 'CS Agent', USER_ROLES.CS_EMPLOYEE);
}

export function isProductionEnvironment() {
  return process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production';
}

// In development or test, initialize a secure bootstrap token if none are set
let devBootstrapToken = null;
if (!isProd) {
  devBootstrapToken = process.env.DEV_BOOTSTRAP_TOKEN || 'cs_dev_supervisor_bootstrap_token';
  registerSystemToken(devBootstrapToken, 'Supervisor Dev', USER_ROLES.SUPERVISOR);

  // Pre-register test and standard development tokens ONLY in non-production environments
  registerSystemToken('test_supervisor_token', 'Test Supervisor', USER_ROLES.SUPERVISOR);
  registerSystemToken('test_admin_token', 'Test Admin', USER_ROLES.ADMIN);
  registerSystemToken('test_cs_token', 'Test CS', USER_ROLES.CS_EMPLOYEE);
  registerSystemToken('supervisor_token_cs_bi', 'Supervisor System', USER_ROLES.SUPERVISOR);
}

export function getDevBootstrapToken() {
  if (isProductionEnvironment()) {
    return null;
  }
  return devBootstrapToken || (process.env.DEV_BOOTSTRAP_TOKEN || 'cs_dev_supervisor_bootstrap_token');
}

export function operatorLogin(secret) {
  if (!secret || typeof secret !== 'string') return null;
  const clean = secret.trim();
  if (isProductionEnvironment()) {
    const isTestToken = clean.startsWith('test_') || clean.startsWith('cs_dev_') || clean === 'supervisor_token_cs_bi';
    if (isTestToken) return null;
  }
  if (VALID_TOKENS.has(clean)) {
    const info = VALID_TOKENS.get(clean);
    const sessionToken = createSessionToken(info.user, info.role, info.employeeId);
    return { success: true, token: sessionToken, user: info.user, role: info.role };
  }
  if ((process.env.SUPERVISOR_API_TOKEN && clean === process.env.SUPERVISOR_API_TOKEN) ||
      (process.env.ADMIN_API_TOKEN && clean === process.env.ADMIN_API_TOKEN) ||
      (!isProductionEnvironment() && devBootstrapToken && clean === devBootstrapToken)) {
    const sessionToken = createSessionToken('Operator', USER_ROLES.SUPERVISOR);
    return { success: true, token: sessionToken, user: 'Operator', role: USER_ROLES.SUPERVISOR };
  }
  return null;
}

/**
 * Extracts and verifies user identity from incoming HTTP request.
 * Strictly rejects forged headers (x-user-role, x-role, body.role, query.role).
 * Strictly rejects token in URL query parameter (prevents leakage in logs and history).
 * Unauthenticated requests receive isAuthenticated: false and role: ANONYMOUS.
 */
export function extractUserIdentity(req) {
  const authHeader = req.headers['authorization'] || '';
  const cookieHeader = req.headers['cookie'] || '';
  let cookieToken = null;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)cs_session=([^;]+)/);
    if (match) cookieToken = decodeURIComponent(match[1].trim());
  }

  // Bearer token, custom header, or cookie session only — NEVER query parameter
  const token = authHeader.startsWith('Bearer ') 
    ? authHeader.slice(7).trim() 
    : (req.headers['x-api-token'] || req.headers['x-session-token'] || cookieToken || null);

  // 1. Check configured system tokens
  if (token && VALID_TOKENS.has(token)) {
    if (isProductionEnvironment()) {
      const isTestToken = token.startsWith('test_') || token.startsWith('cs_dev_') || token === 'supervisor_token_cs_bi';
      if (isTestToken) {
        return {
          user: 'Anonymous',
          role: USER_ROLES.ANONYMOUS,
          employeeId: null,
          token: null,
          permissions: ROLE_PERMISSIONS.ANONYMOUS,
          isSupervisor: false,
          isCsEmployee: false,
          isAuthenticated: false
        };
      }
    }
    const info = VALID_TOKENS.get(token);
    const perms = ROLE_PERMISSIONS[info.role] || [];
    return {
      user: info.user,
      role: info.role,
      employeeId: info.employeeId,
      token,
      permissions: perms,
      isSupervisor: info.role === USER_ROLES.SUPERVISOR || info.role === USER_ROLES.MANAGER || info.role === USER_ROLES.ADMIN,
      isCsEmployee: info.role === USER_ROLES.CS_EMPLOYEE,
      isAuthenticated: true
    };
  }

  // 2. Check active dynamic sessions
  if (token && ACTIVE_SESSIONS.has(token)) {
    const sess = ACTIVE_SESSIONS.get(token);
    if (sess.expiresAt && Date.now() > sess.expiresAt) {
      ACTIVE_SESSIONS.delete(token);
    } else {
      const perms = ROLE_PERMISSIONS[sess.role] || [];
      return {
        user: sess.user,
        role: sess.role,
        employeeId: sess.employeeId,
        token,
        permissions: perms,
        isSupervisor: sess.role === USER_ROLES.SUPERVISOR || sess.role === USER_ROLES.MANAGER || sess.role === USER_ROLES.ADMIN,
        isCsEmployee: sess.role === USER_ROLES.CS_EMPLOYEE,
        isAuthenticated: true
      };
    }
  }

  // 3. For test environment with explicit test token
  const isTestEnv = process.env.NODE_ENV === 'test' || 
    process.env.npm_lifecycle_event?.includes('test') || 
    process.argv.some(arg => typeof arg === 'string' && (arg.includes('test') || arg.includes('spec')));

  if (!isProductionEnvironment() && isTestEnv && req.headers['x-test-auth-token'] && VALID_TOKENS.has(req.headers['x-test-auth-token'])) {
    const info = VALID_TOKENS.get(req.headers['x-test-auth-token']);
    const perms = ROLE_PERMISSIONS[info.role] || [];
    return {
      user: info.user,
      role: info.role,
      employeeId: info.employeeId,
      token: req.headers['x-test-auth-token'],
      permissions: perms,
      isSupervisor: info.role === USER_ROLES.SUPERVISOR || info.role === USER_ROLES.MANAGER || info.role === USER_ROLES.ADMIN,
      isCsEmployee: info.role === USER_ROLES.CS_EMPLOYEE,
      isAuthenticated: true
    };
  }

  // 4. Default: Strictly unauthenticated anonymous caller.
  // Missing or invalid token MUST produce 401/403, NEVER a default Supervisor identity!
  return {
    user: 'Anonymous',
    role: USER_ROLES.ANONYMOUS,
    employeeId: null,
    token: null,
    permissions: ROLE_PERMISSIONS.ANONYMOUS,
    isSupervisor: false,
    isCsEmployee: false,
    isAuthenticated: false
  };
}

/**
 * Express middleware requiring specific roles
 */
export function requireRole(allowedRoles = [USER_ROLES.SUPERVISOR, USER_ROLES.MANAGER, USER_ROLES.ADMIN]) {
  return (req, res, next) => {
    const identity = extractUserIdentity(req);
    req.userIdentity = identity;

    const normalizedAllowed = allowedRoles.map(r => r.toUpperCase());
    if (!normalizedAllowed.includes(identity.role)) {
      const status = identity.isAuthenticated ? 403 : 401;
      return res.status(status).json({
        success: false,
        error: `ROLE_PERMISSION_DENIED: User "${identity.user}" with role "${identity.role}" is not authorized for this operation. Required role: ${allowedRoles.join(' or ')}.`,
        code: identity.isAuthenticated ? 'ROLE_PERMISSION_DENIED' : 'UNAUTHORIZED',
        required_roles: allowedRoles,
        user_role: identity.role
      });
    }

    next();
  };
}

/**
 * Express middleware requiring specific permission
 */
export function requirePermission(permissionName) {
  return (req, res, next) => {
    const identity = extractUserIdentity(req);
    req.userIdentity = identity;

    const perms = identity.permissions || [];
    const hasPermission = perms.includes('*') || perms.includes(permissionName);

    if (!hasPermission) {
      const status = identity.isAuthenticated ? 403 : 401;
      return res.status(status).json({
        success: false,
        error: `PERMISSION_DENIED: User "${identity.user}" lacks required permission "${permissionName}".`,
        code: identity.isAuthenticated ? 'PERMISSION_DENIED' : 'UNAUTHORIZED',
        required_permission: permissionName,
        user_role: identity.role
      });
    }

    next();
  };
}

export function isSupervisor(req) {
  const identity = extractUserIdentity(req);
  return identity.isSupervisor;
}

export const requireSupervisor = requireRole([USER_ROLES.SUPERVISOR, USER_ROLES.MANAGER, USER_ROLES.ADMIN]);
export const requireAuth = requireRole([USER_ROLES.SUPERVISOR, USER_ROLES.MANAGER, USER_ROLES.ADMIN, USER_ROLES.CS_EMPLOYEE]);
export const requireCsOrSupervisor = requireAuth;

/**
 * Validates that an action executed on behalf of a specific employee ID
 * is authorized by the caller. CS Agents can only act on their own ID;
 * Supervisors/Admins can act on behalf of any employee.
 */
export function assertEmployeeAuthorization(req, targetEmployeeId) {
  const identity = req.userIdentity || extractUserIdentity(req);
  if (!identity.isAuthenticated) {
    throw new Error('UNAUTHORIZED: Authentication required.');
  }
  if (identity.isSupervisor) {
    return true;
  }
  if (identity.isCsEmployee) {
    if (!targetEmployeeId) {
      throw new Error('EMPLOYEE_ID_REQUIRED: CS employee must provide employee identity.');
    }
    const targetNum = parseInt(targetEmployeeId, 10);
    if (identity.employeeId && identity.employeeId !== targetNum) {
      throw new Error('FORBIDDEN_EMPLOYEE_MISMATCH: CS agents cannot perform actions on behalf of another employee.');
    }
    return true;
  }
  throw new Error('ROLE_PERMISSION_DENIED: Unauthorized action.');
}

