/**
 * Phase 3 Vendoor Order Completion Detection Engine
 *
 * Responsibilities:
 * - Deterministically classify Vendoor log actions and statuses into completion categories:
 *   1. COMPLETED_WORK (Finished CS processing: Printed label, Shipped, Delivered, Confirmed, Pending verification)
 *   2. PARTIALLY_WORKED (Agent data edits, note added, processing without status completion)
 *   3. NON_PRODUCTIVE (Read-only, export, system ingestion, admin assignment)
 *   4. CANCELED (Explicitly excluded from completion & productivity)
 *   5. UNKNOWN (Unverified action; zero completion credit)
 * - Enforce strict Order Code deduplication (an order code can only be counted as completed once)
 * - Isolate completion counting to the target operational business date
 */

import { db } from '../../db/index.js';
import { resolveEmployeeIdentity, MATCH_STATUS } from './identity.js';

export const COMPLETION_CLASSIFICATIONS = Object.freeze({
  COMPLETED_WORK: 'COMPLETED_WORK',
  PARTIALLY_WORKED: 'PARTIALLY_WORKED',
  NON_PRODUCTIVE: 'NON_PRODUCTIVE',
  CANCELED: 'CANCELED',
  UNKNOWN: 'UNKNOWN'
});

/**
 * Regex rules for completion classification
 */
const COMPLETION_RULES = [
  // Canceled actions (Highest priority - never counts as completed work)
  {
    type: COMPLETION_CLASSIFICATIONS.CANCELED,
    patterns: [
      /cancel/i,
      /ملغي/i,
      /الغاء/i,
      /إلغاء/i,
      /رفض/i,
      /rejected/i,
      /returned/i,
      /مرتجع/i
    ]
  },

  // Completed Work: Defensible proof that the CS agent has processed the order to a valid state
  {
    type: COMPLETION_CLASSIFICATIONS.COMPLETED_WORK,
    patterns: [
      /print/i,
      /طبع/i,
      /طباعة/i,
      /تم.*الطباعة/i,
      /printed/i,
      /shipped/i,
      /شحن/i,
      /تم.*الشحن/i,
      /delivered/i,
      /تم.*التسليم/i,
      /confirmed/i,
      /تأكيد/i,
      /تاكيد/i,
      /pending/i,
      /معلق/i,
      /قيد.*الانتظار/i
    ]
  },

  // Partially Worked: Agent touched order (address, name, alt phone, processing) but order not at milestone
  {
    type: COMPLETION_CLASSIFICATIONS.PARTIALLY_WORKED,
    patterns: [
      /processing/i,
      /قيد.*التجهيز/i,
      /تجهيز/i,
      /alt.*phone/i,
      /رقم.*بديل/i,
      /هاتف.*بديل/i,
      /تليفون.*بديل/i,
      /رقم.*هاتف.*آخر/i,
      /رقم.*هاتف.*اخر/i,
      /عدل.*في.*بيانات/i,
      /عدل.*العنوان/i,
      /تعديل.*العنوان/i,
      /عدل.*اسم/i,
      /action.*recorded/i,
      /action.*done/i
    ]
  },

  // Non-Productive / Administrative / Ingestion
  {
    type: COMPLETION_CLASSIFICATIONS.NON_PRODUCTIVE,
    patterns: [
      /view/i,
      /عرض/i,
      /معاينة/i,
      /note.*added/i,
      /ملاحظة/i,
      /ملاحظه/i,
      /login/i,
      /تسجيل.*دخول/i,
      /export/i,
      /تصدير/i,
      /search/i,
      /بحث/i,
      /filter/i,
      /فلتر/i,
      /tag/i,
      /وسم/i,
      /assigned/i,
      /اسناد/i,
      /إسناد/i,
      /order.*created/i,
      /انشاء.*طلب/i,
      /إنشاء.*طلب/i,
      /اضافة.*طلب/i,
      /اضاف.*اوردر/i,
      /أضاف.*اوردر/i,
      /ايزي.*اوردر/i
    ]
  }
];

/**
 * Classifies an action + status combination into a completion category
 */
export function classifyCompletionAction(actionText = '', statusText = '') {
  const combined = `${actionText || ''} ${statusText || ''}`.trim();
  if (!combined) {
    return {
      classification: COMPLETION_CLASSIFICATIONS.UNKNOWN,
      is_completed: false,
      reason: 'Empty action text'
    };
  }

  for (const rule of COMPLETION_RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(combined)) {
        return {
          classification: rule.type,
          is_completed: rule.type === COMPLETION_CLASSIFICATIONS.COMPLETED_WORK,
          matched_pattern: String(pat),
          raw: combined
        };
      }
    }
  }

  return {
    classification: COMPLETION_CLASSIFICATIONS.UNKNOWN,
    is_completed: false,
    reason: 'No pattern matched'
  };
}

/**
 * Queries real completed orders for a specific work date.
 *
 * Enforces:
 * 1. Only COMPLETED_WORK actions count.
 * 2. Canceled orders are strictly excluded.
 * 3. Strict de-duplication by order_code: each unique order code counts at most once.
 * 4. Deterministic attribution to authoritative master employee ID.
 *
 * @param {string} workDate - YYYY-MM-DD
 * @returns {{
 *   completed_order_codes: Set<string>,
 *   completed_by_employee: Map<number, Set<string>>,
 *   completion_details: Map<string, Object>,
 *   summary: Object
 * }}
 */
export function getCompletedOrdersForDate(workDate) {
  if (!workDate) {
    throw new Error('workDate is required for getCompletedOrdersForDate');
  }

  // 1. Fetch raw logs from both vendoor_logs and raw_log_records for this date
  const vendoorLogs = db.prepare(`
    SELECT 
      order_code, employee_name, action, timestamp_str as event_time
    FROM vendoor_logs
    WHERE work_date = ?
    ORDER BY timestamp_str ASC
  `).all(workDate);

  const rawLogs = db.prepare(`
    SELECT 
      order_code, employee_name, action, event_datetime as event_time
    FROM raw_log_records
    WHERE work_date = ?
    ORDER BY event_datetime ASC
  `).all(workDate);

  const allLogs = [...vendoorLogs, ...rawLogs];

  const completedOrderCodes = new Set();
  const completedByEmployee = new Map(); // employee_id -> Set of order_codes
  const completionDetails = new Map(); // order_code -> detail object
  const canceledOrders = new Set();

  let completedLogsObserved = 0;
  let partialLogsObserved = 0;
  let canceledLogsObserved = 0;
  let nonProductiveLogsObserved = 0;
  let unknownLogsObserved = 0;

  // Track latest action per order to check for cancellation
  for (const log of allLogs) {
    if (!log.order_code) continue;

    const classification = classifyCompletionAction(log.action);
    if (classification.classification === COMPLETION_CLASSIFICATIONS.CANCELED) {
      canceledOrders.add(log.order_code);
      canceledLogsObserved++;
    } else if (classification.classification === COMPLETION_CLASSIFICATIONS.COMPLETED_WORK) {
      completedLogsObserved++;
    } else if (classification.classification === COMPLETION_CLASSIFICATIONS.PARTIALLY_WORKED) {
      partialLogsObserved++;
    } else if (classification.classification === COMPLETION_CLASSIFICATIONS.NON_PRODUCTIVE) {
      nonProductiveLogsObserved++;
    } else {
      unknownLogsObserved++;
    }
  }

  // Process completed orders in chronological order
  for (const log of allLogs) {
    const orderCode = String(log.order_code).trim();
    if (!orderCode) continue;

    // Invariant: Canceled orders never count as completed
    if (canceledOrders.has(orderCode)) continue;

    const classification = classifyCompletionAction(log.action);
    if (!classification.is_completed) continue;

    // Resolve employee identity
    const resolved = resolveEmployeeIdentity(log.employee_name);
    if (resolved.status === MATCH_STATUS.UNMATCHED || !resolved.employee_id) {
      // Ambiguous / unmatched identity cannot reliably attribute completion
      continue;
    }

    const empId = resolved.employee_id;

    // Unique order completion check: count each unique order once
    if (!completedOrderCodes.has(orderCode)) {
      completedOrderCodes.add(orderCode);

      if (!completedByEmployee.has(empId)) {
        completedByEmployee.set(empId, new Set());
      }
      completedByEmployee.get(empId).add(orderCode);

      completionDetails.set(orderCode, {
        order_code: orderCode,
        employee_id: empId,
        employee_name: resolved.employee_name,
        action: log.action,
        completed_at: log.event_time,
        classification: classification.classification
      });
    }
  }

  return {
    completed_order_codes: completedOrderCodes,
    completed_by_employee: completedByEmployee,
    completion_details: completionDetails,
    summary: {
      work_date: workDate,
      total_log_rows: allLogs.length,
      unique_completed_orders: completedOrderCodes.size,
      unique_canceled_orders: canceledOrders.size,
      completed_logs_observed: completedLogsObserved,
      partial_logs_observed: partialLogsObserved,
      canceled_logs_observed: canceledLogsObserved,
      non_productive_logs_observed: nonProductiveLogsObserved,
      unknown_logs_observed: unknownLogsObserved
    }
  };
}

/**
 * Returns operational completion summary for a specific employee on a work date
 */
export function getOperationalCompletionSummary(employeeId, workDate) {
  const comp = getCompletedOrdersForDate(workDate);
  const empOrders = comp.completed_by_employee.get(Number(employeeId)) || new Set();
  return {
    employee_id: Number(employeeId),
    work_date: workDate,
    completed_orders_count: empOrders.size,
    completed_order_codes: Array.from(empOrders),
    total_actions_observed: comp.summary.total_log_rows || 0
  };
}

