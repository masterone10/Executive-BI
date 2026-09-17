/**
 * Vendoor Integration Test Orchestrator & Diagnostic Logger (Phase 1 Access Proof)
 *
 * Responsibilities:
 * - Executes diagnostic test runs on-demand
 * - Logs test outcomes to `vendoor_connection_tests` DB table
 * - Formats proof summaries for API responses and UI dashboards
 * - Zero modification of Smart Allocation or Employee Master state
 */

import { getVendoorDataSource } from './adapter.js';
import { getVendoorConfig } from './auth.js';
import db from '../../db/index.js';

/**
 * Record test outcome into database for audit history
 */
export function recordConnectionTest({
  resource,
  test_type,
  start_date = null,
  end_date = null,
  status,
  http_status = null,
  content_type = null,
  rows_received = 0,
  duration_ms = 0,
  summary_json = null,
  error_safe = null
}) {
  try {
    const stmt = db.prepare(`
      INSERT INTO vendoor_connection_tests (
        resource, test_type, start_date, end_date, status, http_status,
        content_type, rows_received, duration_ms, summary_json, error_safe
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      resource,
      test_type,
      start_date,
      end_date,
      status,
      http_status,
      content_type,
      rows_received,
      duration_ms,
      summary_json ? JSON.stringify(summary_json) : null,
      error_safe ? String(error_safe).slice(0, 500) : null
    );
  } catch (err) {
    console.error('[Vendoor Diagnostic] Failed to save test record:', err.message);
  }
}

/**
 * Retrieve recent connection tests
 */
export function getRecentConnectionTests(limit = 20) {
  try {
    const rows = db.prepare(`
      SELECT * FROM vendoor_connection_tests
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);

    return rows.map(r => ({
      ...r,
      summary: r.summary_json ? JSON.parse(r.summary_json) : null
    }));
  } catch {
    return [];
  }
}

/**
 * Run diagnostic test for Orders access
 */
export async function testVendoorOrdersAccess(options = {}) {
  const cfg = getVendoorConfig();
  const forceMode = options.forceMode || null;
  const ds = getVendoorDataSource(forceMode);
  const length = parseInt(options.length, 10) || 10;
  const fromDate = options.fromDate || '';
  const toDate = options.toDate || '';

  const startTime = Date.now();
  try {
    const result = await ds.fetchOrders({
      start: 0,
      length,
      fromDate,
      toDate,
      statusFilter: options.statusFilter || '',
      search: options.search || ''
    });

    const durationMs = Date.now() - startTime;
    const rowsCount = result.summary ? result.summary.received_orders_count : 0;

    recordConnectionTest({
      resource: 'orders',
      test_type: 'small_page',
      start_date: fromDate || null,
      end_date: toDate || null,
      status: 'SUCCESS',
      http_status: result.http_status || 200,
      content_type: result.content_type || 'application/json',
      rows_received: rowsCount,
      duration_ms: durationMs,
      summary_json: result.summary,
      error_safe: null
    });

    return {
      success: true,
      message: `Successfully connected to Vendoor orders endpoint. Retrieved ${rowsCount} sample orders in ${durationMs}ms.`,
      result
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const statusText = err.code || 'FAILED';

    recordConnectionTest({
      resource: 'orders',
      test_type: 'small_page',
      start_date: fromDate || null,
      end_date: toDate || null,
      status: statusText,
      http_status: err.statusCode || 500,
      content_type: err.details?.contentType || null,
      rows_received: 0,
      duration_ms: durationMs,
      summary_json: null,
      error_safe: err.message
    });

    return {
      success: false,
      error: err.message,
      code: err.code || 'ERROR',
      statusCode: err.statusCode || 500,
      duration_ms: durationMs,
      details: err.details || null
    };
  }
}

/**
 * Run diagnostic test for Logs access (1-2 days range)
 */
export async function testVendoorLogsAccess(options = {}) {
  const forceMode = options.forceMode || null;
  const ds = getVendoorDataSource(forceMode);
  const startDate = options.startDate || options.start_date || new Date().toISOString().slice(0, 10);
  const endDate = options.endDate || options.end_date || startDate;
  const isMultiDay = startDate !== endDate;
  const testType = isMultiDay ? 'two_day' : 'one_day';

  const startTime = Date.now();
  try {
    const result = await ds.fetchLogs({ startDate, endDate });
    const durationMs = Date.now() - startTime;
    const rowsCount = result.summary ? result.summary.total_rows : 0;

    recordConnectionTest({
      resource: 'logs',
      test_type: testType,
      start_date: startDate,
      end_date: endDate,
      status: 'SUCCESS',
      http_status: result.http_status || 200,
      content_type: result.content_type || 'application/vnd.ms-excel',
      rows_received: rowsCount,
      duration_ms: durationMs,
      summary_json: result.summary,
      error_safe: null
    });

    return {
      success: true,
      message: `Successfully retrieved Vendoor logs for ${startDate}${isMultiDay ? ' to ' + endDate : ''}. Parsed ${rowsCount} actions across ${result.summary?.unique_employees_count || 0} employees in ${durationMs}ms.`,
      result
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const statusText = err.code || 'FAILED';

    recordConnectionTest({
      resource: 'logs',
      test_type: testType,
      start_date: startDate,
      end_date: endDate,
      status: statusText,
      http_status: err.statusCode || 500,
      content_type: err.details?.contentType || null,
      rows_received: 0,
      duration_ms: durationMs,
      summary_json: null,
      error_safe: err.message
    });

    return {
      success: false,
      error: err.message,
      code: err.code || 'ERROR',
      statusCode: err.statusCode || 500,
      duration_ms: durationMs,
      details: err.details || null
    };
  }
}
