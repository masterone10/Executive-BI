import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { db } from '../db/index.js';
import { extractWarehouse } from './operational_intelligence.js';
import { parseTimestamp, isHistoricalCsName } from './parser.js';
import { extractCanonicalStatus } from './vendoor/actions.js';
import { getCairoBusinessDate } from './time_utils.js';

/**
 * Normalizes string keys and removes invisible characters.
 */
function cleanStr(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

/**
 * Imports products, merchant codes, and warehouses from Specific Orders Excel file.
 * Compatible with SpcificOrders*.xlsx and Vendoor Export schemas.
 *
 * @param {Buffer} buffer Excel file buffer
 * @param {string} filename Original filename
 * @returns {Object} Import summary
 */
export function importProductsFromExcel(buffer, filename = 'orders.xlsx') {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  let totalRows = rows.length;
  let uniqueOrders = new Set();
  let productsInserted = 0;
  let merchantCodesFound = new Set();
  let warehousesFound = new Set();
  let unlinkedRows = 0;
  let ordersUpdated = 0;

  const insertProductStmt = db.prepare(`
    INSERT OR IGNORE INTO order_products (
      order_code, order_id, product_name, product_sku, merchant_code, merchant_name, warehouse, quantity, unit_price
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateWorkOrderStmt = db.prepare(`
    UPDATE current_work_orders 
    SET merchant_code = COALESCE(?, merchant_code),
        merchant_name = COALESCE(?, merchant_name),
        product_name = COALESCE(?, product_name),
        warehouse = COALESCE(?, warehouse)
    WHERE order_code = ?
  `);

  const updateVendoorOrderStmt = db.prepare(`
    UPDATE vendoor_orders 
    SET merchant_code = COALESCE(?, merchant_code),
        merchant_name = COALESCE(?, merchant_name),
        product_name = COALESCE(?, product_name),
        warehouse = COALESCE(?, warehouse)
    WHERE order_code = ?
  `);

  let lastOrderCode = '';
  let lastOrderId = '';

  const tx = db.transaction(() => {
    for (const r of rows) {
      // Find Order ID & Order Code
      const rawOrderCode = cleanStr(
        r['الرقم العشوائي'] || r['كود الطلب'] || r['كود الاوردر'] || r['Order Code'] || r.order_code
      );
      const rawOrderId = cleanStr(
        r['رقم الاوردر'] || r['Order ID'] || r.order_id
      );

      // Support continuation lines where order ID is blank on multi-item rows
      const orderCode = rawOrderCode || lastOrderCode;
      const orderId = rawOrderId || lastOrderId;

      if (rawOrderCode) lastOrderCode = rawOrderCode;
      if (rawOrderId) lastOrderId = rawOrderId;

      if (!orderCode && !orderId) {
        unlinkedRows++;
        continue;
      }

      const activeCode = orderCode || `ORD-${orderId}`;
      uniqueOrders.add(activeCode);

      // Extract Product Name, SKU, Merchant Code, Merchant Name
      const productName = cleanStr(r['اسم المنتج'] || r['Product Name'] || r.product_name);
      const productSku = cleanStr(r['كود الصنف'] || r['SKU'] || r.product_sku);
      const rawMerchantCode = cleanStr(r['كود التاجر'] || r['Merchant Code'] || r.merchant_code);
      const merchantCode = rawMerchantCode && rawMerchantCode !== '-' ? rawMerchantCode : null;
      const rawMerchantName = cleanStr(r['اسم التاجر'] || r['Merchant Name'] || r.merchant_name);
      const merchantName = rawMerchantName && rawMerchantName !== '-' ? rawMerchantName : null;

      // Extract Warehouse from product name e.g. (مخزن 77) or row columns
      const warehouse = extractWarehouse(productName, r);
      if (warehouse) warehousesFound.add(warehouse);
      if (merchantCode) merchantCodesFound.add(merchantCode);

      const qty = parseInt(r['الكمية'] || r['Quantity'] || 1, 10) || 1;
      const price = parseFloat(r['السعر'] || r['Total'] || r['Net'] || 0) || 0;

      if (productName || productSku) {
        const res = insertProductStmt.run(
          activeCode,
          orderId || null,
          productName || '',
          productSku || null,
          merchantCode,
          merchantName,
          warehouse,
          qty,
          price
        );
        if (res.changes > 0) {
          productsInserted++;
        }

        // Update corresponding order in current_work_orders and vendoor_orders without changing status or CS
        try {
          const r1 = updateWorkOrderStmt.run(merchantCode, merchantName, productName || null, warehouse, activeCode);
          const r2 = updateVendoorOrderStmt.run(merchantCode, merchantName, productName || null, warehouse, activeCode);
          if (r1.changes > 0 || r2.changes > 0) {
            ordersUpdated++;
          }
        } catch (updErr) {
          console.warn('[ExcelImporter] Update order notice:', updErr.message);
        }
      }
    }
  });

  tx();

  return {
    success: true,
    filename,
    total_rows: totalRows,
    unique_orders: uniqueOrders.size,
    products_inserted: productsInserted,
    orders_updated: ordersUpdated,
    merchant_codes_count: merchantCodesFound.size,
    merchant_codes: Array.from(merchantCodesFound),
    warehouses_count: warehousesFound.size,
    warehouses: Array.from(warehousesFound),
    unlinked_rows: unlinkedRows
  };
}

/**
 * Imports historical logs from Excel file (e.g. HISTORICAL_LOGS_1.xlsx or sample_log.xlsx).
 * Strictly adheres to Rule A1 (/cs/i detection for historical logs) and records
 * malformed rows into quarantine.
 *
 * @param {Buffer} buffer Excel file buffer
 * @param {string} filename Original filename
 * @param {Object} options Configuration options
 * @returns {Object} Comprehensive import & reconciliation summary
 */
export function importHistoricalLogsFromExcel(buffer, filename = 'logs.xlsx', options = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

  let totalRows = rows.length;
  let uniqueOrders = new Set();
  let logsInserted = 0;
  let duplicateRows = 0;
  let quarantinedRows = 0;
  let csRecordsCount = 0;
  let nonCsRecordsCount = 0;
  const statusCounts = {
    New: 0,
    Pending: 0,
    Printed: 0,
    Processing: 0,
    Cancelled: 0,
    Completed: 0,
    Other: 0
  };

  const insertLogStmt = db.prepare(`
    INSERT OR IGNORE INTO raw_log_records (
      work_date, order_code, employee_name, action, status, event_datetime, is_cs, is_deduped, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
  `);

  const quarantineStmt = db.prepare(`
    INSERT INTO import_quarantine_records (
      file_name, row_number, work_date, raw_order_code, raw_employee_name, raw_action, raw_datetime, raw_payload_json, rejection_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowNum = i + 2; // Header is row 1
      const orderCode = cleanStr(r['كود الطلب'] || r['كود الاوردر'] || r['الرقم العشوائي'] || r.order_code || r.OrderCode || r['Order Code']);
      const employeeName = cleanStr(r['الاسم'] || r['اسم الموظف'] || r.employee_name || r.Employee || r['Employee Name']);
      const action = cleanStr(r['الاكشن'] || r['Action'] || r.action || r['الحدث']);
      const rawDate = cleanStr(r['التاريخ'] || r['Date'] || r.timestamp || r.datetime || r['الوقت']);
      const rawStatus = cleanStr(r['الحالة'] || r['Status'] || r.status);

      // Quarantine check 1: Missing order code
      if (!orderCode) {
        quarantinedRows++;
        quarantineStmt.run(filename, rowNum, null, null, employeeName || null, action || null, rawDate || null, JSON.stringify(r), 'Missing Order Code');
        continue;
      }

      // Quarantine check 2: Missing employee name
      if (!employeeName) {
        quarantinedRows++;
        quarantineStmt.run(filename, rowNum, null, orderCode, null, action || null, rawDate || null, JSON.stringify(r), 'Missing Employee Name');
        continue;
      }

      // Parse timestamp using canonical Cairo parser
      let parsedTs = parseTimestamp(rawDate);
      if (!parsedTs || !parsedTs.is_valid) {
        if (options.fallbackDate) {
          parsedTs = {
            is_valid: true,
            cairo_date: options.fallbackDate,
            cairo_datetime: options.fallbackDate + ' 12:00:00'
          };
        } else {
          quarantinedRows++;
          quarantineStmt.run(filename, rowNum, null, orderCode, employeeName, action || null, rawDate || null, JSON.stringify(r), 'Invalid or missing timestamp');
          continue;
        }
      }

      const workDate = parsedTs.cairo_date;
      const eventDatetime = parsedTs.cairo_datetime || rawDate;

      // Rule A1: Historical CS name detection (/cs/i)
      const isCs = isHistoricalCsName(employeeName) ? 1 : 0;
      if (isCs) csRecordsCount++;
      else nonCsRecordsCount++;

      // Canonical status extraction
      let status = extractCanonicalStatus(action, rawStatus) || 'New';
      if (!['New', 'Pending', 'Printed', 'Processing', 'Cancelled', 'Completed'].includes(status)) {
        status = 'Other';
      }
      statusCounts[status] = (statusCounts[status] || 0) + 1;

      uniqueOrders.add(orderCode);

      const res = insertLogStmt.run(
        workDate,
        orderCode,
        employeeName,
        action || null,
        status,
        eventDatetime,
        isCs
      );

      if (res.changes > 0) {
        logsInserted++;
      } else {
        duplicateRows++;
      }
    }
  });

  tx();

  return {
    success: true,
    filename,
    total_rows: totalRows,
    valid_rows: totalRows - quarantinedRows,
    logs_inserted: logsInserted,
    duplicate_rows: duplicateRows,
    quarantined_rows: quarantinedRows,
    unique_orders: uniqueOrders.size,
    cs_records_count: csRecordsCount,
    non_cs_records_count: nonCsRecordsCount,
    status_counts: statusCounts
  };
}

/**
 * Scans workspace root and public directories for available sample and export Excel files
 * and seeds product and log tables safely.
 */
export function autoScanAndSeedAvailableExcelFiles(options = {}) {
  const root = process.cwd();
  const results = {
    products: null,
    logs: null
  };

  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && !options?.explicitProductionConsent) {
    return {
      success: false,
      message: 'Automatic file seeding is strictly disabled in production environments.',
      results
    };
  }

  const force = options?.force === true;
  let existingOrdersCount = 0;
  let existingLogsCount = 0;
  try {
    existingOrdersCount = db.prepare('SELECT COUNT(*) as c FROM specific_orders_uploads').get()?.c || 0;
    existingLogsCount = db.prepare('SELECT COUNT(*) as c FROM raw_log_records').get()?.c || 0;
  } catch (_) {}

  // 1. Check for specific orders export files
  if (force || existingOrdersCount === 0) {
    const candidatesOrders = [
      'SpcificOrders (1) (2).xlsx',
      'SpcificOrders (1).xlsx',
      'SpcificOrders.xlsx',
      'test_real_vendoor_export.xlsx'
    ];

    for (const c of candidatesOrders) {
      const p = path.join(root, c);
      if (fs.existsSync(p)) {
        try {
          const buf = fs.readFileSync(p);
          results.products = importProductsFromExcel(buf, c);
          break;
        } catch (e) {
          console.warn(`Could not parse ${c}:`, e.message);
        }
      }
    }
  } else {
    results.products = { skipped: true, count: existingOrdersCount, message: 'Existing orders already present in database' };
  }

  // 2. Check for historical logs files
  if (force || existingLogsCount === 0) {
    const candidatesLogs = [
      'HISTORICAL_LOGS_1.xlsx',
      'HISTORICAL_LOGS.xlsx',
      'sample_log.xlsx'
    ];

    for (const c of candidatesLogs) {
      const p = path.join(root, c);
      if (fs.existsSync(p)) {
        try {
          const buf = fs.readFileSync(p);
          results.logs = importHistoricalLogsFromExcel(buf, c);
          break;
        } catch (e) {
          console.warn(`Could not parse ${c}:`, e.message);
        }
      }
    }
  } else {
    results.logs = { skipped: true, count: existingLogsCount, message: 'Existing logs already present in database' };
  }

  return results;
}
