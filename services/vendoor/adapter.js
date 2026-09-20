/**
 * Vendoor Data Source Adapter Interface (Autonomous Live & Mock Operations)
 *
 * Pattern:
 * VendoorDataSource (Abstract Interface)
 * ├── LiveVendoorDataSource (Real HTTP requests against authenticated Vendoor)
 * └── MockVendoorDataSource (Deterministic mock data for development & tests)
 */

import { fetchVendoorOrdersPage, fetchAllVendoorOrders } from './orders.js';
import { exportAndParseVendoorOrders, mapStatusToCategoryId } from './export_sync.js';
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
  mode = 'LIVE';

  async getStatus() {
    return {
      mode: 'LIVE',
      ...getSafeVendoorStatus()
    };
  }

  async fetchOrders(options = {}) {
    // When export mode is requested or for full dataset sync with real merchant names
    if (options.useExport !== false && (options.fetchAll || options.useExport === true || !options.start)) {
      try {
        const catId = mapStatusToCategoryId(options.statusFilter);
        const exportRes = await exportAndParseVendoorOrders(catId, options);
        return {
          success: true,
          resource: 'orders',
          pages_fetched: exportRes.pagesFetched,
          total_records: exportRes.uniqueOrdersCount,
          total_orders: exportRes.uniqueOrdersCount,
          reported_total: exportRes.reportedTotal,
          reported_filtered: exportRes.reportedFiltered,
          exported_rows_count: exportRes.exportedRowsCount,
          duplicate_rows_count: exportRes.duplicateRowsCount,
          pagination: {
            start: 0,
            length: exportRes.uniqueOrdersCount,
            records_total: exportRes.reportedTotal,
            records_filtered: exportRes.reportedFiltered
          },
          summary: {
            received_orders_count: exportRes.uniqueOrdersCount,
            unique_accounts_count: new Set(exportRes.orders.map(o => o.account)).size
          },
          orders: exportRes.orders,
          orders_sample: exportRes.orders.slice(0, 10)
        };
      } catch (err) {
        console.warn('[LiveVendoorDataSource] Export flow warning, falling back to paginated orders:', err.message);
      }
    }

    if (options.fetchAll) {
      return await fetchAllVendoorOrders(options);
    }
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
  mode = 'MOCK';

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
    const length = parseInt(options.length || options.pageSize, 10) || 300;
    const fromDate = options.fromDate || '2026-03-01';
    const toDate = options.toDate || '2026-03-02';
    const statusFilter = options.statusFilter || '';

    // Accounts and cities for realistic pool generation
    const accounts = ['Vendoor Express', 'Alpha Merchant', 'Beta Logistics', 'Delta Direct', 'Gamma Trade'];
    const cities = ['Cairo', 'Giza', 'Alexandria', 'Mansoura', 'Tanta', 'Suez'];

    // Generate pool matching required pagination test scenario:
    // 350 NEW orders, 620 PENDING orders (970 total)
    const mockPool = [];

    // 350 NEW orders
    for (let i = 1; i <= 350; i++) {
      const padId = String(100000 + i);
      const acc = accounts[(i - 1) % accounts.length];
      const city = cities[(i - 1) % cities.length];
      const d = (i % 2 === 0) ? toDate : fromDate;
      mockPool.push({
        order_code: `VD-NEW-${padId}`,
        status: 'New',
        account: acc,
        date: d,
        city,
        total_price: 120 + ((i * 19) % 650)
      });
    }

    // 620 PENDING orders
    for (let i = 1; i <= 620; i++) {
      const padId = String(200000 + i);
      const acc = accounts[(i - 1) % accounts.length];
      const city = cities[(i - 1) % cities.length];
      const d = (i % 2 === 0) ? toDate : fromDate;
      mockPool.push({
        order_code: `VD-PEN-${padId}`,
        status: 'Pending',
        account: acc,
        date: d,
        city,
        total_price: 150 + ((i * 23) % 750)
      });
    }

    let filtered = mockPool;
    if (statusFilter && statusFilter !== 'ALL') {
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
      duration_ms: 12,
      content_type: 'application/json',
      pagination: {
        start,
        length,
        page: Math.floor(start / length) + 1,
        page_size: length,
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
      orders_sample: pageSlice,
      orders: pageSlice
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

    const employees = ['Ahmed Hassan', 'Sara Mahmoud', 'Mohamed Ali', 'Nour Ibrahim', 'Khaled Omar'];
    const actions = ['Order Printed', 'Status Updated: Pending', 'Alt Phone Added', 'Confirmed with Customer'];

    const mockLogs = [];
    const sDate = new Date(startDate + 'T00:00:00Z');
    const eDate = new Date(endDate + 'T00:00:00Z');

    let curr = new Date(sDate.getTime());
    let counter = 100;
    while (curr <= eDate) {
      const dStr = curr.toISOString().slice(0, 10);
      for (let j = 0; j < 6; j++) {
        counter++;
        const emp = employees[j % employees.length];
        const act = actions[j % actions.length];
        mockLogs.push({
          employee_name: emp,
          order_code: `VD-${counter}`,
          action: act,
          date: dStr,
          timestamp: `${dStr}T09:${String(10 + (j * 8)).padStart(2, '0')}:00.000Z`
        });
      }
      curr.setUTCDate(curr.getUTCDate() + 1);
    }

    const summary = summarizeNormalizedLogs(mockLogs);

    return {
      success: true,
      resource: 'logs',
      adapter: 'MOCK',
      http_status: 200,
      duration_ms: 18,
      content_type: 'application/vnd.ms-excel (mocked)',
      file_size_bytes: mockLogs.length * 200,
      requested_range: {
        start_date: startDate,
        end_date: endDate
      },
      summary,
      sample_rows: mockLogs.slice(0, 10),
      logs: mockLogs
    };
  }
}

/**
 * Factory to obtain the active VendoorDataSource instance
 */
export function getVendoorDataSource(forceMode = null) {
  const cfg = getVendoorConfig();
  const mode = forceMode || (cfg.mockMode ? 'mock' : 'live');

  const isTestEnv = process.env.NODE_ENV === 'test' || 
    process.env.npm_lifecycle_event?.includes('test') || 
    process.argv.some(arg => arg.includes('test'));

  if (mode === 'mock' && !isTestEnv) {
    throw new Error('MOCK_ADAPTER_DISALLOWED: Mock data source is strictly forbidden in production / non-test environments.');
  }

  if (mode === 'mock') {
    return new MockVendoorDataSource();
  }
  return new LiveVendoorDataSource();
}
