import XLSX from 'xlsx';

export const KNOWN_STATUSES = new Set(['Printed', 'Pending', 'Canceled', 'Cancelled', 'Processing']);
export const STATUS_RE = /(?:الى|إلى)\s*'?([A-Za-z][A-Za-z ]*?)'?\s*$/;
export const ADDED_RE = /أضاف\s*ا?أ?وردر|اضاف\s*ا?أ?وردر|انشاء\s*ا?أ?وردر|إنشاء\s*ا?أ?وردر|اضافة\s*ا?أ?وردر/;
export const ALT_RE = /التليفون\s*البديل|رقم\s*بديل|هاتف\s*بديل|موبايل\s*بديل|رقم\s*هاتف\s*آخر|رقم\s*هاتف\s*اخر|رقم\s*تليفون\s*آخر|رقم\s*تليفون\s*اخر|رقم\s*آخر|رقم\s*اخر|تعديل.*رقم|تحديث.*رقم|رقم.*الهاتف|رقم.*التليفون/;

export function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val.getTime();
  if (typeof val === 'number') {
    // Excel serial date to JS timestamp
    return Math.round((val - 25569) * 86400 * 1000);
  }
  const parsed = Date.parse(val);
  return isNaN(parsed) ? null : parsed;
}

export function formatDateKey(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function isCSName(name, dbEmployeesMap = null) {
  const cleanName = String(name || '').trim();
  if (dbEmployeesMap && dbEmployeesMap.has(cleanName)) {
    return dbEmployeesMap.get(cleanName) === 'CS';
  }
  return cleanName.toLowerCase().endsWith('cs');
}

/**
 * Parse Daily Log File (.xlsx buffer)
 */
export function parseDailyLogBuffer(fileBuffer, dbEmployeesMap = null) {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });

  if (!rows || rows.length === 0) {
    throw new Error('ملف السجل فارغ (Empty spreadsheet)');
  }

  const hdr = rows[0].map(h => String(h || '').trim());
  let oi = -1, ci = -1, ai = -1, di = -1;

  hdr.forEach((h, i) => {
    if (/كود\s*الطلب|كود|order|code/i.test(h) && oi === -1) oi = i;
    if (/الاسم|اسم\s*الموظف|name|employee/i.test(h) && ci === -1) ci = i;
    if (/الاكشن|الحدث|action/i.test(h) && ai === -1) ai = i;
    if (/التاريخ|تاريخ|date|datetime|time/i.test(h) && di === -1) di = i;
  });

  // Fallback indices if header names weren't found
  if (oi === -1) oi = 1;
  if (ci === -1) ci = 2;
  if (ai === -1) ai = 3;
  if (di === -1) di = 4;

  const rawRows = rows.slice(1);
  const totalRows = rawRows.length;
  let validRows = 0;
  let skippedRows = 0;
  const skippedReasons = [];

  const records = [];

  for (let idx = 0; idx < rawRows.length; idx++) {
    const r = rawRows[idx];
    if (!r || r.length === 0) {
      skippedRows++;
      continue;
    }

    const order = String(r[oi] || '').trim();
    const name = String(r[ci] || '').trim();
    const act = String(r[ai] || '').trim();
    const dt = parseDate(r[di]);

    if (!order || !name) {
      skippedRows++;
      if (skippedReasons.length < 5) {
        skippedReasons.push(`Row ${idx + 2}: Missing order code or employee name`);
      }
      continue;
    }

    let st = null;
    const m = STATUS_RE.exec(act);
    if (m) {
      st = m[1].trim();
      if (st === 'Canceled') st = 'Cancelled';
      if (!KNOWN_STATUSES.has(st)) st = null;
    }

    records.push({
      order,
      name,
      act,
      st,
      dt,
      alt: ALT_RE.test(act),
      added: ADDED_RE.test(act),
      isCS: isCSName(name, dbEmployeesMap),
    });

    validRows++;
  }

  return {
    records,
    summary: {
      totalRows,
      validRows,
      skippedRows,
      skippedReasons,
    }
  };
}

/**
 * Parse Specific Orders File (.xlsx buffer)
 * Strict validation: Must identify Order Code and Merchant/Account columns.
 * (Part 4, 30, 54)
 */
export function parseSpecificOrdersBuffer(fileBuffer, targetDate = null) {
  let workbook;
  try {
    workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true });
  } catch (err) {
    throw new Error(`Corrupted file format: Failed to read Excel workbook (${err.message})`);
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error('Specific Orders file contains no sheets (Empty workbook)');
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  if (!rows || rows.length <= 1) {
    throw new Error('ملف الأوردرات المحددة فارغ أو لا يحتوي على صفوف بيانات (Empty spreadsheet or no data rows)');
  }

  const hdr = rows[0].map(h => String(h || '').trim());
  let oi = -1, ai = -1, si = -1, di = -1;

  hdr.forEach((h, i) => {
    if (/كود\s*الطلب|كود|order\s*code|code/i.test(h) && oi === -1) oi = i;
    if (/اسم\s*التاجر|التاجر|merchant|account|اسم\s*العميل|حساب/i.test(h) && ai === -1) ai = i;
    if (/حالة\s*الطلب|حاله\s*الطلب|الحالة|حالة|status/i.test(h) && si === -1) si = i;
    if (/تاريخ\s*الطلب|التاريخ|تاريخ|order\s*date|date/i.test(h) && di === -1) di = i;
  });

  // Strict check: if order code and merchant columns could not be identified by header
  if (oi === -1) {
    // Check if column 0 contains order code patterns (digits/alphanumeric codes)
    const sampleVal = String(rows[1] && rows[1][0] || '').trim();
    if (/^[a-z0-9_-]{3,}$/i.test(sampleVal)) {
      oi = 0;
    }
  }

  if (ai === -1) {
    // Check other columns for account names
    for (let c = 1; c < hdr.length; c++) {
      if (c !== oi && c !== si && c !== di) {
        ai = c;
        break;
      }
    }
  }

  if (oi === -1 || ai === -1) {
    throw new Error(
      `Missing required columns: The file header must contain an 'Order Code' (كود الطلب) column and a 'Merchant/Account' (اسم التاجر) column. Found columns: [${hdr.join(', ')}]`
    );
  }

  if (si === -1) {
    // Look for status column or default to none
    hdr.forEach((h, i) => {
      if (i !== oi && i !== ai && i !== di && si === -1) {
        si = i;
      }
    });
  }

  const rawRows = rows.slice(1);
  const totalRows = rawRows.length;
  let validRows = 0;
  let skippedRows = 0;
  const skippedReasons = [];

  const ordersMap = new Map(); // deduplicate within single file

  for (let idx = 0; idx < rawRows.length; idx++) {
    const r = rawRows[idx];
    if (!r || r.length === 0) {
      skippedRows++;
      continue;
    }

    const orderCode = String(r[oi] || '').trim();
    let account = String(r[ai] || '').trim();
    let rawStatus = si !== -1 ? String(r[si] || '').trim() : 'New';
    const orderDate = di !== -1 ? r[di] : null;

    if (!orderCode || !account) {
      skippedRows++;
      if (skippedReasons.length < 5) {
        skippedReasons.push(`Row ${idx + 2}: Missing Order Code or Merchant/Account`);
      }
      continue;
    }

    // Normalize Status
    let status = 'New';
    if (/pending|معلق|انتظار/i.test(rawStatus)) {
      status = 'Pending';
    } else if (/new|جديد/i.test(rawStatus)) {
      status = 'New';
    } else {
      status = rawStatus || 'New';
    }

    // Normalize Account display name: strip redundant quotes and multiple spaces
    account = account.replace(/["']/g, '').replace(/\s+/g, ' ').trim();

    if (!ordersMap.has(orderCode)) {
      ordersMap.set(orderCode, {
        order_code: orderCode,
        account,
        status,
        order_date: orderDate ? String(orderDate) : null,
      });
      validRows++;
    }
  }

  const orders = Array.from(ordersMap.values());

  if (orders.length === 0) {
    throw new Error('No valid orders found in the uploaded file. Please check row data.');
  }

  return {
    orders,
    summary: {
      totalRows,
      validRows,
      uniqueOrders: orders.length,
      skippedRows,
      skippedReasons,
    }
  };
}
