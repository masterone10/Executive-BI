/**
 * services/time_utils.js
 * Canonical Time & Timezone Engine (Africa/Cairo)
 * Single source of truth for business dates, Cairo timestamps, and live vs historical time checks.
 */

export const BUSINESS_TIMEZONE = 'Africa/Cairo';

/**
 * Returns current business date in Africa/Cairo as YYYY-MM-DD
 */
export function getCairoBusinessDate(refDate = new Date()) {
  const d = refDate instanceof Date ? refDate : new Date(refDate);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(d);
}

/**
 * Checks if a given workDate is today's current business date in Africa/Cairo
 */
export function isTodayBusinessDate(workDate, refDate = new Date()) {
  if (!workDate) return false;
  const cairoToday = getCairoBusinessDate(refDate);
  return String(workDate).trim() === cairoToday;
}

/**
 * Checks if a given workDate is strictly in the past (historical) relative to Cairo today
 */
export function isHistoricalBusinessDate(workDate, refDate = new Date()) {
  if (!workDate) return false;
  const cairoToday = getCairoBusinessDate(refDate);
  return String(workDate).trim() < cairoToday;
}

/**
 * Returns the current time in Africa/Cairo as an ISO-like string with local offset
 */
export function getCairoNow(refDate = new Date()) {
  const d = refDate instanceof Date ? refDate : new Date(refDate);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(d).replace(' ', 'T');
}

/**
 * Parse a timestamp string deterministically in Africa/Cairo timezone if no offset is present
 */
export function parseCairoTimestamp(tsStr) {
  if (!tsStr) return null;
  const str = String(tsStr).trim();
  // If string contains explicit Z or +/- timezone offset, parse natively
  if (/Z|[+-]\d{2}:?\d{2}$/i.test(str)) {
    const dt = new Date(str);
    return isNaN(dt.getTime()) ? null : dt;
  }

  // Normalize separator
  const normalized = str.replace(' ', 'T');
  // Africa/Cairo is normally UTC+2 (or UTC+3 during DST).
  // Parse year, month, day, hour, minute, second
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) {
    const dt = new Date(str);
    return isNaN(dt.getTime()) ? null : dt;
  }

  const [_, y, m, d, hh = '00', mm = '00', ss = '00'] = match;
  // Construct UTC representation treating this as Cairo local time
  // Using Intl to find the exact offset for Africa/Cairo on that date
  const approximateUtc = new Date(Date.UTC(+y, +m - 1, +d, +hh, +mm, +ss));
  const cairoParts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    timeZoneName: 'shortOffset',
    hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric'
  }).formatToParts(approximateUtc);

  const tzPart = cairoParts.find(p => p.type === 'timeZoneName');
  let offsetHours = 2; // Default Cairo offset
  if (tzPart && tzPart.value) {
    const mOffset = tzPart.value.match(/GMT([+-]\d+)/);
    if (mOffset) offsetHours = parseInt(mOffset[1], 10);
  }

  // Local Cairo time = UTC + offsetHours => UTC = Local - offsetHours
  const exactUtcMs = Date.UTC(+y, +m - 1, +d, +hh - offsetHours, +mm, +ss);
  return new Date(exactUtcMs);
}

/**
 * Format a timestamp for display in Africa/Cairo (e.g., 02:30:15 PM)
 */
export function formatCairoTime(ts, includeSeconds = true) {
  if (!ts) return '—';
  const dt = ts instanceof Date ? ts : parseCairoTimestamp(ts);
  if (!dt || isNaN(dt.getTime())) return String(ts);

  return new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: includeSeconds ? '2-digit' : undefined,
    hour12: true
  }).format(dt);
}

/**
 * Format idle duration in seconds into human-readable string
 */
export function formatIdleDuration(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds) || seconds < 0) {
    return '—';
  }
  const totalSecs = Math.floor(seconds);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  if (hrs > 0) {
    return `${hrs}h ${mins}m`;
  }
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

/**
 * Diagnostic payload for time configuration
 */
export function getTimeDiagnostic() {
  const now = new Date();
  return {
    business_timezone: BUSINESS_TIMEZONE,
    server_time_iso: now.toISOString(),
    utc_time_iso: now.toISOString(),
    cairo_time_iso: getCairoNow(now),
    derived_business_date: getCairoBusinessDate(now),
    server_local_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
}
