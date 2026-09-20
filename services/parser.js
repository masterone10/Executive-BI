import XLSX from 'xlsx';
import { db } from '../db/index.js';

export const KNOWN_STATUSES = new Set(['Printed', 'Pending', 'Canceled', 'Cancelled', 'Processing']);
export const STATUS_RE = /(?:الى|إلى)\s*'?([A-Za-z][A-Za-z ]*?)'?\s*$/;
export const ADDED_RE = /أضاف\s*ا?أ?وردر|اضاف\s*ا?أ?وردر|انشاء\s*ا?أ?وردر|إنشاء\s*ا?أ?وردر|اضافة\s*ا?أ?وردر/;
export const ALT_RE = /التليفون\s*البديل|رقم\s*بديل|هاتف\s*بديل|موبايل\s*بديل|رقم\s*هاتف\s*آخر|رقم\s*هاتف\s*اخر|رقم\s*تليفون\s*آخر|رقم\s*تليفون\s*اخر|رقم\s*آخر|رقم\s*اخر|تعديل.*رقم|تحديث.*رقم|رقم.*الهاتف|رقم.*التليفون/;

export function normalizeDateToISO(val) {
  if (val === undefined || val === null || val === '') return null;

  // 1. JS Date object
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // 2. Excel serial number
  if (typeof val === 'number') {
    if (val <= 0 || isNaN(val)) return null;
    // Standard Excel epoch: 1 = Jan 1 1900.
    // Handles 1900 leap year bug
    const epochDays = val > 60 ? val - 2 : val - 1;
    const dateObj = new Date(1900, 0, epochDays);
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    if (y >= 1990 && y <= 2050) {
      return `${y}-${m}-${d}`;
    }
  }

  const str = String(val).trim();
  if (!str) return null;

  // 3. Match standard YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = String(parseInt(isoMatch[2], 10)).padStart(2, '0');
    const d = String(parseInt(isoMatch[3], 10)).padStart(2, '0');
    if (y >= 1990 && y <= 2050 && parseInt(m, 10) >= 1 && parseInt(m, 10) <= 12 && parseInt(d, 10) >= 1 && parseInt(d, 10) <= 31) {
      return `${y}-${m}-${d}`;
    }
  }

  // 4. Match DD/MM/YYYY or DD-MM-YYYY
  const ddmmyyyyMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (ddmmyyyyMatch) {
    const part1 = parseInt(ddmmyyyyMatch[1], 10);
    const part2 = parseInt(ddmmyyyyMatch[2], 10);
    const y = parseInt(ddmmyyyyMatch[3], 10);

    let d = part1;
    let m = part2;
    // If part1 <= 12 and part2 > 12 -> MM/DD/YYYY format
    if (part1 <= 12 && part2 > 12) {
      m = part1;
      d = part2;
    }

    const mStr = String(m).padStart(2, '0');
    const dStr = String(d).padStart(2, '0');
    if (y >= 1990 && y <= 2050 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${mStr}-${dStr}`;
    }
  }

  // 5. Try parsing standard Date string
  const parsed = Date.parse(str);
  if (!isNaN(parsed)) {
    const d = new Date(parsed);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    if (y >= 1990 && y <= 2050) {
      return `${y}-${m}-${day}`;
    }
  }

  return null;
}

export function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val.getTime();
  if (typeof val === 'number') {
    return Math.round((val - 25569) * 86400 * 1000);
  }
  const iso = normalizeDateToISO(val);
  if (iso) {
    const parts = iso.split('-');
    return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)).getTime();
  }
  const parsed = Date.parse(val);
  return isNaN(parsed) ? null : parsed;
}

export function formatDateKey(ts) {
  if (!ts) return null;
  if (typeof ts === 'string') {
    const norm = normalizeDateToISO(ts);
    if (norm) return norm;
  }
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Centralized Operational-Day Business Date Resolution Rule
 *
 * Resolves the operational Business Date for a given event/source timestamp based on
 * the configured operational day cutoff time (HH:mm or decimal hours/offset).
 *
 * Operational-Day Logic:
 * - If an event timestamp occurs at or after the configured cutoff (e.g. 20:00:00),
 *   the workload belongs to the next Business Date.
 * - If an event timestamp occurs before the cutoff, it belongs to the current calendar date.
 *
 * @param {Date|string|number} timestamp - The source event or order timestamp.
 * @param {string|number|null} [cutoffConfig] - Optional explicit cutoff override (e.g. '20:00', '20:00:00', 20).
 *                                             Defaults to 'operational_day_cutoff' from system_configs, or '20:00'.
 * @returns {{
 *   source_timestamp: string,
 *   calendar_date: string,
 *   configured_cutoff: string,
 *   is_rolled_over: boolean,
 *   business_date: string,
 *   resulting_business_date: string,
 *   module: string,
 *   function_name: string
 * }}
 */
export function getOperationalBusinessDate(timestamp, cutoffConfig = null) {
  if (timestamp === undefined || timestamp === null || timestamp === '') {
    return null;
  }

  // 1. Resolve cutoff configuration from system_configs or parameter
  let cutoffStr = cutoffConfig;
  if (!cutoffStr) {
    try {
      const cfg = db.prepare("SELECT value FROM system_configs WHERE key = 'operational_day_cutoff'").get();
      if (cfg && cfg.value) {
        cutoffStr = cfg.value;
      }
    } catch {
      // fallback
    }
  }
  if (!cutoffStr) {
    cutoffStr = '20:00';
  }

  // Parse cutoff hour & minute
  let cutoffHour = 20;
  let cutoffMinute = 0;
  if (typeof cutoffStr === 'number') {
    cutoffHour = Math.floor(cutoffStr);
    cutoffMinute = Math.round((cutoffStr - cutoffHour) * 60);
  } else {
    const parts = String(cutoffStr).trim().split(':');
    if (parts.length >= 1) cutoffHour = parseInt(parts[0], 10) || 0;
    if (parts.length >= 2) cutoffMinute = parseInt(parts[1], 10) || 0;
  }
  const cutoffTotalMinutes = cutoffHour * 60 + cutoffMinute;

  // 2. Parse source timestamp
  let dateObj = null;
  let rawStr = '';

  if (timestamp instanceof Date) {
    dateObj = new Date(timestamp.getTime());
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    const hr = String(dateObj.getHours()).padStart(2, '0');
    const min = String(dateObj.getMinutes()).padStart(2, '0');
    const sec = String(dateObj.getSeconds()).padStart(2, '0');
    rawStr = `${y}-${m}-${d} ${hr}:${min}:${sec}`;
  } else if (typeof timestamp === 'number') {
    if (timestamp < 100000) {
      // Excel serial number
      const epochDays = timestamp > 60 ? timestamp - 2 : timestamp - 1;
      dateObj = new Date(1900, 0, epochDays);
      const frac = timestamp - Math.floor(timestamp);
      const totalSecs = Math.round(frac * 86400);
      dateObj.setSeconds(dateObj.getSeconds() + totalSecs);
    } else {
      dateObj = new Date(timestamp);
    }
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    const hr = String(dateObj.getHours()).padStart(2, '0');
    const min = String(dateObj.getMinutes()).padStart(2, '0');
    const sec = String(dateObj.getSeconds()).padStart(2, '0');
    rawStr = `${y}-${m}-${d} ${hr}:${min}:${sec}`;
  } else {
    rawStr = String(timestamp).trim();
    // Parse "YYYY-MM-DD HH:mm:ss" or ISO string
    const dtMatch = rawStr.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
    if (dtMatch) {
      const y = parseInt(dtMatch[1], 10);
      const m = parseInt(dtMatch[2], 10);
      const d = parseInt(dtMatch[3], 10);
      const hr = parseInt(dtMatch[4], 10);
      const min = parseInt(dtMatch[5], 10);
      const sec = dtMatch[6] ? parseInt(dtMatch[6], 10) : 0;
      dateObj = new Date(y, m - 1, d, hr, min, sec);
    } else {
      const parsed = Date.parse(rawStr);
      if (!isNaN(parsed)) {
        dateObj = new Date(parsed);
      }
    }
  }

  if (!dateObj || isNaN(dateObj.getTime())) {
    const fallbackIso = normalizeDateToISO(timestamp);
    return {
      source_timestamp: String(timestamp),
      calendar_date: fallbackIso,
      configured_cutoff: `${String(cutoffHour).padStart(2, '0')}:${String(cutoffMinute).padStart(2, '0')}`,
      is_rolled_over: false,
      business_date: fallbackIso,
      resulting_business_date: fallbackIso,
      module: 'services/parser.js',
      function_name: 'getOperationalBusinessDate'
    };
  }

  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  const calendarDate = `${y}-${m}-${d}`;

  const eventHour = dateObj.getHours();
  const eventMinute = dateObj.getMinutes();
  const eventTotalMinutes = eventHour * 60 + eventMinute;

  const isRolledOver = eventTotalMinutes >= cutoffTotalMinutes;

  let businessDate = calendarDate;
  if (isRolledOver) {
    const nextDay = new Date(y, parseInt(m, 10) - 1, parseInt(d, 10) + 1);
    const ny = nextDay.getFullYear();
    const nm = String(nextDay.getMonth() + 1).padStart(2, '0');
    const nd = String(nextDay.getDate()).padStart(2, '0');
    businessDate = `${ny}-${nm}-${nd}`;
  }

  const formattedCutoff = `${String(cutoffHour).padStart(2, '0')}:${String(cutoffMinute).padStart(2, '0')}`;

  const result = {
    source_timestamp: rawStr,
    calendar_date: calendarDate,
    configured_cutoff: formattedCutoff,
    is_rolled_over: isRolledOver,
    business_date: businessDate,
    resulting_business_date: businessDate,
    module: 'services/parser.js',
    function_name: 'getOperationalBusinessDate'
  };

  result.toString = () => businessDate;
  return result;
}

export function resolveOperationalBusinessDate(timestamp, cutoffConfig = null) {
  const res = getOperationalBusinessDate(timestamp, cutoffConfig);
  return res ? res.business_date : null;
}

export function normalizeEmployeeName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Match an employee name against Employee Master.
 * Safe normalization: trims whitespace, normalizes multiple spaces, case-insensitive.
 * Preserves the original display name from Employee Master if matched.
 */
export function matchEmployeeInMaster(name, dbEmployeesMap = null) {
  if (!name) return null;
  const raw = String(name).trim();
  const norm = normalizeEmployeeName(raw);
  if (!norm) return null;

  if (!dbEmployeesMap) return null;

  if (dbEmployeesMap instanceof Map) {
    if (dbEmployeesMap.has(norm)) {
      const val = dbEmployeesMap.get(norm);
      if (typeof val === 'object' && val !== null) return val;
      return { name: raw, department: String(val), isCS: String(val).toUpperCase() === 'CS' };
    }
    if (dbEmployeesMap.has(raw)) {
      const val = dbEmployeesMap.get(raw);
      if (typeof val === 'object' && val !== null) return val;
      return { name: raw, department: String(val), isCS: String(val).toUpperCase() === 'CS' };
    }
    for (const [k, v] of dbEmployeesMap.entries()) {
      if (normalizeEmployeeName(k) === norm) {
        if (typeof v === 'object' && v !== null) return v;
        return { name: k, department: String(v), isCS: String(v).toUpperCase() === 'CS' };
      }
      if (typeof v === 'object' && v !== null && v.name && normalizeEmployeeName(v.name) === norm) {
        return v;
      }
    }
  } else if (Array.isArray(dbEmployeesMap)) {
    for (const emp of dbEmployeesMap) {
      if (!emp || !emp.name) continue;
      if (normalizeEmployeeName(emp.name) === norm) {
        return {
          id: emp.id,
          name: emp.name,
          department: emp.department,
          isCS: String(emp.department || '').trim().toUpperCase() === 'CS',
        };
      }
    }
  }

  return null;
}

/**
 * Canonical CS Employee validator.
 * Rules:
 * - Employee Master is the authoritative source.
 * - Any employee name or identifying text containing the standalone token "CS" (case-insensitive) is a CS employee.
 * - Substring matching (e.g. "ACCESS", "ACCOUNTS") is strictly forbidden.
 * - department === "CS" alone without standalone CS token is NOT sufficient.
 * - Non-CS employees (e.g. "Noureldin ahmed", "Jehan data entry", "Mostafa sayed Shipping") MUST NOT enter CS workflows.
 * - Merchants/Accounts (e.g. "ARC SHOES", "Nawal Omran group") MUST NOT enter CS workflows.
 *
 * @param {Object|string} employee - Employee object, name string, or record
 * @param {Map|Object} [dbEmployeesMap] - Optional Employee Master map
 * @returns {boolean}
 */
export function isCsEmployee(employee, dbEmployeesMap = null) {
  if (!employee) return false;

  let rawName = '';
  let dept = '';
  let empId = null;

  if (typeof employee === 'string') {
    rawName = employee.trim();
  } else if (typeof employee === 'object') {
    empId = employee.id || null;
    rawName = String(employee.name || employee.employee_name || employee.display_name || employee.employee || '').trim();
    dept = String(employee.department || '').trim();

    if (!rawName && empId && dbEmployeesMap) {
      const found = dbEmployeesMap.get ? dbEmployeesMap.get(empId) : dbEmployeesMap[empId];
      if (found) {
        rawName = typeof found === 'string' ? found : String(found.name || '').trim();
        dept = dept || (typeof found === 'object' ? String(found.department || '') : '');
      }
    }
  }

  if (!rawName && !dept && !empId) return false;

  // 1. If explicit department is provided on the object
  if (dept) {
    const dUpper = dept.toUpperCase();
    if (dUpper !== 'CS' && !dUpper.includes('CUSTOMER SERVICE')) {
      return false;
    }
    if (dUpper === 'CS' || dUpper.includes('CUSTOMER SERVICE')) {
      return true;
    }
  }

  // 2. Check in provided dbEmployeesMap (Master map)
  if (dbEmployeesMap) {
    const matched = matchEmployeeInMaster(rawName, dbEmployeesMap);
    if (matched) {
      const mDept = String(matched.department || '').trim().toUpperCase();
      if (mDept) {
        return mDept === 'CS' || mDept.includes('CUSTOMER SERVICE');
      }
    }
  }

  // 3. Look up in Employee Master database table
  try {
    let row = null;
    if (empId) {
      row = db.prepare('SELECT name, department FROM employees WHERE id = ?').get(empId);
    }
    if (!row && rawName) {
      row = db.prepare('SELECT name, department FROM employees WHERE name = ? COLLATE NOCASE').get(rawName);
    }
    if (row && row.department) {
      const rDept = String(row.department).trim().toUpperCase();
      return rDept === 'CS' || rDept.includes('CUSTOMER SERVICE');
    }
  } catch (_) {
    // In-memory or detached DB fallback
  }

  // 4. Standalone token "CS" check (case-insensitive) bounded by word boundaries or non-alphanumeric characters
  const csRegex = /(?:^|[^a-zA-Z0-9_])CS(?:[^a-zA-Z0-9_]|$)/i;
  return csRegex.test(rawName);
}

/**
 * Backwards-compatible alias for isCsEmployee
 */
export function isCSName(name, dbEmployeesMap = null) {
  return isCsEmployee(name, dbEmployeesMap);
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
 * Helper to identify Specific Orders columns accurately
 * Resolves ambiguities between Order Code and Merchant Code ("رقم الاوردر" vs "كود التاجر")
 */
export function detectSpecificOrdersHeaders(hdr) {
  let oi = -1, ai = -1, si = -1, di = -1, mi = -1;

  // Pass 1: Strict, high-confidence matches
  hdr.forEach((rawH, i) => {
    const h = String(rawH || '').trim();
    // Order Code:
    if (/رقم\s*الاوردر|رقم\s*الطلب|كود\s*الطلب|كود\s*الاوردر|order\s*(?:code|id|no|num|number)|order_id|order_code/i.test(h) &&
        !/تاجر|merchant|عميل|client/i.test(h)) {
      if (oi === -1) oi = i;
    }
    // Merchant Name / Account:
    if (/اسم\s*التاجر|التاجر|merchant\s*name|merchant|account(?:\s*name)?/i.test(h) &&
        !/كود|code|رقم|id/i.test(h)) {
      if (ai === -1) ai = i;
    }
    // Merchant Code:
    if (/كود\s*التاجر|merchant\s*code|كود\s*العميل/i.test(h)) {
      if (mi === -1) mi = i;
    }
    // Status:
    if (/حالة\s*الاوردر|حالة\s*الطلب|حاله\s*الاوردر|حاله\s*الطلب|الحالة|حالة|حاله|order\s*status|status/i.test(h)) {
      if (si === -1) si = i;
    }
    // Date:
    if (/تاريخ\s*الاوردر|تاريخ\s*الطلب|التاريخ|تاريخ|order\s*date|business\s*date|date|datetime|timestamp/i.test(h)) {
      if (di === -1) di = i;
    }
  });

  // Pass 2: Secondary broader matches if still missing
  hdr.forEach((rawH, i) => {
    const h = String(rawH || '').trim();
    if (oi === -1 && i !== ai && i !== mi && i !== si && i !== di) {
      if (/order|code|كود|رقم/i.test(h) && !/تاجر|merchant|عميل|client/i.test(h)) {
        oi = i;
      }
    }
    if (ai === -1 && i !== oi && i !== mi && i !== si && i !== di) {
      if (/اسم\s*العميل|حساب|store|متجر/i.test(h) && !/كود|code/i.test(h)) {
        ai = i;
      }
    }
  });

  return { oi, ai, si, di, mi };
}

/**
 * Parse Specific Orders File (.xlsx buffer)
 * Strict validation: Must identify Order Code and Merchant/Account columns.
 * Status filtering: rows with blank status are skipped and not counted as New Orders.
 * (Part 4, 30, 54)
 */
export function parseSpecificOrdersBuffer(fileBuffer, targetDate = null, expectedStatus = null) {
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
  let { oi, ai, si, di, mi } = detectSpecificOrdersHeaders(hdr);

  // Fallback checks if header names weren't found
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
      if (c !== oi && c !== si && c !== di && c !== mi) {
        ai = c;
        break;
      }
    }
  }

  if (oi === -1 || ai === -1) {
    throw new Error(
      `Missing required columns: The file header must contain an 'Order Code' (رقم الاوردر / كود الطلب) column and a 'Merchant/Account' (اسم التاجر) column. Found columns: [${hdr.join(', ')}]`
    );
  }

  if (si === -1) {
    // Look for status column or default to none
    hdr.forEach((h, i) => {
      if (i !== oi && i !== ai && i !== di && i !== mi && si === -1) {
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

    const orderCode = oi !== -1 ? String(r[oi] || '').trim() : '';
    let account = ai !== -1 ? String(r[ai] || '').trim() : '';
    const merchantCode = mi !== -1 ? String(r[mi] || '').trim() : null;
    const rawStatus = si !== -1 ? String(r[si] || '').trim() : '';
    const orderDate = di !== -1 ? r[di] : null;

    // Filter out blank or invalid status rows (Mandatory Requirement)
    if (!rawStatus || rawStatus === '-' || rawStatus.toLowerCase() === 'null' || rawStatus.toLowerCase() === 'undefined') {
      skippedRows++;
      continue;
    }

    // Status filtering by expectedStatus if specified
    if (expectedStatus === 'New' || expectedStatus === 'NEW') {
      if (!/new|جديد/i.test(rawStatus)) {
        skippedRows++;
        continue;
      }
    } else if (expectedStatus === 'Pending' || expectedStatus === 'PENDING') {
      if (!/pending|معلق|انتظار/i.test(rawStatus)) {
        skippedRows++;
        continue;
      }
    }

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
      status = rawStatus;
    }

    // Normalize Account display name: strip redundant quotes and multiple spaces
    account = account.replace(/["']/g, '').replace(/\s+/g, ' ').trim();

    if (!ordersMap.has(orderCode)) {
      ordersMap.set(orderCode, {
        order_code: orderCode,
        account,
        merchant_code: merchantCode,
        status,
        order_date: orderDate ? String(orderDate) : null,
      });
      validRows++;
    }
  }

  const orders = Array.from(ordersMap.values());

  if (orders.length === 0) {
    throw new Error('No valid orders found in the uploaded file. Please check row data and ensure order statuses are not blank.');
  }

  // Group orders by detected business date
  const ordersByDate = new Map();
  for (const ord of orders) {
    const rowDate = normalizeDateToISO(ord.order_date) || targetDate || null;
    const dKey = rowDate || 'UNDATED';
    if (!ordersByDate.has(dKey)) {
      ordersByDate.set(dKey, []);
    }
    ordersByDate.get(dKey).push(ord);
  }

  return {
    orders,
    orders_by_date: Object.fromEntries(ordersByDate.entries()),
    summary: {
      totalRows,
      validRows,
      uniqueOrders: orders.length,
      skippedRows,
      skippedReasons,
      detected_dates: Array.from(ordersByDate.keys()).filter(k => k !== 'UNDATED')
    }
  };
}

/**
 * ============================================================
 * AUTOMATIC BUSINESS DATE & SOURCE TYPE DETECTOR
 * (Master Specification & User Request: Mandatory Content-First Date Detection)
 * ============================================================
 */

export function extractDateFromFilename(filename = '') {
  if (!filename || typeof filename !== 'string') return null;
  const clean = filename.trim();

  // 1. YYYY-MM-DD or YYYY_MM_DD
  const mIso = clean.match(/(\d{4})[-_](\d{1,2})[-_](\d{1,2})/);
  if (mIso) {
    const iso = normalizeDateToISO(`${mIso[1]}-${mIso[2]}-${mIso[3]}`);
    if (iso) return iso;
  }

  // 2. DD-MM-YYYY or DD_MM_YYYY
  const mDmy = clean.match(/(\d{1,2})[-_](\d{1,2})[-_](\d{4})/);
  if (mDmy) {
    const iso = normalizeDateToISO(`${mDmy[1]}-${mDmy[2]}-${mDmy[3]}`);
    if (iso) return iso;
  }

  // 3. YYYYMMDD
  const mDense = clean.match(/(?:^|[^0-9])(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:$|[^0-9])/);
  if (mDense) {
    const iso = normalizeDateToISO(`${mDense[1]}-${mDense[2]}-${mDense[3]}`);
    if (iso) return iso;
  }

  return null;
}

export function detectWorkbookDateAndType(fileBuffer, originalFilename = '') {
  let workbook;
  try {
    workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true });
  } catch (err) {
    return {
      success: false,
      source_type: 'UNKNOWN',
      business_date: null,
      error: `Corrupted file: ${err.message}`,
      confidence: 'NONE',
      requires_review: true
    };
  }

  const sheetNames = workbook.SheetNames || [];
  if (sheetNames.length === 0) {
    return {
      success: false,
      source_type: 'UNKNOWN',
      business_date: null,
      error: 'Workbook contains no sheets',
      confidence: 'NONE',
      requires_review: true
    };
  }

  const sheet = workbook.Sheets[sheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  if (!rows || rows.length === 0) {
    return {
      success: false,
      source_type: 'UNKNOWN',
      business_date: null,
      error: 'Sheet is empty',
      confidence: 'NONE',
      requires_review: true
    };
  }

  const headerRow = (rows[0] || []).map(h => String(h || '').trim().toLowerCase());
  const filename = String(originalFilename || '').toLowerCase();
  const filenameDate = extractDateFromFilename(originalFilename);

  // 1. Detect Source Type using dedicated header detectors
  const rawHdr = rows[0] || [];
  const specHdr = detectSpecificOrdersHeaders(rawHdr);
  let hasOrderCode = specHdr.oi !== -1;
  let hasAccount = specHdr.ai !== -1;
  let dateColIdx = specHdr.di;
  let statusColIdx = specHdr.si;

  let hasEmployee = false;
  let hasAction = false;

  headerRow.forEach((h, idx) => {
    if (/الاسم|اسم\s*الموظف|employee|agent|name/i.test(h)) hasEmployee = true;
    if (/الاكشن|الحدث|action|event/i.test(h)) hasAction = true;
  });

  let sourceType = 'UNKNOWN';
  if (hasAction && hasEmployee) {
    sourceType = 'EOD_DAILY_LOG';
    if (dateColIdx === -1) {
      headerRow.forEach((h, idx) => {
        if (dateColIdx === -1 && /تاريخ|التاريخ|date|timestamp|created|time/i.test(h)) dateColIdx = idx;
      });
    }
  } else if (hasOrderCode && hasAccount) {
    // Check status values in non-blank rows
    let newCount = 0;
    let pendingCount = 0;
    const sample = rows.slice(1, 100);
    sample.forEach(r => {
      const rawStatus = statusColIdx !== -1 ? String(r[statusColIdx] || '').trim() : '';
      if (/pending|معلق|انتظار/i.test(rawStatus)) pendingCount++;
      if (/new|جديد/i.test(rawStatus)) newCount++;
    });

    if (filename.includes('pending') || filename.includes('معلق')) {
      sourceType = 'PENDING';
    } else if (filename.includes('new') || filename.includes('جديد')) {
      sourceType = 'NEW';
    } else if (pendingCount > newCount && pendingCount > 0) {
      sourceType = 'PENDING';
    } else if (newCount > pendingCount && newCount > 0) {
      sourceType = 'NEW';
    } else {
      sourceType = 'SPECIFIC_ORDERS';
    }
  } else if (filename.includes('log') || filename.includes('daily') || filename.includes('يومي') || filename.includes('سجل')) {
    sourceType = 'EOD_DAILY_LOG';
  } else if (filename.includes('pending') || filename.includes('معلق')) {
    sourceType = 'PENDING';
  } else if (filename.includes('new') || filename.includes('جديد')) {
    sourceType = 'NEW';
  }

  // 2. Detect Row-Level Business Dates
  const dateCounts = new Map();
  const dataRows = rows.slice(1);

  // If date column was not explicitly identified in header, scan columns for date patterns
  if (dateColIdx === -1 && dataRows.length > 0) {
    for (let c = 0; c < (rows[0] || []).length; c++) {
      let matchCount = 0;
      for (let r = 0; r < Math.min(dataRows.length, 10); r++) {
        const val = dataRows[r][c];
        if (normalizeDateToISO(val)) matchCount++;
      }
      if (matchCount >= Math.min(dataRows.length, 5)) {
        dateColIdx = c;
        break;
      }
    }
  }

  if (dateColIdx !== -1) {
    for (const r of dataRows) {
      if (!r || r.length === 0) continue;
      // If this is a Specific Orders sheet, exclude blank-status rows from date counting
      if (sourceType !== 'EOD_DAILY_LOG' && statusColIdx !== -1) {
        const rawStatus = String(r[statusColIdx] || '').trim();
        if (!rawStatus || rawStatus === '-' || rawStatus.toLowerCase() === 'null' || rawStatus.toLowerCase() === 'undefined') {
          continue;
        }
        if (sourceType === 'NEW' && !/new|جديد/i.test(rawStatus)) {
          continue;
        }
        if (sourceType === 'PENDING' && !/pending|معلق|انتظار/i.test(rawStatus)) {
          continue;
        }
      }
      const iso = normalizeDateToISO(r[dateColIdx]);
      if (iso) {
        dateCounts.set(iso, (dateCounts.get(iso) || 0) + 1);
      }
    }
  }

  // Build detected dates summary
  const detectedDatesList = Array.from(dateCounts.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => b.count - a.count);

  let primaryDate = null;
  let dateConfidence = 'NONE';
  let hasMultipleDates = false;
  let hasDateConflict = false;

  if (detectedDatesList.length > 0) {
    primaryDate = detectedDatesList[0].date;
    dateConfidence = 'HIGH';
    if (detectedDatesList.length > 1) {
      hasMultipleDates = true;
    }
    // Check conflict between row dates and filename date
    if (filenameDate && filenameDate !== primaryDate) {
      hasDateConflict = true;
    }
  } else if (filenameDate) {
    primaryDate = filenameDate;
    dateConfidence = 'MEDIUM';
    detectedDatesList.push({ date: filenameDate, count: dataRows.length, from_filename: true });
  }

  return {
    success: true,
    source_type: sourceType,
    primary_date: primaryDate,
    detected_dates: detectedDatesList,
    total_dates_found: detectedDatesList.length,
    has_multiple_dates: hasMultipleDates,
    has_date_conflict: hasDateConflict,
    filename_date: filenameDate,
    confidence: dateConfidence,
    requires_review: !primaryDate || sourceType === 'UNKNOWN',
    sheet_name: sheetNames[0],
    total_rows: dataRows.length
  };
}

/**
 * Universal Unified Parser for Any Uploaded File
 * Automatically identifies Source Type and groups rows by Business Date
 */
export function parseAnyUploadedBuffer(fileBuffer, originalFilename = '', userOverrideDate = null, dbEmployeesMap = null) {
  const detection = detectWorkbookDateAndType(fileBuffer, originalFilename);
  const effectiveDate = userOverrideDate || detection.primary_date;

  if (detection.source_type === 'EOD_DAILY_LOG') {
    const parsed = parseDailyLogBuffer(fileBuffer, dbEmployeesMap);
    // Group records by row-level date
    const recordsByDate = new Map();
    for (const rec of parsed.records) {
      const recDate = normalizeDateToISO(rec.dt) || effectiveDate || 'UNDATED';
      if (!recordsByDate.has(recDate)) {
        recordsByDate.set(recDate, []);
      }
      recordsByDate.get(recDate).push(rec);
    }

    return {
      source_type: 'EOD_DAILY_LOG',
      detection,
      effective_date: effectiveDate,
      records: parsed.records,
      records_by_date: Object.fromEntries(recordsByDate.entries()),
      summary: parsed.summary
    };
  }

  // Specific Orders (New or Pending)
  const expectedStatus = detection.source_type === 'NEW' ? 'New' : (detection.source_type === 'PENDING' ? 'Pending' : null);
  const parsed = parseSpecificOrdersBuffer(fileBuffer, effectiveDate, expectedStatus);
  const ordersByDate = new Map();
  for (const ord of parsed.orders) {
    const rowDate = normalizeDateToISO(ord.order_date) || effectiveDate || 'UNDATED';
    if (!ordersByDate.has(rowDate)) {
      ordersByDate.set(rowDate, []);
    }
    ordersByDate.get(rowDate).push(ord);
  }

  return {
    source_type: detection.source_type,
    detection,
    effective_date: effectiveDate,
    orders: parsed.orders,
    orders_by_date: Object.fromEntries(ordersByDate.entries()),
    summary: parsed.summary
  };
}
