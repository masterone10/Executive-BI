/**
 * Vendoor Orders Connector (Autonomous Pagination & Complete Dataset Retrieval)
 *
 * Responsibilities:
 * - Fetch paginated and full datasets of orders from authenticated Vendoor endpoints
 * - Supports DataTables parameters & date range filters
 * - Handles JSON and DataTables response formats
 * - Removes artificial 50-order business cap by automating multi-page retrieval
 * - Extracts safe metadata & metrics
 */

import { vendoorFetch, VendoorClientError } from './client.js';
import { normalizeVendoorOrder } from './normalize.js';
import { getVendoorConfig } from './auth.js';

/**
 * Fetch a single page of orders from Vendoor
 *
 * @param {Object} options
 * @param {number} [options.start=0]
 * @param {number} [options.length=50]
 * @param {string} [options.fromDate] YYYY-MM-DD
 * @param {string} [options.toDate] YYYY-MM-DD
 * @param {string} [options.statusFilter]
 * @param {string} [options.search]
 */
export async function fetchVendoorOrdersPage(options = {}) {
  const cfg = getVendoorConfig();
  if (options.forceMode === 'mock' || cfg.mockMode) {
    const { MockVendoorDataSource } = await import('./adapter.js');
    return new MockVendoorDataSource().fetchOrders(options);
  }

  const start = Math.max(0, parseInt(options.start, 10) || 0);
  const length = Math.min(300, Math.max(1, parseInt(options.length, 10) || 300));
  const fromDate = options.fromDate || '';
  const toDate = options.toDate || '';
  const statusFilter = options.statusFilter || '';
  const search = options.search || '';

  const pageNum = Math.floor(start / length) + 1;
  const queryParams = new URLSearchParams({
    draw: String(pageNum),
    start: String(start),
    length: String(length),
    page: String(pageNum),
    page_size: String(length),
    per_page: String(length),
    limit: String(length)
  });

  if (fromDate) queryParams.set('from_date', fromDate);
  if (toDate) queryParams.set('to_date', toDate);
  
  if (statusFilter) {
    let mappedStatus = statusFilter;
    if (typeof statusFilter === 'string') {
      const lowerStatus = statusFilter.toLowerCase();
      if (lowerStatus === 'new') mappedStatus = '1';
      else if (lowerStatus === 'pending') mappedStatus = '3';
      else if (lowerStatus === 'printed') mappedStatus = '13';
      else if (lowerStatus === 'canceled' || lowerStatus === 'cancelled') mappedStatus = '12';
      else if (lowerStatus === 'shipped') mappedStatus = '4';
      else if (lowerStatus === 'partial delivery') mappedStatus = '5';
      else if (lowerStatus === 'delivered') mappedStatus = '8';
      else if (lowerStatus === 'collected') mappedStatus = '9';
    }
    queryParams.set('status_filter', mappedStatus);
    queryParams.set('status_id', mappedStatus);
    queryParams.set('status', mappedStatus);
    queryParams.set('order_status', mappedStatus);
  }
  
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
    orders_sample: normalizedOrders.slice(0, 10),
    orders: normalizedOrders
  };
}

/**
 * Fetch all available orders across all pages automatically (No manual pagination required)
 *
 * @param {Object} options
 * @param {number} [options.pageSize=50] Records per page request
 * @param {number} [options.maxPages=50] Safeguard against infinite pagination (max 2500+ orders)
 * @param {string} [options.fromDate] YYYY-MM-DD
 * @param {string} [options.toDate] YYYY-MM-DD
 * @param {string} [options.statusFilter]
 * @param {string} [options.search]
 */
export async function fetchAllVendoorOrders(options = {}) {
  const pageSize = Math.min(300, Math.max(10, parseInt(options.pageSize, 10) || 300));
  const maxPages = Math.min(100, Math.max(1, parseInt(options.maxPages, 10) || 50));

  // If statusFilter is an array (e.g. ['NEW', 'PENDING']), fetch each status completely
  if (Array.isArray(options.statusFilter) && options.statusFilter.length > 1) {
    const combinedOrders = [];
    const seenCodes = new Set();
    let totalPages = 0;
    let totalDuration = 0;
    let maxReported = 0;

    for (const sf of options.statusFilter) {
      const subRes = await fetchAllVendoorOrders({
        ...options,
        statusFilter: sf
      });
      totalPages += subRes.pages_fetched || 0;
      totalDuration += subRes.duration_ms || 0;
      if (subRes.reported_total > maxReported) maxReported = subRes.reported_total;

      for (const ord of (subRes.orders || [])) {
        if (ord.order_code && !seenCodes.has(ord.order_code)) {
          seenCodes.add(ord.order_code);
          combinedOrders.push(ord);
        }
      }
    }

    const accountsSet = new Set();
    const statusesSet = new Set();
    for (const ord of combinedOrders) {
      if (ord.account) accountsSet.add(ord.account);
      if (ord.status) statusesSet.add(ord.status);
    }

    return {
      success: true,
      resource: 'orders',
      pages_fetched: totalPages,
      total_records: combinedOrders.length,
      total_orders: combinedOrders.length,
      reported_total: maxReported,
      duration_ms: totalDuration,
      filter_applied: {
        from_date: options.fromDate || null,
        to_date: options.toDate || null,
        status: options.statusFilter,
        search: options.search || null
      },
      summary: {
        received_orders_count: combinedOrders.length,
        unique_accounts_count: accountsSet.size,
        accounts_sample: Array.from(accountsSet).slice(0, 10),
        statuses_sample: Array.from(statusesSet).slice(0, 10),
        sample_order_codes: combinedOrders.slice(0, 10).map(o => o.order_code)
      },
      orders_sample: combinedOrders.slice(0, 10),
      orders: combinedOrders
    };
  }

  const allOrders = [];
  const seenCodes = new Set();
  let pagesFetched = 0;
  let totalDurationMs = 0;
  let reportedTotal = null;
  let reportedFiltered = null;

  for (let page = 0; page < maxPages; page++) {
    const start = page * pageSize;
    const pageRes = await fetchVendoorOrdersPage({
      ...options,
      start,
      length: pageSize
    });

    pagesFetched++;
    totalDurationMs += pageRes.duration_ms || 0;

    if (pageRes.pagination?.records_total !== null && pageRes.pagination?.records_total !== undefined) {
      reportedTotal = pageRes.pagination.records_total;
    }
    if (pageRes.pagination?.records_filtered !== null && pageRes.pagination?.records_filtered !== undefined) {
      reportedFiltered = pageRes.pagination.records_filtered;
    }

    const pageOrders = pageRes.orders || pageRes.orders_sample || [];
    if (pageOrders.length === 0) {
      break;
    }

    for (const ord of pageOrders) {
      const code = ord.order_code;
      if (code && !seenCodes.has(code)) {
        seenCodes.add(code);
        allOrders.push(ord);
      }
    }

    // If page returned fewer orders than requested, we reached the end
    if (pageOrders.length < pageSize) {
      break;
    }

    // If we've collected the target count reported by DataTables
    const targetCount = (reportedFiltered !== null && reportedFiltered > 0) ? reportedFiltered : reportedTotal;
    if (targetCount !== null && targetCount > 0 && allOrders.length >= targetCount) {
      break;
    }

    // Polite throttle between pages
    await new Promise(r => setTimeout(r, 60));
  }

  const accountsSet = new Set();
  const statusesSet = new Set();
  for (const ord of allOrders) {
    if (ord.account) accountsSet.add(ord.account);
    if (ord.status) statusesSet.add(ord.status);
  }

  return {
    success: true,
    resource: 'orders',
    pages_fetched: pagesFetched,
    total_records: allOrders.length,
    total_orders: allOrders.length,
    reported_total: reportedTotal,
    duration_ms: totalDurationMs,
    filter_applied: {
      from_date: options.fromDate || null,
      to_date: options.toDate || null,
      status: options.statusFilter || null,
      search: options.search || null
    },
    summary: {
      received_orders_count: allOrders.length,
      unique_accounts_count: accountsSet.size,
      accounts_sample: Array.from(accountsSet).slice(0, 10),
      statuses_sample: Array.from(statusesSet).slice(0, 10),
      sample_order_codes: allOrders.slice(0, 10).map(o => o.order_code)
    },
    orders_sample: allOrders.slice(0, 10),
    orders: allOrders
  };
}
