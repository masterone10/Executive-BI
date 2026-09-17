/**
 * Neutral Data Normalizer for Vendoor Payloads (Autonomous Operations)
 *
 * Responsibilities:
 * - Safely normalize raw Vendoor Order objects to standard metadata
 * - Safely normalize raw Vendoor Log rows to standard log items
 * - Strict isolation: Never creates DB employees, never modifies Smart Allocation rules.
 */

/**
 * Normalizes an individual order item from Vendoor order tables
 */
export function normalizeVendoorOrder(rawOrder) {
  if (!rawOrder || typeof rawOrder !== 'object') return null;

  // Extract order code / ID
  const orderCode = String(
    rawOrder.order_code ||
    rawOrder.code ||
    rawOrder.id ||
    rawOrder.order_id ||
    rawOrder.reference ||
    ''
  ).trim();

  if (!orderCode) return null;

  // Extract status
  const status = String(
    rawOrder.status_name ||
    rawOrder.status ||
    rawOrder.order_status ||
    rawOrder.state ||
    'Unknown'
  ).trim();

  // Extract merchant / account / affiliate
  const account = String(
    rawOrder.merchant_name ||
    rawOrder.merchant ||
    rawOrder.account_name ||
    rawOrder.account ||
    rawOrder.affiliate_name ||
    rawOrder.affiliate ||
    rawOrder.client ||
    'Unassigned'
  ).trim();

  // Extract creation / business date
  const rawDate = rawOrder.created_at || rawOrder.date || rawOrder.order_date || rawOrder.created || null;
  let dateStr = null;
  if (rawDate) {
    try {
      const d = new Date(rawDate);
      if (!isNaN(d.getTime())) {
        dateStr = d.toISOString().slice(0, 10);
      } else if (typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
        dateStr = rawDate.slice(0, 10);
      }
    } catch {
      dateStr = null;
    }
  }

  // Extract customer and destination
  const city = String(rawOrder.city || rawOrder.governorate || rawOrder.zone || '').trim();
  const totalPrice = parseFloat(rawOrder.grand_total || rawOrder.total || rawOrder.price || rawOrder.total_price || 0) || 0;

  return {
    order_code: orderCode,
    status,
    account,
    date: dateStr,
    city,
    total_price: totalPrice,
    raw_source: {
      client_name: rawOrder.client_name || rawOrder.customer_name || null,
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

  // Identify keys case-insensitively
  const findValue = (possibleKeys) => {
    for (const key of Object.keys(rawRow)) {
      const clean = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      for (const pk of possibleKeys) {
        if (clean === pk.toLowerCase().replace(/[^a-z0-9]/g, '')) {
          return rawRow[key];
        }
      }
    }
    return null;
  };

  // Find Employee Name
  const empCandidate = String(
    findValue(['User', 'Employee', 'Agent', 'Created By', 'Admin', 'Employee Name', 'user_name', 'username']) || ''
  ).trim();

  // Find Order Code
  const codeCandidate = String(
    findValue(['Order Code', 'Order ID', 'Code', 'Order', 'order_code', 'reference', 'tracking_number']) || ''
  ).trim();

  // Find Action Description
  const actionCandidate = String(
    findValue(['Action', 'Status', 'Event', 'Action Type', 'Operation', 'Title', 'activity']) || 'Action Recorded'
  ).trim();

  // Find Timestamp / Date
  const dateCandidate = findValue(['Date', 'Timestamp', 'Created At', 'Time', 'created_at', 'date_time']);
  let timestampStr = null;
  let dateStr = null;

  if (dateCandidate) {
    const s = String(dateCandidate).trim();
    if (s) {
      const d = new Date(s);
      if (!isNaN(d.getTime())) {
        timestampStr = d.toISOString();
        dateStr = timestampStr.slice(0, 10);
      } else if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        dateStr = s.slice(0, 10);
        timestampStr = s;
      } else {
        timestampStr = s;
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
