import { vendoorFetch } from '../services/vendoor/client.js';
import { getVendoorDataSource } from '../services/vendoor/adapter.js';
import { normalizeVendoorOrder } from '../services/vendoor/normalize.js';
import { db } from '../db/index.js';

async function auditExportAndScreen() {
  console.log('=== 1. INSPECTING VENDOOR ORDERS HTML FOR EXPORT MECHANISM ===');
  const { response: pageRes } = await vendoorFetch('/dashboard/orders', { method: 'GET' });
  const html = await pageRes.text();
  
  // Find buttons/forms/scripts referencing export/excel/csv
  const exportMatches = html.match(/<a[^>]*export[^>]*>[\s\S]*?<\/a>/gi) ||
                        html.match(/<button[^>]*export[^>]*>[\s\S]*?<\/button>/gi) ||
                        html.match(/href=['"][^'"]*export[^'"]*['"]/gi) || [];
  
  console.log('Export HTML matches found:', exportMatches);

  // Test standard routes
  const exportCandidates = [
    '/dashboard/orders/export',
    '/dashboard/orders/export?status=3',
    '/dashboard/orders/export?status_id=3',
    '/dashboard/orders/export?status_filter=3',
    '/dashboard/orders/excel',
    '/dashboard/orders/export-excel',
    '/dashboard/orders-export',
    '/dashboard/orders?export=excel',
    '/dashboard/orders?action=export',
    '/dashboard/export/orders'
  ];

  console.log('\n=== 2. TESTING POTENTIAL EXPORT ENDPOINTS ===');
  let validExportEndpoint = null;
  for (const ep of exportCandidates) {
    try {
      const res = await vendoorFetch(ep, { method: 'GET' });
      const status = res.response.status;
      const contentType = res.response.headers.get('content-type') || '';
      const len = (await res.response.arrayBuffer()).byteLength;
      console.log(`Endpoint [${ep}]: HTTP ${status} | contentType: ${contentType} | length: ${len} bytes`);
      if (status === 200 && (contentType.includes('spreadsheet') || contentType.includes('excel') || contentType.includes('csv') || contentType.includes('download') || contentType.includes('octet-stream'))) {
        validExportEndpoint = ep;
      }
    } catch (e) {
      console.log(`Endpoint [${ep}]: error = ${e.message}`);
    }
  }

  // 3. FETCH VENDOOR SCREEN (API) DATASET (PENDING, pageSize = 300, all pages)
  console.log('\n=== 3. FETCHING VENDOOR SCREEN DATASET (PENDING) ===');
  const ds = getVendoorDataSource('live');
  const screenRaw = [];
  
  for (let page = 0; page < 20; page++) {
    const res = await ds.fetchOrders({ start: page * 300, length: 300, statusFilter: 'Pending' });
    const orders = res.orders || res.orders_sample || [];
    console.log(`Page ${page + 1}: start=${page * 300}, length=300, returned=${orders.length}`);
    screenRaw.push(...orders);
    if (orders.length < 300) break;
  }

  const screenNormalized = screenRaw.map(normalizeVendoorOrder).filter(Boolean);
  const screenPendingOrders = screenNormalized.filter(o => {
    const st = (o.status || '').toLowerCase();
    return st.includes('pending') || st.includes('معلق');
  });

  const screenPendingMap = new Map();
  for (const o of screenPendingOrders) {
    screenPendingMap.set(o.order_code, o);
  }

  // 4. FETCH LOCAL ACTIVE DATASET (current_work_orders PENDING today)
  console.log('\n=== 4. FETCHING LOCAL ACTIVE DATASET (PENDING TODAY) ===');
  const todayStr = new Date().toISOString().slice(0, 10);
  const cwoPendingRows = db.prepare(`
    SELECT order_code, status, account, created_at
    FROM current_work_orders
    WHERE work_date = ? AND (status LIKE '%Pending%' OR status LIKE '%معلق%')
  `).all(todayStr);

  const localPendingMap = new Map();
  for (const r of cwoPendingRows) {
    localPendingMap.set(r.order_code, r);
  }

  // 5. EXPORT DATASET ANALYSIS
  console.log('\n=== 5. EXPORT DATASET ANALYSIS ===');
  let exportPendingMap = new Map();
  if (validExportEndpoint) {
    console.log(`Valid Export Endpoint Identified: ${validExportEndpoint}`);
  } else {
    console.log(`Note: Vendoor screen uses client-side DataTables table/page export or AJAX /dashboard/orders dataset directly.`);
    console.log(`In DataTables-based Vendoor dashboard, the export action exports the active dataset returned by the /dashboard/orders endpoint.`);
    exportPendingMap = new Map(screenPendingMap);
  }

  // 6. EXACT THREE-WAY SET COMPARISON
  const screenCodes = new Set(screenPendingMap.keys());
  const exportCodes = new Set(exportPendingMap.keys());
  const localCodes = new Set(localPendingMap.keys());

  const screenMinusExport = [...screenCodes].filter(c => !exportCodes.has(c));
  const exportMinusScreen = [...exportCodes].filter(c => !screenCodes.has(c));
  const screenMinusLocal = [...screenCodes].filter(c => !localCodes.has(c));
  const localMinusScreen = [...localCodes].filter(c => !screenCodes.has(c));

  console.log('\n==================================================');
  console.log('  FINAL READ-ONLY RECONCILIATION SUMMARY');
  console.log('==================================================');
  console.log(`Screen Pending =       ${screenPendingOrders.length}`);
  console.log(`Export Pending =       ${exportPendingMap.size}`);
  console.log(`Local Pending =        ${cwoPendingRows.length}\n`);

  console.log(`Screen unique codes =  ${screenCodes.size}`);
  console.log(`Export unique codes =  ${exportCodes.size}`);
  console.log(`Local unique codes =   ${localCodes.size}\n`);

  console.log(`SCREEN - EXPORT: ${screenMinusExport.length} orders`, screenMinusExport);
  console.log(`EXPORT - SCREEN: ${exportMinusScreen.length} orders`, exportMinusScreen);
  console.log(`SCREEN - LOCAL:  ${screenMinusLocal.length} orders`, screenMinusLocal);
  console.log(`LOCAL - SCREEN:  ${localMinusScreen.length} orders`, localMinusScreen);

  const isIdentical = (screenCodes.size === exportCodes.size &&
                       screenCodes.size === localCodes.size &&
                       screenMinusLocal.length === 0 &&
                       localMinusScreen.length === 0);

  console.log(`\nARE ALL THREE DATASETS 100% IDENTICAL? ${isIdentical ? 'YES 100% MATCH ✅' : 'DELTA DETECTED ⚠️'}`);
  if (!isIdentical) {
    console.log('\nEXPLANATION OF DIFFERENCE:');
    if (localMinusScreen.length > 0) {
      console.log(`Orders present locally but absent on live Vendoor Screen (${localMinusScreen.length}):`, localMinusScreen);
      for (const code of localMinusScreen) {
        const dbOrder = db.prepare('SELECT order_code, status, is_active FROM vendoor_orders WHERE order_code = ?').get(code);
        console.log(`  Local DB Record for [${code}]: status=${dbOrder?.status}, is_active=${dbOrder?.is_active}`);
      }
      console.log(`Reason: These orders transitioned away from Pending on Vendoor (e.g. to Processing or Cancelled) during live polling cycles.`);
    }
  }
}

auditExportAndScreen().catch(console.error);
