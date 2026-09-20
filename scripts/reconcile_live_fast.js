import { getVendoorDataSource } from '../services/vendoor/adapter.js';
import { normalizeVendoorOrder } from '../services/vendoor/normalize.js';
import { db } from '../db/index.js';

async function fastReconciliation() {
  const ds = getVendoorDataSource('live');
  const allRaw = [];
  
  for (let page = 0; page < 20; page++) {
    const res = await ds.fetchOrders({ start: page * 300, length: 300 });
    const orders = res.orders || res.orders_sample || [];
    allRaw.push(...orders);
    if (orders.length < 300) break;
  }

  const normalized = allRaw.map(normalizeVendoorOrder).filter(Boolean);
  
  const vendorNewMap = new Map();
  const vendorPendingMap = new Map();
  const vendorAllMap = new Map();

  for (const item of normalized) {
    const statusLower = (item.status || '').toLowerCase();
    const isNew = statusLower.includes('new') || statusLower.includes('جديد');
    const isPending = statusLower.includes('pending') || statusLower.includes('معلق');
    
    if (isNew) {
      vendorNewMap.set(item.order_code, item);
      vendorAllMap.set(item.order_code, { ...item, active_status: 'New' });
    } else if (isPending) {
      vendorPendingMap.set(item.order_code, item);
      vendorAllMap.set(item.order_code, { ...item, active_status: 'Pending' });
    }
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const cwoRows = db.prepare(`
    SELECT order_code, status, account, order_date, created_at
    FROM current_work_orders
    WHERE work_date = ?
  `).all(todayStr);

  const localNewMap = new Map();
  const localPendingMap = new Map();
  const localAllMap = new Map();

  for (const row of cwoRows) {
    const statusLower = (row.status || '').toLowerCase();
    const isNew = statusLower.includes('new') || statusLower.includes('جديد');
    const isPending = statusLower.includes('pending') || statusLower.includes('معلق');

    if (isNew) {
      localNewMap.set(row.order_code, row);
      localAllMap.set(row.order_code, { ...row, active_status: 'New' });
    } else if (isPending) {
      localPendingMap.set(row.order_code, row);
      localAllMap.set(row.order_code, { ...row, active_status: 'Pending' });
    }
  }

  const vendorNewCount = vendorNewMap.size;
  const vendorPendingCount = vendorPendingMap.size;
  const vendorTotalActive = vendorAllMap.size;

  const localNewCount = localNewMap.size;
  const localPendingCount = localPendingMap.size;
  const localTotalActive = localAllMap.size;

  const vendorCodes = new Set(vendorAllMap.keys());
  const localCodes = new Set(localAllMap.keys());

  const vendorMinusLocal = [...vendorCodes].filter(code => !localCodes.has(code));
  const localMinusVendor = [...localCodes].filter(code => !vendorCodes.has(code));

  console.log(`=== LIVE SCREEN PARITY RECONCILIATION RESULT ===`);
  console.log(`VENDOOR NEW:               ${vendorNewCount}`);
  console.log(`VENDOOR PENDING:           ${vendorPendingCount}`);
  console.log(`VENDOOR NEW+PENDING UNIQUE: ${vendorTotalActive}\n`);

  console.log(`LOCAL NEW:                 ${localNewCount}`);
  console.log(`LOCAL PENDING:             ${localPendingCount}`);
  console.log(`LOCAL ACTIVE UNIQUE:       ${localTotalActive}\n`);

  console.log(`VENDOOR - LOCAL (missing in local): ${vendorMinusLocal.length}`);
  if (vendorMinusLocal.length > 0) console.log('  Codes:', vendorMinusLocal);

  console.log(`LOCAL - VENDOOR (stale in local):   ${localMinusVendor.length}`);
  if (localMinusVendor.length > 0) console.log('  Codes:', localMinusVendor);

  const statusMismatches = [];
  for (const code of vendorCodes) {
    if (localCodes.has(code)) {
      const v = vendorAllMap.get(code);
      const l = localAllMap.get(code);
      if (v.active_status !== l.active_status) {
        statusMismatches.push({ code, vendoor: v.active_status, local: l.active_status });
      }
    }
  }
  console.log(`STATUS MISMATCHES: ${statusMismatches.length}`);
  if (statusMismatches.length > 0) console.table(statusMismatches);

  // Old created check
  const oldNew = [...vendorNewMap.values()].filter(o => o.source_date && !o.source_date.startsWith(todayStr));
  const oldPending = [...vendorPendingMap.values()].filter(o => o.source_date && !o.source_date.startsWith(todayStr));

  console.log(`\nOLD-CREATED BUT CURRENTLY NEW:     ${oldNew.length}`);
  console.log(`OLD-CREATED BUT CURRENTLY PENDING: ${oldPending.length}`);

  const isPass = vendorNewCount === localNewCount &&
                 vendorPendingCount === localPendingCount &&
                 vendorTotalActive === localTotalActive &&
                 vendorMinusLocal.length === 0 &&
                 localMinusVendor.length === 0 &&
                 statusMismatches.length === 0;

  console.log(`\nFINAL PASS CRITERIA STATUS: ${isPass ? 'PASS ✅' : 'DELTA IDENTIFIED ⚠️'}`);
}

fastReconciliation().catch(console.error);
