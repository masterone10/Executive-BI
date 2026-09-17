/**
 * Phase 2 Vendoor Explicit Sync & Data Bridge Orchestrator
 *
 * Responsibilities:
 * - Deterministic, manual and autonomous sync pipelines for Orders and Logs
 * - Inserts into isolated `vendoor_orders` and `vendoor_logs` tables
 * - Populates `raw_log_records` for feeding unified productivity metrics
 * - Tracks execution history with strict audit logging in `vendoor_sync_runs`
 * - Guarantees data integrity: Idempotent inserts with UPSERT/deduplication
 * - Zero automatic creation of employees into Master table
 */

import { db } from '../../db/index.js';
import { getVendoorDataSource } from './adapter.js';
import { classifyVendoorAction } from './actions.js';
import { getOperationalBusinessDate } from './normalize.js';
import { resolveEmployeeIdentity } from './identity.js';

/**
 * Generate a unique run ID for the sync batch
 */
export function createSyncRunId(prefix = 'sync') {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${ts}-${rand}`;
}

/**
 * Record a sync run audit trail
 */
export function recordSyncRun({
  sync_run_id,
  resource,
  start_date = null,
  end_date = null,
  status,
  records_fetched = 0,
  records_accepted = 0,
  records_duplicated = 0,
  records_rejected = 0,
  duration_ms = 0,
  summary_json = null,
  error_safe = null
}) {
  try {
    const stmt = db.prepare(`
      INSERT INTO vendoor_sync_runs (
        sync_run_id, resource, start_date, end_date, status,
        records_fetched, records_accepted, records_duplicated, records_rejected,
        duration_ms, summary_json, error_safe
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      sync_run_id,
      resource,
      start_date,
      end_date,
      status,
      records_fetched,
      records_accepted,
      records_duplicated,
      records_rejected,
      duration_ms,
      summary_json ? JSON.stringify(summary_json) : null,
      error_safe ? String(error_safe).slice(0, 500) : null
    );
  } catch (err) {
    console.error('[Vendoor Orchestrator] Failed to record sync run audit:', err.message);
  }
}

/**
 * Explicit Orders Sync (Bounded & Paginated, Complete Dataset)
 *
 * @param {Object} options
 * @param {string} [options.fromDate] - YYYY-MM-DD
 * @param {string} [options.toDate] - YYYY-MM-DD
 * @param {number} [options.maxPages=50] - Safeguard to bound pagination
 * @param {number} [options.pageSize=50] - Number of records per page (max 100)
 * @param {string} [options.statusFilter] - Optional status filter
 * @param {string} [options.forceMode] - 'mock' or 'live'
 */
export async function syncVendoorOrders(options = {}) {
  const syncRunId = createSyncRunId('orders');
  const startTime = Date.now();
  const ds = getVendoorDataSource(options.forceMode);

  const fromDate = options.fromDate || '';
  const toDate = options.toDate || fromDate || '';
  const pageSize = Math.min(100, Math.max(10, parseInt(options.pageSize, 10) || 50));
  const maxPages = Math.min(100, Math.max(1, parseInt(options.maxPages, 10) || 50));

  let totalFetched = 0;
  let totalAccepted = 0;
  let totalDuplicated = 0;
  let totalRejected = 0;
  let pagesProcessed = 0;
  const sampleAccounts = new Set();
  const sampleStatuses = new Set();

  try {
    const insertOrderStmt = db.prepare(`
      INSERT INTO vendoor_orders (
        order_code, status, account, source_date, city, total_price,
        raw_payload_json, sync_run_id, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(order_code) DO UPDATE SET
        status = excluded.status,
        account = excluded.account,
        source_date = excluded.source_date,
        city = excluded.city,
        total_price = excluded.total_price,
        raw_payload_json = excluded.raw_payload_json,
        sync_run_id = excluded.sync_run_id,
        imported_at = datetime('now')
    `);

    const checkExistingStmt = db.prepare('SELECT id, status, account FROM vendoor_orders WHERE order_code = ?');

    for (let page = 0; page < maxPages; page++) {
      const start = page * pageSize;
      const res = await ds.fetchOrders({
        start,
        length: pageSize,
        fromDate,
        toDate,
        statusFilter: options.statusFilter || '',
        search: options.search || ''
      });

      const orders = res.orders || res.orders_sample || [];
      if (orders.length === 0) break;

      pagesProcessed++;
      totalFetched += orders.length;

      const tx = db.transaction(() => {
        for (const ord of orders) {
          if (!ord.order_code) {
            totalRejected++;
            continue;
          }

          if (ord.account) sampleAccounts.add(ord.account);
          if (ord.status) sampleStatuses.add(ord.status);

          const existing = checkExistingStmt.get(ord.order_code);
          if (existing) {
            totalDuplicated++;
          } else {
            totalAccepted++;
          }

          insertOrderStmt.run(
            ord.order_code,
            ord.status || 'Unknown',
            ord.account || 'Unassigned',
            ord.date || fromDate || null,
            ord.city || null,
            ord.total_price || 0,
            JSON.stringify(ord),
            syncRunId
          );
        }
      });

      tx();

      // If fewer items than pageSize were returned, reached end
      if (orders.length < pageSize) break;
    }

    const durationMs = Date.now() - startTime;
    const summary = {
      pages_processed: pagesProcessed,
      page_size: pageSize,
      total_fetched: totalFetched,
      total_accepted: totalAccepted,
      total_duplicated: totalDuplicated,
      total_rejected: totalRejected,
      unique_accounts_count: sampleAccounts.size,
      sample_accounts: Array.from(sampleAccounts).slice(0, 10),
      sample_statuses: Array.from(sampleStatuses).slice(0, 5)
    };

    recordSyncRun({
      sync_run_id: syncRunId,
      resource: 'orders',
      start_date: fromDate || null,
      end_date: toDate || null,
      status: 'SUCCESS',
      records_fetched: totalFetched,
      records_accepted: totalAccepted,
      records_duplicated: totalDuplicated,
      records_rejected: totalRejected,
      duration_ms: durationMs,
      summary_json: summary,
      error_safe: null
    });

    return {
      success: true,
      sync_run_id: syncRunId,
      resource: 'orders',
      date_range: { from_date: fromDate, to_date: toDate },
      duration_ms: durationMs,
      summary
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    recordSyncRun({
      sync_run_id: syncRunId,
      resource: 'orders',
      start_date: fromDate || null,
      end_date: toDate || null,
      status: 'FAILED',
      records_fetched: totalFetched,
      records_accepted: totalAccepted,
      records_duplicated: totalDuplicated,
      records_rejected: totalRejected,
      duration_ms: durationMs,
      summary_json: null,
      error_safe: err.message
    });

    return {
      success: false,
      sync_run_id: syncRunId,
      resource: 'orders',
      error: err.message,
      duration_ms: durationMs
    };
  }
}

/**
 * Explicit Logs Sync (Bounded Date Range & Activity Normalization)
 *
 * @param {Object} options
 * @param {string} options.startDate - YYYY-MM-DD
 * @param {string} [options.endDate] - YYYY-MM-DD (defaults to startDate)
 * @param {string} [options.forceMode] - 'mock' or 'live'
 */
export async function syncVendoorLogs(options = {}) {
  const syncRunId = createSyncRunId('logs');
  const startTime = Date.now();
  const ds = getVendoorDataSource(options.forceMode);

  const startDate = options.startDate || options.start_date || new Date().toISOString().slice(0, 10);
  const endDate = options.endDate || options.end_date || startDate;

  let totalFetched = 0;
  let totalAccepted = 0;
  let totalDuplicated = 0;
  let totalRejected = 0;
  const matchedEmployees = new Set();
  const unmatchedEmployees = new Set();
  const actionCounts = {};

  try {
    const res = await ds.fetchLogs({ startDate, endDate });
    const logs = res.logs || res.sample_rows || [];
    totalFetched = logs.length;

    // Prepared statements for idempotent insertion into both vendoor_logs and raw_log_records
    const insertVendoorLogStmt = db.prepare(`
      INSERT INTO vendoor_logs (
        employee_name, order_code, action, action_classification,
        is_productive, timestamp_str, work_date, matched_employee_id,
        sync_run_id, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(order_code, employee_name, timestamp_str, action) DO UPDATE SET
        action_classification = excluded.action_classification,
        is_productive = excluded.is_productive,
        matched_employee_id = excluded.matched_employee_id,
        sync_run_id = excluded.sync_run_id,
        imported_at = datetime('now')
    `);

    const checkExistingVendoorLog = db.prepare(`
      SELECT id FROM vendoor_logs
      WHERE order_code = ? AND employee_name = ? AND timestamp_str = ? AND action = ?
    `);

    // Insert into raw_log_records for feeding unified productivity calculations
    const insertRawLogStmt = db.prepare(`
      INSERT INTO raw_log_records (
        work_date, order_code, employee_name, status, action,
        event_datetime, is_cs, is_deduped
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);

    const checkExistingRawLog = db.prepare(`
      SELECT id FROM raw_log_records
      WHERE work_date = ? AND order_code = ? AND employee_name = ? AND event_datetime = ? AND (action = ? OR status = ?)
    `);

    const tx = db.transaction(() => {
      for (const log of logs) {
        if (!log.order_code || !log.employee_name) {
          totalRejected++;
          continue;
        }

        const rawAction = log.action || 'Action Recorded';
        const rawTs = log.timestamp || `${log.date || startDate} 12:00:00`;
        const classification = classifyVendoorAction(rawAction);

        actionCounts[classification.classification] = (actionCounts[classification.classification] || 0) + 1;

        // Resolve authoritative business date using operational cutoff
        const opDateObj = getOperationalBusinessDate(rawTs);
        const resolvedWorkDate = opDateObj ? opDateObj.business_date : (log.date || startDate);

        // Deterministic Identity Match
        const identity = resolveEmployeeIdentity(log.employee_name, { persistIdentity: true });
        if (identity.employee_id) {
          matchedEmployees.add(identity.employee_name);
        } else {
          unmatchedEmployees.add(log.employee_name);
        }

        const isExisting = checkExistingVendoorLog.get(log.order_code, log.employee_name, rawTs, rawAction);
        if (isExisting) {
          totalDuplicated++;
        } else {
          totalAccepted++;
        }

        // 1. Insert into persistent vendoor_logs
        insertVendoorLogStmt.run(
          log.employee_name,
          log.order_code,
          rawAction,
          classification.classification,
          classification.is_productive ? 1 : 0,
          rawTs,
          resolvedWorkDate,
          identity.employee_id || null,
          syncRunId
        );

        // 2. Insert into raw_log_records if not already present (idempotent bridging)
        const isRawExisting = checkExistingRawLog.get(resolvedWorkDate, log.order_code, log.employee_name, rawTs, rawAction, rawAction);
        if (!isRawExisting) {
          const isCS = identity.department === 'CS' || identity.department === null || identity.department === undefined ? 1 : (identity.department === 'CS' ? 1 : 0);
          insertRawLogStmt.run(
            resolvedWorkDate,
            log.order_code,
            identity.employee_name || log.employee_name,
            rawAction,
            rawAction,
            rawTs,
            isCS
          );
        }
      }
    });

    tx();

    const durationMs = Date.now() - startTime;
    const summary = {
      total_rows: totalFetched,
      total_accepted: totalAccepted,
      total_duplicated: totalDuplicated,
      total_rejected: totalRejected,
      matched_employees_count: matchedEmployees.size,
      matched_employees: Array.from(matchedEmployees).slice(0, 10),
      unmatched_identities_count: unmatchedEmployees.size,
      unmatched_identities: Array.from(unmatchedEmployees).slice(0, 10),
      action_classifications: actionCounts
    };

    recordSyncRun({
      sync_run_id: syncRunId,
      resource: 'logs',
      start_date: startDate,
      end_date: endDate,
      status: 'SUCCESS',
      records_fetched: totalFetched,
      records_accepted: totalAccepted,
      records_duplicated: totalDuplicated,
      records_rejected: totalRejected,
      duration_ms: durationMs,
      summary_json: summary,
      error_safe: null
    });

    return {
      success: true,
      sync_run_id: syncRunId,
      resource: 'logs',
      date_range: { start_date: startDate, end_date: endDate },
      duration_ms: durationMs,
      summary
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    recordSyncRun({
      sync_run_id: syncRunId,
      resource: 'logs',
      start_date: startDate,
      end_date: endDate,
      status: 'FAILED',
      records_fetched: totalFetched,
      records_accepted: totalAccepted,
      records_duplicated: totalDuplicated,
      records_rejected: totalRejected,
      duration_ms: durationMs,
      summary_json: null,
      error_safe: err.message
    });

    return {
      success: false,
      sync_run_id: syncRunId,
      resource: 'logs',
      error: err.message,
      duration_ms: durationMs
    };
  }
}

/**
 * Retrieve sync audit run history
 */
export function getSyncRunsHistory(limit = 20) {
  try {
    const rows = db.prepare(`
      SELECT * FROM vendoor_sync_runs
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
