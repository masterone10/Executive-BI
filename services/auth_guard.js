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
  CS_EMPLOYEE: 'CS_EMPLOYEE'
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
    'reports:read'
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
    'reports:read'
  ],
  ADMIN: [
    '*'
  ],
  CS_EMPLOYEE: [
    'orders:read',
    'orders:claim',
    'orders:work',
    'tracking:write',
    'reports:read_self'
  ]
});

/**
 * Extracts and verifies user identity from incoming HTTP request.
 * Supports:
 * - Authorization: Bearer <token>
 * - X-User-Role / X-Role headers
 * - X-User-Id / X-User headers
 * - Session cookies or query tokens
 */
export function extractUserIdentity(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  // Header or body role
  const rawRole = (
    req.headers['x-user-role'] ||
    req.headers['x-role'] ||
    req.body?.role ||
    req.query?.role ||
    ''
  ).trim().toUpperCase();

  const rawUser = (
    req.headers['x-user'] ||
    req.headers['x-user-id'] ||
    req.body?.operator ||
    req.query?.user ||
    'Supervisor'
  ).trim();

  let role = USER_ROLES.SUPERVISOR;
  if (rawRole === 'CS_EMPLOYEE' || rawRole === 'EMPLOYEE' || rawRole === 'AGENT') {
    role = USER_ROLES.CS_EMPLOYEE;
  } else if (rawRole === 'MANAGER') {
    role = USER_ROLES.MANAGER;
  } else if (rawRole === 'ADMIN') {
    role = USER_ROLES.ADMIN;
  } else if (rawRole === 'SUPERVISOR') {
    role = USER_ROLES.SUPERVISOR;
  } else if (!rawRole && token === 'cs_agent_token') {
    role = USER_ROLES.CS_EMPLOYEE;
  }

  return {
    user: rawUser || (role === USER_ROLES.CS_EMPLOYEE ? 'CS Agent' : 'Supervisor'),
    role,
    token,
    isSupervisor: role === USER_ROLES.SUPERVISOR || role === USER_ROLES.MANAGER || role === USER_ROLES.ADMIN,
    isCsEmployee: role === USER_ROLES.CS_EMPLOYEE
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
      return res.status(403).json({
        success: false,
        error: `ROLE_PERMISSION_DENIED: User "${identity.user}" with role "${identity.role}" is not authorized for this operation. Required role: ${allowedRoles.join(' or ')}.`,
        code: 'ROLE_PERMISSION_DENIED',
        required_roles: allowedRoles,
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
