/**
 * Vendoor Logs Connector (Phase 1 Access Proof)
 *
 * Responsibilities:
 * - Fetch small date ranges (1-2 days) of logs from authenticated Vendoor endpoints
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
 * Fetch logs for a given date range (1-2 days max recommended for Phase 1)
 *
 * @param {Object} options
 * @param {string} options.startDate YYYY-MM-DD
 * @param {string} options.endDate YYYY-MM-DD
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

  // Phase 1 Rate Limit / Safeguard: Prohibit multi-day scans > 2 days
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  const diffDays = Math.round((endMs - startMs) / (1000 * 60 * 60 * 24)) + 1;
  if (diffDays > 2) {
    throw new VendoorClientError(
      `Phase 1 access test is restricted to a maximum of 2 days range. Requested ${diffDays} days (${startDate} to ${endDate}).`,
      400,
      'EXCEEDED_MAX_RANGE'
    );
  }

  const endpoint = `/dashboard/log/xls/all?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`;

  const { response, durationMs, contentType, status } = await vendoorFetch(endpoint, {
    method: 'GET',
    headers: {
      'Accept': 'application/vnd.ms-excel, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/json, */*'
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
  const textPrefix = buffer.slice(0, 300).toString('utf8');
  if (textPrefix.includes('<html') || textPrefix.includes('<!DOCTYPE') || textPrefix.includes('login')) {
    throw new VendoorClientError(
      'Vendoor returned an HTML login page instead of the log file. Session cookie may be expired.',
      401,
      'HTML_LOGIN_REDIRECT',
      { durationMs, status, preview: textPrefix.slice(0, 150) }
    );
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
  const summary = summarizeNormalizedLogs(normalizedLogs);

  return {
    success: true,
    resource: 'logs',
    http_status: status,
    duration_ms: durationMs,
    content_type: contentType,
    file_size_bytes: buffer.length,
    requested_range: {
      start_date: startDate,
      end_date: endDate
    },
    summary,
    sample_rows: normalizedLogs.slice(0, 8)
  };
}
