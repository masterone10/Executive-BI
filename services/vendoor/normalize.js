/**
 * Neutral Data Normalizer for Vendoor Payloads (Autonomous Operations)
 *
 * Responsibilities:
 * - Safely normalize raw Vendoor Order objects to standard metadata
 * - Safely normalize raw Vendoor Log rows to standard log items
 * - Strict isolation: Never creates DB employees, never modifies Smart Allocation rules.
 */

import { extractCanonicalStatus } from './actions.js';
export { extractCanonicalStatus };

/**
 * Normalizes an individual order item from Vendoor order tables
 */
export function normalizeVendoorOrder(rawOrder) {
  if (!rawOrder || typeof rawOrder !== 'object') return null;

  // Extract order code / tracking number (Vendoor logs use random_number/tracking code)
  const orderCode = String(
    rawOrder.random_number ||
    rawOrder.order_no ||
    rawOrder.order_code ||
    rawOrder.code ||
    rawOrder.order_id ||
    rawOrder.id ||
    rawOrder.reference ||
    ''
  ).trim();

  if (!orderCode) return null;

  // Extract status & strip HTML wrapper if present
  let rawStatus = String(
    rawOrder.status_name ||
    rawOrder.status ||
    rawOrder.order_status ||
    rawOrder.state ||
    'Unknown'
  ).trim();

  if (rawStatus.includes('<')) {
    rawStatus = rawStatus.replace(/<[^>]*>/g, '').trim();
    const cleanUpper = rawStatus.toUpperCase();
    if (cleanUpper === 'NEW' || cleanUpper.includes('NEW')) rawStatus = 'New';
    else if (cleanUpper === 'PENDING' || cleanUpper.includes('PENDING')) rawStatus = 'Pending';
    else if (cleanUpper === 'PROCESSING' || cleanUpper.includes('PROCESSING')) rawStatus = 'Processing';
    else if (cleanUpper === 'DELIVERED' || cleanUpper.includes('DELIVERED')) rawStatus = 'Delivered';
    else if (cleanUpper === 'CANCELLED' || cleanUpper.includes('CANCEL')) rawStatus = 'Cancelled';
  }
  const status = rawStatus || 'Unknown';

  // Extract merchant / account / affiliate
  const merchantCode = String(
    rawOrder.merchant_code ||
    rawOrder.merchant_id ||
    rawOrder.merchant_key ||
    rawOrder.client_code ||
    rawOrder.affiliate_code ||
    rawOrder.affiliate_id ||
    rawOrder['كود التاجر'] ||
    rawOrder['كود_التاجر'] ||
    ''
  ).trim();

  const account = String(
    rawOrder.merchant_name ||
    rawOrder.merchant ||
    rawOrder.account_name ||
    rawOrder.account ||
    rawOrder.affiliate_name ||
    rawOrder.affiliate ||
    rawOrder.client ||
    rawOrder['اسم التاجر'] ||
    rawOrder['اسم_التاجر'] ||
    'Unassigned'
  ).trim();

  // Extract creation / business date (preserve original creation date)
  const rawCreatedAt = rawOrder.created_at || rawOrder.order_date || rawOrder.date || rawOrder.created || null;
  let sourceDateStr = null;
  if (rawCreatedAt) {
    try {
      const d = new Date(rawCreatedAt);
      if (!isNaN(d.getTime())) {
        sourceDateStr = d.toISOString().slice(0, 10);
      } else if (typeof rawCreatedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(rawCreatedAt)) {
        sourceDateStr = rawCreatedAt.slice(0, 10);
      }
    } catch {
      sourceDateStr = null;
    }
  }
  if (!sourceDateStr && rawOrder.chipping) {
    try {
      const d = new Date(rawOrder.chipping);
      if (!isNaN(d.getTime())) {
        sourceDateStr = d.toISOString().slice(0, 10);
      } else if (typeof rawOrder.chipping === 'string' && /^\d{4}-\d{2}-\d{2}/.test(rawOrder.chipping)) {
        sourceDateStr = rawOrder.chipping.slice(0, 10);
      }
    } catch {
      sourceDateStr = null;
    }
  }

  // Active status classification: Only New and Pending are active workload items
  const cleanStatusLower = (status || '').toLowerCase();
  const isOrderActive = ['new', 'pending', 'جديد', 'معلق'].includes(cleanStatusLower);

  // Extract customer and destination
  const city = String(rawOrder.governrate_name || rawOrder.city || rawOrder.governorate || rawOrder.zone || '').trim();
  const totalPrice = parseFloat(rawOrder.grand_total || rawOrder.total || rawOrder.price || rawOrder.total_price || 0) || 0;

  return {
    order_code: orderCode,
    status,
    account,
    merchant_code: merchantCode || null,
    date: sourceDateStr,
    source_date: sourceDateStr,
    created_at: rawOrder.created_at || null,
    created_at_original: rawOrder.created_at || null,
    is_active: isOrderActive ? 1 : 0,
    city,
    total_price: totalPrice,
    raw_source: {
      client_name: rawOrder.full_name || rawOrder.client_name || rawOrder.customer_name || null,
      phone: rawOrder.phone || null,
      alt_phone: rawOrder.alt_phone || null
    }
  };
}

/**
 * Normalizes a single row from Vendoor Activity / Logs export (HTML, CSV, JSON)
 */
export function normalizeVendoorLogRow(rawRow) {
  if (!rawRow || typeof rawRow !== 'object') return null;

  // Identify keys case-insensitively, supporting Arabic and English headers
  const findValue = (possibleKeys) => {
    for (const key of Object.keys(rawRow)) {
      const trimmedKey = key.trim().toLowerCase();
      for (const pk of possibleKeys) {
        if (trimmedKey === pk.trim().toLowerCase()) {
          return rawRow[key];
        }
      }
    }
    // Also try stripping common punctuation/spaces without stripping unicode/Arabic letters
    for (const key of Object.keys(rawRow)) {
      const cleanKey = key.trim().toLowerCase().replace(/[\s_\-#:\.\(\)]/g, '');
      for (const pk of possibleKeys) {
        const cleanPk = pk.trim().toLowerCase().replace(/[\s_\-#:\.\(\)]/g, '');
        if (cleanKey === cleanPk) {
          return rawRow[key];
        }
      }
    }
    return null;
  };

  // Find Employee Name (supporting real Vendoor Arabic 'الاسم')
  const empCandidate = String(
    findValue([
      'الاسم', 'اسم الموظف', 'الموظف', 'المستخدم', 'اسم المستخدم',
      'User', 'Employee', 'Agent', 'Created By', 'Admin', 'Employee Name', 'user_name', 'username'
    ]) || ''
  ).trim();

  // Find Order Code (supporting real Vendoor Arabic 'كود الطلب')
  const codeCandidate = String(
    findValue([
      'كود الطلب', 'كود الاوردر', 'رقم الاوردر', 'كود_الطلب', 'رقم الطلب', 'الاوردر',
      'Order Code', 'Order ID', 'Code', 'Order', 'order_code', 'reference', 'tracking_number'
    ]) || ''
  ).trim();

  // Find Action Description (supporting real Vendoor Arabic 'الاكشن')
  const actionCandidate = String(
    findValue([
      'الاكشن', 'العملية', 'الحدث', 'الحالة', 'نوع العملية', 'نوع الاكشن',
      'Action', 'Status', 'Event', 'Action Type', 'Operation', 'Title', 'activity'
    ]) || 'Action Recorded'
  ).trim();

  // Find Timestamp / Date (supporting real Vendoor Arabic 'التاريخ')
  const dateCandidate = findValue([
    'التاريخ', 'تاريخ', 'وقت', 'الوقت', 'تاريخ العملية',
    'Date', 'Timestamp', 'Created At', 'Time', 'created_at', 'date_time'
  ]);
  let timestampStr = null;
  let dateStr = null;

  if (dateCandidate) {
    const s = String(dateCandidate).trim();
    if (s) {
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        dateStr = s.slice(0, 10);
        timestampStr = s;
      } else {
        const d = new Date(s);
        if (!isNaN(d.getTime())) {
          timestampStr = d.toISOString();
          dateStr = timestampStr.slice(0, 10);
        } else {
          timestampStr = s;
        }
      }
    }
  }

  if (!codeCandidate && !empCandidate) return null;

  return {
    employee_name: empCandidate || 'Unknown Agent',
    order_code: codeCandidate || 'UNKNOWN',
    action: actionCandidate,
    timestamp: timestampStr,
    date: dateStr,
    source_fields: Object.keys(rawRow).slice(0, 6)
  };
}

/**
 * Resolves the operational business date for a given timestamp
 */
export function getOperationalBusinessDate(timestampStr) {
  if (!timestampStr) return { business_date: new Date().toISOString().slice(0, 10) };
  try {
    const s = String(timestampStr).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      return { business_date: s.slice(0, 10) };
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      return { business_date: d.toISOString().slice(0, 10) };
    }
  } catch {
    // ignore
  }
  return { business_date: new Date().toISOString().slice(0, 10) };
}

/**
 * Generate aggregate summary metrics from normalized log items
 */
export function summarizeNormalizedLogs(logs = []) {
  const totalRows = logs.length;
  const employeesSet = new Set();
  const orderCodesSet = new Set();
  const actionsCountMap = {};
  let minDate = null;
  let maxDate = null;
  let minTimestamp = null;
  let maxTimestamp = null;

  for (const log of logs) {
    if (log.employee_name) employeesSet.add(log.employee_name);
    if (log.order_code) orderCodesSet.add(log.order_code);

    const act = log.action || 'Unknown';
    actionsCountMap[act] = (actionsCountMap[act] || 0) + 1;

    if (log.date) {
      if (!minDate || log.date < minDate) minDate = log.date;
      if (!maxDate || log.date > maxDate) maxDate = log.date;
    }

    if (log.timestamp) {
      if (!minTimestamp || log.timestamp < minTimestamp) minTimestamp = log.timestamp;
      if (!maxTimestamp || log.timestamp > maxTimestamp) maxTimestamp = log.timestamp;
    }
  }

  return {
    total_rows: totalRows,
    unique_employees_count: employeesSet.size,
    employees_sample: Array.from(employeesSet).slice(0, 10),
    unique_orders_count: orderCodesSet.size,
    order_codes_sample: Array.from(orderCodesSet).slice(0, 5),
    top_actions: Object.entries(actionsCountMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([action, count]) => ({ action, count })),
    date_range: {
      min_date: minDate,
      max_date: maxDate,
      min_timestamp: minTimestamp,
      max_timestamp: maxTimestamp
    }
  };
}
