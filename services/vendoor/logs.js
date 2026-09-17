/**
 * Vendoor Logs Connector (Autonomous Multi-Day & Single-Day Log Intelligence)
 *
 * Responsibilities:
 * - Fetch any requested date range (1 day, 2 days, 3 days, 30 days, etc.) from authenticated Vendoor endpoints
 * - Transparently partition larger multi-day date ranges into safe provider chunks (e.g. 2 days)
 * - Seamlessly merge and deduplicate log records across chunks
 * - Supports xls/all export endpoint & system log endpoints
 * - Parses Excel workbooks, CSV, and JSON representations safely via SheetJS
 * - Computes diagnostic summary metrics (rows, unique employees, actions, date range)
 * - Strict isolation: Never automatically creates employees or alters performance data
 */

import * as XLSX from 'xlsx';
import { vendoorFetch, VendoorClientError } from './client.js';
import { normalizeVendoorLogRow, summarizeNormalizedLogs } from './normalize.js';

/**
 * Validate date format (YYYY-MM-DD)
 */
export function isValidISODate(dStr) {
  return typeof dStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dStr);
}

/**
 * Split a date range (startDate to endDate) into sequential sub-ranges of up to maxChunkDays each.
 *
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 * @param {number} [maxChunkDays=2]
 * @returns {Array<{ start: string, end: string }>}
 */
export function partitionDateRange(startDate, endDate, maxChunkDays = 2) {
  const chunks = [];
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');

  let currentStart = new Date(start.getTime());

  while (currentStart <= end) {
    const currentEnd = new Date(currentStart.getTime());
    currentEnd.setUTCDate(currentEnd.getUTCDate() + (maxChunkDays - 1));

    const chunkEnd = currentEnd > end ? new Date(end.getTime()) : currentEnd;

    chunks.push({
      start: currentStart.toISOString().slice(0, 10),
      end: chunkEnd.toISOString().slice(0, 10)
    });

    // Advance to next day after chunkEnd
    const nextStart = new Date(chunkEnd.getTime());
    nextStart.setUTCDate(nextStart.getUTCDate() + 1);
    currentStart = nextStart;
  }

  return chunks;
}

/**
 * Fetch a single chunk of logs directly from Vendoor endpoint
 *
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 */
async function fetchSingleLogsChunk(startDate, endDate) {
  const endpoint = `/dashboard/log/xls/all?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`;

  const { response, durationMs, contentType, status } = await vendoorFetch(endpoint, {
    method: 'GET',
    headers: {
      'Accept': 'application/vnd.ms-excel, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/json, text/html, */*'
    }
  });

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length === 0) {
    throw new VendoorClientError(
      'Vendoor returned an empty response body for logs export.',
      502,
      'EMPTY_RESPONSE',
      { durationMs, status, contentType }
    );
  }

  // Check if response is HTML login page
  const textPrefix = buffer.slice(0, 400).toString('utf8');
  if (textPrefix.includes('<html') || textPrefix.includes('<!DOCTYPE') || textPrefix.includes('login') || textPrefix.includes('csrf')) {
    if (textPrefix.includes('name="email"') || textPrefix.includes('type="password"')) {
      throw new VendoorClientError(
        'Vendoor returned an HTML login page instead of the log file. Session cookie or authentication has expired.',
        401,
        'HTML_LOGIN_REDIRECT',
        { durationMs, status, preview: textPrefix.slice(0, 150) }
      );
    }
  }

  let rawRows = [];

  // Try parsing as JSON first if header indicates or starts with [ or {
  if (contentType.includes('application/json') || textPrefix.trim().startsWith('{') || textPrefix.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(buffer.toString('utf8'));
      rawRows = Array.isArray(parsed) ? parsed : (parsed.data || parsed.logs || []);
    } catch {
      // Fallback to Excel parsing
    }
  }

  // If not JSON, parse as Excel workbook via SheetJS
  if (rawRows.length === 0) {
    try {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const firstSheetName = workbook.SheetNames[0];
      if (firstSheetName) {
        const worksheet = workbook.Sheets[firstSheetName];
        rawRows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
      }
    } catch (parseErr) {
      throw new VendoorClientError(
        `Failed to parse Vendoor log export workbook: ${parseErr.message}`,
        502,
        'EXCEL_PARSE_ERROR',
        { durationMs, rawError: parseErr.message, sizeBytes: buffer.length }
      );
    }
  }

  const normalizedLogs = rawRows.map(normalizeVendoorLogRow).filter(Boolean);

  return {
    rawRowsCount: rawRows.length,
    normalizedLogs,
    durationMs,
    contentType,
    status,
    fileSizeBytes: buffer.length
  };
}

/**
 * Fetch logs for an arbitrary date range (1 day, 2 days, 3 days, 30 days, etc.)
 * Automatically chunks requests internally for provider stability, then merges and deduplicates.
 *
 * @param {Object} options
 * @param {string} options.startDate YYYY-MM-DD
 * @param {string} options.endDate YYYY-MM-DD
 * @param {number} [options.chunkDays=2] Max days per internal request chunk
 */
export async function fetchVendoorLogsRange(options = {}) {
  const startDate = options.startDate || options.start_date || '';
  const endDate = options.endDate || options.end_date || startDate;

  if (!isValidISODate(startDate)) {
    throw new VendoorClientError(
      `Invalid startDate "${startDate}". Format must be YYYY-MM-DD.`,
      400,
      'INVALID_DATE_FORMAT'
    );
  }

  if (!isValidISODate(endDate)) {
    throw new VendoorClientError(
      `Invalid endDate "${endDate}". Format must be YYYY-MM-DD.`,
      400,
      'INVALID_DATE_FORMAT'
    );
  }

  if (startDate > endDate) {
    throw new VendoorClientError(
      `startDate "${startDate}" cannot be after endDate "${endDate}".`,
      400,
      'INVALID_DATE_RANGE'
    );
  }

  const chunkDays = Math.max(1, Math.min(7, parseInt(options.chunkDays, 10) || 2));
  const chunks = partitionDateRange(startDate, endDate, chunkDays);

  const allLogs = [];
  const seenEventKeys = new Set();
  let totalDurationMs = 0;
  let totalSizeBytes = 0;
  let lastStatus = 200;
  let lastContentType = 'application/vnd.ms-excel';

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    // Polite throttle between consecutive chunk requests
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 80));
    }

    const res = await fetchSingleLogsChunk(chunk.start, chunk.end);
    totalDurationMs += res.durationMs;
    totalSizeBytes += res.fileSizeBytes;
    lastStatus = res.status;
    lastContentType = res.contentType;

    for (const log of res.normalizedLogs) {
      // Deterministic deduplication key across chunk boundaries
      const eventKey = `${log.order_code || ''}|${log.timestamp || log.date || ''}|${log.employee_name || ''}|${log.action || ''}`;
      if (!seenEventKeys.has(eventKey)) {
        seenEventKeys.add(eventKey);
        allLogs.push(log);
      }
    }
  }

  const summary = summarizeNormalizedLogs(allLogs);

  return {
    success: true,
    resource: 'logs',
    http_status: lastStatus,
    duration_ms: totalDurationMs,
    content_type: lastContentType,
    file_size_bytes: totalSizeBytes,
    chunks_requested: chunks.length,
    requested_range: {
      start_date: startDate,
      end_date: endDate
    },
    total_logs_count: allLogs.length,
    summary,
    sample_rows: allLogs.slice(0, 10),
    logs: allLogs
  };
}
