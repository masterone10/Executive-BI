/**
 * Neutral Data Normalizer for Vendoor Payloads (Phase 1 Access Proof)
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

  // Extract customer / city if present
  const city = String(rawOrder.city || rawOrder.governorate || rawOrder.zone || '').trim();
  const totalPrice = Number(rawOrder.total_price || rawOrder.total || rawOrder.price || 0) || 0;

  return {
    order_code: orderCode,
    status,
    account,
    date: dateStr,
    city: city || null,
    total_price: totalPrice,
    raw_keys_sample: Object.keys(rawOrder).slice(0, 8)
  };
}

/**
 * Normalizes an individual log row from Vendoor export worksheets
 */
export function normalizeVendoorLogRow(rawRow) {
  if (!rawRow || typeof rawRow !== 'object') return null;

  // Extract candidate employee name
  const empCandidate = String(
    rawRow['الاسم'] ||
    rawRow['اسم الموظف'] ||
    rawRow['الموظف'] ||
    rawRow['اسم المستخدم'] ||
    rawRow['المستخدم'] ||
    rawRow['Employee'] ||
    rawRow['employee'] ||
    rawRow['User'] ||
    rawRow['user'] ||
    rawRow['User Name'] ||
    rawRow['user_name'] ||
    rawRow['Agent'] ||
    rawRow['agent'] ||
    rawRow['Created By'] ||
    rawRow['created_by'] ||
    rawRow['Name'] ||
    rawRow['name'] ||
    rawRow['action_by'] ||
    ''
  ).trim();

  // Extract order code
  const codeCandidate = String(
    rawRow['كود الطلب'] ||
    rawRow['كود الاوردر'] ||
    rawRow['رقم الاوردر'] ||
    rawRow['رقم الطلب'] ||
    rawRow['Order Code'] ||
    rawRow['order_code'] ||
    rawRow['Code'] ||
    rawRow['code'] ||
    rawRow['Order ID'] ||
    rawRow['order_id'] ||
    rawRow['Order'] ||
    rawRow['order'] ||
    ''
  ).trim();

  // Extract action / status
  const actionCandidate = String(
    rawRow['الاكشن'] ||
    rawRow['الإجراء'] ||
    rawRow['الاجراء'] ||
    rawRow['الحالة'] ||
    rawRow['حالة الطلب'] ||
    rawRow['Action'] ||
    rawRow['action'] ||
    rawRow['Status'] ||
    rawRow['status'] ||
    rawRow['Event'] ||
    rawRow['event'] ||
    rawRow['Operation'] ||
    rawRow['operation'] ||
    rawRow['Note'] ||
    rawRow['note'] ||
    'Action Recorded'
  ).trim();

  // Extract timestamp
  const rawTs =
    rawRow['التاريخ'] ||
    rawRow['تاريخ الاكشن'] ||
    rawRow['الوقت'] ||
    rawRow['Timestamp'] ||
    rawRow['timestamp'] ||
    rawRow['Created At'] ||
    rawRow['created_at'] ||
    rawRow['Date'] ||
    rawRow['date'] ||
    rawRow['Time'] ||
    rawRow['time'] ||
    null;

  let timestampStr = null;
  let dateStr = null;

  if (rawTs) {
    if (typeof rawTs === 'number') {
      // Excel serial date format or epoch ms
      if (rawTs > 1000000000000) {
        const d = new Date(rawTs);
        timestampStr = d.toISOString();
        dateStr = timestampStr.slice(0, 10);
      } else {
        // Excel serial days
        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
        const d = new Date(excelEpoch.getTime() + rawTs * 86400000);
        timestampStr = d.toISOString();
        dateStr = timestampStr.slice(0, 10);
      }
    } else {
      const s = String(rawTs).trim();
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
