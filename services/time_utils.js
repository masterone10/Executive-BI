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
 * Format relative time ago (e.g. 3m ago, or Historical if historical date)
 */
export function formatTimeAgo(ts, refDate = new Date(), isHistorical = false) {
  if (!ts) return '—';
  if (isHistorical) return 'Historical';
  const dt = ts instanceof Date ? ts : parseCairoTimestamp(ts);
  if (!dt || isNaN(dt.getTime())) return '—';
  const refMs = refDate instanceof Date ? refDate.getTime() : new Date(refDate).getTime();
  const diffSec = Math.max(0, Math.floor((refMs - dt.getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) {
    const mins = Math.floor((diffSec % 3600) / 60);
    return `${Math.floor(diffSec / 3600)}h ${mins}m ago`;
  }
  return `${Math.floor(diffSec / 86400)}d ago`;
}

/**
 * Normalizes a time string (e.g. "17:00", "17:00:00", "05:30 PM") into wall-clock seconds from midnight [0, 86399].
 * Returns null if invalid or empty.
 */
export function normalizeTimeToSeconds(timeStr) {
  if (timeStr === undefined || timeStr === null || String(timeStr).trim() === '') {
    return null;
  }
  const s = String(timeStr).trim().toUpperCase();
  
  // Format: "HH:mm:ss" or "HH:mm" (24h)
  const match24 = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match24) {
    const h = parseInt(match24[1], 10);
    const m = parseInt(match24[2], 10);
    const sec = match24[3] ? parseInt(match24[3], 10) : 0;
    if (h >= 0 && h <= 24 && m >= 0 && m < 60 && sec >= 0 && sec < 60) {
      if (h === 24 && m === 0 && sec === 0) return 86400; // end of day boundary
      return h * 3600 + m * 60 + sec;
    }
  }

  // Format: "HH:mm:ss AM/PM" or "HH:mm AM/PM" (12h)
  const match12 = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (match12) {
    let h = parseInt(match12[1], 10);
    const m = parseInt(match12[2], 10);
    const sec = match12[3] ? parseInt(match12[3], 10) : 0;
    const isPm = match12[4].toUpperCase() === 'PM';
    if (h === 12) h = isPm ? 12 : 0;
    else if (isPm) h += 12;
    if (h >= 0 && h < 24 && m >= 0 && m < 60 && sec >= 0 && sec < 60) {
      return h * 3600 + m * 60 + sec;
    }
  }

  return null;
}

/**
 * Extracts Africa/Cairo local date (YYYY-MM-DD) and wall-clock seconds from midnight [0, 86399]
 * from any raw timestamp (string, Date, or number).
 */
export function extractCairoDateTimeComponents(rawTimestamp) {
  if (!rawTimestamp) return null;
  const dt = rawTimestamp instanceof Date ? rawTimestamp : parseCairoTimestamp(rawTimestamp);
  if (!dt || isNaN(dt.getTime())) return null;

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  const parts = formatter.formatToParts(dt);
  let y = '', m = '', d = '', h = 0, min = 0, s = 0;
  for (const p of parts) {
    if (p.type === 'year') y = p.value;
    else if (p.type === 'month') m = p.value;
    else if (p.type === 'day') d = p.value;
    else if (p.type === 'hour') h = parseInt(p.value, 10);
    else if (p.type === 'minute') min = parseInt(p.value, 10);
    else if (p.type === 'second') s = parseInt(p.value, 10);
  }

  const cairoDate = `${y}-${m}-${d}`;
  const cairoSeconds = h * 3600 + min * 60 + s;
  const timeFormatted = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  return {
    cairoDate,
    cairoSeconds,
    cairoTimeFormatted: timeFormatted,
    hour: h,
    minute: min,
    second: s,
    epochMs: dt.getTime()
  };
}

/**
 * Checks if an event timestamp is within a specified time window for a given business date.
 * Strictly uses half-open interval: [fromSec <= eventSec < toSec]
 *
 * @param {string|Date} rawTimestamp - Event timestamp
 * @param {string} workDate - YYYY-MM-DD business date
 * @param {string} [fromTime] - e.g. "17:00" or "17:00:00"
 * @param {string} [toTime] - e.g. "18:00" or "18:00:00"
 * @returns {boolean}
 */
export function isEventInTimeWindow(rawTimestamp, workDate, fromTime, toTime) {
  if (!rawTimestamp || !workDate) return false;
  const comps = extractCairoDateTimeComponents(rawTimestamp);
  if (!comps) return false;

  // Strict Date check: Event must belong to workDate in Africa/Cairo
  if (comps.cairoDate !== String(workDate).trim()) {
    return false;
  }

  // If no time window specified, full day is included
  const fromSec = normalizeTimeToSeconds(fromTime);
  const toSec = normalizeTimeToSeconds(toTime);

  if (fromSec === null || toSec === null) {
    return true;
  }

  // Standard half-open interval [from, to): START <= event_time < END
  if (fromSec <= toSec) {
    return comps.cairoSeconds >= fromSec && comps.cairoSeconds < toSec;
  } else {
    // Spanning overnight / midnight
    return comps.cairoSeconds >= fromSec || comps.cairoSeconds < toSec;
  }
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
