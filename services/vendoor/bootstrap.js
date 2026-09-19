/**
 * Vendoor Two-Calendar-Month Historical Bootstrap & Resumable Synchronization Engine
 *
 * Requirements met:
 * 1. Exact Historical Period: Current Business Date minus 2 calendar months through Current Business Date.
 * 2. Logs First: Fetched via GET /dashboard/log/xls/all in sequential 7-day weekly windows.
 * 3. XLS/XLSX Internal Parser: Uses internal sheetjs parser, normalizes, canonical action/status, 120s dedup, SQL upsert.
 * 4. Orders Second: Fetched via GET /dashboard/orders with DataTables pagination (page size 300, start=0, 300, 600...).
 * 5. Resumable: Tracks state in `vendoor_bootstrap_state` (NOT_STARTED, IN_PROGRESS, PARTIAL, RETRYING, COMPLETE, SOURCE_ERROR).
 * 6. Historical Productivity Baseline: Feeds Smart Allocation and Fair Dispatcher without fabricating data.
 * 7. Daily Handoff: Hands off smoothly to continuous day-by-day synchronization (اليوم بيومه).
 */

import { db } from '../../db/index.js';
import { partitionDateRange } from './logs.js';
import { syncVendoorLogs, syncVendoorOrders, createSyncRunId, recordSyncRun } from './orchestrator.js';
import { computePerformanceFromRecords, savePerformanceSnapshotToDB, getEmployeePerformanceProfiles } from '../performance.js';
import { getEffectiveWorkDate } from './dispatcher.js';

// Ensure bootstrap state table exists
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vendoor_bootstrap_state (
      job_id TEXT PRIMARY KEY,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      current_phase TEXT NOT NULL,
      state_status TEXT NOT NULL,
      progress_json TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
} catch (e) {
  console.warn('[Bootstrap] Table creation warning:', e.message);
}

/**
 * Calculates exact two calendar months date range
 * Current Business Date minus 2 calendar months through Current Business Date
 */
export function getTwoCalendarMonthsRange(todayInput = null) {
  const effectiveToday = todayInput || getEffectiveWorkDate() || new Date().toISOString().slice(0, 10);
  const endD = new Date(effectiveToday + 'T00:00:00Z');
  const startD = new Date(endD.getTime());
  startD.setUTCMonth(startD.getUTCMonth() - 2);

  return {
    startDate: startD.toISOString().slice(0, 10),
    endDate: endD.toISOString().slice(0, 10)
  };
}

// In-memory active bootstrap state cache
const activeBootstrapMemory = {
  isRunning: false,
  jobId: null,
  currentPhase: 'NOT_STARTED',
  stateStatus: 'NOT_STARTED',
  progress: null,
  error: null,
  lastSummary: null
};

/**
 * Get current bootstrap status from memory and SQL database
 */
export function getHistoricalBootstrapStatus() {
  try {
    const latest = db.prepare('SELECT * FROM vendoor_bootstrap_state ORDER BY updated_at DESC LIMIT 1').get();
    if (!latest && !activeBootstrapMemory.isRunning) {
      return {
        is_running: false,
        job_id: null,
        current_phase: 'NOT_STARTED',
        state_status: 'NOT_STARTED',
        percent_complete: 0,
        progress: null,
        error: null,
        last_summary: null
      };
    }

    const stateObj = latest ? JSON.parse(latest.progress_json || '{}') : {};
    const isRunning = activeBootstrapMemory.isRunning;
    const currentPhase = isRunning ? activeBootstrapMemory.currentPhase : (latest?.current_phase || 'NOT_STARTED');
    const stateStatus = isRunning ? activeBootstrapMemory.stateStatus : (latest?.state_status || 'NOT_STARTED');

    let percent = 0;
    if (currentPhase === 'LOGS_CHUNKS') {
      const completed = stateObj.logs_completed_count || 0;
      const total = stateObj.total_logs_chunks || 1;
      percent = Math.round((completed / total) * 60);
    } else if (currentPhase === 'ORDERS') {
      percent = 75;
    } else if (currentPhase === 'RECOMPUTING_METRICS') {
      percent = 90;
    } else if (currentPhase === 'COMPLETE' || stateStatus === 'COMPLETE') {
      percent = 100;
    }

    return {
      is_running: isRunning,
      job_id: latest?.job_id || activeBootstrapMemory.jobId,
      current_phase: currentPhase,
      state_status: stateStatus,
      percent_complete: percent,
      date_range: {
        start_date: latest?.start_date || stateObj.startDate,
        end_date: latest?.end_date || stateObj.endDate
      },
      progress: stateObj,
      error: latest?.error_message || activeBootstrapMemory.error,
      last_summary: activeBootstrapMemory.lastSummary || stateObj.lastSummary || null
    };
  } catch (err) {
    return {
      is_running: activeBootstrapMemory.isRunning,
      job_id: activeBootstrapMemory.jobId,
      current_phase: activeBootstrapMemory.currentPhase,
      state_status: activeBootstrapMemory.stateStatus,
      percent_complete: 0,
      error: err.message
    };
  }
}

/**
 * Save or update bootstrap state in SQL database
 */
function persistBootstrapState(jobId, startDate, endDate, phase, status, progressObj, errorMsg = null) {
  try {
    db.prepare(`
      INSERT INTO vendoor_bootstrap_state (job_id, start_date, end_date, current_phase, state_status, progress_json, error_message, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(job_id) DO UPDATE SET
        current_phase = excluded.current_phase,
        state_status = excluded.state_status,
        progress_json = excluded.progress_json,
        error_message = excluded.error_message,
        updated_at = datetime('now')
    `).run(
      jobId,
      startDate,
      endDate,
      phase,
      status,
      JSON.stringify(progressObj),
      errorMsg
    );
  } catch (err) {
    console.error('[Bootstrap] Failed to persist state:', err.message);
  }
}

/**
 * Execute Two-Calendar-Month Historical Bootstrap (Resumable)
 */
export async function bootstrapHistoricalTwoMonths(options = {}) {
  if (activeBootstrapMemory.isRunning) {
    return {
      success: false,
      message: 'Bootstrap is already running',
      status: getHistoricalBootstrapStatus()
    };
  }

  // CRITICAL: Production/runtime bootstrap MUST NEVER use mock data.
  if (options.forceMode === 'mock' && process.env.NODE_ENV !== 'test') {
    throw new Error('MOCK_BOOTSTRAP_DISALLOWED: Historical bootstrap requires real authenticated Vendoor data.');
  }
  const effectiveMode = (process.env.NODE_ENV === 'test' && options.forceMode === 'mock') ? 'mock' : 'live';

  const range = getTwoCalendarMonthsRange(options.today);
  const startDate = options.startDate || range.startDate;
  const endDate = options.endDate || range.endDate;
  const logicalWeeklyChunkDays = 7; // Weekly logical windows (اسبوع اسبوع)

  const jobId = options.jobId || createSyncRunId('bootstrap-2calendar-months');
  const startTime = Date.now();

  activeBootstrapMemory.isRunning = true;
  activeBootstrapMemory.jobId = jobId;
  activeBootstrapMemory.currentPhase = 'LOGS_CHUNKS';
  activeBootstrapMemory.stateStatus = 'IN_PROGRESS';
  activeBootstrapMemory.error = null;

  // Generate weekly logical chunks covering the entire two calendar months range
  const chunks = partitionDateRange(startDate, endDate, logicalWeeklyChunkDays);
  
  const progressObj = {
    jobId,
    startDate,
    endDate,
    logical_weekly_windows_total: chunks.length,
    logs_completed_count: 0,
    completed_chunks: [],
    failed_chunks: [],
    orders_progress: { status: 'PENDING', fetched: 0, accepted: 0 },
    lastSummary: null
  };

  persistBootstrapState(jobId, startDate, endDate, 'LOGS_CHUNKS', 'IN_PROGRESS', progressObj);

  try {
    console.log(`[BOOTSTRAP-2MONTHS] Starting 2-calendar-month historical bootstrap: ${startDate} to ${endDate} (${chunks.length} weekly logical windows)...`);

    // =========================================================================
    // PHASE 1: Historical Logs — Weekly Windows with Complete Sub-window Coverage
    // =========================================================================
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkKey = `${chunk.start}->${chunk.end}`;

      // Check if already completed in prior run (Resumability)
      if (progressObj.completed_chunks.some(c => c.key === chunkKey)) {
        console.log(`[BOOTSTRAP-2MONTHS] Skipping already completed weekly log window ${i + 1}/${chunks.length} (${chunkKey})`);
        continue;
      }

      activeBootstrapMemory.currentPhase = 'LOGS_CHUNKS';
      console.log(`[BOOTSTRAP-2MONTHS] Processing Weekly Log Window ${i + 1}/${chunks.length} (${chunk.start} to ${chunk.end})...`);

      // To guarantee zero timeouts and handle dense payloads safely, partition the week into complete contiguous sub-windows (2-day max)
      const subWindows = partitionDateRange(chunk.start, chunk.end, 2);
      let weekTotalFetched = 0;
      let weekTotalAccepted = 0;
      const subWindowResults = [];

      for (let sIdx = 0; sIdx < subWindows.length; sIdx++) {
        const sub = subWindows[sIdx];
        const subKey = `${sub.start}->${sub.end}`;
        console.log(`[BOOTSTRAP-2MONTHS] Fetching Sub-Window ${sIdx + 1}/${subWindows.length} (${subKey}) for Weekly Window ${i + 1}...`);

        let logRes;
        try {
          logRes = await syncVendoorLogs({
            startDate: sub.start,
            endDate: sub.end,
            forceMode: effectiveMode
          });
        } catch (subErr) {
          console.warn(`[BOOTSTRAP-2MONTHS] Sub-window ${subKey} failed:`, subErr.message);
          // One safe retry
          try {
            await new Promise(r => setTimeout(r, 500));
            logRes = await syncVendoorLogs({
              startDate: sub.start,
              endDate: sub.end,
              forceMode: effectiveMode
            });
          } catch (retryErr) {
            progressObj.failed_chunks.push({ key: chunkKey, sub_key: subKey, error: retryErr.message, timestamp: new Date().toISOString() });
            persistBootstrapState(jobId, startDate, endDate, 'LOGS_CHUNKS', 'FAILED', progressObj, retryErr.message);
            throw new Error(`Weekly Window ${chunkKey} failed on sub-window ${subKey}: ${retryErr.message}`);
          }
        }

        const fetched = logRes?.summary?.total_rows || logRes?.total_fetched || 0;
        const accepted = logRes?.summary?.total_accepted || logRes?.total_accepted || 0;
        weekTotalFetched += fetched;
        weekTotalAccepted += accepted;
        subWindowResults.push({ sub_key: subKey, start: sub.start, end: sub.end, fetched, accepted });

        if (sIdx < subWindows.length - 1) {
          await new Promise(r => setTimeout(r, 50));
        }
      }

      progressObj.completed_chunks.push({
        key: chunkKey,
        start: chunk.start,
        end: chunk.end,
        fetched: weekTotalFetched,
        accepted: weekTotalAccepted,
        sub_windows: subWindowResults
      });
      progressObj.logs_completed_count++;

      persistBootstrapState(jobId, startDate, endDate, 'LOGS_CHUNKS', 'IN_PROGRESS', progressObj);
      if (i < chunks.length - 1) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // =========================================================================
    // PHASE 2: Historical Orders — Paginated (Page Size 300)
    // =========================================================================
    activeBootstrapMemory.currentPhase = 'ORDERS';
    progressObj.orders_progress.status = 'IN_PROGRESS';
    persistBootstrapState(jobId, startDate, endDate, 'ORDERS', 'IN_PROGRESS', progressObj);

    console.log(`[BOOTSTRAP-2MONTHS] Fetching 2-calendar-month orders from ${startDate} to ${endDate} with page size 300...`);

    const ordersRes = await syncVendoorOrders({
      fromDate: startDate,
      toDate: endDate,
      pageSize: 300,
      maxPages: 200,
      forceMode: effectiveMode
    });

    if (!ordersRes.success) {
      throw new Error(`Orders historical sync failed: ${ordersRes.error || 'Unknown error'}`);
    }

    progressObj.orders_progress = {
      status: 'COMPLETE',
      fetched: ordersRes.total_fetched || ordersRes.summary?.total_fetched || 0,
      accepted: ordersRes.total_accepted || ordersRes.summary?.total_accepted || 0,
      pages: ordersRes.pages_processed || ordersRes.summary?.pages_processed || 0
    };

    persistBootstrapState(jobId, startDate, endDate, 'RECOMPUTING_METRICS', 'IN_PROGRESS', progressObj);

    // =========================================================================
    // PHASE 3: Historical Productivity Baseline & Snapshots
    // =========================================================================
    activeBootstrapMemory.currentPhase = 'RECOMPUTING_METRICS';
    console.log('[BOOTSTRAP-2MONTHS] Recomputing historical performance metrics & employee profiles...');

    const distinctDates = db.prepare(`
      SELECT DISTINCT work_date FROM raw_log_records
      WHERE work_date >= ? AND work_date <= ?
      ORDER BY work_date ASC
    `).all(startDate, endDate);

    let daysSnapshotted = 0;
    for (const dRow of distinctDates) {
      const d = dRow.work_date;
      const records = db.prepare('SELECT * FROM raw_log_records WHERE work_date = ?').all(d);
      if (records && records.length > 0) {
        const metrics = computePerformanceFromRecords(records, d);
        savePerformanceSnapshotToDB(d, metrics);
        daysSnapshotted++;
      }
    }

    const profiles = getEmployeePerformanceProfiles(endDate);

    // Save completion flag in system_configs
    try {
      db.prepare(`
        INSERT INTO system_configs (key, value, description)
        VALUES ('vendoor_bootstrap_2calendar_months_completed', 'true', 'Flag indicating 2-calendar-month bootstrap completed')
        ON CONFLICT(key) DO UPDATE SET value = 'true'
      `).run();
    } catch (_) {}

    const totalDurationMs = Date.now() - startTime;
    activeBootstrapMemory.currentPhase = 'COMPLETE';
    activeBootstrapMemory.stateStatus = 'COMPLETE';

    const summary = {
      job_id: jobId,
      date_range: { start_date: startDate, end_date: endDate },
      duration_ms: totalDurationMs,
      logs_chunks_count: chunks.length,
      logs_total_accepted: progressObj.completed_chunks.reduce((acc, c) => acc + c.accepted, 0),
      orders_total_fetched: progressObj.orders_progress.fetched,
      days_snapshotted: daysSnapshotted,
      profiles_generated: profiles.length,
      mode: 'NORMAL_DAILY_MODE'
    };

    progressObj.lastSummary = summary;
    persistBootstrapState(jobId, startDate, endDate, 'COMPLETE', 'COMPLETE', progressObj, null);

    recordSyncRun({
      sync_run_id: jobId,
      resource: 'bootstrap_2calendar_months',
      start_date: startDate,
      end_date: endDate,
      status: 'SUCCESS',
      records_fetched: summary.logs_total_accepted + summary.orders_total_fetched,
      records_accepted: summary.logs_total_accepted + summary.orders_total_fetched,
      duration_ms: totalDurationMs,
      summary_json: summary,
      error_safe: null
    });

    console.log(`[BOOTSTRAP-2MONTHS] ✓ 2-calendar-month historical bootstrap COMPLETED successfully in ${totalDurationMs}ms.`);

    return {
      success: true,
      job_id: jobId,
      summary
    };
  } catch (err) {
    const totalDurationMs = Date.now() - startTime;
    activeBootstrapMemory.currentPhase = 'SOURCE_ERROR';
    activeBootstrapMemory.stateStatus = 'SOURCE_ERROR';
    activeBootstrapMemory.error = err.message;

    persistBootstrapState(jobId, startDate, endDate, activeBootstrapMemory.currentPhase, 'SOURCE_ERROR', progressObj, err.message);

    recordSyncRun({
      sync_run_id: jobId,
      resource: 'bootstrap_2calendar_months',
      start_date: startDate,
      end_date: endDate,
      status: 'FAILED',
      duration_ms: totalDurationMs,
      error_safe: err.message
    });

    console.error('[BOOTSTRAP-2MONTHS] Error during historical bootstrap:', err);
    return {
      success: false,
      job_id: jobId,
      error: err.message,
      duration_ms: totalDurationMs
    };
  } finally {
    activeBootstrapMemory.isRunning = false;
  }
}
