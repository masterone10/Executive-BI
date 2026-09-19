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

  // Status-driven vs Historical sync
  const isStatusDriven = options.statusDriven === true || (!options.fromDate && !options.toDate);
  const fromDate = isStatusDriven ? '' : (options.fromDate || '');
  const toDate = isStatusDriven ? '' : (options.toDate || fromDate || '');
  const operationalBusinessDate = options.businessDate || options.workDate || options.operationalDate || options.fromDate || new Date().toISOString().slice(0, 10);

  const pageSize = Math.min(300, Math.max(10, parseInt(options.pageSize, 10) || 300));
  const maxPages = Math.min(100, Math.max(1, parseInt(options.maxPages, 10) || 50));

  const isLive = ds.mode === 'LIVE';
  const statusesToFetch = options.statusFilter 
    ? [options.statusFilter] 
    : (Array.isArray(options.statuses) && options.statuses.length > 0 
        ? options.statuses 
        : ['New', 'Pending']);

  let totalFetched = 0;
  let totalAccepted = 0;
  let totalDuplicated = 0;
  let totalRejected = 0;
  let pagesProcessed = 0;
  const sampleAccounts = new Set();
  const sampleStatuses = new Set();
  const activeOrderCodes = new Set();

  try {
    const insertOrderStmt = db.prepare(`
      INSERT INTO vendoor_orders (
        order_code, status, active_status, account, merchant_code, source_date,
        created_at_original, business_date, is_active, last_synced_at, city,
        total_price, raw_payload_json, sync_run_id, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(order_code) DO UPDATE SET
        status = excluded.status,
        active_status = excluded.active_status,
        account = COALESCE(excluded.account, vendoor_orders.account),
        merchant_code = COALESCE(excluded.merchant_code, vendoor_orders.merchant_code),
        source_date = COALESCE(vendoor_orders.source_date, excluded.source_date),
        created_at_original = COALESCE(vendoor_orders.created_at_original, excluded.created_at_original),
        business_date = excluded.business_date,
        is_active = excluded.is_active,
        last_synced_at = datetime('now'),
        city = COALESCE(excluded.city, vendoor_orders.city),
        total_price = excluded.total_price,
        raw_payload_json = excluded.raw_payload_json,
        sync_run_id = excluded.sync_run_id,
        imported_at = datetime('now')
    `);

    const insertCwoStmt = db.prepare(`
      INSERT INTO current_work_orders (
        work_date, order_code, account, status, order_date, source_file_slot, source_type, merchant_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(work_date, order_code) DO UPDATE SET
        account = excluded.account,
        status = excluded.status,
        order_date = COALESCE(current_work_orders.order_date, excluded.order_date),
        source_file_slot = excluded.source_file_slot,
        source_type = excluded.source_type,
        merchant_code = COALESCE(excluded.merchant_code, current_work_orders.merchant_code),
        updated_at = datetime('now')
    `);

    const updateCwoStatusStmt = db.prepare(`
      UPDATE current_work_orders
      SET status = ?, updated_at = datetime('now')
      WHERE work_date = ? AND order_code = ?
    `);

    const deleteCwoStmt = db.prepare(`
      DELETE FROM current_work_orders
      WHERE work_date = ? AND order_code = ?
    `);

    const checkExistingStmt = db.prepare('SELECT id, status, account, source_date FROM vendoor_orders WHERE order_code = ?');

    for (const currentStatus of statusesToFetch) {
      let reportedTotal = null;
      let reportedFiltered = null;
      let statusOrdersCount = 0;

      for (let page = 0; page < maxPages; page++) {
        const start = page * pageSize;
        const res = await ds.fetchOrders({
          start,
          length: pageSize,
          fromDate,
          toDate,
          statusFilter: currentStatus === 'ALL' ? '' : currentStatus,
          search: options.search || ''
        });

        const orders = res.orders || res.orders_sample || [];
        pagesProcessed++;
        totalFetched += orders.length;
        statusOrdersCount += orders.length;

        if (res.pagination) {
          if (res.pagination.records_total !== null && res.pagination.records_total !== undefined) {
            reportedTotal = res.pagination.records_total;
          }
          if (res.pagination.records_filtered !== null && res.pagination.records_filtered !== undefined) {
            reportedFiltered = res.pagination.records_filtered;
          }
        }

        if (orders.length === 0) break;

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

            const ordStatus = ord.status || (currentStatus !== 'ALL' ? currentStatus : 'New');
            const cleanStatusLower = (ordStatus || '').toLowerCase();
            const isPending = cleanStatusLower.includes('pending') || cleanStatusLower.includes('معلق');
            const isNew = cleanStatusLower.includes('new') || cleanStatusLower.includes('جديد');
            // ACTIVE WORKLOAD RULE: Only real Vendoor orders that are currently NEW or PENDING
            // Processing, Shipped, Delivered, Cancelled are NOT active workload
            const isOrderActive = isNew || isPending;
            const normalizedActiveStatus = isPending ? 'Pending' : (isNew ? 'New' : ordStatus);

            // Preserve original source creation date and timestamp
            const originalSourceDate = ord.source_date || ord.date || existing?.source_date || null;
            const originalCreatedAt = ord.created_at_original || ord.created_at || null;

            insertOrderStmt.run(
              ord.order_code,
              normalizedActiveStatus,
              normalizedActiveStatus,
              ord.account || 'Unassigned',
              ord.merchant_code || null,
              originalSourceDate,
              originalCreatedAt,
              operationalBusinessDate,
              isOrderActive ? 1 : 0,
              ord.city || null,
              ord.total_price || 0,
              JSON.stringify(ord),
              syncRunId
            );

            if (isOrderActive) {
              activeOrderCodes.add(ord.order_code);
              const slot = isPending ? 2 : 1;
              const sourceType = isPending ? 'PENDING' : 'NEW';
              try {
                insertCwoStmt.run(
                  operationalBusinessDate,
                  ord.order_code,
                  ord.account || 'Unassigned',
                  normalizedActiveStatus,
                  originalSourceDate || operationalBusinessDate,
                  slot,
                  sourceType,
                  ord.merchant_code || null
                );
              } catch (_) {}
            } else {
              // Not active (e.g. Processing, Shipped, Delivered, Cancelled):
              // Remove from current active work pool for today if present
              try {
                deleteCwoStmt.run(operationalBusinessDate, ord.order_code);
              } catch (_) {}
            }
          }
        });

        tx();

        // If fewer items than pageSize were returned, reached end for this status
        if (orders.length < pageSize) break;

        // If we've collected the target count reported by DataTables
        const targetCount = (reportedFiltered !== null && reportedFiltered > 0) ? reportedFiltered : reportedTotal;
        if (targetCount !== null && targetCount > 0 && statusOrdersCount >= targetCount) {
          break;
        }
      }
    }

    // ACTIVE WORKLOAD RECONCILIATION & STALE PRUNING:
    // Any order in current_work_orders for operationalBusinessDate that is no longer in the active Vendoor set (New/Pending)
    // MUST NOT remain active. Prune from current_work_orders and set is_active = 0 in vendoor_orders.
    if (isStatusDriven && activeOrderCodes.size > 0) {
      const existingCwo = db.prepare('SELECT order_code FROM current_work_orders WHERE work_date = ?').all(operationalBusinessDate);
      const toPrune = existingCwo.filter(row => !activeOrderCodes.has(row.order_code)).map(r => r.order_code);
      if (toPrune.length > 0) {
        const delCwo = db.prepare('DELETE FROM current_work_orders WHERE work_date = ? AND order_code = ?');
        const inactVo = db.prepare("UPDATE vendoor_orders SET is_active = 0, last_synced_at = datetime('now') WHERE business_date = ? AND order_code = ?");
        const pruneTx = db.transaction(() => {
          for (const code of toPrune) {
            delCwo.run(operationalBusinessDate, code);
            inactVo.run(operationalBusinessDate, code);
          }
        });
        pruneTx();
      }
    }

    // Smart Dispatcher: check if newly arrived orders match an existing allocation for their account (strictly when dispatcher is ENABLED)
    let smartDispatcherResult = null;
    try {
      const dispCfg = getDispatcherConfig();
      if (dispCfg && dispCfg.enabled) {
        const effectiveDate = operationalBusinessDate;
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
      operational_business_date: operationalBusinessDate,
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
      operational_business_date: operationalBusinessDate,
      date_range: { from_date: fromDate || null, to_date: toDate || null },
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

    const insertRawLogStmt = db.prepare(`
      INSERT INTO raw_log_records (
        work_date, order_code, employee_name, status, action,
        event_datetime, is_cs, is_deduped
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);

    // Efficient in-memory duplicate tracking to prevent expensive nested table scans
    const existingVendoorKeys = new Set(
      db.prepare(`
        SELECT order_code || '|' || employee_name || '|' || timestamp_str || '|' || action AS k
        FROM vendoor_logs
        WHERE work_date >= ? AND work_date <= ?
      `).all(startDate, endDate).map(r => r.k)
    );

    const existingRawKeys = new Set(
      db.prepare(`
        SELECT work_date || '|' || order_code || '|' || employee_name || '|' || event_datetime || '|' || COALESCE(action, '') AS k
        FROM raw_log_records
        WHERE work_date >= ? AND work_date <= ?
      `).all(startDate, endDate).map(r => r.k)
    );

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

        const vKey = `${log.order_code}|${log.employee_name}|${rawTs}|${rawAction}`;
        if (existingVendoorKeys.has(vKey)) {
          totalDuplicated++;
        } else {
          totalAccepted++;
          existingVendoorKeys.add(vKey);
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
        const rawKey = `${resolvedWorkDate}|${log.order_code}|${identity.employee_name || log.employee_name}|${rawTs}|${rawAction}`;
        if (!existingRawKeys.has(rawKey)) {
          existingRawKeys.add(rawKey);
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
      businessDate: dateStr,
      isHistoricalSync: i > 0,
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

// In-memory autonomous poller state with decoupled pipelines
const pollerState = {
  isRunning: false,
  orders: {
    isRunning: false,
    isCycleActive: false,
    intervalMs: 30000,
    timerId: null,
    runCount: 0,
    lastRunAt: null,
    lastSuccessAt: null,
    status: 'IDLE', // 'IDLE' | 'RUNNING' | 'SUCCESS' | 'ERROR'
    consecutiveErrors: 0,
    lastError: null,
    lastResult: null
  },
  logs: {
    isRunning: false,
    isCycleActive: false,
    intervalMs: 30000,
    timerId: null,
    runCount: 0,
    lastRunAt: null,
    lastSuccessAt: null,
    status: 'IDLE', // 'IDLE' | 'RUNNING' | 'SUCCESS' | 'ERROR'
    consecutiveErrors: 0,
    lastError: null,
    lastResult: null
  }
};

/**
 * Get comprehensive autonomous poller status for both decoupled pipelines
 */
export function getAutonomousPollerStatus() {
  const cfg = getVendoorConfig();
  
  // Determine overall connection state based on poller health and config
  let connectionState = 'NOT_CONFIGURED';
  if (cfg.mockMode) {
    connectionState = 'CONNECTED';
  } else if (cfg.hasCredentials) {
    const ordersErr = pollerState.orders.lastError || '';
    const logsErr = pollerState.logs.lastError || '';
    const isAuthErr = ordersErr.includes('401') || ordersErr.includes('login') || ordersErr.includes('AUTH') ||
                      logsErr.includes('401') || logsErr.includes('login') || logsErr.includes('AUTH');

    if (isAuthErr) {
      connectionState = 'AUTH_FAILED';
    } else if (pollerState.orders.consecutiveErrors >= 3 || pollerState.logs.consecutiveErrors >= 3) {
      connectionState = 'ERROR';
    } else if (pollerState.orders.isCycleActive || pollerState.logs.isCycleActive) {
      connectionState = pollerState.orders.consecutiveErrors > 0 ? 'RECONNECTING' : 'CONNECTED';
    } else if (pollerState.orders.lastSuccessAt || pollerState.logs.lastSuccessAt) {
      const now = Date.now();
      const lastSuccessTs = Math.max(
        pollerState.orders.lastSuccessAt ? new Date(pollerState.orders.lastSuccessAt).getTime() : 0,
        pollerState.logs.lastSuccessAt ? new Date(pollerState.logs.lastSuccessAt).getTime() : 0
      );
      // If no successful sync within 5 minutes, mark as STALE
      if (lastSuccessTs > 0 && (now - lastSuccessTs > 300000)) {
        connectionState = 'STALE';
      } else {
        connectionState = 'CONNECTED';
      }
    } else if (pollerState.isRunning) {
      connectionState = 'RECONNECTING';
    } else {
      connectionState = cfg.hasActiveSession ? 'CONNECTED' : 'READY';
    }
  }

  return {
    isRunning: pollerState.isRunning,
    connection_state: connectionState,
    orders: {
      is_running: pollerState.orders.isRunning,
      is_cycle_active: pollerState.orders.isCycleActive,
      status: pollerState.orders.isCycleActive ? 'RUNNING' : (pollerState.orders.consecutiveErrors > 0 ? 'ERROR' : 'IDLE'),
      interval_ms: pollerState.orders.intervalMs,
      run_count: pollerState.orders.runCount,
      last_run_at: pollerState.orders.lastRunAt,
      last_success_at: pollerState.orders.lastSuccessAt,
      consecutive_errors: pollerState.orders.consecutiveErrors,
      last_error: pollerState.orders.lastError,
      last_result: pollerState.orders.lastResult
    },
    logs: {
      is_running: pollerState.logs.isRunning,
      is_cycle_active: pollerState.logs.isCycleActive,
      status: pollerState.logs.isCycleActive ? 'RUNNING' : (pollerState.logs.consecutiveErrors > 0 ? 'ERROR' : 'IDLE'),
      interval_ms: pollerState.logs.intervalMs,
      run_count: pollerState.logs.runCount,
      last_run_at: pollerState.logs.lastRunAt,
      last_success_at: pollerState.logs.lastSuccessAt,
      consecutive_errors: pollerState.logs.consecutiveErrors,
      last_error: pollerState.logs.lastError,
      last_result: pollerState.logs.lastResult
    },
    // Backward compatibility fields
    isCycleActive: pollerState.orders.isCycleActive || pollerState.logs.isCycleActive,
    lastRunAt: pollerState.orders.lastRunAt || pollerState.logs.lastRunAt,
    runCount: pollerState.orders.runCount + pollerState.logs.runCount,
    lastResult: {
      orders: pollerState.orders.lastResult,
      logs: pollerState.logs.lastResult
    }
  };
}

/**
 * Run a single autonomous Orders cycle
 */
async function executeAutonomousOrdersCycle(forceMode) {
  if (pollerState.orders.isCycleActive) return;
  pollerState.orders.isCycleActive = true;
  pollerState.orders.status = 'RUNNING';

  try {
    const todayStr = new Date().toISOString().slice(0, 10);
    const ordersRes = await syncVendoorOrders({
      businessDate: todayStr,
      forceMode,
      pageSize: 300,
      statusDriven: true
    });

    pollerState.orders.runCount++;
    pollerState.orders.lastRunAt = new Date().toISOString();
    pollerState.orders.lastResult = ordersRes;

    if (ordersRes.success) {
      pollerState.orders.status = 'IDLE';
      pollerState.orders.lastSuccessAt = new Date().toISOString();
      pollerState.orders.consecutiveErrors = 0;
      pollerState.orders.lastError = null;
    } else {
      pollerState.orders.status = 'ERROR';
      pollerState.orders.consecutiveErrors++;
      pollerState.orders.lastError = ordersRes.error || 'Orders sync returned failure';
    }
  } catch (err) {
    pollerState.orders.status = 'ERROR';
    pollerState.orders.consecutiveErrors++;
    pollerState.orders.lastError = err.message;
    console.warn('[Autonomous Vendoor Poller] Orders cycle warning:', err.message);
  } finally {
    pollerState.orders.isCycleActive = false;
  }
}

/**
 * Run a single autonomous Logs cycle
 */
async function executeAutonomousLogsCycle(forceMode) {
  if (pollerState.logs.isCycleActive) return;
  pollerState.logs.isCycleActive = true;
  pollerState.logs.status = 'RUNNING';

  try {
    const todayStr = new Date().toISOString().slice(0, 10);
    const logsRes = await syncVendoorLogs({
      startDate: todayStr,
      endDate: todayStr,
      forceMode
    });

    pollerState.logs.runCount++;
    pollerState.logs.lastRunAt = new Date().toISOString();
    pollerState.logs.lastResult = logsRes;

    if (logsRes.success) {
      pollerState.logs.status = 'IDLE';
      pollerState.logs.lastSuccessAt = new Date().toISOString();
      pollerState.logs.consecutiveErrors = 0;
      pollerState.logs.lastError = null;
    } else {
      pollerState.logs.status = 'ERROR';
      pollerState.logs.consecutiveErrors++;
      pollerState.logs.lastError = logsRes.error || 'Logs sync returned failure';
    }
  } catch (err) {
    pollerState.logs.status = 'ERROR';
    pollerState.logs.consecutiveErrors++;
    pollerState.logs.lastError = err.message;
    console.warn('[Autonomous Vendoor Poller] Logs cycle warning:', err.message);
  } finally {
    pollerState.logs.isCycleActive = false;
  }
}

/**
 * Centralized Autonomous Poller for Orders & Logs
 * Fully decoupled pipelines with independent 30s timers and single-flight locks
 */
export function startAutonomousVendoorPoller(options = {}) {
  const ordersIntervalMs = Math.max(10000, parseInt(options.ordersIntervalMs || options.intervalMs, 10) || 30000);
  const logsIntervalMs = Math.max(10000, parseInt(options.logsIntervalMs || options.intervalMs, 10) || 30000);

  pollerState.orders.intervalMs = ordersIntervalMs;
  pollerState.logs.intervalMs = logsIntervalMs;

  if (pollerState.isRunning) {
    return {
      success: true,
      message: 'Autonomous Vendoor Poller is already running',
      status: getAutonomousPollerStatus()
    };
  }

  pollerState.isRunning = true;
  pollerState.orders.isRunning = true;
  pollerState.logs.isRunning = true;

  // Run initial cycles immediately
  executeAutonomousOrdersCycle(options.forceMode).catch(() => {});
  // Slight 1.5s offset for initial logs run to prevent cookie race
  setTimeout(() => {
    executeAutonomousLogsCycle(options.forceMode).catch(() => {});
  }, 1500);

  // Decoupled independent interval timers
  pollerState.orders.timerId = setInterval(() => {
    executeAutonomousOrdersCycle(options.forceMode).catch(() => {});
  }, ordersIntervalMs);

  pollerState.logs.timerId = setInterval(() => {
    executeAutonomousLogsCycle(options.forceMode).catch(() => {});
  }, logsIntervalMs);

  return {
    success: true,
    message: 'Autonomous Vendoor Poller started (Decoupled 30s Orders & Logs pipelines)',
    orders_interval_ms: ordersIntervalMs,
    logs_interval_ms: logsIntervalMs,
    status: getAutonomousPollerStatus()
  };
}

export function stopAutonomousVendoorPoller() {
  if (pollerState.orders.timerId) {
    clearInterval(pollerState.orders.timerId);
    pollerState.orders.timerId = null;
  }
  if (pollerState.logs.timerId) {
    clearInterval(pollerState.logs.timerId);
    pollerState.logs.timerId = null;
  }
  pollerState.isRunning = false;
  pollerState.orders.isRunning = false;
  pollerState.logs.isRunning = false;
  pollerState.orders.isCycleActive = false;
  pollerState.logs.isCycleActive = false;
  return { success: true, message: 'Autonomous Vendoor Poller stopped', status: getAutonomousPollerStatus() };
}

