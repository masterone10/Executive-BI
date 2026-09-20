/**
 * Vendoor Official Export Sync Engine
 *
 * Implements the authoritative 2-step Vendoor Excel Export workflow:
 * 1. Collects all order IDs across all pages for the requested status (category)
 * 2. Fetches fresh CSRF token from /dashboard/orders HTML
 * 3. POST /dashboard/export/check/order with the complete array of order IDs
 * 4. POST /dashboard/export/excute with the returned batch token/IDs
 * 5. Parses the returned SpcificOrders.xlsx binary workbook
 * 6. Extracts canonical Merchant Name ('اسم التاجر') and Merchant Code ('كود التاجر')
 * 7. Deduplicates rows by canonical Order Code ('رقم الاوردر')
 * 8. Preserves original creation timestamp ('التاريخ') separately from operational business date
 * 9. Strictly ignores marketer/affiliate fields for merchant/account identity
 */

import XLSX from 'xlsx';
import { vendoorFetch, VendoorClientError } from './client.js';
import { extractCsrfTokenFromHtml } from './auth.js';

/**
 * Map status filter to Vendoor category ID
 */
export function mapStatusToCategoryId(status) {
  if (!status) return 1; // Default New
  const s = String(status).trim().toLowerCase();
  if (s === '1' || s === 'new' || s.includes('جديد')) return 1;
  if (s === '3' || s === 'pending' || s.includes('معلق')) return 3;
  if (s === '13' || s === 'printed' || s.includes('طباعة')) return 13;
  if (s === '4' || s === 'shipped' || s.includes('شحن')) return 4;
  if (s === '5' || s.includes('partial')) return 5;
  if (s === '8' || s === 'delivered' || s.includes('استلام')) return 8;
  if (s === '9' || s === 'collected' || s.includes('تحصيل')) return 9;
  if (s === '12' || s === 'canceled' || s === 'cancelled' || s.includes('ملغ')) return 12;
  return 1;
}

/**
 * Fetch fresh CSRF token from /dashboard/orders HTML page
 */
export async function fetchFreshOrdersCsrfToken() {
  const pageRes = await vendoorFetch('/dashboard/orders', {
    method: 'GET',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'X-Requested-With': ''
    }
  });
  const html = await pageRes.response.text();
  const csrf = extractCsrfTokenFromHtml(html);
  if (!csrf) {
    throw new VendoorClientError('Could not extract CSRF token from Vendoor orders page.', 500, 'CSRF_MISSING');
  }
  return csrf;
}

/**
 * Collect all Order IDs for a given status category across all pages
 */
export async function collectAllOrderIdsForStatus(categoryId, options = {}) {
  const pageSize = Math.min(300, Math.max(10, parseInt(options.pageSize, 10) || 300));
  const maxPages = Math.min(100, Math.max(1, parseInt(options.maxPages, 10) || 50));
  const fromDate = options.fromDate || '';
  const toDate = options.toDate || '';
  const search = options.search || '';

  let allIds = [];
  let start = 0;
  let pageNum = 0;
  let reportedTotal = 0;
  let reportedFiltered = 0;

  for (let p = 0; p < maxPages; p++) {
    pageNum++;
    const params = new URLSearchParams({
      category: String(categoryId),
      start: String(start),
      length: String(pageSize),
      draw: String(pageNum)
    });
    if (fromDate) params.set('from_date', fromDate);
    if (toDate) params.set('to_date', toDate);
    if (search) params.set('search[value]', search);

    const res = await vendoorFetch(`/dashboard/orders?${params.toString()}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/javascript, */*; q=0.01'
      }
    });

    const json = await res.response.json();
    reportedTotal = json.recordsTotal || 0;
    reportedFiltered = json.recordsFiltered !== undefined ? json.recordsFiltered : reportedTotal;

    const pageRecords = Array.isArray(json.data) ? json.data : [];
    const pageIds = pageRecords.map(o => o.id).filter(Boolean);
    allIds.push(...pageIds);

    if (pageIds.length === 0 || allIds.length >= reportedFiltered || pageRecords.length < pageSize) {
      break;
    }

    start += pageSize;
  }

  return {
    categoryId,
    pagesFetched: pageNum,
    reportedTotal,
    reportedFiltered,
    orderIds: allIds
  };
}

/**
 * Execute real Vendoor Export and return parsed, deduplicated orders with canonical Merchant Name & Code
 */
export async function exportAndParseVendoorOrders(categoryId, options = {}) {
  const statusLabel = categoryId === 1 ? 'New' : (categoryId === 3 ? 'Pending' : `Category_${categoryId}`);
  
  // Step 1: Collect all order IDs across all pages
  const idCollection = await collectAllOrderIdsForStatus(categoryId, options);
  const { orderIds, pagesFetched, reportedTotal, reportedFiltered } = idCollection;

  if (orderIds.length === 0) {
    return {
      success: true,
      categoryId,
      statusLabel,
      pagesFetched,
      reportedTotal,
      reportedFiltered,
      exportedRowsCount: 0,
      duplicateRowsCount: 0,
      uniqueOrdersCount: 0,
      orders: []
    };
  }

  // Step 2: Fetch fresh CSRF token
  const csrfToken = await fetchFreshOrdersCsrfToken();

  // Step 3: POST /dashboard/export/check/order
  const checkBody = new URLSearchParams();
  checkBody.append('_token', csrfToken);
  orderIds.forEach((id, idx) => {
    checkBody.append(`id[${idx}]`, String(id));
  });

  const checkRes = await vendoorFetch('/dashboard/export/check/order', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-CSRF-TOKEN': csrfToken,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: checkBody.toString()
  });

  const checkJson = await checkRes.response.json();
  const batchToken = checkJson.data;
  if (!batchToken) {
    throw new VendoorClientError('Vendoor /dashboard/export/check/order did not return export token/data.', 500, 'EXPORT_CHECK_FAILED');
  }

  // Step 4: POST /dashboard/export/excute to download the real SpcificOrders.xlsx
  const ordersidsVal = Array.isArray(batchToken) ? batchToken.join(',') : String(batchToken);
  const excuteBody = new URLSearchParams();
  excuteBody.append('_token', csrfToken);
  excuteBody.append('_method', 'post');
  excuteBody.append('ordersids', ordersidsVal);

  const excuteRes = await vendoorFetch('/dashboard/export/excute', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRF-TOKEN': csrfToken,
      'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/xhtml+xml,text/html,*/*'
    },
    body: excuteBody.toString()
  });

  const buffer = Buffer.from(await excuteRes.response.arrayBuffer());
  if (buffer.length === 0) {
    throw new VendoorClientError('Vendoor export returned empty binary buffer.', 500, 'EMPTY_EXPORT');
  }

  // Step 5: Parse SpcificOrders.xlsx binary sheet
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  // Step 6: Deduplicate by Order Code & extract canonical Merchant Name + Code
  const uniqueOrdersMap = new Map();
  let duplicateRowsCount = 0;

  for (const r of rawRows) {
    const rawOrderCode = r['رقم الاوردر'] || r['Order Code'] || r['Order ID'] || r['id'];
    const orderCode = String(rawOrderCode || '').trim();
    if (!orderCode) continue;

    if (uniqueOrdersMap.has(orderCode)) {
      duplicateRowsCount++;
      continue;
    }

    const merchantName = String(r['اسم التاجر'] || r['Merchant Name'] || r['Merchant'] || r['Account'] || '').trim();
    const merchantCode = String(r['كود التاجر'] || r['Merchant Code'] || r['Vendor Code'] || '').trim();
    
    // Stable account display identity: Real Merchant Name (or stable fallback to Merchant_<code>)
    // NEVER use marketer/affiliate, employee name, or order code as account name
    const canonicalAccount = merchantName || (merchantCode ? `Merchant_${merchantCode}` : 'Unassigned');

    const rawStatus = String(r['حالة الاوردر'] || r['Status'] || statusLabel).trim();
    const substatus = String(r['حالة الاوردر الفرعية'] || r['Sub Status'] || '').trim();
    const createdAtOriginal = String(r['التاريخ'] || r['Created Date'] || r['Date'] || '').trim();
    const customerName = String(r['الإسم'] || r['Customer Name'] || '').trim();
    const phone = String(r['موبايل(1)'] || r['Phone'] || '').trim();
    const phone2 = String(r['موبايل(2)'] || r['Phone 2'] || '').trim();
    const address = String(r['العنوان'] || r['Address'] || '').trim();
    const governorate = String(r['المحافظة'] || r['Governorate'] || '').trim();
    const city = String(r['المدينة'] || r['City'] || '').trim();
    const productName = String(r['اسم المنتج'] || r['Product Name'] || '').trim();
    const productSku = String(r['كود الصنف'] || r['SKU'] || '').trim();
    const totalPrice = Number(r['Total'] || r['Net'] || r['السعر'] || 0);
    const shippingCompany = String(r['شركة الشحن'] || '').trim();
    const trackingNumber = String(r['بوليصة الشحن'] || '').trim();
    const affiliateCode = String(r['الافيليت كود'] || '').trim(); // Preserved for metadata, NOT used for account identity

    uniqueOrdersMap.set(orderCode, {
      order_code: orderCode,
      status: rawStatus,
      substatus,
      account: canonicalAccount,
      merchant_name: merchantName,
      merchant_code: merchantCode,
      created_at_original: createdAtOriginal,
      date: createdAtOriginal ? createdAtOriginal.slice(0, 10) : new Date().toISOString().slice(0, 10),
      customer_name: customerName,
      phone,
      phone2,
      address,
      governorate,
      city,
      product_name: productName,
      product_sku: productSku,
      total_price: totalPrice,
      shipping_company: shippingCompany,
      tracking_number: trackingNumber,
      affiliate_code: affiliateCode
    });
  }

  const uniqueOrders = Array.from(uniqueOrdersMap.values());

  return {
    success: true,
    categoryId,
    statusLabel,
    pagesFetched,
    reportedTotal,
    reportedFiltered,
    exportedRowsCount: rawRows.length,
    duplicateRowsCount,
    uniqueOrdersCount: uniqueOrders.length,
    orders: uniqueOrders
  };
}
