/**
 * Vendoor Orders Connector (Phase 1 Access Proof)
 *
 * Responsibilities:
 * - Fetch small pages of orders from authenticated Vendoor endpoints
 * - Supports DataTables parameters & date range filters
 * - Handles JSON and DataTables response formats
 * - Extracts safe metadata & metrics without persisting or triggering allocation
 */

import { vendoorFetch, VendoorClientError } from './client.js';
import { normalizeVendoorOrder } from './normalize.js';

/**
 * Fetch a small page of orders from Vendoor
 *
 * @param {Object} options
 * @param {number} [options.start=0]
 * @param {number} [options.length=10]
 * @param {string} [options.fromDate] YYYY-MM-DD
 * @param {string} [options.toDate] YYYY-MM-DD
 * @param {string} [options.statusFilter]
 * @param {string} [options.search]
 */
export async function fetchVendoorOrdersPage(options = {}) {
  const start = Math.max(0, parseInt(options.start, 10) || 0);
  const length = Math.min(100, Math.max(1, parseInt(options.length, 10) || 10));
  const fromDate = options.fromDate || '';
  const toDate = options.toDate || '';
  const statusFilter = options.statusFilter || '';
  const search = options.search || '';

  const queryParams = new URLSearchParams({
    draw: '1',
    start: String(start),
    length: String(length)
  });

  if (fromDate) queryParams.set('from_date', fromDate);
  if (toDate) queryParams.set('to_date', toDate);
  if (statusFilter) queryParams.set('status', statusFilter);
  if (search) queryParams.set('search[value]', search);

  const endpoint = `/dashboard/orders?${queryParams.toString()}`;

  const { response, durationMs, contentType, status } = await vendoorFetch(endpoint, {
    method: 'GET',
    headers: {
      'Accept': 'application/json, text/javascript, */*; q=0.01'
    }
  });

  // Verify response type
  const text = await response.text();
  let parsedJson = null;

  try {
    parsedJson = JSON.parse(text);
  } catch {
    // If response is HTML, it likely is a login page or error screen
    if (text.includes('<html') || text.includes('<!DOCTYPE') || text.includes('login')) {
      throw new VendoorClientError(
        'Vendoor returned an HTML page instead of JSON. Authentication cookie or session may be invalid or expired.',
        401,
        'HTML_LOGIN_REDIRECT',
        { durationMs, preview: text.slice(0, 200) }
      );
    }
    throw new VendoorClientError(
      'Failed to parse Vendoor orders response as JSON.',
      502,
      'INVALID_JSON_RESPONSE',
      { durationMs, preview: text.slice(0, 200) }
    );
  }

  // Extract array of records from DataTables structure or raw array
  let rawRecords = [];
  let recordsTotal = null;
  let recordsFiltered = null;

  if (Array.isArray(parsedJson)) {
    rawRecords = parsedJson;
    recordsTotal = parsedJson.length;
    recordsFiltered = parsedJson.length;
  } else if (parsedJson && Array.isArray(parsedJson.data)) {
    rawRecords = parsedJson.data;
    recordsTotal = parsedJson.recordsTotal !== undefined ? parsedJson.recordsTotal : rawRecords.length;
    recordsFiltered = parsedJson.recordsFiltered !== undefined ? parsedJson.recordsFiltered : rawRecords.length;
  } else if (parsedJson && Array.isArray(parsedJson.orders)) {
    rawRecords = parsedJson.orders;
    recordsTotal = rawRecords.length;
    recordsFiltered = rawRecords.length;
  } else {
    // Check if empty object or unexpected structure
    rawRecords = [];
  }

  const normalizedOrders = rawRecords.map(normalizeVendoorOrder).filter(Boolean);

  const accountsSet = new Set();
  const statusesSet = new Set();
  for (const ord of normalizedOrders) {
    if (ord.account) accountsSet.add(ord.account);
    if (ord.status) statusesSet.add(ord.status);
  }

  return {
    success: true,
    resource: 'orders',
    http_status: status,
    duration_ms: durationMs,
    content_type: contentType,
    pagination: {
      start,
      length,
      page_records_count: normalizedOrders.length,
      records_total: recordsTotal,
      records_filtered: recordsFiltered
    },
    filter_applied: {
      from_date: fromDate || null,
      to_date: toDate || null,
      status: statusFilter || null,
      search: search || null
    },
    summary: {
      received_orders_count: normalizedOrders.length,
      unique_accounts_count: accountsSet.size,
      accounts_sample: Array.from(accountsSet).slice(0, 5),
      statuses_sample: Array.from(statusesSet).slice(0, 5),
      sample_order_codes: normalizedOrders.slice(0, 5).map(o => o.order_code)
    },
    orders_sample: normalizedOrders.slice(0, 10)
  };
}
