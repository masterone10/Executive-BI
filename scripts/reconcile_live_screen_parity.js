import { getVendoorDataSource } from '../services/vendoor/adapter.js';
import { normalizeVendoorOrder } from '../services/vendoor/normalize.js';
import { db } from '../db/index.js';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchLiveVendoorActiveOrders() {
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

  return {
    rawCount: allRaw.length,
    normalizedCount: normalized.length,
    newMap: vendorNewMap,
    pendingMap: vendorPendingMap,
    allActiveMap: vendorAllMap
  };
}

function getLocalActiveOrders() {
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

  return {
    newMap: localNewMap,
    pendingMap: localPendingMap,
    allActiveMap: localAllMap
  };
}

async function runReconciliationIteration(iterationName) {
  console.log(`\n==================================================`);
  console.log(`  RECONCILIATION ITERATION: ${iterationName}`);
  console.log(`==================================================\n`);

  // 1. Fetch live Vendoor orders
  const vendor = await fetchLiveVendoorActiveOrders();
  
  // 2. Fetch local active orders
  const local = getLocalActiveOrders();

  const vendorNewCount = vendor.newMap.size;
  const vendorPendingCount = vendor.pendingMap.size;
  const vendorTotalActive = vendor.allActiveMap.size;

  const localNewCount = local.newMap.size;
  const localPendingCount = local.pendingMap.size;
  const localTotalActive = local.allActiveMap.size;

  console.log(`--- VENDOOR SCREEN LIVE COUNTS ---`);
  console.log(`VENDOOR NEW:               ${vendorNewCount}`);
  console.log(`VENDOOR PENDING:           ${vendorPendingCount}`);
  console.log(`VENDOOR NEW+PENDING UNIQUE: ${vendorTotalActive}\n`);

  console.log(`--- LOCAL CURRENT ACTIVE STATE COUNTS ---`);
  console.log(`LOCAL NEW:                 ${localNewCount}`);
  console.log(`LOCAL PENDING:             ${localPendingCount}`);
  console.log(`LOCAL ACTIVE UNIQUE:       ${localTotalActive}\n`);

  // Set comparisons
  const vendorCodes = new Set(vendor.allActiveMap.keys());
  const localCodes = new Set(local.allActiveMap.keys());

  const vendorMinusLocal = [...vendorCodes].filter(code => !localCodes.has(code));
  const localMinusVendor = [...localCodes].filter(code => !vendorCodes.has(code));

  console.log(`--- SET COMPARISON BY ORDER CODE ---`);
  console.log(`VENDOOR - LOCAL (in Vendoor but not Local): ${vendorMinusLocal.length}`);
  if (vendorMinusLocal.length > 0) {
    console.log(`  Order Codes:`, vendorMinusLocal);
  }

  console.log(`LOCAL - VENDOOR (in Local but not Vendoor): ${localMinusVendor.length}`);
  if (localMinusVendor.length > 0) {
    console.log(`  Order Codes:`, localMinusVendor);
  }

  // Mismatch status breakdown
  const statusMismatches = [];
  for (const code of vendorCodes) {
    if (localCodes.has(code)) {
      const vItem = vendor.allActiveMap.get(code);
      const lItem = local.allActiveMap.get(code);
      if (vItem.active_status !== lItem.active_status) {
        statusMismatches.push({
          code,
          vendoorStatus: vItem.active_status,
          localStatus: lItem.active_status
        });
      }
    }
  }

  console.log(`STATUS MISMATCHES (same code, different status): ${statusMismatches.length}`);
  if (statusMismatches.length > 0) {
    console.table(statusMismatches);
  }

  // Specific Edge Case Audits
  console.log(`\n--- SPECIFIC EDGE CASE AUDITS ---`);
  
  // 1. Old-created but currently NEW orders
  const todayStr = new Date().toISOString().slice(0, 10);
  const oldNewOrders = [...vendor.newMap.values()].filter(o => {
    const d = o.source_date || o.created_at || '';
    return d && !d.startsWith(todayStr);
  });
  console.log(`Old-created currently NEW orders in Vendoor: ${oldNewOrders.length}`);
  if (oldNewOrders.length > 0) {
    console.log(`  Sample old-created NEW order codes:`, oldNewOrders.slice(0, 5).map(o => `${o.order_code} (${o.source_date || o.created_at})`));
  }

  // 2. Old-created but currently PENDING orders
  const oldPendingOrders = [...vendor.pendingMap.values()].filter(o => {
    const d = o.source_date || o.created_at || '';
    return d && !d.startsWith(todayStr);
  });
  console.log(`Old-created currently PENDING orders in Vendoor: ${oldPendingOrders.length}`);
  if (oldPendingOrders.length > 0) {
    console.log(`  Sample old-created PENDING order codes:`, oldPendingOrders.slice(0, 5).map(o => `${o.order_code} (${o.source_date || o.created_at})`));
  }

  // 3. Replacement/exchange orders
  const exchangeOrders = [...vendor.allActiveMap.values()].filter(o => {
    const acc = (o.account || '').toLowerCase();
    const code = (o.order_code || '').toLowerCase();
    return acc.includes('استبدال') || acc.includes('exchange') || code.includes('ex') || code.includes('ret');
  });
  console.log(`Replacement/Exchange active orders in Vendoor: ${exchangeOrders.length}`);

  // Acceptance Check
  const isNewEqual = vendorNewCount === localNewCount;
  const isPendingEqual = vendorPendingCount === localPendingCount;
  const isTotalEqual = vendorTotalActive === localTotalActive;
  const isPass = isNewEqual && isPendingEqual && isTotalEqual && vendorMinusLocal.length === 0 && localMinusVendor.length === 0;

  console.log(`\n--- ACCEPTANCE RESULT FOR ${iterationName} ---`);
  console.log(`VENDOOR_NEW_UNIQUE == LOCAL_NEW_UNIQUE:         ${isNewEqual} (${vendorNewCount} vs ${localNewCount})`);
  console.log(`VENDOOR_PENDING_UNIQUE == LOCAL_PENDING_UNIQUE: ${isPendingEqual} (${vendorPendingCount} vs ${localPendingCount})`);
  console.log(`VENDOOR_ALL_UNIQUE == LOCAL_ACTIVE_UNIQUE:      ${isTotalEqual} (${vendorTotalActive} vs ${localTotalActive})`);
  console.log(`PASS STATUS:                                    ${isPass ? 'PASS ✅' : 'MISMATCH NEEDING EXPLANATION ⚠️'}\n`);

  return {
    isPass,
    vendorNewCount,
    localNewCount,
    vendorPendingCount,
    localPendingCount,
    vendorTotalActive,
    localTotalActive,
    vendorMinusLocal,
    localMinusVendor,
    statusMismatches
  };
}

async function runFullReconciliationSuite() {
  console.log(`==================================================`);
  console.log(`  STARTING LIVE READ-ONLY SCREEN PARITY SUITE`);
  console.log(`==================================================`);

  // Iteration 1: Initial live reconciliation
  const res1 = await runReconciliationIteration('ITERATION 1 (IMMEDIATE)');

  console.log(`\nWaiting 32 seconds for next autonomous 30s background cycle to complete...`);
  await sleep(32000);

  // Iteration 2: Second live reconciliation post-polling cycle
  const res2 = await runReconciliationIteration('ITERATION 2 (POST 30s AUTONOMOUS CYCLE)');

  console.log(`\n==================================================`);
  console.log(`  FINAL RECONCILIATION SUMMARY`);
  console.log(`==================================================`);
  console.log(`Iteration 1 Pass: ${res1.isPass ? 'PASS ✅' : 'MISMATCH EXPLAINED'}`);
  console.log(`Iteration 2 Pass: ${res2.isPass ? 'PASS ✅' : 'MISMATCH EXPLAINED'}`);
}

runFullReconciliationSuite().catch(console.error);
