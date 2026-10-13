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
import { getCairoBusinessDate } from '../time_utils.js';

import { extractWarehouse } from '../operational_intelligence.js';
import { db } from '../../db/index.js';

/**
 * Map status filter to Vendoor category ID
 * Throws explicit UNSUPPORTED_STATUS_FILTER for unknown statuses
 */
export function mapStatusToCategoryId(status) {
  if (!status) {
    const err = new Error('UNSUPPORTED_STATUS_FILTER: Status filter is required.');
    err.code = 'UNSUPPORTED_STATUS_FILTER';
    throw err;
  }
  const s = String(status).trim().toLowerCase();
  if (s === '1' || s === 'new' || s.includes('جديد')) return 1;
  if (s === '2' || s === 'processing' || s.includes('تجهيز')) return 2;
  if (s === '3' || s === 'pending' || s.includes('معلق') || s.includes('انتظار')) return 3;
  if (s === '4' || s === 'shipped' || s.includes('شحن')) return 4;
  if (s === '5' || s.includes('partial')) return 5;
  if (s === '8' || s === 'delivered' || s.includes('استلام') || s.includes('تسليم')) return 8;
  if (s === '9' || s === 'collected' || s.includes('تحصيل')) return 9;
  if (s === '12' || s === 'canceled' || s === 'cancelled' || s.includes('ملغ') || s.includes('رفض')) return 12;
  if (s === '13' || s === 'printed' || s.includes('طباعة') || s.includes('طبع')) return 13;

  const err = new Error(`UNSUPPORTED_STATUS_FILTER: Status "${status}" cannot be mapped to a known Vendoor category.`);
  err.code = 'UNSUPPORTED_STATUS_FILTER';
  throw err;
}

/**
 * Universal canonical status normalization
 */
export function normalizeCanonicalStatus(status) {
  if (!status) return 'Unknown';
  const s = String(status).trim().toLowerCase();
  if (s === '1' || s === 'new' || s.includes('جديد')) return 'New';
  if (s === '2' || s === 'processing' || s.includes('تجهيز')) return 'Processing';
  if (s === '3' || s === 'pending' || s.includes('معلق') || s.includes('انتظار')) return 'Pending';
  if (s === '13' || s === 'printed' || s.includes('طباعة') || s.includes('طبع')) return 'Printed';
  if (s === '12' || s === 'canceled' || s === 'cancelled' || s.includes('ملغ') || s.includes('رفض')) return 'Cancelled';
  if (s === '4' || s === 'shipped' || s.includes('شحن')) return 'Shipped';
  if (s === '8' || s === 'delivered' || s.includes('تسليم') || s.includes('مكتمل')) return 'Delivered';
  if (s === '9' || s === 'collected' || s.includes('تحصيل')) return 'Collected';
  return String(status).trim();
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
  const maxPages = Math.min(1000, Math.max(1, parseInt(options.maxPages, 10) || 100));
  const fromDate = options.fromDate || '';
  const toDate = options.toDate || '';
  const search = options.search || '';

  let allIds = [];
  const orderMetadata = new Map();
  const affiliateNamesMap = new Map();
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
    for (const rec of pageRecords) {
      if (!rec || !rec.id) continue;
      const recId = rec.id;
      allIds.push(recId);

      const rawAffCode = rec.affiliate_code ? String(rec.affiliate_code).trim() : null;
      let cleanAffName = rec.affiliate_name ? String(rec.affiliate_name).replace(/<[^>]+>/g, '').trim() : null;
      if (cleanAffName && /no name specified|none specified|unknown \/ not available|^\s*[-_—]\s*$/i.test(cleanAffName)) {
        cleanAffName = null;
      }
      orderMetadata.set(String(recId), {
        affiliate_code: rawAffCode,
        affiliate_name: cleanAffName
      });
      if (rawAffCode && cleanAffName) {
        affiliateNamesMap.set(rawAffCode, cleanAffName);
      }
    }

    if (pageRecords.length === 0 || allIds.length >= reportedFiltered || pageRecords.length < pageSize) {
      break;
    }

    start += pageSize;
  }

  return {
    categoryId,
    pagesFetched: pageNum,
    reportedTotal,
    reportedFiltered,
    orderIds: allIds,
    orderMetadata,
    affiliateNamesMap
  };
}

/**
 * Execute real Vendoor Export and return parsed, deduplicated orders with canonical Merchant Name & Code
 */
export async function exportAndParseVendoorOrders(categoryId, options = {}) {
  const statusLabel = categoryId === 1 ? 'New' : (categoryId === 3 ? 'Pending' : `Category_${categoryId}`);
  
  // Step 1: Collect all order IDs across all pages
  const idCollection = await collectAllOrderIdsForStatus(categoryId, options);
  const { orderIds, pagesFetched, reportedTotal, reportedFiltered, orderMetadata, affiliateNamesMap } = idCollection;

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

  // Step 6: 2-Level Multi-Product Parser (ordersByCode & productsByCode)
  const ordersByCode = new Map();
  const productsByCode = new Map();
  let continuationRowsCount = 0;
  let totalProductsCount = 0;
  let lastOrderCode = '';

  for (let rowIndex = 0; rowIndex < rawRows.length; rowIndex++) {
    const r = rawRows[rowIndex];
    const rawOrderCode = r['رقم الاوردر'] || r['Order Code'] || r['Order ID'] || r['id'];
    let orderCode = String(rawOrderCode || '').trim();

    // Continuation row detection: if order code is empty but row contains product information
    const rowHasProduct = Boolean(
      String(r['اسم المنتج'] || r['Product Name'] || '').trim() ||
      String(r['كود الصنف'] || r['SKU'] || '').trim()
    );

    if (!orderCode && lastOrderCode && rowHasProduct) {
      orderCode = lastOrderCode;
      continuationRowsCount++;
    }

    if (!orderCode) continue;
    lastOrderCode = orderCode;

    const merchantName = String(r['اسم التاجر'] || r['Merchant Name'] || r['Merchant'] || r['Account'] || '').trim();
    const merchantCode = String(r['كود التاجر'] || r['Merchant Code'] || r['Vendor Code'] || '').trim();
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
    const totalPrice = Number(r['Total'] || r['Net'] || r['السعر'] || 0);
    const shippingCompany = String(r['شركة الشحن'] || '').trim();
    const trackingNumber = String(r['بوليصة الشحن'] || '').trim();

    const liveMeta = orderMetadata ? orderMetadata.get(orderCode) : null;
    const rawAffiliateCode = liveMeta?.affiliate_code || 
      r['الافيليت كود'] || r['كود الافلييت'] || r['كود المسوق'] || r['كود_المسوق'] || 
      r['Affiliate Code'] || r['Marketer Code'] || r.affiliate_code || '';
    let affiliateCode = String(rawAffiliateCode || '').trim() || null;
    if (affiliateCode && /^\s*[-_—]\s*$/i.test(affiliateCode)) {
      affiliateCode = null;
    }

    const rawMarketerName = liveMeta?.affiliate_name || 
      (affiliateCode && affiliateNamesMap ? affiliateNamesMap.get(affiliateCode) : null) ||
      r['اسم المسوق'] || r['اسم_المسوق'] || r['المسوق'] || r['اسم الافلييت'] || r['اسم الافيليت'] || 
      r['الافيليت'] || r['الافلييت'] || r['Marketer Name'] || r['Marketer'] || r['Affiliate Name'] || 
      r.affiliate_name || r.marketer_name || '';
    let marketerName = String(rawMarketerName || '').replace(/<[^>]+>/g, '').trim() || null;
    if (marketerName && /no name specified|none specified|unknown \/ not available|^\s*[-_—]\s*$/i.test(marketerName)) {
      marketerName = null;
    }

    // 1. Initialize or merge master order record
    if (!ordersByCode.has(orderCode)) {
      ordersByCode.set(orderCode, {
        order_code: orderCode,
        status: normalizeCanonicalStatus(rawStatus),
        raw_status: rawStatus,
        substatus,
        account: canonicalAccount,
        merchant_name: merchantName,
        merchant_code: merchantCode,
        created_at_original: createdAtOriginal,
        date: createdAtOriginal ? createdAtOriginal.slice(0, 10) : getCairoBusinessDate(),
        customer_name: customerName,
        phone,
        phone2,
        address,
        governorate,
        city,
        total_price: totalPrice,
        shipping_company: shippingCompany,
        tracking_number: trackingNumber,
        affiliate_code: affiliateCode,
        marketer_name: marketerName,
        affiliate_name: marketerName,
        products: []
      });
    } else {
      const existing = ordersByCode.get(orderCode);
      if (!existing.phone && phone) existing.phone = phone;
      if (!existing.phone2 && phone2) existing.phone2 = phone2;
      if (!existing.address && address) existing.address = address;
      if (!existing.customer_name && customerName) existing.customer_name = customerName;
      if (!existing.merchant_code && merchantCode) existing.merchant_code = merchantCode;
      if (!existing.merchant_name && merchantName) existing.merchant_name = merchantName;
    }

    // 2. Extract and preserve every individual product line
    const prodName = String(r['اسم المنتج'] || r['Product Name'] || '').trim();
    const prodSku = String(r['كود الصنف'] || r['SKU'] || '').trim();
    const prodQty = parseInt(r['الكمية'] || r['Quantity'] || 1, 10) || 1;
    const prodPrice = parseFloat(r['السعر'] || r['Price'] || r['Total'] || 0) || 0;
    const prodWh = extractWarehouse(prodName, r);
    const prodMerchCode = merchantCode || null;
    const prodMerchName = merchantName || null;

    if (prodName || prodSku) {
      if (!productsByCode.has(orderCode)) {
        productsByCode.set(orderCode, []);
      }
      const productList = productsByCode.get(orderCode);
      productList.push({
        order_code: orderCode,
        product_name: prodName,
        product_sku: prodSku || null,
        merchant_code: prodMerchCode,
        merchant_name: prodMerchName,
        warehouse: prodWh,
        quantity: prodQty,
        unit_price: prodPrice,
        source: 'VENDOOR_EXPORT',
        source_row: rowIndex + 1
      });
      totalProductsCount++;
    }
  }

  // 3. Attach full products list to each order and persist to order_products
  const insertProductStmt = db.prepare(`
    INSERT OR IGNORE INTO order_products (
      order_code, order_id, product_name, product_sku, merchant_code, merchant_name,
      warehouse, quantity, unit_price, source, source_row
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const persistTx = db.transaction(() => {
    for (const [code, pList] of productsByCode.entries()) {
      for (const p of pList) {
        try {
          insertProductStmt.run(
            code,
            code,
            p.product_name,
            p.product_sku,
            p.merchant_code,
            p.merchant_name,
            p.warehouse,
            p.quantity,
            p.unit_price,
            p.source,
            p.source_row
          );
        } catch (_) {}
      }
    }
  });

  try {
    persistTx();
  } catch (dbErr) {
    console.warn('[ExportSync] Product persistence warning:', dbErr.message);
  }

  for (const [code, ord] of ordersByCode.entries()) {
    ord.products = productsByCode.get(code) || [];
    if (ord.products.length > 0) {
      ord.product_name = ord.products[0].product_name;
      ord.product_sku = ord.products[0].product_sku;
      ord.warehouse = ord.products[0].warehouse;
      if (!ord.merchant_code && ord.products[0].merchant_code) {
        ord.merchant_code = ord.products[0].merchant_code;
      }
    }
  }

  const uniqueOrders = Array.from(ordersByCode.values());

  return {
    success: true,
    categoryId,
    statusLabel,
    pagesFetched,
    reportedTotal,
    reportedFiltered,
    exportedRowsCount: rawRows.length,
    continuationRowsCount,
    totalProductsCount,
    uniqueOrdersCount: uniqueOrders.length,
    orders: uniqueOrders
  };
}
