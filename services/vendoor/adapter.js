/**
 * Vendoor Data Source Adapter Interface (Phase 1 Access Proof)
 *
 * Pattern:
 * VendoorDataSource (Abstract Interface)
 * ├── LiveVendoorDataSource (Real HTTP requests against authenticated Vendoor)
 * └── MockVendoorDataSource (Deterministic mock data for development & tests)
 */

import { fetchVendoorOrdersPage } from './orders.js';
import { fetchVendoorLogsRange, isValidISODate } from './logs.js';
import { getVendoorConfig, getSafeVendoorStatus } from './auth.js';
import { summarizeNormalizedLogs } from './normalize.js';

/**
 * Base Abstract Interface
 */
export class VendoorDataSource {
  async getStatus() {
    throw new Error('getStatus() not implemented');
  }

  async fetchOrders(options = {}) {
    throw new Error('fetchOrders() not implemented');
  }

  async fetchLogs(options = {}) {
    throw new Error('fetchLogs() not implemented');
  }
}

/**
 * Live Data Source (Calls authenticated Vendoor endpoints)
 */
export class LiveVendoorDataSource extends VendoorDataSource {
  async getStatus() {
    return {
      mode: 'LIVE',
      ...getSafeVendoorStatus()
    };
  }

  async fetchOrders(options = {}) {
    return await fetchVendoorOrdersPage(options);
  }

  async fetchLogs(options = {}) {
    return await fetchVendoorLogsRange(options);
  }
}

/**
 * Mock Data Source (Deterministic responses for development, offline testing, CI)
 */
export class MockVendoorDataSource extends VendoorDataSource {
  async getStatus() {
    const safe = getSafeVendoorStatus();
    return {
      mode: 'MOCK',
      ...safe,
      mock_mode: true,
      auth_method: 'MOCK_ADAPTER'
    };
  }

  async fetchOrders(options = {}) {
    const start = parseInt(options.start, 10) || 0;
    const length = parseInt(options.length, 10) || 10;
    const fromDate = options.fromDate || '2026-03-01';
    const toDate = options.toDate || '2026-03-02';
    const statusFilter = options.statusFilter || '';

    const mockPool = [
      { order_code: 'VD-100234', status: 'New', account: 'Vendoor Express', date: fromDate, city: 'Cairo', total_price: 340 },
      { order_code: 'VD-100235', status: 'New', account: 'Vendoor Express', date: fromDate, city: 'Giza', total_price: 190 },
      { order_code: 'VD-100236', status: 'Pending', account: 'Alpha Merchant', date: fromDate, city: 'Alexandria', total_price: 520 },
      { order_code: 'VD-100237', status: 'Printed', account: 'Alpha Merchant', date: fromDate, city: 'Mansoura', total_price: 430 },
      { order_code: 'VD-100238', status: 'Cancelled', account: 'Beta Logistics', date: fromDate, city: 'Tanta', total_price: 260 },
      { order_code: 'VD-100239', status: 'New', account: 'Beta Logistics', date: fromDate, city: 'Cairo', total_price: 610 },
      { order_code: 'VD-100240', status: 'New', account: 'Vendoor Express', date: toDate, city: 'Giza', total_price: 150 },
      { order_code: 'VD-100241', status: 'Pending', account: 'Alpha Merchant', date: toDate, city: 'Suez', total_price: 380 },
      { order_code: 'VD-100242', status: 'New', account: 'Delta Direct', date: toDate, city: 'Cairo', total_price: 490 },
      { order_code: 'VD-100243', status: 'Printed', account: 'Delta Direct', date: toDate, city: 'Alexandria', total_price: 320 }
    ];

    let filtered = mockPool;
    if (statusFilter) {
      filtered = filtered.filter(o => o.status.toLowerCase() === statusFilter.toLowerCase());
    }

    const pageSlice = filtered.slice(start, start + length);
    const accountsSet = new Set(pageSlice.map(o => o.account));
    const statusesSet = new Set(pageSlice.map(o => o.status));

    return {
      success: true,
      resource: 'orders',
      adapter: 'MOCK',
      http_status: 200,
      duration_ms: 24,
      content_type: 'application/json',
      pagination: {
        start,
        length,
        page_records_count: pageSlice.length,
        records_total: mockPool.length,
        records_filtered: filtered.length
      },
      filter_applied: {
        from_date: fromDate,
        to_date: toDate,
        status: statusFilter || null,
        search: options.search || null
      },
      summary: {
        received_orders_count: pageSlice.length,
        unique_accounts_count: accountsSet.size,
        accounts_sample: Array.from(accountsSet),
        statuses_sample: Array.from(statusesSet),
        sample_order_codes: pageSlice.map(o => o.order_code)
      },
      orders_sample: pageSlice
    };
  }

  async fetchLogs(options = {}) {
    const startDate = options.startDate || options.start_date || '2026-03-01';
    const endDate = options.endDate || options.end_date || startDate;

    if (!isValidISODate(startDate) || !isValidISODate(endDate)) {
      throw new Error('Invalid date format. Must be YYYY-MM-DD.');
    }
    if (startDate > endDate) {
      throw new Error(`startDate "${startDate}" cannot be after endDate "${endDate}".`);
    }

    const startMs = new Date(startDate).getTime();
    const endMs = new Date(endDate).getTime();
    const diffDays = Math.round((endMs - startMs) / (1000 * 60 * 60 * 24)) + 1;
    if (diffDays > 2) {
      throw new Error(`Phase 1 access test is restricted to a maximum of 2 days range. Requested ${diffDays} days (${startDate} to ${endDate}).`);
    }

    const sampleMockLogs = [
      { employee_name: 'Ahmed Hassan', order_code: 'VD-100234', action: 'Order Printed', date: startDate, timestamp: `${startDate}T09:15:22.000Z` },
      { employee_name: 'Ahmed Hassan', order_code: 'VD-100235', action: 'Status Updated: Pending', date: startDate, timestamp: `${startDate}T09:22:10.000Z` },
      { employee_name: 'Sara Mahmoud', order_code: 'VD-100236', action: 'Alt Phone Added', date: startDate, timestamp: `${startDate}T09:45:00.000Z` },
      { employee_name: 'Sara Mahmoud', order_code: 'VD-100237', action: 'Order Printed', date: startDate, timestamp: `${startDate}T10:05:14.000Z` },
      { employee_name: 'Mohamed Ali', order_code: 'VD-100238', action: 'Cancelled by Customer', date: startDate, timestamp: `${startDate}T10:30:45.000Z` },
      { employee_name: 'Nour Ibrahim', order_code: 'VD-100239', action: 'Order Printed', date: startDate, timestamp: `${startDate}T11:12:00.000Z` },
      { employee_name: 'Ahmed Hassan', order_code: 'VD-100240', action: 'Order Printed', date: endDate, timestamp: `${endDate}T09:05:00.000Z` },
      { employee_name: 'Sara Mahmoud', order_code: 'VD-100241', action: 'Status Updated: Pending', date: endDate, timestamp: `${endDate}T09:30:00.000Z` },
      { employee_name: 'Mohamed Ali', order_code: 'VD-100242', action: 'Order Printed', date: endDate, timestamp: `${endDate}T10:15:00.000Z` }
    ];

    const logsInRange = sampleMockLogs.filter(l => l.date >= startDate && l.date <= endDate);
    const summary = summarizeNormalizedLogs(logsInRange);

    return {
      success: true,
      resource: 'logs',
      adapter: 'MOCK',
      http_status: 200,
      duration_ms: 18,
      content_type: 'application/vnd.ms-excel (mocked)',
      file_size_bytes: 4096,
      requested_range: {
        start_date: startDate,
        end_date: endDate
      },
      summary,
      sample_rows: logsInRange
    };
  }
}

/**
 * Factory to obtain the active VendoorDataSource instance
 */
export function getVendoorDataSource(forceMode = null) {
  const cfg = getVendoorConfig();
  const mode = forceMode || (cfg.mockMode ? 'mock' : 'live');

  if (mode === 'mock') {
    return new MockVendoorDataSource();
  }
  return new LiveVendoorDataSource();
}
