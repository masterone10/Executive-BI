/**
 * CS Executive BI — Canonical Historical Date Resolver & Automatic Vendoor Sync Engine
 * 
 * Provides centralized historical date discovery, order resolution,
 * registry management, automatic Vendoor date synchronization,
 * snapshot compilation, and multi-view historical parity.
 */

import { db } from '../db/index.js';
import { getCairoBusinessDate } from './time_utils.js';
import { isCsEmployee } from './parser.js';
import { getVendoorDataSource } from './vendoor/adapter.js';
import { ensureAuthenticatedVendoorSession, performVendoorAutoLogin } from './vendoor/auth.js';
import { computePerformanceFromRecords, savePerformanceSnapshotToDB } from './performance.js';
import { createSyncRunId, recordSyncRun } from './vendoor/orchestrator.js';
import { fetchVendoorLogsForDate, canonicalWorkDate } from './vendoor/logs.js';
import { extractCanonicalStatus } from './vendoor/actions.js';

let cachedAvailableDates = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5000; // 5-second TTL cache

// In-flight sync promises to prevent duplicate simultaneous fetches for the same date
const inFlightHistoricalSyncs = new Map();

export function invalidateAvailableDatesCache() {
  cachedAvailableDates = null;
  cacheTimestamp = 0;
}

/**
 * Ensures the historical_date_registry table exists
 */
export function ensureHistoricalDateRegistryTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS historical_date_registry (
      work_date TEXT PRIMARY KEY,
      data_availability TEXT NOT NULL DEFAULT 'MISSING',
      logs_available INTEGER DEFAULT 0,
      orders_available INTEGER DEFAULT 0,
      metrics_available INTEGER DEFAULT 0,
      snapshots_available INTEGER DEFAULT 0,
      sync_status TEXT DEFAULT 'IDLE',
      sync_started_at TEXT,
      sync_completed_at TEXT,
      last_successful_sync TEXT,
      record_count INTEGER DEFAULT 0,
      pages_fetched INTEGER DEFAULT 0,
      pages_total INTEGER DEFAULT 0,
      completeness TEXT DEFAULT 'NONE',
      last_error TEXT,
      source TEXT DEFAULT 'VENDOOR',
      summary_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hist_reg_date ON historical_date_registry(work_date);
    CREATE INDEX IF NOT EXISTS idx_hist_reg_status ON historical_date_registry(data_availability);
  `);
}

/**
 * Reads or dynamically computes the registry status for a specific business date
 */
export function getHistoricalDateRegistryStatus(workDate) {
  ensureHistoricalDateRegistryTable();
  const cleanDate = String(workDate || '').trim();
  if (!cleanDate || !/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
    return {
      work_date: cleanDate,
      data_availability: 'FAILED',
      sync_status: 'FAILED',
      last_error: `Invalid date format: ${cleanDate}. Expected YYYY-MM-DD`,
      completeness: 'NONE'
    };
  }

  // 1. Check if an existing registry record is present
  const regRow = db.prepare('SELECT * FROM historical_date_registry WHERE work_date = ?').get(cleanDate);

  // 2. Count local SQLite records for this date
  const rawLogsCount = db.prepare('SELECT count(*) as c FROM raw_log_records WHERE work_date = ?').get(cleanDate)?.c || 0;
  const vendoorLogsCount = db.prepare('SELECT count(*) as c FROM vendoor_logs WHERE work_date = ?').get(cleanDate)?.c || 0;
  const cwoOrdersCount = db.prepare('SELECT count(*) as c FROM current_work_orders WHERE work_date = ?').get(cleanDate)?.c || 0;
  const voOrdersCount = db.prepare('SELECT count(*) as c FROM vendoor_orders WHERE (business_date = ? OR source_date = ?)').get(cleanDate, cleanDate)?.c || 0;
  const totalOrders = Math.max(cwoOrdersCount, voOrdersCount);
  const totalLogs = Math.max(rawLogsCount, vendoorLogsCount);

  // 3. Check snapshots and auto-build if logs are present but snapshots are missing
  let dailySnap = db.prepare('SELECT id, metrics_json, created_at FROM daily_metrics_snapshots WHERE work_date = ?').get(cleanDate);
  let perfSnapsCount = db.prepare('SELECT count(*) as c FROM performance_snapshots WHERE date = ?').get(cleanDate)?.c || 0;
  let hasSnapshots = Boolean(dailySnap || perfSnapsCount > 0);

  if (totalLogs > 0 && !hasSnapshots) {
    try {
      const logs = db.prepare('SELECT * FROM raw_log_records WHERE work_date = ?').all(cleanDate);
      if (logs && logs.length > 0) {
        const metrics = computePerformanceFromRecords(logs);
        savePerformanceSnapshotToDB(cleanDate, metrics);
        dailySnap = db.prepare('SELECT id, metrics_json, created_at FROM daily_metrics_snapshots WHERE work_date = ?').get(cleanDate);
        hasSnapshots = true;
      }
    } catch (_) {}
  }

  // 4. Derive availability
  let availability = 'MISSING';
  let completeness = 'NONE';
  let syncStatus = regRow ? regRow.sync_status : 'IDLE';

  if (inFlightHistoricalSyncs.has(cleanDate)) {
    availability = 'SYNCING';
    syncStatus = 'SYNCING';
  } else if (totalLogs > 0) {
    availability = 'READY';
    completeness = 'COMPLETE';
    if (syncStatus === 'SYNCING') syncStatus = 'COMPLETED';
  } else if (hasSnapshots || totalOrders > 0) {
    availability = 'PARTIAL';
    completeness = 'PARTIAL';
  } else if (regRow && regRow.sync_status === 'FAILED') {
    availability = 'FAILED';
    completeness = 'NONE';
  }

  const result = {
    work_date: cleanDate,
    data_availability: availability,
    logs_available: totalLogs > 0 ? 1 : 0,
    orders_available: totalOrders > 0 ? 1 : 0,
    metrics_available: hasSnapshots ? 1 : 0,
    snapshots_available: hasSnapshots ? 1 : 0,
    sync_status: syncStatus,
    sync_started_at: regRow?.sync_started_at || null,
    sync_completed_at: regRow?.sync_completed_at || null,
    last_successful_sync: regRow?.last_successful_sync || (hasSnapshots ? dailySnap?.created_at : null),
    record_count: totalLogs,
    pages_fetched: regRow?.pages_fetched || (totalLogs > 0 ? 1 : 0),
    pages_total: regRow?.pages_total || (totalLogs > 0 ? 1 : 0),
    completeness,
    last_error: regRow?.last_error || null,
    source: regRow?.source || (totalLogs > 0 ? 'LOCAL_DATABASE' : 'VENDOOR'),
    summary: dailySnap?.metrics_json ? JSON.parse(dailySnap.metrics_json)?.summary : null
  };

  // Upsert into registry for consistency
  try {
    db.prepare(`
      INSERT INTO historical_date_registry (
        work_date, data_availability, logs_available, orders_available,
        metrics_available, snapshots_available, sync_status, sync_started_at,
        sync_completed_at, last_successful_sync, record_count, pages_fetched,
        pages_total, completeness, last_error, source, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(work_date) DO UPDATE SET
        data_availability = excluded.data_availability,
        logs_available = excluded.logs_available,
        orders_available = excluded.orders_available,
        metrics_available = excluded.metrics_available,
        snapshots_available = excluded.snapshots_available,
        sync_status = excluded.sync_status,
        record_count = excluded.record_count,
        completeness = excluded.completeness,
        updated_at = datetime('now')
    `).run(
      result.work_date, result.data_availability, result.logs_available,
      result.orders_available, result.metrics_available, result.snapshots_available,
      result.sync_status, result.sync_started_at, result.sync_completed_at,
      result.last_successful_sync, result.record_count, result.pages_fetched,
      result.pages_total, result.completeness, result.last_error, result.source
    );
  } catch {}

  return result;
}

/**
 * Returns canonical list of all business dates containing operational data + registry statuses
 */
export function getAvailableBusinessDates(forceFresh = false) {
  const now = Date.now();
  if (!forceFresh && cachedAvailableDates && (now - cacheTimestamp < CACHE_TTL_MS)) {
    return cachedAvailableDates;
  }

  ensureHistoricalDateRegistryTable();
  const today = getCairoBusinessDate();

  // 1. Union of all date sources
  const dateRows = db.prepare(`
    WITH all_dates AS (
      SELECT work_date as d FROM current_work_orders WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT business_date as d FROM vendoor_orders WHERE business_date IS NOT NULL AND business_date != ''
      UNION
      SELECT source_date as d FROM vendoor_orders WHERE source_date IS NOT NULL AND source_date != ''
      UNION
      SELECT allocation_date as d FROM order_level_allocations WHERE allocation_date IS NOT NULL AND allocation_date != ''
      UNION
      SELECT work_date as d FROM daily_working_team WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT work_date as d FROM raw_log_records WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT work_date as d FROM vendoor_logs WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT work_date as d FROM order_tracking_events WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT work_date as d FROM daily_metrics_snapshots WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT date as d FROM performance_snapshots WHERE date IS NOT NULL AND date != ''
      UNION
      SELECT work_date as d FROM specific_orders_uploads WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT work_date as d FROM enterprise_allocation_runs WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT work_date as d FROM current_work_pool_summary WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT work_date as d FROM historical_date_registry WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT ? as d
    )
    SELECT d as date FROM all_dates
    WHERE d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    ORDER BY d DESC
  `).all(today);

  // 2. Compute rich metadata flags per date
  const results = dateRows.map(row => {
    const d = row.date;
    const isToday = (d === today);

    // Orders count
    const cwoCount = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'New' THEN 1 ELSE 0 END) as n,
        SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) as p
      FROM current_work_orders 
      WHERE work_date = ?
    `).get(d);

    let ordersCount = cwoCount?.total || 0;
    let newCount = cwoCount?.n || 0;
    let pendingCount = cwoCount?.p || 0;

    // Allocations count
    const allocCount = db.prepare(`
      SELECT 
        COUNT(*) as total_alloc,
        COUNT(DISTINCT employee_id) as emps
      FROM order_level_allocations 
      WHERE allocation_date = ? AND employee_name IS NOT NULL AND employee_name != 'UNASSIGNED'
    `).get(d);
    const allocatedCount = allocCount?.total_alloc || 0;

    if (ordersCount === 0) {
      const allocTotal = db.prepare(`
        SELECT 
          COUNT(DISTINCT order_code) as total,
          SUM(CASE WHEN LOWER(TRIM(status)) = 'new' THEN 1 ELSE 0 END) as n,
          SUM(CASE WHEN LOWER(TRIM(status)) = 'pending' THEN 1 ELSE 0 END) as p
        FROM order_level_allocations 
        WHERE allocation_date = ?
      `).get(d);

      if (allocTotal && allocTotal.total > 0) {
        ordersCount = allocTotal.total;
        newCount = allocTotal.n || 0;
        pendingCount = allocTotal.p || 0;
      } else {
        const voTotal = db.prepare(`
          SELECT 
            COUNT(DISTINCT order_code) as total,
            SUM(CASE WHEN LOWER(TRIM(COALESCE(active_status, status))) = 'new' THEN 1 ELSE 0 END) as n,
            SUM(CASE WHEN LOWER(TRIM(COALESCE(active_status, status))) = 'pending' THEN 1 ELSE 0 END) as p
          FROM vendoor_orders 
          WHERE (business_date = ? OR source_date = ?) AND is_active = 1
        `).get(d, d);

        if (voTotal && voTotal.total > 0) {
          ordersCount = voTotal.total;
          newCount = voTotal.n || 0;
          pendingCount = voTotal.p || 0;
        }
      }
    }

    // Working team count
    const teamRow = db.prepare('SELECT COUNT(*) as c FROM daily_working_team WHERE work_date = ? AND is_working = 1').get(d);
    const teamCount = teamRow?.c || 0;

    // Tracking count
    const rawLogsRow = db.prepare('SELECT COUNT(*) as c FROM raw_log_records WHERE work_date = ?').get(d);
    const vendoorLogsRow = db.prepare('SELECT COUNT(*) as c FROM vendoor_logs WHERE work_date = ?').get(d);
    const oteRow = db.prepare('SELECT COUNT(*) as c FROM order_tracking_events WHERE work_date = ?').get(d);
    const trackingCount = (rawLogsRow?.c || 0) + (vendoorLogsRow?.c || 0) + (oteRow?.c || 0);

    // Performance snapshots
    const dmsRow = db.prepare('SELECT COUNT(*) as c FROM daily_metrics_snapshots WHERE work_date = ?').get(d);
    const psRow = db.prepare('SELECT COUNT(*) as c FROM performance_snapshots WHERE date = ?').get(d);
    const hasPerformance = (dmsRow?.c || 0) > 0 || (psRow?.c || 0) > 0;

    // Registry status
    let status = 'READY';
    if (inFlightHistoricalSyncs.has(d)) {
      status = 'SYNCING';
    } else if (trackingCount === 0 && !hasPerformance && !isToday) {
      status = 'MISSING';
    } else if (trackingCount > 0 && hasPerformance) {
      status = 'READY';
    } else {
      status = 'PARTIAL';
    }

    return {
      date: d,
      status,
      is_today: isToday,
      has_orders: ordersCount > 0,
      has_allocation: allocatedCount > 0,
      has_working_team: teamCount > 0,
      has_tracking: trackingCount > 0,
      has_performance: hasPerformance,
      orders_count: ordersCount,
      new_count: newCount,
      pending_count: pendingCount,
      allocated_count: allocatedCount,
      working_team_count: teamCount,
      tracking_events_count: trackingCount
    };
  });

  const payload = {
    success: true,
    today,
    count: results.length,
    dates: results
  };

  cachedAvailableDates = payload;
  cacheTimestamp = now;
  return payload;
}

/**
 * Automatically loads or synchronizes a historical business date with Vendoor.
 * 
 * End-to-end execution:
 * 1. Validates business date
 * 2. Checks data availability in registry
 * 3. If ready and complete: returns local canonical data immediately
 * 4. If missing or incomplete: fetches all paginated activity logs from Vendoor
 * 5. Persists raw records idempotently into vendoor_logs and raw_log_records
 * 6. Computes canonical metrics via single computePerformanceFromRecords engine
 * 7. Updates daily_metrics_snapshots and performance_snapshots
 * 8. Updates historical_date_registry with status READY
 * 9. Returns unified payload for UI consumption
 * 
 * @param {string} workDate - YYYY-MM-DD
 * @param {Object} [options]
 * @param {boolean} [options.forceSync=false]
 * @param {string} [options.forceMode] - 'mock' or 'live'
 */
export async function loadOrSyncHistoricalDate(workDate, options = {}) {
  const cleanDate = String(workDate || '').trim();
  if (!cleanDate || !/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
    throw new Error(`Invalid business date: ${workDate}. Format must be YYYY-MM-DD.`);
  }

  const today = getCairoBusinessDate();
  if (cleanDate > today) {
    return {
      success: true,
      work_date: cleanDate,
      is_future: true,
      status: 'FUTURE_DATE',
      message: `Selected date ${cleanDate} is in the future. No operational logs available.`,
      summary: {
        totalRealActions: 0,
        printedActions: 0,
        pendingActions: 0,
        cancelledActions: 0,
        processingActions: 0,
        totalAltPhones: 0,
        totalNewOrders: 0
      },
      employees: []
    };
  }

  // 1. Single Flight In-Flight Deduplication
  if (inFlightHistoricalSyncs.has(cleanDate)) {
    console.log(`[HistoricalDateSync] Attaching to in-flight sync for ${cleanDate}...`);
    return await inFlightHistoricalSyncs.get(cleanDate);
  }

  const syncPromise = (async () => {
    ensureHistoricalDateRegistryTable();

    // 2. Check current local status
    const statusInfo = getHistoricalDateRegistryStatus(cleanDate);
    const hasRawLogs = statusInfo.record_count > 0;

    if (!options.forceSync && hasRawLogs) {
      console.log(`[HistoricalDateSync] ${cleanDate} is already available locally (${statusInfo.record_count} records). Computing canonical metrics...`);
      const records = db.prepare('SELECT * FROM raw_log_records WHERE work_date = ?').all(cleanDate);
      const metrics = computePerformanceFromRecords(records, cleanDate);

      // Keep DB snapshots in sync with canonical engine
      savePerformanceSnapshotToDB(cleanDate, metrics);

      return {
        success: true,
        work_date: cleanDate,
        status: 'READY',
        source: 'LOCAL_CANONICAL',
        summary: metrics.summary,
        dedup: metrics.dedup,
        employees: metrics.employees
      };
    }

    // 3. Mark Registry as SYNCING
    const jobId = createSyncRunId('hist_date');
    const startTime = Date.now();
    try {
      db.prepare(`
        INSERT INTO historical_date_registry (
          work_date, data_availability, sync_status, sync_started_at, updated_at
        ) VALUES (?, 'SYNCING', 'SYNCING', datetime('now'), datetime('now'))
        ON CONFLICT(work_date) DO UPDATE SET
          data_availability = 'SYNCING',
          sync_status = 'SYNCING',
          sync_started_at = datetime('now'),
          updated_at = datetime('now')
      `).run(cleanDate);
    } catch {}

    console.log(`[HistoricalDateSync] Starting live Vendoor fetch for historical date ${cleanDate}...`);

    let logsResult = null;
    let fetchError = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        logsResult = await fetchVendoorLogsForDate(cleanDate, {
          forceMode: options.forceMode
        });
        break;
      } catch (err) {
        fetchError = err;
        console.warn(`[HistoricalDateSync] Attempt ${attempt} failed for ${cleanDate}: ${err.message}`);
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, attempt * 1000));
        }
      }
    }

    if (!logsResult) {
      const errMsg = fetchError?.message || `Failed to fetch activity logs for ${cleanDate} from Vendoor`;
      try {
        db.prepare(`
          UPDATE historical_date_registry
          SET data_availability = 'FAILED', sync_status = 'FAILED', last_error = ?, updated_at = datetime('now')
          WHERE work_date = ?
        `).run(errMsg, cleanDate);
      } catch {}

      recordSyncRun({
        sync_run_id: jobId,
        resource: 'HISTORICAL_SINGLE_DAY',
        start_date: cleanDate,
        end_date: cleanDate,
        status: 'FAILED',
        records_fetched: 0,
        records_accepted: 0,
        records_duplicated: 0,
        records_rejected: 0,
        duration_ms: Date.now() - startTime,
        summary_json: null,
        error_safe: errMsg
      });

      throw new Error(errMsg);
    }

    // 4. Idempotent Database Persistence into vendoor_logs and raw_log_records
    const rawLogs = logsResult.normalizedLogs || logsResult.logs || [];
    const pagesFetched = logsResult.pages_fetched || logsResult.chunks_requested || 1;
    
    // Exact Africa/Cairo date validation filter on every single record
    const acceptedLogs = [];
    let rejectedCount = 0;
    for (const log of rawLogs) {
      const recDate = canonicalWorkDate(log);
      if (recDate === cleanDate) {
        acceptedLogs.push(log);
      } else {
        rejectedCount++;
      }
    }

    console.log(`[HistoricalDateSync] Ingesting ${acceptedLogs.length} validated logs for ${cleanDate} (${rejectedCount} rejected out-of-range, ${pagesFetched} pages/chunks)...`);

    if (options.forceSync) {
      db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(cleanDate);
      db.prepare('DELETE FROM vendoor_logs WHERE work_date = ?').run(cleanDate);
    }

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
      INSERT OR IGNORE INTO raw_log_records (
        work_date, order_code, employee_name, status, action,
        event_datetime, is_cs, is_deduped
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);

    const BATCH_SIZE = 1000;
    for (let i = 0; i < acceptedLogs.length; i += BATCH_SIZE) {
      const batch = acceptedLogs.slice(i, i + BATCH_SIZE);
      const batchTx = db.transaction(() => {
        for (const log of batch) {
          const orderCode = log.order_code || log.order || 'UNKNOWN';
          const rawName = log.employee_name || log.name || 'UNKNOWN';
          const actionText = log.action || '';
          const timestampStr = log.timestamp_str || log.event_datetime || `${cleanDate} 00:00:00`;
          const actionClassification = log.action_classification || 'UNKNOWN';
          const isProductive = log.is_productive ? 1 : 0;
          const matchedEmpId = log.matched_employee_id || null;
          const isCS = isCsEmployee({ name: rawName, employee_name: rawName }) ? 1 : 0;

          insertVendoorLogStmt.run(
            rawName, orderCode, actionText, actionClassification,
            isProductive, timestampStr, cleanDate, matchedEmpId,
            jobId
          );

          insertRawLogStmt.run(
            cleanDate, orderCode, rawName, log.status || 'Action Recorded', actionText,
            timestampStr, isCS
          );
        }
      });
      batchTx();
    }

    // 5. Compute Canonical Metrics via computePerformanceFromRecords
    const records = db.prepare('SELECT * FROM raw_log_records WHERE work_date = ?').all(cleanDate);
    const metrics = computePerformanceFromRecords(records);

    // 6. Save Updated Snapshots
    savePerformanceSnapshotToDB(cleanDate, metrics);

    // 7. Update Historical Date Registry to READY
    db.prepare(`
      UPDATE historical_date_registry
      SET data_availability = 'READY',
          sync_status = 'COMPLETED',
          logs_available = 1,
          orders_available = 1,
          metrics_available = 1,
          snapshots_available = 1,
          record_count = ?,
          pages_fetched = ?,
          pages_total = ?,
          completeness = 'COMPLETE',
          last_successful_sync = datetime('now'),
          last_error = NULL,
          summary_json = ?,
          updated_at = datetime('now')
      WHERE work_date = ?
    `).run(records.length, pagesFetched, pagesFetched, JSON.stringify(metrics.summary), cleanDate);

    invalidateAvailableDatesCache();

    recordSyncRun({
      sync_run_id: jobId,
      resource: 'HISTORICAL_SINGLE_DAY',
      start_date: cleanDate,
      end_date: cleanDate,
      status: 'SUCCESS',
      records_fetched: rawLogs.length,
      records_accepted: acceptedLogs.length,
      records_duplicated: logsResult.duplicates_removed || 0,
      records_rejected: rejectedCount + (logsResult.rows_rejected || 0),
      duration_ms: Date.now() - startTime,
      summary_json: JSON.stringify(metrics.summary),
      error_safe: null
    });

    console.log(`[HistoricalDateSync] ✓ ${cleanDate} successfully synchronized and snapshots saved (${metrics.summary.totalRealActions} real actions).`);

    return {
      success: true,
      work_date: cleanDate,
      status: 'READY',
      source: 'VENDOOR_SYNC',
      summary: metrics.summary,
      dedup: metrics.dedup,
      employees: metrics.employees
    };
  })();

  inFlightHistoricalSyncs.set(cleanDate, syncPromise);
  try {
    const res = await syncPromise;
    return res;
  } finally {
    inFlightHistoricalSyncs.delete(cleanDate);
  }
}

/**
 * Resolves full historical reality for a given workDate without mutating database
 */
export function getHistoricalDayOverview(workDate) {
  const cleanDate = String(workDate || '').trim();
  if (!cleanDate || !/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
    throw new Error(`Invalid workDate: ${workDate}. Expected format YYYY-MM-DD`);
  }

  // 1. Orders resolution via single canonical source
  const allOrders = getHistoricalOrdersForDate(cleanDate);
  const accountsSet = new Set(allOrders.map(o => o.account));
  const newCount = allOrders.filter(o => String(o.status || '').toLowerCase() === 'new' || String(o.status || '').includes('جديد')).length;
  const pendingCount = allOrders.filter(o => String(o.status || '').toLowerCase() === 'pending' || String(o.status || '').includes('معلق')).length;

  // 2. Working team resolution
  const teamRow = db.prepare(`
    SELECT 
      COUNT(*) as team_count,
      source
    FROM daily_working_team
    WHERE work_date = ? AND is_working = 1
    GROUP BY source
    ORDER BY CASE WHEN source = 'MANUAL' THEN 1 ELSE 2 END ASC
    LIMIT 1
  `).get(cleanDate);

  const teamCount = teamRow ? teamRow.team_count : 0;
  const teamSource = teamRow ? (teamRow.source || 'MANUAL') : 'MANUAL';

  // 3. Allocations resolution
  const allocRow = db.prepare(`
    SELECT COUNT(*) as allocated_count
    FROM order_level_allocations
    WHERE allocation_date = ? AND employee_name IS NOT NULL AND employee_name != 'UNASSIGNED'
  `).get(cleanDate);
  const allocatedCount = allocRow ? allocRow.allocated_count : 0;

  // 4. Completed orders resolution
  const compRow = db.prepare(`
    SELECT COUNT(DISTINCT order_code) as completed_count
    FROM (
      SELECT order_code FROM raw_log_records WHERE work_date = ? AND UPPER(action) IN ('PRINTED', 'STATUS_CHANGE', 'PROCESSING', 'DELIVERED', 'COMPLETED', 'SEALED', 'DISPATCHED')
      UNION
      SELECT order_code FROM vendoor_logs WHERE work_date = ? AND UPPER(action) IN ('PRINTED', 'STATUS_CHANGE', 'PROCESSING', 'DELIVERED', 'COMPLETED', 'SEALED', 'DISPATCHED')
      UNION
      SELECT order_code FROM order_tracking_events WHERE work_date = ? AND UPPER(action) IN ('PRINTED', 'STATUS_CHANGE', 'PROCESSING', 'DELIVERED', 'COMPLETED', 'SEALED', 'DISPATCHED')
    )
  `).get(cleanDate, cleanDate, cleanDate);
  const completedCount = compRow ? compRow.completed_count : 0;

  const totalOrders = allOrders.length;
  const unallocatedCount = Math.max(0, totalOrders - allocatedCount);

  return {
    work_date: cleanDate,
    source: 'canonical_historical_resolver',
    total_orders: totalOrders,
    accounts_count: accountsSet.size,
    new_count: newCount,
    pending_count: pendingCount,
    working_team_count: teamCount,
    working_team_source: teamSource,
    allocated_count: allocatedCount,
    unallocated_count: unallocatedCount,
    completed_count: completedCount
  };
}

/**
 * Resolves order list for a historical date using canonical single source
 */
export function getHistoricalOrdersList(workDate, options = {}) {
  const cleanDate = String(workDate || '').trim();
  const { account, status, search, limit = 100, offset = 0 } = options;

  let allOrders = getHistoricalOrdersForDate(cleanDate);

  if (account) {
    allOrders = allOrders.filter(o => String(o.account || '').toLowerCase() === String(account).toLowerCase());
  }
  if (status) {
    allOrders = allOrders.filter(o => String(o.status || '').toLowerCase() === String(status).toLowerCase());
  }
  if (search) {
    const s = String(search).toLowerCase();
    allOrders = allOrders.filter(o => String(o.order_code || '').toLowerCase().includes(s) || String(o.account || '').toLowerCase().includes(s));
  }

  const total = allOrders.length;
  const paged = allOrders.slice(offset, offset + limit);

  return {
    work_date: cleanDate,
    source: 'canonical_historical_resolver',
    total,
    limit,
    offset,
    orders: paged
  };
}

/**
 * Canonical Resolver for all orders belonging strictly to a historical date.
 * Single source of truth across all historical views.
 *
 * @param {string} workDate YYYY-MM-DD
 * @returns {Array<Object>} Date-scoped order objects
 */
export function getHistoricalOrdersForDate(workDate) {
  const cleanDate = String(workDate || '').trim();
  if (!cleanDate || !/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
    throw new Error(`Invalid workDate: ${workDate}. Expected format YYYY-MM-DD`);
  }

  const today = getCairoBusinessDate();
  const isToday = (cleanDate === today);

  // 1. For Today (Operational Work Pool), primary source of truth is current_work_orders
  if (isToday) {
    const cwoOrders = db.prepare(`
      SELECT 
        id, 
        order_code, 
        account, 
        status, 
        COALESCE(order_date, work_date) as order_date, 
        source_file_slot, 
        work_state, 
        assigned_employee_id, 
        assigned_employee_name, 
        tracking_id
      FROM current_work_orders
      WHERE (order_date = ? OR work_date = ?)
      ORDER BY account ASC, order_code ASC
    `).all(cleanDate, cleanDate);

    if (cwoOrders && cwoOrders.length > 0) {
      return cwoOrders;
    }

    // Fallback for today if current_work_orders not yet populated: active vendoor_orders
    const voOrders = db.prepare(`
      SELECT 
        id, 
        order_code, 
        account, 
        COALESCE(active_status, status) as status, 
        COALESCE(source_date, business_date, ?) as order_date, 
        1 as source_file_slot, 
        'UNASSIGNED' as work_state, 
        null as assigned_employee_id, 
        'UNASSIGNED' as assigned_employee_name, 
        order_code as tracking_id
      FROM vendoor_orders
      ORDER BY account ASC, order_code ASC
    `).all(cleanDate);

    if (voOrders && voOrders.length > 0) {
      return voOrders;
    }
  }

  // 2. For Historical Dates (or historical fallback)
  const ordersMap = new Map();

  // A. Check historical current_work_orders snapshot for cleanDate
  const cwoHist = db.prepare(`
    SELECT 
      id, 
      order_code, 
      account, 
      status, 
      COALESCE(order_date, work_date) as order_date, 
      source_file_slot, 
      work_state, 
      assigned_employee_id, 
      assigned_employee_name, 
      tracking_id
    FROM current_work_orders
    WHERE (order_date = ? OR work_date = ?)
      AND COALESCE(order_date, work_date) = ?
    ORDER BY account ASC, order_code ASC
  `).all(cleanDate, cleanDate, cleanDate);

  for (const cwo of cwoHist) {
    ordersMap.set(cwo.order_code, {
      id: cwo.id,
      order_code: cwo.order_code,
      account: cwo.account || 'General Account',
      status: cwo.status || 'New',
      order_date: cleanDate,
      source_file_slot: cwo.source_file_slot || 1,
      work_state: cwo.work_state || 'UNASSIGNED',
      assigned_employee_id: cwo.assigned_employee_id || null,
      assigned_employee_name: cwo.assigned_employee_name || 'UNASSIGNED',
      tracking_id: cwo.tracking_id || cwo.order_code
    });
  }

  // B. Check historical vendoor_orders explicitly dated cleanDate
  const voHist = db.prepare(`
    SELECT 
      id, 
      order_code, 
      account, 
      COALESCE(active_status, status) as status, 
      COALESCE(source_date, business_date) as order_date, 
      1 as source_file_slot, 
      'UNASSIGNED' as work_state, 
      null as assigned_employee_id, 
      'UNASSIGNED' as assigned_employee_name, 
      order_code as tracking_id
    FROM vendoor_orders
    WHERE (source_date = ? OR business_date = ?)
      AND COALESCE(source_date, business_date) IS NOT NULL
      AND TRIM(COALESCE(source_date, business_date)) != ''
    ORDER BY account ASC, order_code ASC
  `).all(cleanDate, cleanDate);

  for (const vo of voHist) {
    if (!ordersMap.has(vo.order_code)) {
      ordersMap.set(vo.order_code, {
        id: vo.id,
        order_code: vo.order_code,
        account: vo.account || 'General Account',
        status: vo.status || 'New',
        order_date: cleanDate,
        source_file_slot: vo.source_file_slot || 1,
        work_state: vo.work_state || 'UNASSIGNED',
        assigned_employee_id: vo.assigned_employee_id || null,
        assigned_employee_name: vo.assigned_employee_name || 'UNASSIGNED',
        tracking_id: vo.tracking_id || vo.order_code
      });
    } else {
      const ord = ordersMap.get(vo.order_code);
      if (ord.account === 'General Account' && vo.account) {
        ord.account = vo.account;
      }
    }
  }

  // C. CS-Scoped Historical Raw Logs for cleanDate
  const rawLogs = db.prepare(`
    SELECT id, order_code, employee_name, action, status, event_datetime, is_cs
    FROM raw_log_records
    WHERE work_date = ? AND order_code IS NOT NULL AND TRIM(order_code) != '' AND order_code != 'UNKNOWN'
      AND (is_cs = 1 OR status IN ('Printed', 'Pending', 'Processing', 'Cancelled'))
    ORDER BY event_datetime ASC, id ASC
  `).all(cleanDate);

  if (rawLogs && rawLogs.length > 0) {
    for (const log of rawLogs) {
      const code = log.order_code;
      const derivedStatus = extractCanonicalStatus(log.action, log.status);
      if (!ordersMap.has(code)) {
        ordersMap.set(code, {
          id: log.id,
          order_code: code,
          account: 'General Account',
          status: derivedStatus || 'Action Recorded',
          order_date: cleanDate,
          source_file_slot: 1,
          work_state: 'COMPLETED',
          assigned_employee_id: null,
          assigned_employee_name: log.employee_name || 'UNASSIGNED',
          tracking_id: code,
          first_action_time: log.event_datetime,
          last_action_time: log.event_datetime
        });
      } else {
        const existing = ordersMap.get(code);
        if (derivedStatus && derivedStatus !== 'Action Recorded') {
          existing.status = derivedStatus;
        }
        existing.last_action_time = log.event_datetime;
        if (log.employee_name && log.employee_name !== 'System AutoCancel') {
          existing.assigned_employee_name = log.employee_name;
        }
      }
    }
  }

  return Array.from(ordersMap.values());
}

/**
 * Canonical Resolver for all PENDING orders belonging strictly to a historical date.
 * Relies strictly on getHistoricalOrdersForDate to prevent current pending queue leakage.
 *
 * @param {string} workDate YYYY-MM-DD
 * @returns {Array<Object>} Date-scoped pending order objects
 */
export function getHistoricalPendingOrders(workDate) {
  const allOrders = getHistoricalOrdersForDate(workDate);
  return allOrders.filter(order => {
    const st = String(order.status || '').trim().toLowerCase();
    return st === 'pending' || st.includes('معلق') || st.includes('pending');
  });
}

/**
 * Resolves current live pending orders ONLY for LIVE_MODE (Today).
 * Never called for historical dates.
 *
 * @returns {Array<Object>} Live pending order objects
 */
export function getCurrentLivePendingOrders() {
  const today = getCairoBusinessDate();
  const cwoPending = db.prepare(`
    SELECT id, order_code, account, status, order_date, source_file_slot, work_state, assigned_employee_id, assigned_employee_name, tracking_id
    FROM current_work_orders
    WHERE work_date = ? AND (LOWER(status) = 'pending' OR status LIKE '%Pending%')
  `).all(today);

  if (cwoPending && cwoPending.length > 0) {
    return cwoPending;
  }

  return db.prepare(`
    SELECT id, order_code, account, COALESCE(active_status, status) as status, COALESCE(source_date, business_date) as order_date, 2 as source_file_slot, 'UNASSIGNED' as work_state, null as assigned_employee_id, 'UNASSIGNED' as assigned_employee_name, order_code as tracking_id
    FROM vendoor_orders
    WHERE (business_date = ? OR source_date = ?) AND is_active = 1 AND (LOWER(COALESCE(active_status, status)) = 'pending' OR COALESCE(active_status, status) LIKE '%Pending%')
  `).all(today, today);
}
