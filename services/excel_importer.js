import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { db } from '../db/index.js';
import { extractWarehouse } from './operational_intelligence.js';

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

      // Extract Warehouse from product name e.g. (مخزن 77)
      const warehouse = extractWarehouse(productName);
      if (warehouse) warehousesFound.add(warehouse);
      if (merchantCode) merchantCodesFound.add(merchantCode);

      const qty = parseInt(r['الكمية'] || r['Quantity'] || 1, 10) || 1;
      const price = parseFloat(r['السعر'] || r['Total'] || r['Net'] || 0) || 0;

      if (productName) {
        const res = insertProductStmt.run(
          activeCode,
          orderId || null,
          productName,
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
          updateWorkOrderStmt.run(merchantCode, merchantName, productName, warehouse, activeCode);
          updateVendoorOrderStmt.run(merchantCode, merchantName, productName, warehouse, activeCode);
        } catch (_) {}
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
    merchant_codes_count: merchantCodesFound.size,
    merchant_codes: Array.from(merchantCodesFound),
    warehouses_count: warehousesFound.size,
    warehouses: Array.from(warehousesFound),
    unlinked_rows: unlinkedRows
  };
}

/**
 * Imports historical logs from Excel file (e.g. HISTORICAL_LOGS_1.xlsx or sample_log.xlsx).
 *
 * @param {Buffer} buffer Excel file buffer
 * @param {string} filename Original filename
 * @returns {Object} Import summary
 */
export function importHistoricalLogsFromExcel(buffer, filename = 'logs.xlsx') {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  let totalRows = rows.length;
  let uniqueOrders = new Set();
  let logsInserted = 0;

  const insertLogStmt = db.prepare(`
    INSERT OR IGNORE INTO raw_log_records (
      work_date, order_code, employee_name, action, status, event_datetime, is_cs, is_deduped
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const r of rows) {
      const orderCode = cleanStr(r['كود الطلب'] || r['كود الاوردر'] || r['الرقم العشوائي'] || r.order_code);
      const employeeName = cleanStr(r['الاسم'] || r['اسم الموظف'] || r.employee_name);
      const action = cleanStr(r['الاكشن'] || r['Action'] || r.action);
      const rawDate = cleanStr(r['التاريخ'] || r['Date'] || r.timestamp);

      if (!orderCode) continue;
      uniqueOrders.add(orderCode);

      const workDate = rawDate ? rawDate.slice(0, 10) : new Date().toISOString().slice(0, 10);
      const isCs = /cs/i.test(employeeName) ? 1 : 0;
      let status = 'New';
      if (/pending|معلق/i.test(action)) status = 'Pending';
      if (/printed|طبع/i.test(action)) status = 'Printed';
      if (/completed|delivered/i.test(action)) status = 'Completed';

      const res = insertLogStmt.run(
        workDate,
        orderCode,
        employeeName || 'System',
        action,
        status,
        rawDate || null,
        isCs,
        1
      );
      if (res.changes > 0) logsInserted++;
    }
  });

  tx();

  return {
    success: true,
    filename,
    total_rows: totalRows,
    unique_orders: uniqueOrders.size,
    logs_inserted: logsInserted
  };
}

/**
 * Scans workspace root and public directories for available sample and export Excel files
 * and seeds product and log tables safely.
 */
export function autoScanAndSeedAvailableExcelFiles() {
  const root = process.cwd();
  const results = {
    products: null,
    logs: null
  };

  // 1. Check for specific orders export files
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

  // 2. Check for historical logs files
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

  return results;
}
