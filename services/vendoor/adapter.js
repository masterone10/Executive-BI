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
import { fetchVendoorLogsRange, fetchVendoorLogsForDate, isValidISODate, canonicalWorkDate } from './logs.js';
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
        console.log('[LiveVendoorDataSource] Export flow notice, falling back to paginated orders:', err.message);
      }
    }

    if (options.fetchAll) {
      return await fetchAllVendoorOrders(options);
    }
    return await fetchVendoorOrdersPage(options);
  }

  async fetchLogs(options = {}) {
    const startDate = options.startDate || options.start_date || '';
    const endDate = options.endDate || options.end_date || startDate;
    if (startDate && endDate && startDate === endDate) {
      return await fetchVendoorLogsForDate(startDate, options);
    }
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
    const mockMarketers = [
      { name: 'محمد طارق', code: 'AFF-MT01' },
      { name: 'سارة السيد', code: 'AFF-SS02' },
      { name: 'أحمد خالد', code: 'AFF-AK03' },
      { name: 'كريم حسن', code: 'AFF-KH04' },
      { name: 'نور مصطفى', code: 'AFF-NM05' }
    ];

    // Generate pool matching required pagination test scenario:
    // 350 NEW orders, 620 PENDING orders (970 total)
    const mockPool = [];

    // 350 NEW orders
    for (let i = 1; i <= 350; i++) {
      const padId = String(100000 + i);
      const acc = accounts[(i - 1) % accounts.length];
      const city = cities[(i - 1) % cities.length];
      const d = (i % 2 === 0) ? toDate : fromDate;
      const mkt = mockMarketers[(i - 1) % mockMarketers.length];
      mockPool.push({
        order_code: `VD-NEW-${padId}`,
        status: 'New',
        account: acc,
        merchant_name: acc,
        merchant_code: `MERC-${100 + ((i - 1) % accounts.length)}`,
        'اسم المسوق': mkt.name,
        'الافيليت كود': mkt.code,
        marketer_name: mkt.name,
        affiliate_code: mkt.code,
        affiliate_name: mkt.name,
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
      const mkt = mockMarketers[(i - 1) % mockMarketers.length];
      mockPool.push({
        order_code: `VD-PEN-${padId}`,
        status: 'Pending',
        account: acc,
        merchant_name: acc,
        merchant_code: `MERC-${100 + ((i - 1) % accounts.length)}`,
        'اسم المسوق': mkt.name,
        'الافيليت كود': mkt.code,
        marketer_name: mkt.name,
        affiliate_code: mkt.code,
        affiliate_name: mkt.name,
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

    const employees = ['BASMA CS', 'MOHAMED OSAMA CS', 'Sanaa CS', 'Ahmed Hassan', 'Store Admin'];
    const actions = ['Order Printed', 'Status Updated: Pending', 'Alt Phone Added', 'Confirmed with Customer'];

    const mockLogs = [];
    const sDate = new Date(startDate + 'T00:00:00Z');
    const eDate = new Date(endDate + 'T00:00:00Z');

    let curr = new Date(sDate.getTime());
    let counter = 100;

    while (curr <= eDate) {
      const dStr = curr.toISOString().slice(0, 10);

      if (dStr === '2026-10-01') {
        // Deterministic canonical benchmark dataset for 2026-10-01
        let orderId = 1000;
        let minOffset = 0;
        const agentSpecs = [
          { name: 'BASMA CS', printed: 29, pending: 38, cancelled: 23, processing: 2, alt: 25, newOrders: 60 },
          { name: 'EMAN CS', printed: 49, pending: 5, cancelled: 12, processing: 2, alt: 18, newOrders: 50 },
          { name: 'MENNA ATEF CS', printed: 35, pending: 18, cancelled: 29, processing: 1, alt: 15, newOrders: 40 },
          { name: 'AHD CS', printed: 22, pending: 5, cancelled: 3, processing: 13, alt: 12, newOrders: 35 },
          { name: 'REEM ELSAEED CS', printed: 45, pending: 30, cancelled: 27, processing: 0, alt: 16, newOrders: 45 }
        ];

        let remPrinted = 811 - (29 + 49 + 35 + 22 + 45); // 631
        let remPending = 422 - (38 + 5 + 18 + 5 + 30);  // 326
        let remCancelled = 225 - (23 + 12 + 29 + 3 + 27); // 131
        let remProcessing = 57 - (2 + 2 + 1 + 13 + 0); // 39
        let remAlt = 242 - (25 + 18 + 15 + 12 + 16); // 156
        let remNew = 1041 - (60 + 50 + 40 + 35 + 45); // 811

        const otherCsAgents = [
          'Sanaa CS', 'MOHAMED OSAMA CS', 'Ali CS', 'Salwa Cs',
          'Alyaa CS', 'Sahar cs', 'Esraa Reda CS', 'Malak Abdelfattah CS', 'Menna Sherif cs',
          'Rania ahmed CS', 'Mostafa Ehab CS', 'Nourhan CS', 'Hagar CS', 'Dina CS'
        ];

        const numAgents = otherCsAgents.length;
        otherCsAgents.forEach((agentName, idx) => {
          const isLast = (idx === numAgents - 1);
          const p = isLast ? remPrinted : Math.floor(remPrinted / (numAgents - idx));
          remPrinted -= p;
          const pe = isLast ? remPending : Math.floor(remPending / (numAgents - idx));
          remPending -= pe;
          const c = isLast ? remCancelled : Math.floor(remCancelled / (numAgents - idx));
          remCancelled -= c;
          const pr = isLast ? remProcessing : Math.floor(remProcessing / (numAgents - idx));
          remProcessing -= pr;
          const a = isLast ? remAlt : Math.floor(remAlt / (numAgents - idx));
          remAlt -= a;
          const nw = isLast ? remNew : Math.floor(remNew / (numAgents - idx));
          remNew -= nw;

          agentSpecs.push({
            name: agentName,
            printed: p,
            pending: pe,
            cancelled: c,
            processing: pr,
            alt: a,
            newOrders: nw
          });
        });

        const day1001Logs = [];
        const pendingOrderCodes = [];
        const printedOrderCodes = [];

        for (const spec of agentSpecs) {
          const actions = [];
          for (let i = 0; i < spec.printed; i++) actions.push({ type: 'Printed', status: 'Printed', act: `عدل ${spec.name} حالة الطلب إلى 'Printed'` });
          for (let i = 0; i < spec.pending; i++) actions.push({ type: 'Pending', status: 'Pending', act: `عدل ${spec.name} حالة الطلب إلى 'Pending'` });
          for (let i = 0; i < spec.cancelled; i++) actions.push({ type: 'Cancelled', status: 'Cancelled', act: `عدل ${spec.name} حالة الطلب إلى 'Cancelled'` });
          for (let i = 0; i < spec.processing; i++) actions.push({ type: 'Processing', status: 'Processing', act: `عدل ${spec.name} حالة الطلب إلى 'Processing'` });

          for (const item of actions) {
            orderId++;
            let code = 'ORD-' + orderId;

            // Re-use order codes to establish multi-event order histories:
            // 144 Pending orders progress to Printed (latest = Printed) -> currentPendingBacklog = 422 - 144 = 278
            if (item.type === 'Pending' && pendingOrderCodes.length < 144) {
              pendingOrderCodes.push(code);
            } else if (item.type === 'Printed' && printedOrderCodes.length < 144 && pendingOrderCodes.length > printedOrderCodes.length) {
              code = pendingOrderCodes[printedOrderCodes.length];
              printedOrderCodes.push(code);
            }

            minOffset += 3;
            const h = String(9 + (Math.floor(minOffset / 3600) % 12)).padStart(2, '0');
            const m = String(Math.floor((minOffset % 3600) / 60)).padStart(2, '0');
            const s = String(minOffset % 60).padStart(2, '0');
            const baseTime = dStr + ' ' + h + ':' + m + ':' + s;

            day1001Logs.push({
              employee_name: spec.name,
              order_code: code,
              action: item.act,
              status: item.status,
              event_datetime: baseTime,
              timestamp: dStr + 'T' + h + ':' + m + ':' + s + '.000Z',
              date: dStr,
              is_cs: 1
            });
          }

          for (let i = 0; i < spec.alt; i++) {
            orderId++;
            const code = 'ORD-' + orderId;
            minOffset += 3;
            const h = String(9 + (Math.floor(minOffset / 3600) % 12)).padStart(2, '0');
            const m = String(Math.floor((minOffset % 3600) / 60)).padStart(2, '0');
            const s = String(minOffset % 60).padStart(2, '0');
            day1001Logs.push({
              employee_name: spec.name,
              order_code: code,
              action: 'اضافة رقم هاتف بديل: 01012345678',
              status: null,
              event_datetime: dStr + ' ' + h + ':' + m + ':' + s,
              timestamp: dStr + 'T' + h + ':' + m + ':' + s + '.000Z',
              date: dStr,
              is_cs: 1
            });
          }

          for (let i = 0; i < spec.newOrders; i++) {
            orderId++;
            const code = 'ORD-' + orderId;
            minOffset += 3;
            const h = String(9 + (Math.floor(minOffset / 3600) % 12)).padStart(2, '0');
            const m = String(Math.floor((minOffset % 3600) / 60)).padStart(2, '0');
            const s = String(minOffset % 60).padStart(2, '0');
            day1001Logs.push({
              employee_name: spec.name,
              order_code: code,
              action: 'أضاف اوردر جديد',
              status: null,
              event_datetime: dStr + ' ' + h + ':' + m + ':' + s,
              timestamp: dStr + 'T' + h + ':' + m + ':' + s + '.000Z',
              date: dStr,
              is_cs: 1
            });
          }
        }

        // Add 10 non-CS printed events so uniquePrintedOrders (821) differs from printedActions (811)
        for (let i = 0; i < 10; i++) {
          minOffset += 2;
          const h = String(10 + (Math.floor(minOffset / 3600) % 10)).padStart(2, '0');
          const m = String(Math.floor((minOffset % 3600) / 60)).padStart(2, '0');
          const s = String(minOffset % 60).padStart(2, '0');
          day1001Logs.push({
            employee_name: 'Warehouse Printer',
            order_code: `ORD-WH-${i + 1}`,
            action: `طبع البوليصة في المخزن`,
            status: 'Printed',
            event_datetime: `${dStr} ${h}:${m}:${s}`,
            timestamp: `${dStr}T${h}:${m}:${s}.000Z`,
            date: dStr,
            is_cs: 0 // Non-CS so CS printedActions stays 811
          });
        }

        // To reach uniqueCancelledOrders = 256 (31 orders reached Cancelled after another status)
        // Add 31 non-CS cancellation transition events for 31 existing distinct order codes
        for (let i = 0; i < 31; i++) {
          minOffset += 2;
          const h = String(10 + (Math.floor(minOffset / 3600) % 10)).padStart(2, '0');
          const m = String(Math.floor((minOffset % 3600) / 60)).padStart(2, '0');
          const s = String(minOffset % 60).padStart(2, '0');
          day1001Logs.push({
            employee_name: 'System AutoCancel',
            order_code: `ORD-${1001 + i}`,
            action: `عدل النظام حالة الطلب إلى 'Cancelled'`,
            status: 'Cancelled',
            event_datetime: `${dStr} ${h}:${m}:${s}`,
            timestamp: `${dStr}T${h}:${m}:${s}.000Z`,
            date: dStr,
            is_cs: 0 // Non-CS actor so CS cancelled actions remains 225
          });
        }

        // Duplicate inflation: Add exactly 3003 duplicate rows to reach 4518 raw status count
        const statusLogs = day1001Logs.filter(l => l.status && l.is_cs === 1);
        for (let i = 0; i < 3003; i++) {
          const parent = statusLogs[i % statusLogs.length];
          // Ensure every duplicate timestamp is unique within the 120s dedup window
          const cycle = Math.floor(i / statusLogs.length); // 0 or 1
          const dupSec = 10 + (cycle * 25) + ((i * 3) % 15);
          // Parse base time and add dupSec seconds
          const [hStr, mStr, sStr] = parent.event_datetime.split(' ')[1].split(':');
          let sVal = parseInt(sStr, 10) + dupSec;
          let mVal = parseInt(mStr, 10);
          if (sVal >= 60) {
            sVal -= 60;
            mVal += 1;
          }
          const dupTime = `${dStr} ${hStr}:${String(mVal).padStart(2, '0')}:${String(sVal).padStart(2, '0')}`;
          day1001Logs.push({
            employee_name: parent.employee_name,
            order_code: parent.order_code,
            action: parent.action,
            status: parent.status,
            event_datetime: dupTime,
            timestamp: `${dStr}T${hStr}:${String(mVal).padStart(2, '0')}:${String(sVal).padStart(2, '0')}.000Z`,
            date: dStr,
            is_cs: 1
          });
        }

        // Add non-CS audit logs (Shipping, Warehouse, System, Merchant) to reach > 19,000 total records
        const nonCsActors = ['Bosta integration', 'ARC SHOES Shipping', 'Warehouse Admin', 'Merchant Portal', 'Qpxpress'];
        for (let i = 0; i < 15000; i++) {
          const actor = nonCsActors[i % nonCsActors.length];
          const h = String(8 + Math.floor(i / 1500) % 14).padStart(2, '0');
          const m = String(Math.floor((i % 60))).padStart(2, '0');
          const s = String(Math.floor((i * 7) % 60)).padStart(2, '0');
          day1001Logs.push({
            employee_name: actor,
            order_code: `ORD-EXT-${20000 + i}`,
            action: `تحديث حالة الشحن بواسطة ${actor}`,
            status: null,
            event_datetime: `${dStr} ${h}:${m}:${s}`,
            timestamp: `${dStr}T${h}:${m}:${s}.000Z`,
            date: dStr,
            is_cs: 0
          });
        }

        mockLogs.push(...day1001Logs);
      } else {
        // Standard per-day mock logs for other dates
        const dateHash = dStr.split('-').reduce((acc, part) => acc + parseInt(part, 10), 0);
        const dayActionsCount = 40 + (dateHash % 30);
        for (let j = 0; j < dayActionsCount; j++) {
          counter++;
          const emp = employees[j % employees.length];
          const act = actions[j % actions.length];
          mockLogs.push({
            employee_name: emp,
            order_code: `VD-${dStr.replace(/-/g, '')}-${counter}`,
            action: act,
            date: dStr,
            timestamp: `${dStr}T09:${String(10 + (j % 50)).padStart(2, '0')}:00.000Z`
          });
        }
      }
      curr.setUTCDate(curr.getUTCDate() + 1);
    }

    const acceptedLogs = (startDate === endDate)
      ? mockLogs.filter(log => (canonicalWorkDate ? canonicalWorkDate(log) : log.date) === startDate)
      : mockLogs;

    const summary = summarizeNormalizedLogs(acceptedLogs);

    return {
      success: true,
      resource: 'logs',
      adapter: 'MOCK',
      http_status: 200,
      duration_ms: 18,
      content_type: 'application/vnd.ms-excel (mocked)',
      file_size_bytes: acceptedLogs.length * 200,
      pages_fetched: 1,
      pages_expected: 1,
      rows_fetched: mockLogs.length,
      rows_accepted: acceptedLogs.length,
      rows_rejected: mockLogs.length - acceptedLogs.length,
      duplicates_removed: 0,
      requested_range: {
        startDate,
        endDate,
        start_date: startDate,
        end_date: endDate
      },
      summary,
      sample_rows: acceptedLogs.slice(0, 10),
      logs: acceptedLogs,
      normalizedLogs: acceptedLogs
    };
  }
}

/**
 * Factory to obtain the active VendoorDataSource instance
 */
export function getVendoorDataSource(forceMode = null) {
  const cfg = getVendoorConfig();
  const isTestEnv = process.env.NODE_ENV === 'test' || 
    process.env.npm_lifecycle_event?.includes('test') || 
    process.argv.some(arg => typeof arg === 'string' && (arg.includes('test') || arg.includes('spec')));

  let mode = (cfg.mockMode && isTestEnv) ? 'mock' : 'live';
  if (forceMode) {
    if (forceMode === 'mock' && !isTestEnv && process.env.NODE_ENV === 'production') {
      throw new Error('MOCK_ADAPTER_DISALLOWED: Mock data source cannot be forced in production.');
    }
    mode = forceMode;
  }

  if (mode === 'mock') {
    if (!isTestEnv && process.env.NODE_ENV === 'production') {
      throw new Error('MOCK_ADAPTER_DISALLOWED: Mock data source is strictly forbidden in production.');
    }
    return new MockVendoorDataSource();
  }
  return new LiveVendoorDataSource();
}
