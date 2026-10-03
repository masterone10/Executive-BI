/**
 * Historical Vendoor Logs Weekly Import Service
 *
 * Responsibilities:
 * - Calculates canonical previous completed Cairo calendar week (Monday -> Sunday).
 * - Real live Vendoor activity logs ingestion with day-by-day streaming.
 * - Single-flight lock preventing concurrent imports.
 * - Automatic session authentication, token validation, and retry recovery.
 * - Authoritative operational Cairo business date preservation (work_date from activity timestamp).
 * - 100% idempotent SQL persistence into `vendoor_logs` and `raw_log_records`.
 * - CS actor separation (non-CS recorded strictly for audit without polluting Employee Master).
 * - Data quality breakdown (fetched, inserted, duplicates, rejected, unique orders/employees, status counts).
 * - Read-only historical snapshot recomputation.
 * - Zero mutation of live operational pools, current allocations, or dispatcher queues.
 */

import { db } from '../../db/index.js';
import { getVendoorDataSource } from './adapter.js';
import { ensureAuthenticatedVendoorSession, performVendoorAutoLogin } from './auth.js';
import { classifyVendoorAction, extractCanonicalStatus } from './actions.js';
import { getOperationalBusinessDate } from './normalize.js';
import { resolveEmployeeIdentity } from './identity.js';
import { isCsEmployee } from '../parser.js';
import { computePerformanceFromRecords, savePerformanceSnapshotToDB } from '../performance.js';
import { getPreviousCompletedWeekRange, getCairoBusinessDate } from '../time_utils.js';
import { createSyncRunId, recordSyncRun } from './orchestrator.js';
import { invalidateAvailableDatesCache } from '../historical_dates.js';

// Ensure weekly import state table exists for audit & resumption
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vendoor_weekly_import_state (
      job_id TEXT PRIMARY KEY,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      status TEXT NOT NULL,
      current_day TEXT,
      days_total INTEGER DEFAULT 7,
      days_completed INTEGER DEFAULT 0,
      total_fetched INTEGER DEFAULT 0,
      total_inserted INTEGER DEFAULT 0,
      total_duplicated INTEGER DEFAULT 0,
      total_rejected INTEGER DEFAULT 0,
      summary_json TEXT,
      last_error TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  // Clean up any stale RUNNING states on boot
  db.prepare(`
    UPDATE vendoor_weekly_import_state
    SET status = 'FAILED', last_error = 'Process restarted during import', completed_at = datetime('now')
    WHERE status = 'RUNNING'
  `).run();
} catch (e) {
  console.warn('[WeeklyLogsImporter] State table setup:', e.message);
}

// In-memory single-flight state
const activeWeeklyImportState = {
  isRunning: false,
  jobId: null,
  startDate: null,
  endDate: null,
  status: 'IDLE', // 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PARTIAL_FAILURE'
  currentDay: null,
  daysTotal: 7,
  daysCompleted: 0,
  totalFetched: 0,
  totalInserted: 0,
  totalDuplicated: 0,
  totalRejected: 0,
  perDaySummary: [],
  lastError: null,
  startedAt: null,
  completedAt: null
};

/**
 * Returns the current weekly logs import status
 */
export function getWeeklyLogsImportStatus() {
  try {
    const latestDbRow = db.prepare(`
      SELECT * FROM vendoor_weekly_import_state
      ORDER BY rowid DESC
      LIMIT 1
    `).get();

    if (!activeWeeklyImportState.isRunning && latestDbRow) {
      const summary = latestDbRow.summary_json ? JSON.parse(latestDbRow.summary_json) : null;
      return {
        is_running: false,
        job_id: latestDbRow.job_id,
        start_date: latestDbRow.start_date,
        end_date: latestDbRow.end_date,
        status: latestDbRow.status,
        current_day: latestDbRow.current_day,
        days_total: latestDbRow.days_total,
        days_completed: latestDbRow.days_completed,
        pages_completed: latestDbRow.days_completed,
        total_fetched: latestDbRow.total_fetched,
        total_inserted: latestDbRow.total_inserted,
        records_fetched: latestDbRow.total_fetched,
        records_stored: latestDbRow.total_inserted,
        total_duplicated: latestDbRow.total_duplicated,
        total_rejected: latestDbRow.total_rejected,
        per_day_summary: summary?.per_day_summary || [],
        last_error: latestDbRow.last_error,
        started_at: latestDbRow.started_at,
        start_time: latestDbRow.started_at,
        completed_at: latestDbRow.completed_at,
        end_time: latestDbRow.completed_at
      };
    }

    return {
      is_running: activeWeeklyImportState.isRunning,
      job_id: activeWeeklyImportState.jobId,
      start_date: activeWeeklyImportState.startDate,
      end_date: activeWeeklyImportState.endDate,
      status: activeWeeklyImportState.status,
      current_day: activeWeeklyImportState.currentDay,
      days_total: activeWeeklyImportState.daysTotal,
      days_completed: activeWeeklyImportState.daysCompleted,
      pages_completed: activeWeeklyImportState.daysCompleted,
      total_fetched: activeWeeklyImportState.totalFetched,
      total_inserted: activeWeeklyImportState.totalInserted,
      records_fetched: activeWeeklyImportState.totalFetched,
      records_stored: activeWeeklyImportState.totalInserted,
      total_duplicated: activeWeeklyImportState.totalDuplicated,
      total_rejected: activeWeeklyImportState.totalRejected,
      per_day_summary: activeWeeklyImportState.perDaySummary,
      last_error: activeWeeklyImportState.lastError,
      started_at: activeWeeklyImportState.startedAt,
      start_time: activeWeeklyImportState.startedAt,
      completed_at: activeWeeklyImportState.completedAt,
      end_time: activeWeeklyImportState.completedAt
    };
  } catch {
    return {
      is_running: activeWeeklyImportState.isRunning,
      status: activeWeeklyImportState.status,
      error: 'Failed to read status'
    };
  }
}

/**
 * Execute the Historical Previous Week Vendoor Logs Import.
 * Day-by-day streaming, idempotent storage, full retry recovery, and strict isolation.
 *
 * @param {Object} options
 * @param {string} [options.startDate] - YYYY-MM-DD (optional, defaults to Cairo previous week Monday)
 * @param {string} [options.endDate] - YYYY-MM-DD (optional, defaults to Cairo previous week Sunday)
 * @param {string} [options.forceMode] - 'mock' or 'live'
 * @param {Function} [options.onProgress] - progress callback (day, percent, counts)
 */
export async function importWeeklyVendoorLogs(options = {}) {
  // 1. Single Flight Guard
  if (activeWeeklyImportState.isRunning) {
    const err = new Error('Historical week import is already running.');
    err.code = 'IMPORT_ALREADY_RUNNING';
    err.status = getWeeklyLogsImportStatus();
    throw err;
  }

  // 2. Determine Date Range
  let startDate = options.startDate || options.start_date;
  let endDate = options.endDate || options.end_date;
  let targetDates = [];

  if (!startDate || !endDate) {
    const range = getPreviousCompletedWeekRange();
    startDate = range.startDate;
    endDate = range.endDate;
    targetDates = range.dates;
  } else {
    // Generate sequential daily list between startDate and endDate
    const cur = new Date(startDate + 'T00:00:00Z');
    const end = new Date(endDate + 'T00:00:00Z');
    while (cur <= end) {
      targetDates.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }

  const jobId = createSyncRunId('weekly_logs');
  const startTime = Date.now();

  // Reset active state
  activeWeeklyImportState.isRunning = true;
  activeWeeklyImportState.jobId = jobId;
  activeWeeklyImportState.startDate = startDate;
  activeWeeklyImportState.endDate = endDate;
  activeWeeklyImportState.status = 'RUNNING';
  activeWeeklyImportState.currentDay = null;
  activeWeeklyImportState.daysTotal = targetDates.length;
  activeWeeklyImportState.daysCompleted = 0;
  activeWeeklyImportState.totalFetched = 0;
  activeWeeklyImportState.totalInserted = 0;
  activeWeeklyImportState.totalDuplicated = 0;
  activeWeeklyImportState.totalRejected = 0;
  activeWeeklyImportState.perDaySummary = [];
  activeWeeklyImportState.lastError = null;
  activeWeeklyImportState.startedAt = new Date().toISOString();
  activeWeeklyImportState.completedAt = null;

  // Persist initial running state to DB
  try {
    db.prepare(`
      INSERT OR REPLACE INTO vendoor_weekly_import_state (
        job_id, start_date, end_date, status, current_day,
        days_total, days_completed, total_fetched, total_inserted,
        total_duplicated, total_rejected, summary_json, last_error,
        started_at, updated_at
      ) VALUES (?, ?, ?, 'RUNNING', ?, ?, 0, 0, 0, 0, 0, ?, NULL, datetime('now'), datetime('now'))
    `).run(
      jobId, startDate, endDate, targetDates[0] || startDate,
      targetDates.length, JSON.stringify({ dates: targetDates })
    );
  } catch (dbErr) {
    console.warn('[WeeklyLogsImporter] Initial DB state warning:', dbErr.message);
  }

  let ds;
  // 3. Ensure live session authentication & datasource initialization
  try {
    ds = getVendoorDataSource(options.forceMode);
    await ensureAuthenticatedVendoorSession();
  } catch (initErr) {
    activeWeeklyImportState.isRunning = false;
    activeWeeklyImportState.status = 'FAILED';
    activeWeeklyImportState.lastError = initErr.message;
    activeWeeklyImportState.completedAt = new Date().toISOString();

    recordSyncRun({
      sync_run_id: jobId,
      resource: 'HISTORICAL_LOG_WEEK',
      start_date: startDate,
      end_date: endDate,
      status: 'FAILED',
      records_fetched: 0,
      records_accepted: 0,
      records_duplicated: 0,
      records_rejected: 0,
      duration_ms: Date.now() - startTime,
      summary_json: null,
      error_safe: initErr.message
    });

    try {
      db.prepare(`
        UPDATE vendoor_weekly_import_state
        SET status = 'FAILED', last_error = ?, completed_at = datetime('now'), updated_at = datetime('now')
        WHERE job_id = ?
      `).run(initErr.message, jobId);
    } catch {}

    throw initErr;
  }

  // Prepared statements for idempotent writes
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

  let hasPartialFailure = false;
  let overallError = null;

  // 4. Sequential Day-by-Day Processing
  for (let dIdx = 0; dIdx < targetDates.length; dIdx++) {
    const targetDay = targetDates[dIdx];
    const dayStartTime = Date.now();
    activeWeeklyImportState.currentDay = targetDay;

    let dayFetched = 0;
    let dayInserted = 0;
    let dayDuplicated = 0;
    let dayRejected = 0;
    let dayPrinted = 0;
    let dayPending = 0;
    let dayCancelled = 0;
    let dayProcessing = 0;
    let dayOther = 0;

    const uniqueOrders = new Set();
    const uniqueEmployees = new Set();

    let logsResult = null;
    let dayError = null;

    // Fetch with retry & session renewal (explicit historical target day)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        logsResult = await ds.fetchLogs({
          startDate: targetDay,
          endDate: targetDay,
          historical: true
        });
        break;
      } catch (fetchErr) {
        dayError = fetchErr;
        const errMsg = String(fetchErr.message || '').toLowerCase();
        if (errMsg.includes('401') || errMsg.includes('419') || errMsg.includes('login') || errMsg.includes('session')) {
          try {
            await performVendoorAutoLogin();
          } catch {}
        }
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, attempt * 1000));
        }
      }
    }

    const dayDurationMs = Date.now() - dayStartTime;

    if (!logsResult) {
      hasPartialFailure = true;
      overallError = dayError?.message || `Failed to fetch logs for ${targetDay}`;
      activeWeeklyImportState.perDaySummary.push({
        date: targetDay,
        status: 'FAILED',
        error: dayError?.message || 'Fetch failed after 3 attempts',
        zero_reason: 'FETCH_FAILED_AFTER_RETRIES',
        requested: 1,
        raw_fetched: 0,
        raw_stored: 0,
        normalized: 0,
        inserted: 0,
        duplicates: 0,
        rejected: 0,
        unique_orders: 0,
        unique_employees: 0,
        unique_actors: 0,
        duration_ms: dayDurationMs,
        rows_per_sec: 0,
        status_breakdown: { printed: 0, pending: 0, cancelled: 0, processing: 0, other: 0 }
      });
      continue;
    }

    const logs = logsResult.logs || logsResult.sample_rows || [];
    dayFetched = logs.length;

    // Existing keys for precise duplication tracking
    const existingVendoorKeys = new Set(
      db.prepare(`
        SELECT order_code || '|' || employee_name || '|' || timestamp_str || '|' || action AS k
        FROM vendoor_logs
        WHERE work_date = ?
      `).all(targetDay).map(r => r.k)
    );

    const existingRawKeys = new Set(
      db.prepare(`
        SELECT work_date || '|' || order_code || '|' || employee_name || '|' || event_datetime || '|' || COALESCE(action, '') AS k
        FROM raw_log_records
        WHERE work_date = ?
      `).all(targetDay).map(r => r.k)
    );

    // Idempotent Transaction for this day
    const tx = db.transaction(() => {
      for (const log of logs) {
        if (!log.order_code || !log.employee_name) {
          dayRejected++;
          continue;
        }

        const rawAction = log.action || 'Action Recorded';
        const rawTs = log.timestamp || `${log.date || targetDay} 12:00:00`;
        const classification = classifyVendoorAction(rawAction);
        const canonicalStatus = extractCanonicalStatus(rawAction);

        // Derive authoritative business date from raw timestamp (NEVER falls back to current day)
        const opDateObj = getOperationalBusinessDate(rawTs, targetDay);
        const resolvedWorkDate = opDateObj ? opDateObj.business_date : (log.date || targetDay);

        // Deterministic CS / Employee Identity Resolution without mutating Employee Master
        const identity = resolveEmployeeIdentity(log.employee_name, { persistIdentity: false });
        const actorName = identity.employee_name || log.employee_name;
        const isCS = isCsEmployee({ name: actorName, department: identity.department }) ? 1 : 0;

        uniqueOrders.add(log.order_code);
        uniqueEmployees.add(actorName);

        // Status breakdown metrics
        const statusUpper = (canonicalStatus || rawAction).toUpperCase();
        if (statusUpper.includes('PRINT')) dayPrinted++;
        else if (statusUpper.includes('PENDING') || statusUpper.includes('WAIT')) dayPending++;
        else if (statusUpper.includes('CANCEL')) dayCancelled++;
        else if (statusUpper.includes('PROCESS') || statusUpper.includes('PROGRESS')) dayProcessing++;
        else dayOther++;

        const vKey = `${log.order_code}|${log.employee_name}|${rawTs}|${rawAction}`;
        if (existingVendoorKeys.has(vKey)) {
          dayDuplicated++;
        } else {
          dayInserted++;
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
          jobId
        );

        // 2. Insert into raw_log_records
        const rawKey = `${resolvedWorkDate}|${log.order_code}|${actorName}|${rawTs}|${rawAction}`;
        if (!existingRawKeys.has(rawKey)) {
          existingRawKeys.add(rawKey);
          insertRawLogStmt.run(
            resolvedWorkDate,
            log.order_code,
            actorName,
            canonicalStatus,
            rawAction,
            rawTs,
            isCS
          );
        }
      }
    });

    tx();

    // Recompute safe read-only performance snapshot for this date
    try {
      const records = db.prepare('SELECT * FROM raw_log_records WHERE work_date = ? AND is_cs = 1').all(targetDay);
      if (records && records.length > 0) {
        const metrics = computePerformanceFromRecords(records);
        savePerformanceSnapshotToDB(targetDay, metrics, null, db);
      }
    } catch (metricErr) {
      console.warn(`[WeeklyLogsImporter] Performance snapshot notice for ${targetDay}:`, metricErr.message);
    }

    activeWeeklyImportState.daysCompleted++;
    activeWeeklyImportState.totalFetched += dayFetched;
    activeWeeklyImportState.totalInserted += dayInserted;
    activeWeeklyImportState.totalDuplicated += dayDuplicated;
    activeWeeklyImportState.totalRejected += dayRejected;

    const zeroReason = (dayFetched === 0)
      ? (logsResult.rawRowsCount === 0 ? 'VENDOOR_RETURNED_ZERO_RECORDS' : 'NORMALIZATION_REJECTED_ALL_ROWS')
      : null;

    const rowsPerSec = dayDurationMs > 0 ? Math.round(dayFetched / (dayDurationMs / 1000)) : dayFetched;

    const daySummary = {
      date: targetDay,
      status: 'SUCCESS',
      requested: 1,
      raw_fetched: dayFetched,
      raw_stored: dayInserted + dayDuplicated,
      normalized: Math.max(0, dayFetched - dayRejected),
      inserted: dayInserted,
      duplicates: dayDuplicated,
      rejected: dayRejected,
      unique_orders: uniqueOrders.size,
      unique_employees: uniqueEmployees.size,
      unique_actors: uniqueEmployees.size,
      zero_reason: zeroReason,
      duration_ms: dayDurationMs,
      rows_per_sec: rowsPerSec,
      status_breakdown: {
        printed: dayPrinted,
        pending: dayPending,
        cancelled: dayCancelled,
        processing: dayProcessing,
        other: dayOther
      }
    };

    activeWeeklyImportState.perDaySummary.push(daySummary);

    // Invalidate dates cache so each day is visible immediately
    invalidateAvailableDatesCache();

    if (typeof options.onProgress === 'function') {
      try {
        options.onProgress({
          jobId,
          dayIndex: dIdx + 1,
          daysTotal: targetDates.length,
          currentDay: targetDay,
          daySummary,
          totalFetched: activeWeeklyImportState.totalFetched,
          totalInserted: activeWeeklyImportState.totalInserted
        });
      } catch {}
    }
  }

  const durationMs = Date.now() - startTime;
  const finalStatus = hasPartialFailure
    ? (activeWeeklyImportState.daysCompleted > 0 ? 'PARTIAL_FAILURE' : 'FAILED')
    : 'COMPLETED';

  activeWeeklyImportState.isRunning = false;
  activeWeeklyImportState.status = finalStatus;
  activeWeeklyImportState.completedAt = new Date().toISOString();
  activeWeeklyImportState.lastError = overallError;

  // Invalidate date cache globally after complete run
  invalidateAvailableDatesCache();

  // Persist final audit to vendoor_sync_runs
  recordSyncRun({
    sync_run_id: jobId,
    resource: 'HISTORICAL_LOG_WEEK',
    start_date: startDate,
    end_date: endDate,
    status: finalStatus === 'COMPLETED' ? 'SUCCESS' : finalStatus,
    records_fetched: activeWeeklyImportState.totalFetched,
    records_accepted: activeWeeklyImportState.totalInserted,
    records_duplicated: activeWeeklyImportState.totalDuplicated,
    records_rejected: activeWeeklyImportState.totalRejected,
    duration_ms: durationMs,
    summary_json: {
      days_requested: targetDates.length,
      days_completed: activeWeeklyImportState.daysCompleted,
      dates: targetDates,
      per_day_summary: activeWeeklyImportState.perDaySummary
    },
    error_safe: overallError
  });

  // Update persistent state in SQLite
  try {
    db.prepare(`
      UPDATE vendoor_weekly_import_state
      SET status = ?, current_day = NULL, days_completed = ?,
          total_fetched = ?, total_inserted = ?, total_duplicated = ?,
          total_rejected = ?, summary_json = ?, last_error = ?,
          completed_at = datetime('now'), updated_at = datetime('now')
      WHERE job_id = ?
    `).run(
      finalStatus,
      activeWeeklyImportState.daysCompleted,
      activeWeeklyImportState.totalFetched,
      activeWeeklyImportState.totalInserted,
      activeWeeklyImportState.totalDuplicated,
      activeWeeklyImportState.totalRejected,
      JSON.stringify({
        per_day_summary: activeWeeklyImportState.perDaySummary,
        dates: targetDates,
        duration_ms: durationMs
      }),
      overallError,
      jobId
    );
  } catch (saveErr) {
    console.warn('[WeeklyLogsImporter] Final state save warning:', saveErr.message);
  }

  return {
    success: finalStatus === 'COMPLETED',
    job_id: jobId,
    start_date: startDate,
    end_date: endDate,
    days: targetDates.length,
    days_completed: activeWeeklyImportState.daysCompleted,
    fetched: activeWeeklyImportState.totalFetched,
    inserted: activeWeeklyImportState.totalInserted,
    duplicates: activeWeeklyImportState.totalDuplicated,
    rejected: activeWeeklyImportState.totalRejected,
    status: finalStatus,
    per_day_summary: activeWeeklyImportState.perDaySummary,
    duration_ms: durationMs,
    error: overallError
  };
}
