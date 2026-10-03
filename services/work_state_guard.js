/**
 * CS Executive BI — Enterprise Edition
 * Central Work State & Lifecycle Transition Guard
 * 
 * Defines authoritative work states, protected operational states,
 * and valid lifecycle state transitions.
 */

export const WORK_STATES = Object.freeze([
  'UNASSIGNED',
  'ASSIGNED',
  'CLAIMED',
  'IN_PROGRESS',
  'PRINTED',
  'COMPLETED',
  'CANCELLED'
]);

/**
 * Protected States:
 * Orders in these states represent active, in-flight, or finalized operational work.
 * Standard allocation engines, auto-dispatchers, batch rebalancing, and operational
 * resets MUST NEVER unassign or overwrite orders in these states.
 */
export const PROTECTED_WORK_STATES = Object.freeze([
  'CLAIMED',
  'IN_PROGRESS',
  'PRINTED',
  'COMPLETED',
  'CANCELLED'
]);

/**
 * Check if a work state is protected from automated re-allocation/unassignment
 */
export function isProtectedWorkState(workState) {
  if (!workState) return false;
  const normalized = String(workState).trim().toUpperCase();
  return PROTECTED_WORK_STATES.includes(normalized);
}

/**
 * Authoritative Work State Machine Transitions
 * 
 * UNASSIGNED -> ASSIGNED (Allocation), CLAIMED (Direct Pickup), CANCELLED
 * ASSIGNED -> CLAIMED (Agent accepts), IN_PROGRESS (Immediate start), PRINTED, UNASSIGNED (Rollback/Reset), CANCELLED
 * CLAIMED -> IN_PROGRESS (Working), PRINTED, COMPLETED, ASSIGNED (Supervisor reassign), CANCELLED
 * IN_PROGRESS -> PRINTED, COMPLETED, CANCELLED
 * PRINTED -> COMPLETED, CANCELLED
 * COMPLETED -> Terminal (No transitions)
 * CANCELLED -> Terminal (No transitions)
 */
export const VALID_WORK_TRANSITIONS = Object.freeze({
  UNASSIGNED: ['ASSIGNED', 'CLAIMED', 'CANCELLED'],
  ASSIGNED: ['CLAIMED', 'IN_PROGRESS', 'PRINTED', 'UNASSIGNED', 'CANCELLED'],
  CLAIMED: ['IN_PROGRESS', 'PRINTED', 'COMPLETED', 'ASSIGNED', 'CANCELLED'],
  IN_PROGRESS: ['PRINTED', 'COMPLETED', 'CANCELLED'],
  PRINTED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: []
});

/**
 * Checks whether a lifecycle state transition is permitted
 */
export function canTransitionWorkState(fromState, toState) {
  const from = (fromState || 'UNASSIGNED').trim().toUpperCase();
  const to = (toState || '').trim().toUpperCase();
  if (from === to) return true; // Idempotent no-op
  const allowed = VALID_WORK_TRANSITIONS[from];
  return Boolean(allowed && allowed.includes(to));
}

/**
 * Asserts that a lifecycle state transition is valid, throwing an explicit error if forbidden
 */
export function assertValidWorkTransition(fromState, toState, orderCode = '') {
  if (!canTransitionWorkState(fromState, toState)) {
    const err = new Error(
      `INVALID_WORK_STATE_TRANSITION: Order ${orderCode ? `"${orderCode}" ` : ''}cannot transition from '${fromState || 'UNASSIGNED'}' to '${toState}'. State transition is forbidden by operational lifecycle rules.`
    );
    err.code = 'INVALID_WORK_STATE_TRANSITION';
    err.status = 400;
    err.fromState = fromState;
    err.toState = toState;
    throw err;
  }
  return true;
}
