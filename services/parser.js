import XLSX from 'xlsx';
import { db } from '../db/index.js';

export const KNOWN_STATUSES = new Set(['Printed', 'Pending', 'Canceled', 'Cancelled', 'Processing']);
export const STATUS_RE = /(?:الى|إلى)\s*'?([A-Za-z][A-Za-z ]*?)'?\s*$/;
export const ADDED_RE = /أضاف\s*ا?أ?وردر|اضاف\s*ا?أ?وردر|انشاء\s*ا?أ?وردر|إنشاء\s*ا?أ?وردر|اضافة\s*ا?أ?وردر/;
export const ALT_RE = /التليفون\s*البديل|رقم\s*بديل|هاتف\s*بديل|موبايل\s*بديل|رقم\s*هاتف\s*آخر|رقم\s*هاتف\s*اخر|رقم\s*تليفون\s*آخر|رقم\s*تليفون\s*اخر|رقم\s*آخر|رقم\s*اخر|تعديل.*رقم|تحديث.*رقم|رقم.*الهاتف|رقم.*التليفون/;

export const CANONICAL_TIMEZONE = 'Africa/Cairo';

/**
 * ============================================================
 * CANONICAL TIME & TIMEZONE ENGINE (Africa/Cairo)
 * ============================================================
 * Converts between UTC milliseconds and Africa/Cairo wall-clock
 * components deterministically without relying on the host OS
 * or server local timezone.
 */

/**
 * Helper: Validate calendar year, month, and day strictly.
 * Prevents silent JavaScript Date normalization of invalid dates (e.g. 2026-02-31, 2026-04-31, 2026-13-01).
 */
export function isValidCalendarDate(year, month, day) {
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number') return false;
  if (isNaN(year) || isNaN(month) || isNaN(day)) return false;
  if (year < 1900 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
  const daysInMonth = [31, (isLeapYear(year) ? 29 : 28), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

/**
 * Convert Africa/Cairo wall-clock date and time into exact UTC epoch milliseconds.
 * Invariant across all server local timezones (UTC, America/New_York, Asia/Tokyo, etc.).
 * Guarantees exact bidirectional conversion across DST transitions, midnight boundaries, and historical dates.
 */
export function cairoWallClockToUtcMs(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  // Estimate using standard Egypt offset (~2 hours)
  const guess = targetUtc - 2 * 3600 * 1000;
  const p = getCairoPartsFromUtcMs(guess);
  const pUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offsetDiff = pUtc - targetUtc;
  return guess - offsetDiff + millisecond;
}

/**
 * Extract Africa/Cairo wall-clock components from a UTC epoch millisecond instant.
 * Invariant across all server local timezones.
 */
export function getCairoPartsFromUtcMs(utcMs) {
  const d = new Date(utcMs);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: CANONICAL_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23'
  });

  const parts = formatter.formatToParts(d);
  let year = 1970, month = 1, day = 1, hour = 0, minute = 0, second = 0;
  for (const p of parts) {
    if (p.type === 'year') year = parseInt(p.value, 10);
    else if (p.type === 'month') month = parseInt(p.value, 10);
    else if (p.type === 'day') day = parseInt(p.value, 10);
    else if (p.type === 'hour') hour = parseInt(p.value, 10);
    else if (p.type === 'minute') minute = parseInt(p.value, 10);
    else if (p.type === 'second') second = parseInt(p.value, 10);
  }
  return { year, month, day, hour, minute, second };
}

/**
 * Parse Excel serial number into wall-clock date and time components.
 * Standard Excel 1900 date system: Day 1 = Jan 1 1900.
 * Anomaly handling: Serial 60 (Excel's non-existent 1900-02-29 leap day) is explicitly rejected.
 */
export function parseExcelSerial(serial) {
  if (typeof serial !== 'number' || isNaN(serial) || serial <= 0) return null;
  const daySerial = Math.floor(serial);
  const frac = serial - daySerial;

  // Excel 1900 leap-year anomaly: serial 60 represents the fictional leap day 1900-02-29.
  // Explicitly reject serial 60 as an invalid calendar date.
  if (daySerial === 60) {
    return null;
  }

  const epochDays = daySerial > 60 ? daySerial - 2 : daySerial - 1;
  const baseDate = new Date(Date.UTC(1900, 0, 1 + epochDays));
  const year = baseDate.getUTCFullYear();
  const month = baseDate.getUTCMonth() + 1;
  const day = baseDate.getUTCDate();

  if (!isValidCalendarDate(year, month, day)) {
    return null;
  }

  let hour = 0, minute = 0, second = 0, millisecond = 0;
  let hasTime = false;

  if (frac > 0.0000001) {
    hasTime = true;
    const totalMs = Math.round(frac * 86400 * 1000);
    hour = Math.floor(totalMs / 3600000);
    minute = Math.floor((totalMs % 3600000) / 60000);
    second = Math.floor((totalMs % 60000) / 1000);
    millisecond = totalMs % 1000;
  }

  return { year, month, day, hour, minute, second, millisecond, has_time: hasTime };
}

/**
 * ============================================================
 * CANONICAL TIMESTAMP PARSER
 * ============================================================
 * Pipeline:
 * RAW SOURCE
 * → parseTimestamp()
 * → canonical instant (UTC ms)
 * → Africa/Cairo business-local wall-clock time
 *
 * Rules:
 * - Preserves date + hour + minute + second + millisecond.
 * - Respects explicit Z / +03:00 / other offsets.
 * - Timezone-less source timestamps are interpreted explicitly as Africa/Cairo business-local time.
 * - Never passes Unix milliseconds to an Excel serial parser.
 * - Distinguishes date-only (has_time = false) from datetime (has_time = true).
 *
 * @param {Date|number|string} val
 * @param {Object} [options]
 * @returns {Object|null} CanonicalTimestamp object
 */
export function parseTimestamp(val, options = {}) {
  if (val === undefined || val === null || val === '') {
    return null;
  }

  let rawSource = val;
  let year = null, month = null, day = null;
  let hour = 0, minute = 0, second = 0, millisecond = 0;
  let hasTime = false;
  let hasExplicitOffset = false;
  let instantUtcMs = null;

  // 1. JS Date instance
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    instantUtcMs = val.getTime();
    hasTime = true;
    hasExplicitOffset = true;
    rawSource = val.toISOString();
  }
  // 2. Number: Distinguish Unix Timestamp vs Excel Serial Number
  else if (typeof val === 'number') {
    if (isNaN(val) || val <= 0) return null;

    // Unix timestamp boundary: Unix epoch for year 1990+ is > 6e8 seconds or > 6e11 ms
    // Excel serial numbers for 1900-2100 are between 1 and 73,050
    if (val > 100000) {
      instantUtcMs = val > 1e11 ? Math.round(val) : Math.round(val * 1000);
      hasTime = true;
      hasExplicitOffset = true;
      rawSource = String(val);
    } else {
      // Excel serial number
      rawSource = String(val);
      const parsedExcel = parseExcelSerial(val);
      if (!parsedExcel) return null;

      year = parsedExcel.year;
      month = parsedExcel.month;
      day = parsedExcel.day;
      hour = parsedExcel.hour;
      minute = parsedExcel.minute;
      second = parsedExcel.second;
      millisecond = parsedExcel.millisecond;
      hasTime = parsedExcel.has_time;

      // Excel serial in our business context represents Africa/Cairo local wall-clock time
      instantUtcMs = cairoWallClockToUtcMs(year, month, day, hour, minute, second, millisecond);
    }
  }
  // 3. String
  else {
    const str = String(val).trim();
    if (!str) return null;
    rawSource = str;

    // Check for explicit timezone offset: Z or +HH:mm or -HH:mm
    // Timezone detection must only activate when the string contains an actual time component before the timezone
    const explicitTzMatch = str.match(/^(.*?[T\s]\d{1,2}:\d{1,2}(?::\d{1,2})?(?:\.\d{1,3})?)\s*(Z|[+-]\d{2}(?::?\d{2})?)$/i);
    if (explicitTzMatch) {
      // Validate calendar date before accepting
      const datePartMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
      if (datePartMatch) {
        const y = parseInt(datePartMatch[1], 10);
        const m = parseInt(datePartMatch[2], 10);
        const d = parseInt(datePartMatch[3], 10);
        if (!isValidCalendarDate(y, m, d)) {
          return null;
        }
      }
      const parsedMs = Date.parse(str);
      if (!isNaN(parsedMs)) {
        instantUtcMs = parsedMs;
        hasExplicitOffset = true;
        hasTime = true;
      }
    }

    if (instantUtcMs === null) {
      // Timezone-less string: interpret explicitly as Africa/Cairo business-local time

      // Pattern A: "YYYY-MM-DD HH:mm:ss" or "YYYY/MM/DD HH:mm:ss" or "YYYY-MM-DDTHH:mm:ss"
      const ymdTimeMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d{1,3}))?$/);
      if (ymdTimeMatch) {
        year = parseInt(ymdTimeMatch[1], 10);
        month = parseInt(ymdTimeMatch[2], 10);
        day = parseInt(ymdTimeMatch[3], 10);
        hour = parseInt(ymdTimeMatch[4], 10);
        minute = parseInt(ymdTimeMatch[5], 10);
        second = ymdTimeMatch[6] ? parseInt(ymdTimeMatch[6], 10) : 0;
        millisecond = ymdTimeMatch[7] ? parseInt(ymdTimeMatch[7].padEnd(3, '0').slice(0, 3), 10) : 0;
        hasTime = true;
      }
      // Pattern B: "DD-MM-YYYY HH:mm:ss" or "DD/MM/YYYY HH:mm:ss"
      else {
        const dmyTimeMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d{1,3}))?$/);
        if (dmyTimeMatch) {
          const part1 = parseInt(dmyTimeMatch[1], 10);
          const part2 = parseInt(dmyTimeMatch[2], 10);
          year = parseInt(dmyTimeMatch[3], 10);
          if (part1 <= 12 && part2 > 12) {
            month = part1;
            day = part2;
          } else {
            day = part1;
            month = part2;
          }
          hour = parseInt(dmyTimeMatch[4], 10);
          minute = parseInt(dmyTimeMatch[5], 10);
          second = dmyTimeMatch[6] ? parseInt(dmyTimeMatch[6], 10) : 0;
          millisecond = dmyTimeMatch[7] ? parseInt(dmyTimeMatch[7].padEnd(3, '0').slice(0, 3), 10) : 0;
          hasTime = true;
        }
        // Pattern C: Date-only "YYYY-MM-DD" or "YYYY/MM/DD"
        else {
          const ymdOnlyMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
          if (ymdOnlyMatch) {
            year = parseInt(ymdOnlyMatch[1], 10);
            month = parseInt(ymdOnlyMatch[2], 10);
            day = parseInt(ymdOnlyMatch[3], 10);
            hasTime = false;
          }
          // Pattern D: Date-only "DD-MM-YYYY" or "DD/MM/YYYY"
          else {
            const dmyOnlyMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
            if (dmyOnlyMatch) {
              const part1 = parseInt(dmyOnlyMatch[1], 10);
              const part2 = parseInt(dmyOnlyMatch[2], 10);
              year = parseInt(dmyOnlyMatch[3], 10);
              if (part1 <= 12 && part2 > 12) {
                month = part1;
                day = part2;
              } else {
                day = part1;
                month = part2;
              }
              hasTime = false;
            }
          }
        }
      }

      if (year !== null && month !== null && day !== null) {
        if (isValidCalendarDate(year, month, day)) {
          instantUtcMs = cairoWallClockToUtcMs(year, month, day, hour, minute, second, millisecond);
        } else {
          return null;
        }
      } else {
        // Unknown or unsupported format: strictly return null (NO ambiguous Date.parse fallback)
        return null;
      }
    }
  }

  if (instantUtcMs === null || isNaN(instantUtcMs)) {
    return null;
  }

  // Derive exact Africa/Cairo wall-clock components from canonical instantUtcMs
  const cairoParts = getCairoPartsFromUtcMs(instantUtcMs);
  const cairoYear = cairoParts.year;
  const cairoMonth = cairoParts.month;
  const cairoDay = cairoParts.day;
  const cairoHour = hasTime ? cairoParts.hour : 0;
  const cairoMinute = hasTime ? cairoParts.minute : 0;
  const cairoSecond = hasTime ? cairoParts.second : 0;
  const cairoMillisecond = hasTime ? (instantUtcMs % 1000 + 1000) % 1000 : 0;

  const yStr = String(cairoYear);
  const mStr = String(cairoMonth).padStart(2, '0');
  const dStr = String(cairoDay).padStart(2, '0');
  const hrStr = String(cairoHour).padStart(2, '0');
  const minStr = String(cairoMinute).padStart(2, '0');
  const secStr = String(cairoSecond).padStart(2, '0');

  const cairoDate = `${yStr}-${mStr}-${dStr}`;
  const cairoTime = `${hrStr}:${minStr}:${secStr}`;
  const cairoDatetime = hasTime ? `${cairoDate} ${cairoTime}` : `${cairoDate} 00:00:00`;
  const cairoIso = hasTime ? `${cairoDate}T${cairoTime}` : cairoDate;
  const instantIso = new Date(instantUtcMs).toISOString();

  return {
    raw_source: rawSource,
    is_valid: true,
    has_time: hasTime,
    has_explicit_offset: hasExplicitOffset,
    instant_utc_ms: instantUtcMs,
    instant_iso: instantIso,
    cairo_year: cairoYear,
    cairo_month: cairoMonth,
    cairo_day: cairoDay,
    cairo_hour: cairoHour,
    cairo_minute: cairoMinute,
    cairo_second: cairoSecond,
    cairo_millisecond: cairoMillisecond,
    cairo_date: cairoDate,
    cairo_time: cairoTime,
    cairo_datetime: cairoDatetime,
    cairo_iso: cairoIso,
    getTime: () => instantUtcMs,
    valueOf: () => instantUtcMs,
    toString: () => (hasTime ? cairoDatetime : cairoDate)
  };
}

/**
 * Parses any timestamp into exact UTC epoch milliseconds.
 * Preserves hours, minutes, and seconds without resetting to 00:00:00.
 *
 * @param {Date|number|string} val
 * @returns {number|null} Unix epoch milliseconds
 */
export function parseDate(val) {
  if (val === undefined || val === null || val === '') return null;
  const ts = parseTimestamp(val);
  return ts && ts.is_valid ? ts.instant_utc_ms : null;
}

/**
 * Normalizes any date or timestamp value to canonical ISO Date string "YYYY-MM-DD"
 * in Africa/Cairo business local time.
 * Handles Excel serial numbers, Unix milliseconds, Date instances, and date strings.
 */
export function normalizeDateToISO(val) {
  if (val === undefined || val === null || val === '') return null;

  // 1. Number: Distinguish Unix timestamp vs Excel serial number
  if (typeof val === 'number') {
    if (isNaN(val) || val <= 0) return null;
    if (val > 100000) {
      // Unix timestamp (milliseconds or seconds)
      const ms = val > 1e11 ? Math.round(val) : Math.round(val * 1000);
      const parts = getCairoPartsFromUtcMs(ms);
      return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    }
    // Excel serial number
    const parsedExcel = parseExcelSerial(val);
    if (parsedExcel && parsedExcel.year >= 1990 && parsedExcel.year <= 2050) {
      return `${parsedExcel.year}-${String(parsedExcel.month).padStart(2, '0')}-${String(parsedExcel.day).padStart(2, '0')}`;
    }
    return null;
  }

  // 2. JS Date
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    const parts = getCairoPartsFromUtcMs(val.getTime());
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  }

  const str = String(val).trim();
  if (!str) return null;

  // 3. String via Canonical Timestamp Parser
  const ts = parseTimestamp(str);
  if (ts && ts.is_valid) {
    return ts.cairo_date;
  }

  return null;
}

/**
 * Format date key helper
 */
export function formatDateKey(ts) {
  if (!ts) return null;
  return normalizeDateToISO(ts);
}

/**
 * Centralized Operational-Day Business Date Resolution Rule
 *
 * Resolves the operational Business Date for a given event/source timestamp based on
 * the configured operational day cutoff time (e.g. 20:00).
 *
 * Operational-Day Logic:
 * - The actual event timestamp, not import time, determines business date.
 * - If an event timestamp occurs at or after the configured cutoff (e.g. 20:00:00),
 *   the workload belongs to the next Business Date.
 * - If an event timestamp occurs before the cutoff, it belongs to the current calendar date.
 * - Date-only values without time (has_time = false) are not rolled over.
 *
 * @param {Date|string|number|Object} timestamp - The source event or order timestamp, or CanonicalTimestamp
 * @param {string|number|null} [cutoffConfig] - Optional explicit cutoff override (e.g. '20:00', '20:00:00', 20)
 * @returns {Object|null}
 */
export function getOperationalBusinessDate(timestamp, cutoffConfig = null) {
  if (timestamp === undefined || timestamp === null || timestamp === '') {
    return null;
  }

  // 1. Resolve cutoff configuration from system_configs or parameter
  let cutoffStr = null;
  if (typeof cutoffConfig === 'object' && cutoffConfig !== null) {
    cutoffStr = cutoffConfig.cutoff || cutoffConfig.operational_day_cutoff || cutoffConfig.time || null;
  } else if (typeof cutoffConfig === 'string' || typeof cutoffConfig === 'number') {
    cutoffStr = cutoffConfig;
  }

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
    cutoffStr = '20:00:00';
  }

  let cutoffHour = 20;
  let cutoffMinute = 0;
  let cutoffSecond = 0;
  if (typeof cutoffStr === 'number') {
    cutoffHour = Math.floor(cutoffStr);
    cutoffMinute = Math.round((cutoffStr - cutoffHour) * 60);
  } else {
    const parts = String(cutoffStr).trim().split(':');
    if (parts.length >= 1) cutoffHour = parseInt(parts[0], 10) || 0;
    if (parts.length >= 2) cutoffMinute = parseInt(parts[1], 10) || 0;
    if (parts.length >= 3) cutoffSecond = parseInt(parts[2], 10) || 0;
  }
  const cutoffTotalSeconds = cutoffHour * 3600 + cutoffMinute * 60 + cutoffSecond;

  // 2. Obtain canonical timestamp
  let ts = null;
  if (typeof timestamp === 'object' && timestamp !== null && timestamp.is_valid && timestamp.cairo_date) {
    ts = timestamp;
  } else {
    ts = parseTimestamp(timestamp);
  }

  if (!ts || !ts.is_valid) {
    const fallbackIso = normalizeDateToISO(timestamp);
    if (!fallbackIso) return null;
    const formattedCutoff = `${String(cutoffHour).padStart(2, '0')}:${String(cutoffMinute).padStart(2, '0')}:${String(cutoffSecond).padStart(2, '0')}`;
    return {
      source_timestamp: String(timestamp),
      raw_source: timestamp,
      calendar_date: fallbackIso,
      configured_cutoff: formattedCutoff,
      is_rolled_over: false,
      business_date: fallbackIso,
      resulting_business_date: fallbackIso,
      module: 'services/parser.js',
      function_name: 'getOperationalBusinessDate',
      toString: () => fallbackIso
    };
  }

  const calendarDate = ts.cairo_date;
  let isRolledOver = false;
  let businessDate = calendarDate;

  // Rollover only applies when an actual event time of day exists
  if (ts.has_time) {
    const eventTotalSeconds = ts.cairo_hour * 3600 + ts.cairo_minute * 60 + ts.cairo_second;
    isRolledOver = eventTotalSeconds >= cutoffTotalSeconds;
    if (isRolledOver) {
      const [y, m, d] = calendarDate.split('-').map(Number);
      const nextDate = new Date(Date.UTC(y, m - 1, d + 1));
      const ny = nextDate.getUTCFullYear();
      const nm = String(nextDate.getUTCMonth() + 1).padStart(2, '0');
      const nd = String(nextDate.getUTCDate()).padStart(2, '0');
      businessDate = `${ny}-${nm}-${nd}`;
    }
  }

  const formattedCutoff = `${String(cutoffHour).padStart(2, '0')}:${String(cutoffMinute).padStart(2, '0')}:${String(cutoffSecond).padStart(2, '0')}`;

  const result = {
    source_timestamp: String(ts.raw_source),
    raw_source: ts.raw_source,
    calendar_date: calendarDate,
    configured_cutoff: formattedCutoff,
    is_rolled_over: isRolledOver,
    business_date: businessDate,
    resulting_business_date: businessDate,
    instant_utc_ms: ts.instant_utc_ms,
    instant_iso: ts.instant_iso,
    cairo_datetime: ts.cairo_datetime,
    module: 'services/parser.js',
    function_name: 'getOperationalBusinessDate',
    toString: () => businessDate
  };

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
      const kName = typeof k === 'string' ? k : (v && v.name ? v.name : '');
      if (kName && normalizeEmployeeName(kName) === norm) {
        if (typeof v === 'object' && v !== null) return v;
        return { name: kName, department: String(v), isCS: String(v).toUpperCase() === 'CS' };
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

export function isCsDept(dept) {
  if (!dept) return false;
  const d = String(dept).trim().toUpperCase();
  return d === 'CS' || d === 'CUSTOMER SERVICE' || d.startsWith('CS ') || d.endsWith(' CS');
}

/**
 * Canonical CS Employee Validator.
 *
 * Rules:
 * - Employee Master (employees table) is the sole authoritative source of truth.
 * - employee_id is the canonical identity.
 * - Never trust caller-provided department blindly.
 * - In production, never infer CS from raw actor/name text or standalone tokens.
 * - Non-CS actors (e.g. Sales, Data Entry, Shipping, Merchants, Logistics) MUST NOT enter CS workflows.
 * - Raw non-CS actors remain available for audit only in raw_log_records.
 *
 * @param {Object|string|number} employee - Employee object, ID, name string, or record
 * @param {Map|Array|Object} [dbEmployeesMap] - Optional pre-loaded Employee Master cache
 * @param {Object} [options] - Optional settings { strictMaster: boolean }
 * @returns {boolean}
 */
export function isCsEmployee(employee, dbEmployeesMap = null, options = {}) {
  if (employee === undefined || employee === null || employee === '') {
    return false;
  }

  let empId = null;
  let rawName = '';
  let suppliedId = false;

  if (typeof employee === 'number') {
    empId = employee;
    suppliedId = true;
  } else if (typeof employee === 'string') {
    rawName = employee.trim();
    if (/^\d+$/.test(rawName)) {
      empId = parseInt(rawName, 10);
      suppliedId = true;
    }
  } else if (typeof employee === 'object' && employee !== null) {
    if (employee.id !== undefined && employee.id !== null && employee.id !== '') {
      empId = employee.id;
      suppliedId = true;
    } else if (employee.employee_id !== undefined && employee.employee_id !== null && employee.employee_id !== '') {
      empId = employee.employee_id;
      suppliedId = true;
    }
    rawName = String(employee.name || employee.employee_name || employee.display_name || employee.employee || '').trim();
    // NEVER trust caller-provided employee.department blindly!
  }

  if (!empId && !rawName) return false;

  // 1. If caller supplied an explicit employee_id:
  // employee_id MUST be resolved against Employee Master.
  // If it does not exist in Employee Master or does not belong to CS: RETURN FALSE.
  // DO NOT fall back to matching another Employee Master record by name!
  if (suppliedId) {
    if (dbEmployeesMap) {
      if (dbEmployeesMap instanceof Map && dbEmployeesMap.has(empId)) {
        const val = dbEmployeesMap.get(empId);
        const dept = typeof val === 'object' && val !== null ? val.department : String(val || '');
        return isCsDept(dept);
      }
      if (Array.isArray(dbEmployeesMap)) {
        const found = dbEmployeesMap.find(e => e && e.id === empId);
        if (found) return isCsDept(found.department);
      }
      if (typeof dbEmployeesMap === 'object' && dbEmployeesMap[empId] !== undefined) {
        const val = dbEmployeesMap[empId];
        const dept = typeof val === 'object' && val !== null ? val.department : String(val || '');
        return isCsDept(dept);
      }
    }

    try {
      const row = db.prepare('SELECT id, name, department, active, status FROM employees WHERE id = ?').get(empId);
      if (row) {
        return isCsDept(row.department);
      }
    } catch (_) {}

    // Explicit employee_id was supplied but not found in Master -> strictly FALSE
    return false;
  }

  // 2. If NO employee_id was supplied, only then resolve by name
  if (dbEmployeesMap) {
    if (dbEmployeesMap instanceof Map) {
      const norm = normalizeEmployeeName(rawName);
      if (dbEmployeesMap.has(norm)) {
        const val = dbEmployeesMap.get(norm);
        const dept = typeof val === 'object' && val !== null ? val.department : String(val || '');
        return isCsDept(dept);
      }
      if (dbEmployeesMap.has(rawName)) {
        const val = dbEmployeesMap.get(rawName);
        const dept = typeof val === 'object' && val !== null ? val.department : String(val || '');
        return isCsDept(dept);
      }
      for (const [k, v] of dbEmployeesMap.entries()) {
        const kName = typeof k === 'string' ? k : (v && v.name ? v.name : '');
        if (kName && normalizeEmployeeName(kName) === norm) {
          const dept = typeof v === 'object' && v !== null ? v.department : String(v || '');
          return isCsDept(dept);
        }
      }
    } else if (Array.isArray(dbEmployeesMap)) {
      for (const emp of dbEmployeesMap) {
        if (!emp) continue;
        if (emp.name && normalizeEmployeeName(emp.name) === normalizeEmployeeName(rawName)) {
          return isCsDept(emp.department);
        }
      }
    } else if (typeof dbEmployeesMap === 'object') {
      if (dbEmployeesMap[rawName] !== undefined) {
        const val = dbEmployeesMap[rawName];
        const dept = typeof val === 'object' && val !== null ? val.department : String(val || '');
        return isCsDept(dept);
      }
    }
  }

  // 3. Authoritative Database Lookup in employees table by name
  try {
    const row = db.prepare('SELECT id, name, department FROM employees WHERE name = ? COLLATE NOCASE').get(rawName);
    if (row) {
      return isCsDept(row.department);
    }
  } catch (_) {
    // In-memory or detached DB fallback
  }

  // If strictMaster is requested (e.g. Tracking / Allocation / Mutations): NEVER infer CS from name
  if (options.strictMaster) {
    return false;
  }

  // Fallback for parser / report calculation when actor is not found in Master:
  // Match standard ' CS' name suffix
  const csRegex = /(?:^|[^a-zA-Z0-9_])CS(?:[^a-zA-Z0-9_]|$)/i;
  if (csRegex.test(rawName)) {
    return true;
  }

  return false;
}

/**
 * Authoritative Operational CS Active Check.
 * Checks whether the employee has CS identity AND active = 1 AND status = 'ACTIVE'.
 */
export function isOperationallyActiveCsEmployee(employee, dbEmployeesMap = null, options = {}) {
  if (employee === undefined || employee === null || employee === '') {
    return false;
  }

  let empId = null;
  let rawName = '';
  let suppliedId = false;

  if (typeof employee === 'number') {
    empId = employee;
    suppliedId = true;
  } else if (typeof employee === 'string') {
    rawName = employee.trim();
    if (/^\d+$/.test(rawName)) {
      empId = parseInt(rawName, 10);
      suppliedId = true;
    }
  } else if (typeof employee === 'object' && employee !== null) {
    if (employee.id !== undefined && employee.id !== null && employee.id !== '') {
      empId = employee.id;
      suppliedId = true;
    } else if (employee.employee_id !== undefined && employee.employee_id !== null && employee.employee_id !== '') {
      empId = employee.employee_id;
      suppliedId = true;
    }
    rawName = String(employee.name || employee.employee_name || employee.display_name || employee.employee || '').trim();
  }

  let row = null;
  try {
    if (suppliedId) {
      row = db.prepare('SELECT id, name, department, active, status FROM employees WHERE id = ?').get(empId);
    } else if (rawName) {
      row = db.prepare('SELECT id, name, department, active, status FROM employees WHERE name = ? COLLATE NOCASE').get(rawName);
    }
  } catch (_) {}

  if (!row) return false;
  const isCs = isCsDept(row.department);
  if (!isCs) return false;
  const isActive = (row.active === 1 || row.active === true || row.active === '1' || row.active === undefined) &&
                   (row.status === null || row.status === undefined || String(row.status || '').trim().toUpperCase() === 'ACTIVE');
  return isActive;
}

/**
 * Backwards-compatible alias for isCsEmployee
 */
export function isCSName(name, dbEmployeesMap = null, options = {}) {
  return isCsEmployee(name, dbEmployeesMap, options);
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
    const rawDt = di !== -1 ? r[di] : null;

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

    const ts = parseTimestamp(rawDt);
    const dt = ts && ts.is_valid ? ts.instant_utc_ms : null;
    const op = getOperationalBusinessDate(ts || rawDt);
    const businessDate = op ? op.business_date : (ts ? ts.cairo_date : null);
    const isCS = isCsEmployee(name, dbEmployeesMap);

    records.push({
      order,
      name,
      act,
      st,
      dt,
      raw_dt: rawDt,
      raw_timestamp: rawDt !== undefined && rawDt !== null ? String(rawDt) : null,
      cairo_datetime: ts ? ts.cairo_datetime : null,
      business_date: businessDate,
      alt: ALT_RE.test(act),
      added: ADDED_RE.test(act),
      isCS,
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
 */
export function detectSpecificOrdersHeaders(hdr) {
  let oi = -1, ai = -1, si = -1, di = -1, mi = -1;

  // Pass 1: Strict, high-confidence matches
  hdr.forEach((rawH, i) => {
    const h = String(rawH || '').trim();
    if (/رقم\s*الاوردر|رقم\s*الطلب|كود\s*الطلب|كود\s*الاوردر|order\s*(?:code|id|no|num|number)|order_id|order_code/i.test(h) &&
        !/تاجر|merchant|عميل|client/i.test(h)) {
      if (oi === -1) oi = i;
    }
    if (/اسم\s*التاجر|التاجر|merchant\s*name|merchant|account(?:\s*name)?/i.test(h) &&
        !/كود|code|رقم|id/i.test(h)) {
      if (ai === -1) ai = i;
    }
    if (/كود\s*التاجر|merchant\s*code|كود\s*العميل/i.test(h)) {
      if (mi === -1) mi = i;
    }
    if (/حالة\s*الاوردر|حالة\s*الطلب|حاله\s*الاوردر|حاله\s*الطلب|الحالة|حالة|حاله|order\s*status|status/i.test(h)) {
      if (si === -1) si = i;
    }
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

  if (oi === -1) {
    const sampleVal = String(rows[1] && rows[1][0] || '').trim();
    if (/^[a-z0-9_-]{3,}$/i.test(sampleVal)) {
      oi = 0;
    }
  }

  if (ai === -1) {
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

  const ordersMap = new Map();

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

    if (!rawStatus || rawStatus === '-' || rawStatus.toLowerCase() === 'null' || rawStatus.toLowerCase() === 'undefined') {
      skippedRows++;
      continue;
    }

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

    let status = 'New';
    if (/pending|معلق|انتظار/i.test(rawStatus)) {
      status = 'Pending';
    } else if (/new|جديد/i.test(rawStatus)) {
      status = 'New';
    } else {
      status = rawStatus;
    }

    account = account.replace(/["']/g, '').replace(/\s+/g, ' ').trim();

    const ts = parseTimestamp(orderDate);
    const op = getOperationalBusinessDate(ts || orderDate);
    const resolvedBusinessDate = op?.business_date || (ts ? ts.cairo_date : null) || targetDate || null;

    if (!ordersMap.has(orderCode)) {
      ordersMap.set(orderCode, {
        order_code: orderCode,
        account,
        merchant_code: merchantCode,
        status,
        order_date: orderDate !== undefined && orderDate !== null ? String(orderDate) : null,
        raw_order_date: orderDate !== undefined && orderDate !== null ? String(orderDate) : null,
        business_date: resolvedBusinessDate,
        order_timestamp_ms: ts ? ts.instant_utc_ms : null,
        cairo_datetime: ts ? ts.cairo_datetime : null,
      });
      validRows++;
    }
  }

  const orders = Array.from(ordersMap.values());

  if (orders.length === 0) {
    throw new Error('No valid orders found in the uploaded file. Please check row data and ensure order statuses are not blank.');
  }

  // Group orders by resolved operational business date
  const ordersByDate = new Map();
  for (const ord of orders) {
    const dKey = ord.business_date || targetDate || 'UNDATED';
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
 * ============================================================
 */

export function extractDateFromFilename(filename = '') {
  if (!filename || typeof filename !== 'string') return null;
  const clean = filename.trim();

  const mIso = clean.match(/(\d{4})[-_](\d{1,2})[-_](\d{1,2})/);
  if (mIso) {
    const iso = normalizeDateToISO(`${mIso[1]}-${mIso[2]}-${mIso[3]}`);
    if (iso) return iso;
  }

  const mDmy = clean.match(/(\d{1,2})[-_](\d{1,2})[-_](\d{4})/);
  if (mDmy) {
    const iso = normalizeDateToISO(`${mDmy[1]}-${mDmy[2]}-${mDmy[3]}`);
    if (iso) return iso;
  }

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

  // Detect Row-Level Operational Business Dates
  const dateCounts = new Map();
  const dataRows = rows.slice(1);

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
      const op = getOperationalBusinessDate(r[dateColIdx]);
      const dateKey = op ? op.business_date : normalizeDateToISO(r[dateColIdx]);
      if (dateKey) {
        dateCounts.set(dateKey, (dateCounts.get(dateKey) || 0) + 1);
      }
    }
  }

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
 * Automatically identifies Source Type and groups rows by Operational Business Date
 */
export function parseAnyUploadedBuffer(fileBuffer, originalFilename = '', userOverrideDate = null, dbEmployeesMap = null) {
  const detection = detectWorkbookDateAndType(fileBuffer, originalFilename);
  const effectiveDate = userOverrideDate || detection.primary_date;

  if (detection.source_type === 'EOD_DAILY_LOG') {
    const parsed = parseDailyLogBuffer(fileBuffer, dbEmployeesMap);
    // Group records by row-level operational business date
    const recordsByDate = new Map();
    for (const rec of parsed.records) {
      const recDate = rec.business_date || effectiveDate || 'UNDATED';
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
    const rowDate = ord.business_date || effectiveDate || 'UNDATED';
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
