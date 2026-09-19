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
import { classifyVendoorAction, extractCanonicalStatus } from './actions.js';
import { getOperationalBusinessDate } from './normalize.js';
import { resolveEmployeeIdentity } from './identity.js';
import { computePerformanceFromRecords, savePerformanceSnapshotToDB } from '../performance.js';
import { attachEligibleArrivedOrders, getDispatcherConfig } from './dispatcher.js';

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
  const pageSize = Math.min(300, Math.max(10, parseInt(options.pageSize, 10) || 300));
  const maxPages = Math.min(100, Math.max(1, parseInt(options.maxPages, 10) || 50));

  const statusesToFetch = options.statusFilter 
    ? [options.statusFilter] 
    : (Array.isArray(options.statuses) && options.statuses.length > 0 ? options.statuses : ['New', 'Pending']);

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
        order_code, status, account, merchant_code, source_date, city, total_price,
        raw_payload_json, sync_run_id, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(order_code) DO UPDATE SET
        status = excluded.status,
        account = excluded.account,
        merchant_code = excluded.merchant_code,
        source_date = excluded.source_date,
        city = excluded.city,
        total_price = excluded.total_price,
        raw_payload_json = excluded.raw_payload_json,
        sync_run_id = excluded.sync_run_id,
        imported_at = datetime('now')
    `);

    const insertCwoStmt = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, order_date, source_file_slot, merchant_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(work_date, order_code) DO UPDATE SET
        account = excluded.account,
        status = excluded.status,
        source_file_slot = excluded.source_file_slot,
        merchant_code = COALESCE(excluded.merchant_code, current_work_orders.merchant_code),
        updated_at = datetime('now')
    `);

    const checkExistingStmt = db.prepare('SELECT id, status, account FROM vendoor_orders WHERE order_code = ?');

    for (const currentStatus of statusesToFetch) {
      for (let page = 0; page < maxPages; page++) {
        const start = page * pageSize;
        const res = await ds.fetchOrders({
          start,
          length: pageSize,
          fromDate,
          toDate,
          statusFilter: currentStatus,
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

            const targetWorkDate = ord.date || fromDate || new Date().toISOString().slice(0, 10);
            const ordStatus = ord.status || currentStatus || 'New';
            const slot = (ordStatus && String(ordStatus).toLowerCase().includes('pending')) ? 2 : 1;

            insertOrderStmt.run(
              ord.order_code,
              ordStatus,
              ord.account || 'Unassigned',
              ord.merchant_code || null,
              targetWorkDate,
              ord.city || null,
              ord.total_price || 0,
              JSON.stringify(ord),
              syncRunId
            );

            try {
              insertCwoStmt.run(
                targetWorkDate,
                ord.order_code,
                ord.account || 'Unassigned',
                ordStatus,
                targetWorkDate,
                slot,
                ord.merchant_code || null
              );
            } catch (_) {}
          }
        });

        tx();

        // If fewer items than pageSize were returned, reached end for this status
        if (orders.length < pageSize) break;
      }
    }

    // Smart Dispatcher: check if newly arrived orders match an existing allocation for their account (strictly when dispatcher is ENABLED)
    let smartDispatcherResult = null;
    try {
      const dispCfg = getDispatcherConfig();
      if (dispCfg && dispCfg.enabled) {
        const effectiveDate = fromDate || new Date().toISOString().slice(0, 10);
        smartDispatcherResult = attachEligibleArrivedOrders(effectiveDate);
      } else {
        smartDispatcherResult = { attached_count: 0, unassigned_count: 0, note: 'Dispatcher is OFF (safe sync)' };
      }
    } catch (sdErr) {
      console.warn('Smart dispatcher order attachment failed:', sdErr.message);
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
      sample_statuses: Array.from(sampleStatuses).slice(0, 5),
      smart_dispatcher: smartDispatcherResult
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
      total_fetched: totalFetched,
      pages_processed: pagesProcessed,
      page_size: pageSize,
      total_accepted: totalAccepted,
      total_duplicated: totalDuplicated,
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

        // 2. Insert into raw_log_records with canonical normalized status
        const canonicalStatus = extractCanonicalStatus(rawAction);
        const isRawExisting = checkExistingRawLog.get(resolvedWorkDate, log.order_code, log.employee_name, rawTs, rawAction, canonicalStatus);
        if (!isRawExisting) {
          const isCS = identity.department === 'CS' || identity.department === null || identity.department === undefined ? 1 : (identity.department === 'CS' ? 1 : 0);
          insertRawLogStmt.run(
            resolvedWorkDate,
            log.order_code,
            identity.employee_name || log.employee_name,
            canonicalStatus,
            rawAction,
            rawTs,
            isCS
          );
        }
      }
    });

    tx();

    // Recompute canonical performance snapshots for all relevant dates
    try {
      const datesToRecompute = new Set([startDate, endDate].filter(Boolean));
      for (const d of datesToRecompute) {
        const records = db.prepare('SELECT * FROM raw_log_records WHERE work_date = ?').all(d);
        if (records && records.length > 0) {
          const metrics = computePerformanceFromRecords(records, d);
          savePerformanceSnapshotToDB(d, metrics);
        }
      }
    } catch (snapErr) {
      console.warn('[Vendoor Sync] Snapshot update notice:', snapErr.message);
    }

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

/**
 * Continuous Historical Order & Log Reconciliation
 * Reconciles current business date + recent previous business dates
 */
export async function reconcileHistoricalWindow(options = {}) {
  const days = Math.min(14, Math.max(1, parseInt(options.days, 10) || 3));
  const results = [];
  const today = new Date();

  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    // 1. Sync orders for this business date
    const ordersRes = await syncVendoorOrders({
      fromDate: dateStr,
      toDate: dateStr,
      forceMode: options.forceMode
    });

    // 2. Sync logs for this business date
    const logsRes = await syncVendoorLogs({
      startDate: dateStr,
      endDate: dateStr,
      forceMode: options.forceMode
    });

    results.push({
      date: dateStr,
      orders: ordersRes,
      logs: logsRes
    });
  }

  return {
    success: true,
    reconciled_days: days,
    dates: results.map(r => r.date),
    details: results
  };
}

// In-memory autonomous poller state
const pollerState = {
  isRunning: false,
  isCycleActive: false,
  lastRunAt: null,
  runCount: 0,
  lastResult: null,
  activeTimerId: null
};

export function getAutonomousPollerStatus() {
  return {
    isRunning: pollerState.isRunning,
    isCycleActive: pollerState.isCycleActive,
    lastRunAt: pollerState.lastRunAt,
    runCount: pollerState.runCount,
    lastResult: pollerState.lastResult
  };
}

/**
 * Centralized Autonomous Poller for Orders & Logs
 * Single-flight concurrency lock prevents overlapping cycles
 */
export function startAutonomousVendoorPoller(options = {}) {
  if (pollerState.isRunning) {
    return { success: true, message: 'Autonomous Vendoor Poller is already running' };
  }

  const intervalMs = Math.max(15000, parseInt(options.intervalMs, 10) || 60000);
  pollerState.isRunning = true;

  const runPollerCycle = async () => {
    // Single-flight lock: never run concurrent overlapping cycles
    if (pollerState.isCycleActive) return;
    pollerState.isCycleActive = true;

    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      const ordersRes = await syncVendoorOrders({ fromDate: todayStr, toDate: todayStr, forceMode: options.forceMode });
      const logsRes = await syncVendoorLogs({ startDate: todayStr, endDate: todayStr, forceMode: options.forceMode });

      pollerState.runCount++;
      pollerState.lastRunAt = new Date().toISOString();
      pollerState.lastResult = { orders: ordersRes, logs: logsRes };
    } catch (err) {
      console.warn('[Autonomous Vendoor Poller] Cycle warning:', err.message);
    } finally {
      pollerState.isCycleActive = false;
    }
  };

  // Run initial poll asynchronously
  runPollerCycle().catch(() => {});

  pollerState.activeTimerId = setInterval(runPollerCycle, intervalMs);
  return { success: true, message: 'Autonomous Vendoor Poller started', interval_ms: intervalMs };
}

export function stopAutonomousVendoorPoller() {
  if (pollerState.activeTimerId) {
    clearInterval(pollerState.activeTimerId);
    pollerState.activeTimerId = null;
  }
  pollerState.isRunning = false;
  return { success: true, message: 'Autonomous Vendoor Poller stopped' };
}

