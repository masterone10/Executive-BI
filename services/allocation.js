import { db } from '../db/index.js';
import { parseSpecificOrdersBuffer, parseAnyUploadedBuffer, detectWorkbookDateAndType, normalizeDateToISO, isCsEmployee, isCsDept } from './parser.js';
import { computePerformanceFromRecords, savePerformanceSnapshotToDB, getEmployeePerformanceProfiles, calculateSmartAllocationScore } from './performance.js';
import { persistDailyLogRecords, generateTrackingId, recordOrderLifecycleEvent, logEmployeeActivity } from './tracking.js';
import { syncAndRestoreObservedTeam } from './working_team_ops.js';
import { getCapacityConfig, getEmployeeEffectiveCapacity } from './capacity_config.js';
import {
  getEnterpriseAllocationConfig,
  validateEnterpriseAllocationConfig,
  saveEnterpriseAllocationConfig,
  getEnterpriseConfigurationHistory,
  evaluateAccountTimeStatus,
  evaluateEmployeeAllocationEligibility,
  evaluatePendingRescueOperation,
  computeDistributionFingerprint,
  checkDistributionUniqueness,
  planEnterpriseAllocation,
  executeEnterpriseAllocation,
  checkEnterpriseOperationalAlerts,
  getEnterpriseAllocationRunDetails,
  getEnterpriseAllocationHistory,
  ALLOCATION_MODES,
  ALLOCATION_ERROR_CODES
} from './enterprise_allocation.js';

export {
  getEnterpriseAllocationConfig,
  validateEnterpriseAllocationConfig,
  saveEnterpriseAllocationConfig,
  getEnterpriseConfigurationHistory,
  evaluateAccountTimeStatus,
  evaluateEmployeeAllocationEligibility,
  evaluatePendingRescueOperation,
  computeDistributionFingerprint,
  checkDistributionUniqueness,
  planEnterpriseAllocation,
  executeEnterpriseAllocation,
  checkEnterpriseOperationalAlerts,
  getEnterpriseAllocationRunDetails,
  getEnterpriseAllocationHistory,
  ALLOCATION_MODES,
  ALLOCATION_ERROR_CODES
};


/**
 * Universal Auto-Detected Upload Processor
 * Detects Business Date and Source Type from file content and routes records automatically.
 */
export function processAutoDetectedUpload(fileBuffer, originalFilename = '', userOverrideDate = null, fileSize = 0) {
  // 1. Get employees map
  const allEmps = db.prepare('SELECT name, department FROM employees').all();
  const empMap = new Map();
  for (const e of allEmps) {
    empMap.set(e.name, e.department);
  }

  // 2. Parse and detect
  const parsedResult = parseAnyUploadedBuffer(fileBuffer, originalFilename, userOverrideDate, empMap);
  const detection = parsedResult.detection;
  const sourceType = parsedResult.source_type;

  const resultsByDate = [];

  if (sourceType === 'EOD_DAILY_LOG') {
    const recordsByDate = parsedResult.records_by_date || {};
    let dates = Object.keys(recordsByDate).filter(d => d !== 'UNDATED');
    if (dates.length === 0 && userOverrideDate) dates = [userOverrideDate];
    if (dates.length === 0 && detection.primary_date) dates = [detection.primary_date];

    for (const d of dates) {
      const recs = recordsByDate[d] || parsedResult.records || [];
      const metrics = computePerformanceFromRecords(recs, empMap);

      const insertFile = db.prepare(`
        INSERT INTO uploaded_files (
          file_name, file_type, source_type, upload_date, business_date, row_count, valid_rows, skipped_rows, notes, detection_json
        ) VALUES (?, 'daily_log', 'EOD_DAILY_LOG', datetime('now'), ?, ?, ?, ?, ?, ?)
      `);
      const fileRes = insertFile.run(
        originalFilename,
        d,
        recs.length,
        recs.length,
        0,
        `Auto-detected EOD Log for ${d} with ${metrics.summary.totalRealActions} actions`,
        JSON.stringify(detection)
      );
      const sourceFileId = fileRes.lastInsertRowid;

      savePerformanceSnapshotToDB(d, metrics, sourceFileId);
      persistDailyLogRecords(d, sourceFileId, recs);

      resultsByDate.push({
        business_date: d,
        source_type: 'EOD_DAILY_LOG',
        records_count: recs.length,
        real_actions: metrics.summary.totalRealActions,
        unique_orders: metrics.summary.totalNewOrders,
        status: 'ready'
      });
    }
  } else {
    // Specific Orders (New or Pending)
    const ordersByDate = parsedResult.orders_by_date || {};
    let dates = Object.keys(ordersByDate).filter(d => d !== 'UNDATED');
    if (dates.length === 0 && userOverrideDate) dates = [userOverrideDate];
    if (dates.length === 0 && detection.primary_date) dates = [detection.primary_date];

    for (const d of dates) {
      const dateOrders = ordersByDate[d] || parsedResult.orders || [];

      // Determine slot dynamically: if file with same name already staged for this date, re-use its slot; otherwise assign next available slot
      const existingFile = db.prepare('SELECT file_slot FROM specific_orders_uploads WHERE work_date = ? AND file_name = ?').get(d, originalFilename);
      let slot;
      if (existingFile) {
        slot = existingFile.file_slot;
      } else {
        const maxSlotRow = db.prepare('SELECT MAX(file_slot) as max_s FROM specific_orders_uploads WHERE work_date = ?').get(d);
        slot = (maxSlotRow && maxSlotRow.max_s) ? maxSlotRow.max_s + 1 : 1;
      }

      // Stage for date
      const stagedInfo = stageSpecificOrdersFile(d, slot, originalFilename, dateOrders, fileSize);
      let mergeSummary = null;
      try {
        mergeSummary = mergeSpecificOrdersPool(d);
      } catch (mErr) {
        console.warn(`Merge note for date ${d}:`, mErr.message);
      }

      // Record in uploaded_files audit
      try {
        db.prepare(`
          INSERT INTO uploaded_files (
            file_name, file_type, source_type, upload_date, business_date, row_count, valid_rows, skipped_rows, notes, detection_json
          ) VALUES (?, 'specific_orders', ?, datetime('now'), ?, ?, ?, ?, ?, ?)
        `).run(
          originalFilename,
          sourceType,
          d,
          stagedInfo.row_count,
          stagedInfo.valid_orders_count,
          stagedInfo.skipped_rows,
          `Auto-routed ${stagedInfo.valid_orders_count} orders to slot ${slot} for ${d}`,
          JSON.stringify(detection)
        );
      } catch (_) {}

      resultsByDate.push({
        business_date: d,
        source_type: sourceType,
        file_slot: slot,
        orders_count: dateOrders.length,
        unique_orders: mergeSummary ? mergeSummary.unique_orders : dateOrders.length,
        status: 'ready_for_allocation'
      });
    }
  }

  return {
    success: true,
    file_name: originalFilename,
    source_type: sourceType,
    detection,
    results_by_date: resultsByDate,
    requires_review: detection.requires_review && !userOverrideDate
  };
}

/**
 * Returns summary of all detected business dates and their readiness
 */
export function getUploadsBusinessDatesSummary() {
  const datesMap = new Map();

  // 1. Get dates from specific_orders_uploads
  const stagedRows = db.prepare(`
    SELECT work_date, file_slot, file_name, row_count, valid_orders_count, upload_date
    FROM specific_orders_uploads
    ORDER BY work_date DESC, file_slot ASC
  `).all();

  for (const r of stagedRows) {
    if (!datesMap.has(r.work_date)) {
      datesMap.set(r.work_date, {
        work_date: r.work_date,
        files: [],
        files_count: 0,
        file1: null,
        file2: null,
        new_orders: 0,
        pending_orders: 0,
        eod_records: 0,
        eod_actions: 0,
        has_allocation: false,
        total_unique_orders: 0,
        status: 'Ready for Allocation'
      });
    }
    const dObj = datesMap.get(r.work_date);
    dObj.files.push(r);
    dObj.files_count++;
    if (r.file_slot === 1) {
      dObj.file1 = r;
      dObj.new_orders += r.valid_orders_count;
    } else if (r.file_slot === 2) {
      dObj.file2 = r;
      dObj.pending_orders += r.valid_orders_count;
    } else {
      dObj.new_orders += r.valid_orders_count;
    }
  }

  // 2. Get current pool counts
  const poolRows = db.prepare(`
    SELECT work_date, unique_orders_count, merged_orders_count
    FROM current_work_pool_summary
  `).all();

  for (const p of poolRows) {
    if (datesMap.has(p.work_date)) {
      datesMap.get(p.work_date).total_unique_orders = p.unique_orders_count;
    }
  }

  // Check direct count from current_work_orders if needed
  for (const [wDate, dObj] of datesMap.entries()) {
    if (!dObj.total_unique_orders) {
      try {
        const cnt = db.prepare('SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ?').get(wDate).c;
        if (cnt > 0) dObj.total_unique_orders = cnt;
      } catch (_) {}
    }
  }

  // 3. Check allocations
  const allocRows = db.prepare(`
    SELECT DISTINCT allocation_date FROM order_level_allocations
  `).all();
  for (const a of allocRows) {
    if (datesMap.has(a.allocation_date)) {
      datesMap.get(a.allocation_date).has_allocation = true;
    }
  }

  // 4. Check EOD logs
  const eodRows = db.prepare(`
    SELECT work_date, COUNT(*) as cnt FROM raw_log_records GROUP BY work_date
  `).all();
  for (const e of eodRows) {
    if (!datesMap.has(e.work_date)) {
      datesMap.set(e.work_date, {
        work_date: e.work_date,
        files: [],
        files_count: 0,
        file1: null,
        file2: null,
        new_orders: 0,
        pending_orders: 0,
        eod_records: e.cnt,
        eod_actions: e.cnt,
        has_allocation: false,
        total_unique_orders: 0,
        status: 'EOD Log Loaded'
      });
    } else {
      datesMap.get(e.work_date).eod_records = e.cnt;
    }
  }

  return Array.from(datesMap.values()).sort((a, b) => b.work_date.localeCompare(a.work_date));
}

/**
 * Stage an uploaded Specific Orders file (Dynamic slot: 1, 2, 3...) for a given date
 * (Part 4, 30, 54, Final Real-Data Fix)
 */
export function stageSpecificOrdersFile(workDate, fileSlot = null, fileName = '', bufferOrOrders = [], fileSize = 0) {
  let slot = (fileSlot !== null && fileSlot !== undefined && fileSlot !== 'auto') ? parseInt(fileSlot, 10) : null;
  if (isNaN(slot) || slot <= 0) {
    slot = null;
  }

  // If slot not explicitly specified, check if a file with this name is already staged for workDate
  if (!slot) {
    const existing = db.prepare('SELECT file_slot FROM specific_orders_uploads WHERE work_date = ? AND file_name = ?').get(workDate, fileName);
    if (existing) {
      slot = existing.file_slot;
    } else {
      const maxSlotRow = db.prepare('SELECT MAX(file_slot) as max_s FROM specific_orders_uploads WHERE work_date = ?').get(workDate);
      slot = (maxSlotRow && maxSlotRow.max_s) ? maxSlotRow.max_s + 1 : 1;
    }
  }

  let parsedOrders = [];
  let rowCount = 0;
  let skippedRows = 0;

  if (Array.isArray(bufferOrOrders)) {
    parsedOrders = bufferOrOrders;
    rowCount = bufferOrOrders.length;
  } else {
    const parsed = parseSpecificOrdersBuffer(bufferOrOrders, workDate);
    parsedOrders = parsed.orders;
    rowCount = parsed.summary.totalRows;
    skippedRows = parsed.summary.skippedRows;
  }

  const insertStaged = db.prepare(`
    INSERT INTO specific_orders_uploads (
      work_date, file_slot, file_name, file_size, row_count, valid_orders_count, raw_orders_json, upload_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(work_date, file_slot) DO UPDATE SET
      file_name = excluded.file_name,
      file_size = excluded.file_size,
      row_count = excluded.row_count,
      valid_orders_count = excluded.valid_orders_count,
      raw_orders_json = excluded.raw_orders_json,
      upload_date = datetime('now')
  `);

  insertStaged.run(
    workDate,
    slot,
    fileName,
    fileSize,
    rowCount,
    parsedOrders.length,
    JSON.stringify(parsedOrders)
  );

  // Ensure preparation_batches entry exists and is OPEN
  try {
    const existingBatch = db.prepare('SELECT id, status FROM preparation_batches WHERE work_date = ?').get(workDate);
    if (!existingBatch) {
      db.prepare(`
        INSERT INTO preparation_batches (batch_id, work_date, status, total_files, files_json, created_at, updated_at)
        VALUES (?, ?, 'OPEN', 1, ?, datetime('now'), datetime('now'))
      `).run(`BATCH_${workDate}_${Date.now()}`, workDate, JSON.stringify([fileName]));
    } else if (existingBatch.status === 'FINALIZED') {
      db.prepare(`
        UPDATE preparation_batches
        SET status = 'OPEN', updated_at = datetime('now')
        WHERE work_date = ?
      `).run(workDate);
    }
  } catch (_) {}

  return {
    work_date: workDate,
    file_slot: slot,
    file_name: fileName,
    row_count: rowCount,
    valid_orders_count: parsedOrders.length,
    skipped_rows: skippedRows
  };
}

export const stageSpecificOrdersUpload = stageSpecificOrdersFile;

/**
 * Remove a staged file from the Specific Orders Pool
 */
export function deleteSpecificOrdersFile(workDate, fileSlot) {
  const slot = parseInt(fileSlot, 10);
  db.prepare('DELETE FROM specific_orders_uploads WHERE work_date = ? AND file_slot = ?').run(workDate, slot);
  const remaining = db.prepare('SELECT COUNT(*) as c FROM specific_orders_uploads WHERE work_date = ?').get(workDate).c;
  if (remaining > 0) {
    return mergeSpecificOrdersPool(workDate);
  } else {
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(workDate);
    db.prepare('DELETE FROM current_work_pool_summary WHERE work_date = ?').run(workDate);
    return {
      success: true,
      work_date: workDate,
      files_count: 0,
      unique_orders: 0
    };
  }
}

/**
 * Merge ALL staged Specific Orders files into ONE Current Orders Pool for that day
 * Deterministic deduplication, account preservation, and clear audit metrics
 * Supports any number of uploaded files (1, 2, 3...)
 * (Part 4, 30, 54, Final Real-Data Fix)
 */
export function mergeSpecificOrdersPool(workDate) {
  const stagedFiles = db.prepare('SELECT * FROM specific_orders_uploads WHERE work_date = ? ORDER BY file_slot ASC').all(workDate);

  if (!stagedFiles || stagedFiles.length === 0) {
    throw new Error(`No Specific Orders files have been uploaded for date: ${workDate}. Please upload Specific Orders file(s).`);
  }

  const file1 = stagedFiles.find(f => f.file_slot === 1) || stagedFiles[0] || null;
  const file2 = stagedFiles.find(f => f.file_slot === 2) || (stagedFiles.length > 1 ? stagedFiles[1] : null);

  let mergedOrdersCount = 0;
  const consolidatedMap = new Map();
  const duplicates = [];
  let intraDups = 0;
  let crossDups = 0;

  for (const fileRecord of stagedFiles) {
    const orders = JSON.parse(fileRecord.raw_orders_json || '[]');
    mergedOrdersCount += orders.length;

    for (const ord of orders) {
      if (!consolidatedMap.has(ord.order_code)) {
        consolidatedMap.set(ord.order_code, {
          ...ord,
          source_file_slot: fileRecord.file_slot,
          file_name: fileRecord.file_name
        });
      } else {
        const existing = consolidatedMap.get(ord.order_code);
        if (existing.source_file_slot === fileRecord.file_slot) {
          intraDups++;
          duplicates.push({
            order_code: ord.order_code,
            account: ord.account,
            file_slot: fileRecord.file_slot,
            status: ord.status,
            reason: `Duplicate order code within File #${fileRecord.file_slot}`
          });
        } else {
          crossDups++;
          let resolvedStatus = existing.status;
          let reason = `Duplicate order code in both File #${existing.source_file_slot} and File #${fileRecord.file_slot}.`;
          if (existing.status !== ord.status) {
            resolvedStatus = 'Opening Status Conflict';
            reason += ` Status differed ('${existing.status}' vs '${ord.status}'). Flagged as 'Opening Status Conflict' for Tracking and Audit.`;
          } else {
            reason += ' Preserved unique order.';
          }
          duplicates.push({
            order_code: ord.order_code,
            account: ord.account || existing.account,
            file_slot: fileRecord.file_slot,
            status: ord.status,
            existing_status: existing.status,
            resolved_status: resolvedStatus,
            reason
          });
          existing.status = resolvedStatus;
        }
      }
    }
  }

  const uniqueOrders = Array.from(consolidatedMap.values());
  const duplicateOrdersCount = mergedOrdersCount - uniqueOrders.length;
  const duplicatesExplanation = duplicateOrdersCount > 0
    ? `Consolidated ${mergedOrdersCount} orders across ${stagedFiles.length} file(s) into ${uniqueOrders.length} unique orders. Resolved ${duplicateOrdersCount} duplicate occurrences (${crossDups} cross-file, ${intraDups} intra-file). Active statuses and merchant accounts preserved without double-counting.`
    : 'All orders are distinct across uploaded files. No duplicates detected.';

  // Save to database
  const insertOrder = db.prepare(`
    INSERT INTO current_work_orders (
      source_file_id, work_date, order_code, account, status, order_date, source_file_slot, merchant_code, file_name, source_type, tracking_id, priority, work_state
    ) VALUES (null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    // Clear today's current orders
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(workDate);

    for (let i = 0; i < uniqueOrders.length; i++) {
      const ord = uniqueOrders[i];
      const trackingId = ord.tracking_id || generateTrackingId(ord.order_code, workDate, i + 1);
      const prio = ord.priority || (String(ord.priority || '').toUpperCase().includes('FAST') ? 'FAST_TRACK' : 'REGULAR');
      insertOrder.run(
        workDate,
        ord.order_code,
        ord.account,
        ord.status,
        ord.order_date || null,
        ord.source_file_slot || 1,
        ord.merchant_code || null,
        ord.file_name || null,
        ord.status === 'Pending' ? 'PENDING' : 'NEW',
        trackingId,
        prio,
        ord.work_state || 'UNASSIGNED'
      );
    }

    const insertSummary = db.prepare(`
      INSERT INTO current_work_pool_summary (
        work_date,
        file1_name, file1_rows, file1_orders,
        file2_name, file2_rows, file2_orders,
        files_count, files_json,
        merged_orders_count, unique_orders_count, duplicate_orders_count,
        duplicate_details_json, duplicates_explanation, merged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(work_date) DO UPDATE SET
        file1_name = excluded.file1_name,
        file1_rows = excluded.file1_rows,
        file1_orders = excluded.file1_orders,
        file2_name = excluded.file2_name,
        file2_rows = excluded.file2_rows,
        file2_orders = excluded.file2_orders,
        files_count = excluded.files_count,
        files_json = excluded.files_json,
        merged_orders_count = excluded.merged_orders_count,
        unique_orders_count = excluded.unique_orders_count,
        duplicate_orders_count = excluded.duplicate_orders_count,
        duplicate_details_json = excluded.duplicate_details_json,
        duplicates_explanation = excluded.duplicates_explanation,
        merged_at = datetime('now')
    `);

    insertSummary.run(
      workDate,
      file1 ? file1.file_name : null,
      file1 ? file1.row_count : 0,
      file1 ? file1.valid_orders_count : 0,
      file2 ? file2.file_name : null,
      file2 ? file2.row_count : 0,
      file2 ? file2.valid_orders_count : 0,
      stagedFiles.length,
      JSON.stringify(stagedFiles.map(f => ({
        slot: f.file_slot,
        name: f.file_name,
        rows: f.row_count,
        orders: f.valid_orders_count,
        upload_date: f.upload_date
      }))),
      mergedOrdersCount,
      uniqueOrders.length,
      duplicateOrdersCount,
      JSON.stringify(duplicates),
      duplicatesExplanation
    );
  });

  tx();

  const accounts = getCurrentAccounts(workDate);

  return {
    success: true,
    work_date: workDate,
    files: stagedFiles.map(f => ({
      slot: f.file_slot,
      name: f.file_name,
      rows: f.row_count,
      orders: f.valid_orders_count,
      upload_date: f.upload_date
    })),
    files_count: stagedFiles.length,
    file1: file1 ? { name: file1.file_name, rows: file1.row_count, orders: file1.valid_orders_count } : null,
    file2: file2 ? { name: file2.file_name, rows: file2.row_count, orders: file2.valid_orders_count } : null,
    file1_orders: file1 ? file1.valid_orders_count : 0,
    file2_orders: file2 ? file2.valid_orders_count : 0,
    merged_orders: mergedOrdersCount,
    unique_orders: uniqueOrders.length,
    duplicates_count: duplicateOrdersCount,
    duplicates_explanation: duplicatesExplanation,
    duplicates_sample: duplicates.slice(0, 50),
    accounts_count: accounts.length,
    accounts
  };
}

/**
 * Get Specific Orders pool status & metadata for a given date
 */
export function getSpecificOrdersPoolStatus(workDate) {
  const stagedFiles = db.prepare('SELECT id, work_date, file_slot, file_name, file_size, row_count, valid_orders_count, upload_date FROM specific_orders_uploads WHERE work_date = ? ORDER BY file_slot ASC').all(workDate);
  const file1 = stagedFiles.find(f => f.file_slot === 1) || stagedFiles[0] || null;
  const file2 = stagedFiles.find(f => f.file_slot === 2) || (stagedFiles.length > 1 ? stagedFiles[1] : null);
  const summary = db.prepare('SELECT * FROM current_work_pool_summary WHERE work_date = ?').get(workDate);
  const accounts = getCurrentAccounts(workDate);
  const totalOrders = db.prepare('SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ?').get(workDate).c;

  let duplicateDetails = [];
  if (summary && summary.duplicate_details_json) {
    try {
      duplicateDetails = JSON.parse(summary.duplicate_details_json);
    } catch (_) {}
  }

  return {
    work_date: workDate,
    files: stagedFiles,
    files_count: stagedFiles.length,
    file1: file1 || null,
    file2: file2 || null,
    has_file1: !!file1,
    has_file2: !!file2,
    merged: !!summary,
    summary: summary ? {
      ...summary,
      duplicate_details: duplicateDetails.slice(0, 50)
    } : null,
    accounts,
    accounts_count: accounts.length,
    total_orders: totalOrders
  };
}

/**
 * Compatibility helper: store uploaded Specific Orders directly
 */
export function saveCurrentWorkOrders(workDate, orders, fileName) {
  const insertFile = db.prepare(`
    INSERT INTO current_work_files (file_name, work_date, order_count)
    VALUES (?, ?, ?)
  `);
  const fileRes = insertFile.run(fileName, workDate, orders.length);
  const fileId = fileRes.lastInsertRowid;

  const insertOrder = db.prepare(`
    INSERT INTO current_work_orders (source_file_id, work_date, order_code, account, status, order_date, tracking_id, priority, work_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_date, order_code) DO UPDATE SET
      account = excluded.account,
      status = excluded.status,
      order_date = excluded.order_date,
      tracking_id = COALESCE(excluded.tracking_id, current_work_orders.tracking_id),
      priority = COALESCE(excluded.priority, current_work_orders.priority),
      work_state = COALESCE(excluded.work_state, current_work_orders.work_state),
      updated_at = datetime('now')
  `);

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(workDate);
    for (let i = 0; i < orders.length; i++) {
      const ord = orders[i];
      const tid = ord.tracking_id || generateTrackingId(ord.order_code, workDate, i + 1);
      const prio = ord.priority || (String(ord.priority || '').toUpperCase().includes('FAST') ? 'FAST_TRACK' : 'REGULAR');
      insertOrder.run(
        fileId,
        workDate,
        ord.order_code,
        ord.account,
        ord.status,
        ord.order_date,
        tid,
        prio,
        ord.work_state || 'UNASSIGNED'
      );
    }
  });

  tx();
  return fileId;
}

/**
 * Get distinct accounts physically present in current work for the specified date
 * (Part 14, 15, 40)
 */
export function getCurrentAccounts(workDate, sortBy = 'alphabetical') {
  const orderClause = sortBy === 'orders'
    ? 'COUNT(*) DESC, account COLLATE NOCASE ASC'
    : 'account COLLATE NOCASE ASC';
  const rows = db.prepare(`
    SELECT account, COUNT(*) as total_orders
    FROM current_work_orders
    WHERE work_date = ?
    GROUP BY account
    ORDER BY ${orderClause}
  `).all(workDate);

  return rows.map(r => r.account);
}

/**
 * Get distinct accounts with exact order counts (total, New, Pending) for the specified date
 * (Sorted by order count descending)
 */
export function getCurrentAccountsWithCounts(workDate) {
  const rows = db.prepare(`
    SELECT 
      cwo.account,
      COUNT(*) as total_orders,
      SUM(CASE WHEN cwo.status = 'New' THEN 1 ELSE 0 END) as new_orders,
      SUM(CASE WHEN cwo.status = 'Pending' THEN 1 ELSE 0 END) as pending_orders,
      ao.owner_employee_id,
      ao.owner_employee_name,
      ao.is_override,
      ao.notes as owner_notes
    FROM current_work_orders cwo
    LEFT JOIN account_owners ao ON ao.work_date = cwo.work_date AND LOWER(ao.account) = LOWER(cwo.account)
    WHERE cwo.work_date = ?
    GROUP BY cwo.account
    ORDER BY total_orders DESC, cwo.account COLLATE NOCASE ASC
  `).all(workDate);

  // Fallback: If owner_employee_name is null in account_owners, check order_level_allocations
  const fallbackRows = db.prepare(`
    SELECT account, employee_id, employee_name, is_override
    FROM order_level_allocations
    WHERE allocation_date = ? AND employee_id IS NOT NULL
    GROUP BY account
  `).all(workDate);
  const fallbackMap = new Map();
  for (const f of fallbackRows) {
    if (f.account && f.employee_name && f.employee_name !== 'UNASSIGNED') {
      fallbackMap.set(f.account.toLowerCase(), f);
    }
  }

  // Fetch today's working team to check stream eligibility
  let workingTeam = [];
  try {
    workingTeam = getWorkingTeam(workDate) || [];
  } catch (e) {
    // ignore
  }
  const teamMap = new Map();
  for (const emp of workingTeam) {
    teamMap.set(emp.employee_id, emp);
  }

  for (const r of rows) {
    if (!r.owner_employee_name && fallbackMap.has(r.account.toLowerCase())) {
      const fb = fallbackMap.get(r.account.toLowerCase());
      r.owner_employee_id = fb.employee_id;
      r.owner_employee_name = fb.employee_name;
      r.is_override = fb.is_override;
    }

    const hasNew = (r.new_orders || 0) > 0;
    const hasPending = (r.pending_orders || 0) > 0;
    r.has_new = hasNew;
    r.has_pending = hasPending;
    r.has_conflict = false;
    r.conflict_reason = null;

    if (!r.owner_employee_name || r.owner_employee_name === 'UNASSIGNED' || !r.owner_employee_id) {
      r.is_unassigned = true;
      if (hasNew && hasPending) {
        r.conflict_reason = 'No single eligible employee for both New and Pending.';
      } else {
        r.conflict_reason = 'Owner Required';
      }
    } else {
      r.is_unassigned = false;
      const emp = teamMap.get(r.owner_employee_id);
      if (emp) {
        if (hasNew && hasPending && (!emp.allowed_new || !emp.allowed_pending)) {
          r.has_conflict = true;
          r.conflict_reason = 'Account Owner requires both New and Pending eligibility.';
        } else if (hasNew && !emp.allowed_new) {
          r.has_conflict = true;
          r.conflict_reason = 'Account Owner requires New eligibility.';
        } else if (hasPending && !emp.allowed_pending) {
          r.has_conflict = true;
          r.conflict_reason = 'Account Owner requires Pending eligibility.';
        }
      }
    }
  }

  return rows;
}

/**
 * Get available statuses for a specific account on a given date
 */
export function getAccountAvailableStatuses(workDate, account) {
  const rows = db.prepare(`
    SELECT DISTINCT status
    FROM current_work_orders
    WHERE work_date = ? AND account = ?
  `).all(workDate, account);

  const statuses = new Set(rows.map(r => r.status));
  const hasNew = statuses.has('New');
  const hasPending = statuses.has('Pending');

  const options = [];
  if (hasNew) options.push('New');
  if (hasPending) options.push('Pending');
  if (hasNew && hasPending) options.push('New + Pending');

  for (const s of statuses) {
    if (s !== 'New' && s !== 'Pending') {
      options.push(s);
    }
  }

  return options;
}

/**
 * Get count of available orders for (account, status) on given date
 */
export function getAvailableOrdersCount(workDate, account, status) {
  if (status === 'New + Pending') {
    const row = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'New' THEN 1 ELSE 0 END) as new_count,
        SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) as pending_count
      FROM current_work_orders
      WHERE work_date = ? AND account = ? AND status IN ('New', 'Pending')
    `).get(workDate, account);

    return {
      total: row.total || 0,
      new_count: row.new_count || 0,
      pending_count: row.pending_count || 0,
      display: `${row.total || 0} total (New: ${row.new_count || 0}, Pending: ${row.pending_count || 0})`
    };
  }

  const row = db.prepare(`
    SELECT COUNT(*) as total
    FROM current_work_orders
    WHERE work_date = ? AND account = ? AND status = ?
  `).get(workDate, account, status);

  return {
    total: row.total || 0,
    display: `${row.total || 0} orders`
  };
}

/**
 * Get current work overview for a date
 */
export function getCurrentWorkOverview(workDate) {
  let orderRow = null;
  try {
    orderRow = db.prepare(`
      SELECT 
        COUNT(*) as total_orders,
        COUNT(DISTINCT account) as accounts_count,
        SUM(CASE WHEN status = 'New' THEN 1 ELSE 0 END) as new_count,
        SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) as pending_count
      FROM current_work_orders
      WHERE work_date = ?
    `).get(workDate);
  } catch (err) {
    console.warn('Warning in getCurrentWorkOverview order query:', err.message);
  }

  let teamCount = 0;
  let teamSource = 'SETUP_REQUIRED';
  try {
    let teamRow = db.prepare(`
      SELECT COUNT(*) as team_count
      FROM daily_working_team
      WHERE work_date = ? AND is_working = 1
    `).get(workDate);

    if (!teamRow || teamRow.team_count === 0) {
      try {
        syncAndRestoreObservedTeam(workDate);
        teamRow = db.prepare(`
          SELECT COUNT(*) as team_count
          FROM daily_working_team
          WHERE work_date = ? AND is_working = 1
        `).get(workDate);
      } catch (e) {}
    }

    teamCount = teamRow ? (teamRow.team_count || 0) : 0;

    if (teamCount > 0) {
      const sourceRow = db.prepare(`
        SELECT source
        FROM daily_working_team
        WHERE work_date = ? AND is_working = 1
        GROUP BY source
        ORDER BY CASE WHEN source = 'MANUAL' THEN 1 ELSE 2 END ASC
        LIMIT 1
      `).get(workDate);
      teamSource = sourceRow ? (sourceRow.source || 'MANUAL') : 'MANUAL';
    }
  } catch (err) {
    try {
      const fallbackRow = db.prepare(`
        SELECT COUNT(*) as team_count
        FROM daily_working_team
        WHERE work_date = ?
      `).get(workDate);
      teamCount = fallbackRow ? (fallbackRow.team_count || 0) : 0;
    } catch (e) {
      console.warn('Warning in getCurrentWorkOverview team query:', e.message);
    }
  }

  let allocatedCount = 0;
  try {
    const allocRow = db.prepare(`
      SELECT COUNT(*) as c
      FROM order_level_allocations
      WHERE allocation_date = ? AND employee_name IS NOT NULL AND employee_name != 'UNASSIGNED'
    `).get(workDate);
    allocatedCount = allocRow ? (allocRow.c || 0) : 0;
  } catch (err) {}

  const totalOrders = orderRow ? (orderRow.total_orders || 0) : 0;
  const unallocatedCount = Math.max(0, totalOrders - allocatedCount);

  let completedCount = 0;
  try {
    const compRow = db.prepare(`
      SELECT COUNT(DISTINCT order_code) as c
      FROM raw_log_records
      WHERE log_date = ? AND action_type IN ('PRINTED', 'STATUS_CHANGE', 'PROCESSING', 'DELIVERED')
    `).get(workDate);
    completedCount = compRow ? (compRow.c || 0) : 0;
  } catch (err) {}

  return {
    work_date: workDate,
    total_orders: totalOrders,
    accounts_count: orderRow ? (orderRow.accounts_count || 0) : 0,
    new_count: orderRow ? (orderRow.new_count || 0) : 0,
    pending_count: orderRow ? (orderRow.pending_count || 0) : 0,
    working_team_count: teamCount,
    working_team_source: teamSource,
    allocated_count: allocatedCount,
    unallocated_count: unallocatedCount,
    completed_count: completedCount,
  };
}

/**
 * Query orders in current work pool with filtering & pagination
 */
export function getCurrentOrders(workDate, options = {}) {
  const { account, status, search, limit = 100, offset = 0 } = options;
  let sql = 'SELECT id, order_code, account, status, order_date, source_file_slot FROM current_work_orders WHERE work_date = ?';
  const params = [workDate];

  if (account) {
    sql += ' AND account = ?';
    params.push(account);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (search) {
    sql += ' AND (order_code LIKE ? OR account LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  const countSql = sql.replace('SELECT id, order_code, account, status, order_date, source_file_slot', 'SELECT COUNT(*) as total');
  const total = db.prepare(countSql).get(...params).total;

  sql += ' ORDER BY account ASC, order_code ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const orders = db.prepare(sql).all(...params);

  return {
    work_date: workDate,
    total,
    limit,
    offset,
    orders
  };
}

/**
 * Save manual work allocation for a date
 * Supports UNLIMITED accounts per employee (Part 17, 18, 21, 25, 69)
 * Strictly prevents exact duplicates for the same employee + account + status
 */
export function saveWorkAllocation(workDate, assignments, notes = '') {
  // Validate duplicate assignments per employee
  const seen = new Set();
  for (const item of assignments) {
    const key = `${item.employee_id}|${item.account}|${item.status}`;
    if (seen.has(key)) {
      const emp = db.prepare('SELECT name FROM employees WHERE id = ?').get(item.employee_id);
      const empName = emp ? emp.name : `Employee ID ${item.employee_id}`;
      throw new Error(`Duplicate assignment: ${empName} is already assigned account "${item.account}" with status "${item.status}".`);
    }
    seen.add(key);
  }

  const insertHeader = db.prepare(`
    INSERT INTO allocation_headers (allocation_date, notes)
    VALUES (?, ?)
    ON CONFLICT(allocation_date) DO UPDATE SET
      notes = excluded.notes,
      updated_at = datetime('now')
  `);
  insertHeader.run(workDate, notes);

  const headerRow = db.prepare('SELECT id FROM allocation_headers WHERE allocation_date = ?').get(workDate);
  const headerId = headerRow.id;

  // Replace existing items for this header
  db.prepare('DELETE FROM allocation_items WHERE allocation_header_id = ?').run(headerId);

  const insertItem = db.prepare(`
    INSERT INTO allocation_items (allocation_header_id, employee_id, account, status, available_orders_at_assignment)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const item of assignments) {
      insertItem.run(
        headerId,
        item.employee_id,
        item.account,
        item.status,
        item.available_orders || 0
      );
    }
  });

  tx();

  return {
    success: true,
    allocation_id: headerId,
    item_count: assignments.length,
    work_date: workDate,
  };
}

/**
 * Get work allocation for a specific date
 */
export function getAllocationForDate(workDate) {
  const header = db.prepare('SELECT * FROM allocation_headers WHERE allocation_date = ?').get(workDate);
  if (!header) return null;

  const items = db.prepare(`
    SELECT 
      ai.id,
      ai.allocation_header_id,
      ai.employee_id,
      e.name as employee_name,
      e.department,
      ai.account,
      ai.status,
      ai.available_orders_at_assignment,
      ai.created_at
    FROM allocation_items ai
    JOIN employees e ON ai.employee_id = e.id
    WHERE ai.allocation_header_id = ?
    ORDER BY e.name ASC, ai.account ASC
  `).all(header.id).filter(it => isCsEmployee({ name: it.employee_name, department: it.department, id: it.employee_id }));

  // Group by employee
  const byEmployee = new Map();
  for (const it of items) {
    if (!byEmployee.has(it.employee_id)) {
      byEmployee.set(it.employee_id, {
        employee_id: it.employee_id,
        employee_name: it.employee_name,
        department: it.department,
        accounts: [],
      });
    }
    byEmployee.get(it.employee_id).accounts.push({
      item_id: it.id,
      account: it.account,
      status: it.status,
      available_orders: it.available_orders_at_assignment,
    });
  }

  return {
    header,
    items,
    by_employee: Array.from(byEmployee.values()),
  };
}

/**
 * Update a single allocation item
 */
export function updateAllocationItem(id, data) {
  const current = db.prepare('SELECT * FROM allocation_items WHERE id = ?').get(id);
  if (!current) {
    throw new Error(`Allocation item with ID ${id} not found.`);
  }

  const account = data.account || current.account;
  const status = data.status || current.status;
  const availableOrders = data.available_orders !== undefined ? data.available_orders : current.available_orders_at_assignment;

  db.prepare(`
    UPDATE allocation_items
    SET account = ?, status = ?, available_orders_at_assignment = ?
    WHERE id = ?
  `).run(account, status, availableOrders, id);

  return { success: true, id, account, status, available_orders: availableOrders };
}

/**
 * Delete a single allocation item
 */
export function deleteAllocationItem(id) {
  const res = db.prepare('DELETE FROM allocation_items WHERE id = ?').run(id);
  if (res.changes === 0) {
    throw new Error(`Allocation item with ID ${id} not found.`);
  }
  return { success: true, deleted_id: id };
}

/**
 * Delete entire allocation for a date
 */
export function deleteAllocationForDate(workDate) {
  const header = db.prepare('SELECT id FROM allocation_headers WHERE allocation_date = ?').get(workDate);
  if (!header) {
    return { success: false, message: 'No allocation found for this date.' };
  }
  db.prepare('DELETE FROM allocation_items WHERE allocation_header_id = ?').run(header.id);
  db.prepare('DELETE FROM allocation_headers WHERE id = ?').run(header.id);
  return { success: true, deleted_date: workDate };
}

/**
 * Generate formatted text for WhatsApp/Teams (Standard, Compact, All Employees, Single Employee, Account)
 * (Part 23, 24, 28, 29, 30, 52)
 */
export function generateCopyAllocationText(workDate, format = 'all_employees', targetIdOrName = null) {
  // Try order-level allocation first (as it contains the exact order codes and final overrides)
  const orderAlloc = getOrderLevelAllocation(workDate);
  const d = new Date(workDate);
  const formattedDate = !isNaN(d.getTime())
    ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : workDate;

  if (orderAlloc && orderAlloc.by_employee && orderAlloc.by_employee.length > 0) {
    if (format === 'all_employees' || format === 'order_level' || format === 'detailed') {
      const blocks = [`📅 Allocation — ${workDate}\n`];

      for (const emp of orderAlloc.by_employee) {
        let empBlock = `👤 ${emp.employee_name}\n\n`;

        // Group by Account
        const accMap = new Map();
        for (const o of (emp.orders || [])) {
          if (!accMap.has(o.account)) {
            accMap.set(o.account, { account: o.account, orders: [] });
          }
          accMap.get(o.account).orders.push(o);
        }

        for (const accData of accMap.values()) {
          const newCnt = accData.orders.filter(o => o.status === 'New').length;
          const penCnt = accData.orders.filter(o => o.status === 'Pending').length;
          const otherCnt = accData.orders.length - (newCnt + penCnt);

          empBlock += `${accData.account}\n`;
          if (newCnt > 0) empBlock += `NEW: ${newCnt}\n`;
          if (penCnt > 0) empBlock += `PENDING: ${penCnt}\n`;
          if (otherCnt > 0) empBlock += `OTHER: ${otherCnt}\n`;
          empBlock += `TOTAL: ${accData.orders.length}\n\n`;

          empBlock += `Order Codes:\n`;
          empBlock += accData.orders.map(o => o.order_code).join('\n') + `\n\n`;
        }

        empBlock += `Total Accounts: ${accMap.size}\n`;
        empBlock += `Total Orders: ${emp.total_orders}`;
        blocks.push(empBlock);
      }

      return blocks.join('\n━━━━━━━━━━━━━━\n\n').trim();
    }

    if (format === 'single_employee' && targetIdOrName) {
      const emp = orderAlloc.by_employee.find(e =>
        e.employee_id === Number(targetIdOrName) ||
        e.employee_name.toLowerCase() === String(targetIdOrName).toLowerCase()
      );
      if (!emp) return `لا توجد أوردرات مسندة للموظف ${targetIdOrName} في تاريخ ${workDate}`;

      let text = `👤 ${emp.employee_name} — Allocation\nDate: ${workDate}\n\n`;
      const accMap = new Map();
      for (const o of (emp.orders || [])) {
        if (!accMap.has(o.account)) accMap.set(o.account, { account: o.account, orders: [] });
        accMap.get(o.account).orders.push(o);
      }

      for (const [accName, accData] of accMap.entries()) {
        const newCnt = accData.orders.filter(o => o.status === 'New').length;
        const penCnt = accData.orders.filter(o => o.status === 'Pending').length;
        text += `${accName}\n`;
        if (newCnt > 0) text += `NEW: ${newCnt}\n`;
        if (penCnt > 0) text += `PENDING: ${penCnt}\n`;
        text += `TOTAL: ${accData.orders.length}\n\n`;
        text += `Order Codes:\n` + accData.orders.map(o => o.order_code).join('\n') + `\n\n`;
      }
      text += `Total Accounts: ${accMap.size}\n`;
      text += `Total Orders: ${emp.total_orders}`;
      return text.trim();
    }

    if (format === 'account' && targetIdOrName) {
      const targetAcc = String(targetIdOrName).trim();
      const accOrders = (orderAlloc.orders || []).filter(o => o.account.toLowerCase() === targetAcc.toLowerCase());
      if (accOrders.length === 0) return `لا توجد أوردرات مسندة لحساب ${targetAcc} في تاريخ ${workDate}`;

      const ownerName = accOrders[0].employee_name || 'UNASSIGNED';
      const newCnt = accOrders.filter(o => o.status === 'New').length;
      const penCnt = accOrders.filter(o => o.status === 'Pending').length;

      let text = `${targetAcc}\nOwner: 👤 ${ownerName}\nDate: ${workDate}\n\n`;
      if (newCnt > 0) text += `NEW: ${newCnt}\n`;
      if (penCnt > 0) text += `PENDING: ${penCnt}\n`;
      text += `TOTAL: ${accOrders.length}\n\n`;
      text += `Order Codes:\n` + accOrders.map(o => o.order_code).join('\n');
      return text.trim();
    }
  }

  // Fallback to legacy account-level allocation text
  const alloc = getAllocationForDate(workDate);
  if (!alloc || alloc.by_employee.length === 0) {
    return 'لا يوجد توزيع مسجل لهذا اليوم.';
  }

  if (format === 'compact') {
    const lines = [`📋 توزيع شغل اليوم (${formattedDate})`];
    for (const emp of alloc.by_employee) {
      const accStr = emp.accounts.map(a => `${a.account} - ${a.status}`).join(' | ');
      lines.push(`${emp.employee_name}: ${accStr}`);
    }
    return lines.join('\n\n');
  }

  // Standard clean format
  const lines = [`📋 توزيع شغل اليوم — ${formattedDate}\n`];
  for (const emp of alloc.by_employee) {
    lines.push(emp.employee_name);
    for (const a of emp.accounts) {
      lines.push(`- ${a.account} → ${a.status}`);
    }
    lines.push(''); // blank line between employees
  }

  return lines.join('\n').trim();
}

/**
 * Allocation history list
 */
export function getAllocationHistory(limit = 60) {
  const headers = db.prepare(`
    SELECT 
      ah.id,
      ah.allocation_date,
      ah.notes,
      ah.created_at,
      COUNT(DISTINCT ai.employee_id) as employee_count,
      COUNT(ai.id) as assignment_count,
      SUM(ai.available_orders_at_assignment) as total_workload
    FROM allocation_headers ah
    LEFT JOIN allocation_items ai ON ah.id = ai.allocation_header_id
    GROUP BY ah.id
    ORDER BY ah.allocation_date DESC
    LIMIT ?
  `).all(limit);

  return headers;
}

/**
 * ============================================================
 * ACCOUNT RULES & EXCEPTIONS MANAGEMENT
 * (Part 4, 6, 7, 55, 56)
 * ============================================================
 */

export function getAccountRules() {
  const rows = db.prepare('SELECT * FROM account_rules ORDER BY account_name COLLATE NOCASE ASC').all();
  return rows.map(r => ({
    id: r.id,
    account: r.account_name,
    account_name: r.account_name,
    new_eligible: r.new_eligible_json ? JSON.parse(r.new_eligible_json) : [],
    pending_eligible: r.pending_eligible_json ? JSON.parse(r.pending_eligible_json) : [],
    blocked: r.blocked_json ? JSON.parse(r.blocked_json) : [],
    active: !!r.active,
    notes: r.notes || '',
    created_at: r.created_at,
    updated_at: r.updated_at
  }));
}

export function getAccountRuleForAccount(accountName) {
  if (!accountName) return null;
  const row = db.prepare('SELECT * FROM account_rules WHERE account_name = ? COLLATE NOCASE').get(accountName.trim());
  if (!row) return null;
  return {
    id: row.id,
    account: row.account_name,
    account_name: row.account_name,
    new_eligible: row.new_eligible_json ? JSON.parse(row.new_eligible_json) : [],
    pending_eligible: row.pending_eligible_json ? JSON.parse(row.pending_eligible_json) : [],
    blocked: row.blocked_json ? JSON.parse(row.blocked_json) : [],
    active: !!row.active,
    notes: row.notes || ''
  };
}

export function saveAccountRule(data) {
  const rawName = data.account_name || data.account;
  if (!rawName || !rawName.trim()) {
    throw new Error('Account name is required');
  }
  const cleanName = rawName.trim();
  const new_eligible = data.new_eligible || data.new_eligible_json || [];
  const pending_eligible = data.pending_eligible || data.pending_eligible_json || [];
  const blocked = data.blocked || data.blocked_json || [];
  const active = data.active !== undefined ? (data.active ? 1 : 0) : 1;
  const notes = data.notes || '';

  const insertRule = db.prepare(`
    INSERT INTO account_rules (
      account_name, new_eligible_json, pending_eligible_json, blocked_json, active, notes, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(account_name) DO UPDATE SET
      new_eligible_json = excluded.new_eligible_json,
      pending_eligible_json = excluded.pending_eligible_json,
      blocked_json = excluded.blocked_json,
      active = excluded.active,
      notes = excluded.notes,
      updated_at = datetime('now')
  `);

  insertRule.run(
    cleanName,
    JSON.stringify(new_eligible),
    JSON.stringify(pending_eligible),
    JSON.stringify(blocked),
    active ? 1 : 0,
    notes
  );

  return { success: true, ...getAccountRuleForAccount(cleanName) };
}

export function deleteAccountRule(idOrName) {
  if (typeof idOrName === 'number' || !isNaN(Number(idOrName))) {
    db.prepare('DELETE FROM account_rules WHERE id = ?').run(Number(idOrName));
  } else {
    db.prepare('DELETE FROM account_rules WHERE account_name = ? COLLATE NOCASE').run(String(idOrName).trim());
  }
  return { success: true };
}

/**
 * Get all unique account names across all uploaded sheets, history, and rules
 */
export function getAllKnownAccounts() {
  const accountsSet = new Set();

  const safeQuery = (sql) => {
    try {
      const rows = db.prepare(sql).all();
      for (const r of rows) {
        const val = Object.values(r)[0];
        if (val && typeof val === 'string' && val.trim()) {
          accountsSet.add(val.trim());
        }
      }
    } catch (_) {}
  };

  safeQuery("SELECT DISTINCT account FROM current_work_orders WHERE account IS NOT NULL AND TRIM(account) != ''");
  safeQuery("SELECT DISTINCT account_name FROM account_rules WHERE account_name IS NOT NULL AND TRIM(account_name) != ''");
  safeQuery("SELECT DISTINCT account FROM order_level_allocations WHERE account IS NOT NULL AND TRIM(account) != ''");
  safeQuery("SELECT DISTINCT account FROM allocation_items WHERE account IS NOT NULL AND TRIM(account) != ''");
  safeQuery("SELECT DISTINCT account_name FROM account_exceptions WHERE account_name IS NOT NULL AND TRIM(account_name) != ''");
  safeQuery("SELECT DISTINCT account FROM raw_actions WHERE account IS NOT NULL AND TRIM(account) != ''");

  // Also check specific_orders_uploads raw rows if present
  try {
    const rawFiles = db.prepare('SELECT file_rows_json FROM specific_orders_uploads WHERE file_rows_json IS NOT NULL').all();
    for (const rf of rawFiles) {
      if (rf.file_rows_json) {
        try {
          const parsed = JSON.parse(rf.file_rows_json);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              const acc = item.account || item.Account || item['Account Name'] || item['اسم الحساب'] || item['Merchant'];
              if (acc && typeof acc === 'string' && acc.trim()) {
                accountsSet.add(acc.trim());
              }
            }
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  return Array.from(accountsSet).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export function getAccountExceptions(workDate = null) {
  let sql = `
    SELECT ae.*, ae.account_name as account, ae.exception_type as action_type, e.name as employee_name
    FROM account_exceptions ae
    LEFT JOIN employees e ON ae.employee_id = e.id
  `;
  const params = [];
  if (workDate) {
    sql += ' WHERE ae.work_date IS NULL OR ae.work_date = ?';
    params.push(workDate);
  }
  sql += ' ORDER BY ae.account_name ASC, ae.id DESC';
  return db.prepare(sql).all(...params);
}

export function saveAccountException(data) {
  const rawName = data.account_name || data.account;
  const exception_type = data.exception_type || data.action_type;
  if (!rawName || !exception_type) {
    throw new Error('account_name and exception_type are required');
  }

  const work_date = data.work_date || null;
  const status_type = data.status_type || 'Both';
  const employee_id = data.employee_id || data.target_employee_id || null;
  const notes = data.notes || '';

  const emp = employee_id ? db.prepare('SELECT name FROM employees WHERE id = ?').get(employee_id) : null;
  const empName = emp ? emp.name : (data.employee_name || null);

  const res = db.prepare(`
    INSERT INTO account_exceptions (
      account_name, work_date, status_type, exception_type, employee_id, employee_name, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    rawName.trim(),
    work_date,
    status_type,
    exception_type,
    employee_id,
    empName,
    notes
  );

  return { success: true, id: res.lastInsertRowid, account: rawName.trim(), exception_type };
}

export function deleteAccountException(id) {
  db.prepare('DELETE FROM account_exceptions WHERE id = ?').run(id);
  return { success: true, id };
}

/**
 * ============================================================
 * PERMANENT TEAM MEMBERSHIP & DAILY WORKING TEAM
 * (Part 3, 4, 5)
 * ============================================================
 */

export function getEmployeeTeamMemberships() {
  const rows = db.prepare(`
    SELECT id, name, department, active, team_membership, notes
    FROM employees
    WHERE active = 1
    ORDER BY name COLLATE NOCASE ASC
  `).all();
  return rows;
}

export function updateEmployeeTeamMembership(employeeId, teamMembership) {
  const valid = ['New', 'Pending', 'Both'];
  const tm = valid.includes(teamMembership) ? teamMembership : 'Both';
  db.prepare("UPDATE employees SET team_membership = ?, updated_at = datetime('now') WHERE id = ?").run(tm, employeeId);
  return { success: true, id: employeeId, team_membership: tm };
}

export function bulkUpdateTeamMembership(updates = []) {
  const updateStmt = db.prepare("UPDATE employees SET team_membership = ?, updated_at = datetime('now') WHERE id = ?");
  const valid = ['New', 'Pending', 'Both'];
  const tx = db.transaction(() => {
    for (const u of updates) {
      const tm = valid.includes(u.team_membership) ? u.team_membership : 'Both';
      updateStmt.run(tm, u.employee_id);
    }
  });
  tx();
  return { success: true, updated_count: updates.length };
}

/**
 * Get date-specific working team with auto-derived allowed teams from permanent membership
 */
export function getWorkingTeam(workDate) {
  // If no working team records exist for workDate, attempt auto-restoration from logs
  const countRow = db.prepare("SELECT COUNT(*) as c FROM daily_working_team WHERE work_date = ?").get(workDate);
  if (!countRow || countRow.c === 0) {
    try {
      syncAndRestoreObservedTeam(workDate);
    } catch (e) {
      console.warn('[getWorkingTeam] Auto-restore notice:', e.message);
    }
  }

  const allEmployees = db.prepare(`
    SELECT id, name, department, active, status, team_membership, notes
    FROM employees
    WHERE active = 1 AND (status = 'ACTIVE' OR status IS NULL)
    ORDER BY name COLLATE NOCASE ASC
  `).all().filter(e => isCsEmployee(e));

  const workingRows = db.prepare(`
    SELECT employee_id, is_working, source, observed_at, last_activity_at
    FROM daily_working_team
    WHERE work_date = ?
  `).all(workDate);

  const hasCustomAttendance = workingRows.length > 0;
  const workingMap = new Map();
  const metaMap = new Map();
  for (const r of workingRows) {
    workingMap.set(r.employee_id, r.is_working === 1);
    metaMap.set(r.employee_id, {
      source: r.source || 'MANUAL',
      observed_at: r.observed_at,
      last_activity_at: r.last_activity_at
    });
  }

  return allEmployees.map(emp => {
    // If no custom attendance has been configured for this date, do NOT assume all are working
    const isWorking = hasCustomAttendance ? (workingMap.get(emp.id) === true) : false;
    const meta = metaMap.get(emp.id);

    return {
      id: emp.id,
      employee_id: emp.id,
      name: emp.name,
      department: emp.department,
      active: emp.active === 1,
      permanent_team_membership: emp.team_membership || 'Both',
      is_working: isWorking,
      source: meta ? meta.source : (isWorking ? 'MANUAL' : null),
      observed_at: meta ? meta.observed_at : null,
      last_activity_at: meta ? meta.last_activity_at : null,
      // Auto-derived allowed teams for today
      allowed_new: isWorking && (emp.team_membership === 'New' || emp.team_membership === 'Both'),
      allowed_pending: isWorking && (emp.team_membership === 'Pending' || emp.team_membership === 'Both'),
    };
  });
}

/**
 * Save date-specific working team (explicit MANUAL configuration)
 */
export function saveWorkingTeam(workDate, teamList) {
  const allEmployees = db.prepare("SELECT id, name, department FROM employees WHERE active = 1 AND (status = 'ACTIVE' OR status IS NULL)").all().filter(e => isCsEmployee(e));
  const activeIdsSet = new Set(
    teamList
      .filter(item => item.is_working === true || item.is_working === 1)
      .map(item => item.employee_id || item.id)
  );

  const insertWorking = db.prepare(`
    INSERT INTO daily_working_team (work_date, employee_id, is_working, source, created_at, updated_at)
    VALUES (?, ?, ?, 'MANUAL', datetime('now'), datetime('now'))
    ON CONFLICT(work_date, employee_id) DO UPDATE SET
      is_working = excluded.is_working,
      source = 'MANUAL',
      updated_at = datetime('now')
  `);

  const tx = db.transaction(() => {
    for (const emp of allEmployees) {
      const isWorking = activeIdsSet.has(emp.id) ? 1 : 0;
      insertWorking.run(workDate, emp.id, isWorking);
    }
  });

  tx();
  return getWorkingTeam(workDate);
}

/**
 * ============================================================
 * ACCOUNT-BASED ORDER-LEVEL ALLOCATION ENGINE
 * ONE ACCOUNT = ONE EMPLOYEE
 * All order codes under an Account belong to that Account's Owner
 * ============================================================
 */

export function getAccountOwners(workDate) {
  return db.prepare(`
    SELECT * FROM account_owners
    WHERE work_date = ?
    ORDER BY account COLLATE NOCASE ASC
  `).all(workDate);
}

export function getAccountReassignmentLogs(workDate) {
  return db.prepare(`
    SELECT * FROM account_reassignment_logs
    WHERE work_date = ?
    ORDER BY created_at DESC
  `).all(workDate);
}

export function isCSDepartment(dept, name = '') {
  if (dept && !name) {
    return isCsDept(dept);
  }
  return isCsEmployee({ name: name || '', department: dept || '' });
}

export function reassignAccountOwner(workDate, account, newEmployeeId, reason = 'Supervisor Reassignment', reassignedBy = 'Supervisor', forceOverride = false) {
  const emp = db.prepare('SELECT id, name, department, team_membership, status, active FROM employees WHERE id = ?').get(newEmployeeId);
  if (!emp) {
    throw new Error(`Employee ID ${newEmployeeId} not found`);
  }
  if (!isCsEmployee(emp) && !forceOverride) {
    throw new Error(`Worker "${emp.name}" (ID #${newEmployeeId}) belongs to department "${emp.department}". Work Allocation requires CS employees only.`);
  }
  if (emp.status === 'DEPARTED' && !forceOverride) {
    throw new Error(`Cannot reassign account to departed employee "${emp.name}". Employee is marked as DEPARTED.`);
  }

  // Check actual streams of the account
  const orders = db.prepare('SELECT status FROM current_work_orders WHERE work_date = ? AND LOWER(account) = LOWER(?)').all(workDate, account);
  const hasNew = orders.some(o => o.status === 'New');
  const hasPending = orders.some(o => o.status === 'Pending');

  const allowedNew = emp.team_membership === 'New' || emp.team_membership === 'Both';
  const allowedPending = emp.team_membership === 'Pending' || emp.team_membership === 'Both';

  let streamIneligible = false;
  let reasonNote = reason;
  if (hasNew && hasPending && (!allowedNew || !allowedPending)) {
    streamIneligible = true;
    reasonNote = `[Force Override - Ineligible Streams] ${reason}`;
  } else if (hasNew && !allowedNew) {
    streamIneligible = true;
    reasonNote = `[Force Override - Ineligible Stream New] ${reason}`;
  } else if (hasPending && !allowedPending) {
    streamIneligible = true;
    reasonNote = `[Force Override - Ineligible Stream Pending] ${reason}`;
  }

  if (streamIneligible && !forceOverride) {
    // If not explicitly forced, we still record is_override = 1 to denote supervisor override
  }

  // Get current owner for audit log
  const prevOwner = db.prepare(`
    SELECT owner_employee_id, owner_employee_name
    FROM account_owners
    WHERE work_date = ? AND LOWER(account) = LOWER(?)
  `).get(workDate, account);

  const prevId = prevOwner ? prevOwner.owner_employee_id : null;
  const prevName = prevOwner ? prevOwner.owner_employee_name : 'UNASSIGNED';

  const tx = db.transaction(() => {
    // 1. Upsert into account_owners
    db.prepare(`
      INSERT INTO account_owners (
        work_date, account, owner_employee_id, owner_employee_name,
        allocation_method, is_override, notes, updated_at
      ) VALUES (?, ?, ?, ?, 'Manual Reassignment', 1, ?, datetime('now'))
      ON CONFLICT(work_date, account) DO UPDATE SET
        owner_employee_id = excluded.owner_employee_id,
        owner_employee_name = excluded.owner_employee_name,
        allocation_method = 'Manual Reassignment',
        is_override = 1,
        notes = excluded.notes,
        updated_at = datetime('now')
    `).run(workDate, account, emp.id, emp.name, reasonNote);

    // 2. Insert into account_reassignment_logs
    db.prepare(`
      INSERT INTO account_reassignment_logs (
        work_date, account, previous_employee_id, previous_employee_name,
        new_employee_id, new_employee_name, reassigned_by, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(workDate, account, prevId, prevName, emp.id, emp.name, reassignedBy, reasonNote);

    // 3. Update all order_level_allocations for this account on this date
    db.prepare(`
      UPDATE order_level_allocations
      SET employee_id = ?, employee_name = ?, is_override = 1, method = 'Manual Reassignment',
          rule_note = ?
      WHERE allocation_date = ? AND LOWER(account) = LOWER(?)
    `).run(emp.id, emp.name, `Manual Reassignment: ${reasonNote}`, workDate, account);

    // 4. Update legacy allocation_items
    const header = db.prepare('SELECT id FROM allocation_headers WHERE allocation_date = ?').get(workDate);
    if (header) {
      db.prepare(`
        UPDATE allocation_items
        SET employee_id = ?
        WHERE allocation_header_id = ? AND LOWER(account) = LOWER(?)
      `).run(emp.id, header.id, account);
    }
  });

  tx();

  return {
    success: true,
    work_date: workDate,
    account,
    previous_owner: prevName,
    new_owner: emp.name,
    new_employee_id: emp.id,
    is_override: 1,
    reason: reasonNote
  };
}

export function generateOrderLevelAllocation(workDate, options = {}) {
  if (options.use_enterprise === true || options.enterprise === true) {
    return executeEnterpriseAllocation(workDate, options);
  }
  if (options.round_based === true || options.is_reallocation === true || options.round_number !== undefined) {
    return generateRoundBasedAllocation(workDate, options);
  }
  return _legacy_generateOrderLevelAllocation(workDate, options);
}

function _legacy_generateOrderLevelAllocation(workDate, options = {}) {

  const method = options.method === 'Random' ? 'Random' : 'Fair Random';
  const isRegenerate = options.regenerate === true;

  // 1. Fetch all opening inventory orders for this date
  let orders = db.prepare(`
    SELECT id, order_code, account, status, order_date, source_file_slot
    FROM current_work_orders
    WHERE work_date = ?
    ORDER BY account ASC, order_code ASC
  `).all(workDate);

  if (orders.length === 0) {
    // Check if vendoor_orders has records for this business date or active orders
    const vOrders = db.prepare(`
      SELECT order_code, account, status, source_date as order_date
      FROM vendoor_orders
      WHERE (business_date = ? OR is_active = 1 OR source_date = ?)
        AND (status IS NULL OR LOWER(status) NOT IN ('cancelled', 'canceled', 'ملغي', 'الغاء', 'إلغاء', 'delivered', 'تم التسليم', 'shipped', 'completed', 'مكتمل', 'processing', 'قيد التجهيز'))
      ORDER BY account ASC, order_code ASC
    `).all(workDate, workDate);

    if (vOrders.length > 0) {
      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO current_work_orders (work_date, order_code, account, status, order_date, source_file_slot, source_type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      db.transaction(() => {
        for (const vo of vOrders) {
          const isPending = (vo.status || '').toLowerCase().includes('pending');
          const slot = isPending ? 2 : 1;
          const sourceType = isPending ? 'PENDING' : 'NEW';
          insertStmt.run(workDate, vo.order_code, vo.account || 'Unassigned', vo.status || 'New', vo.order_date || workDate, slot, sourceType);
        }
      })();

      orders = db.prepare(`
        SELECT id, order_code, account, status, order_date, source_file_slot
        FROM current_work_orders
        WHERE work_date = ?
        ORDER BY account ASC, order_code ASC
      `).all(workDate);
    }
  }

  if (orders.length === 0) {
    throw new Error(`No current work orders found for date: ${workDate}. Please upload New and/or Pending Orders first.`);
  }

  // 2. Fetch today's active working team — STRICTLY CS DEPARTMENT ONLY
  const workingTeam = getWorkingTeam(workDate).filter(e => e.is_working && isCSDepartment(e.department, e.name));
  if (workingTeam.length === 0) {
    throw new Error(`SETUP REQUIRED / VALIDATION ERROR: No working employees selected. No active CS employees found in today's working team for date: ${workDate}. Please configure Today's Working Team with CS employees.`);
  }

  // 3. Fetch existing saved Account Owners and saved order allocations (if incremental mode)
  const savedOwnersMap = new Map(); // key: account.toLowerCase() -> { employee_id, employee_name, is_override, method, rule_note }
  const savedAllocMap = new Map(); // key: order_code -> order alloc object
  if (!isRegenerate) {
    const existingSavedAllocation = getOrderLevelAllocation(workDate);
    if (existingSavedAllocation && Array.isArray(existingSavedAllocation.raw_allocations)) {
      for (const alloc of existingSavedAllocation.raw_allocations) {
        if (alloc.order_code) {
          savedAllocMap.set(alloc.order_code, alloc);
        }
      }
    }

    const existingOwners = db.prepare(`
      SELECT account, owner_employee_id as employee_id, owner_employee_name as employee_name, is_override, allocation_method as method, notes
      FROM account_owners
      WHERE work_date = ? AND owner_employee_id IS NOT NULL
    `).all(workDate);

    for (const own of existingOwners) {
      if (own.account && own.employee_id) {
        const isStillWorking = workingTeam.some(w => w.employee_id === own.employee_id && isCSDepartment(w.department, w.name));
        if (isStillWorking) {
          savedOwnersMap.set(own.account.toLowerCase(), {
            employee_id: own.employee_id,
            employee_name: own.employee_name,
            is_override: own.is_override,
            method: own.method || 'Account Owner',
            rule_note: own.is_override ? 'Supervisor Manual Override' : 'Preserved Account Owner'
          });
        }
      }
    }

    // Fallback: check order_level_allocations if account_owners was empty
    if (savedOwnersMap.size === 0 && existingSavedAllocation && Array.isArray(existingSavedAllocation.raw_allocations)) {
      for (const alloc of existingSavedAllocation.raw_allocations) {
        if (alloc.account && alloc.employee_id && !savedOwnersMap.has(alloc.account.toLowerCase())) {
          const isStillWorking = workingTeam.some(w => w.employee_id === alloc.employee_id && isCSDepartment(w.department, w.name));
          if (isStillWorking) {
            savedOwnersMap.set(alloc.account.toLowerCase(), {
              employee_id: alloc.employee_id,
              employee_name: alloc.employee_name,
              is_override: alloc.is_override,
              method: alloc.method || 'Account Owner',
              rule_note: alloc.rule_note || 'Preserved Account Owner'
            });
          }
        }
      }
    }
  }

  // Historical Sticky Ownership Fallback (Section 25):
  // If an Account had an established owner on a prior business date, preserve sticky ownership (CS ONLY)
  if (options.ignore_sticky !== true) {
    try {
      const priorOwners = db.prepare(`
        SELECT account, owner_employee_id as employee_id, owner_employee_name as employee_name, is_override, allocation_method as method, notes
        FROM account_owners
        WHERE work_date < ? AND owner_employee_id IS NOT NULL
        ORDER BY work_date DESC
      `).all(workDate);

      for (const own of priorOwners) {
        const accLower = (own.account || '').toLowerCase();
        if (accLower && !savedOwnersMap.has(accLower) && own.employee_id) {
          const isStillWorking = workingTeam.some(w => w.employee_id === own.employee_id && isCSDepartment(w.department, w.name));
          if (isStillWorking) {
            savedOwnersMap.set(accLower, {
              employee_id: own.employee_id,
              employee_name: own.employee_name,
              is_override: own.is_override,
              method: own.method || 'Sticky Account Owner',
              rule_note: 'Preserved Sticky Account Owner (Historical)'
            });
          }
        }
      }
    } catch (_) {}
  }

  // 4. Fetch persistent Account Rules & Exceptions
  const accountRulesMap = new Map();
  getAccountRules().forEach(r => {
    if (r.active) accountRulesMap.set(r.account_name.toLowerCase(), r);
  });
  const exceptions = getAccountExceptions(workDate);

  // 5. Fetch real historical employee performance profiles and system configs
  const performanceProfiles = getEmployeePerformanceProfiles(workDate);
  const cfgRows = db.prepare('SELECT key, value FROM system_configs').all();
  const systemConfigs = {};
  for (const cr of cfgRows) {
    systemConfigs[cr.key] = cr.value;
  }
  const systemWeights = {
    weight_performance: parseFloat(systemConfigs.weight_performance) || 0.40,
    weight_capacity: parseFloat(systemConfigs.weight_capacity) || 0.35,
    weight_workload_balance: parseFloat(systemConfigs.weight_workload_balance) || 0.25
  };
  const maxSingleEmployeeCap = parseFloat(systemConfigs.max_single_employee_capacity) || 80;

  // Group all orders by Account
  const accountOrdersMap = new Map(); // key: account.toLowerCase() -> { accountName, orders: [], newCount, pendingCount }
  for (const ord of orders) {
    const accKey = ord.account.toLowerCase();
    if (!accountOrdersMap.has(accKey)) {
      accountOrdersMap.set(accKey, {
        accountName: ord.account,
        orders: [],
        newCount: 0,
        pendingCount: 0
      });
    }
    const accData = accountOrdersMap.get(accKey);
    accData.orders.push(ord);
    if (ord.status === 'New') accData.newCount++;
    else if (ord.status === 'Pending') accData.pendingCount++;
  }

  // Helper: resolve eligibility for an entire Account
  function resolveAccountEligibility(accountName, hasNew, hasPending) {
    let eligible = workingTeam.filter(emp => {
      if (hasNew && hasPending) {
        return Boolean(emp.allowed_new && emp.allowed_pending);
      }
      if (hasNew) return Boolean(emp.allowed_new);
      if (hasPending) return Boolean(emp.allowed_pending);
      return true;
    });

    const rule = accountRulesMap.get(accountName.toLowerCase());
    let ruleNote = 'Account Owner';

    if (rule) {
      if (hasNew && Array.isArray(rule.new_eligible) && rule.new_eligible.length > 0) {
        eligible = eligible.filter(emp => rule.new_eligible.includes(emp.employee_id) || rule.new_eligible.includes(emp.name));
        ruleNote = 'Account Rule (New Allowed List)';
      }
      if (hasPending && Array.isArray(rule.pending_eligible) && rule.pending_eligible.length > 0) {
        eligible = eligible.filter(emp => rule.pending_eligible.includes(emp.employee_id) || rule.pending_eligible.includes(emp.name));
        ruleNote = hasNew ? `${ruleNote} & (Pending Allowed List)` : 'Account Rule (Pending Allowed List)';
      }
      if (Array.isArray(rule.blocked) && rule.blocked.length > 0) {
        eligible = eligible.filter(emp => !rule.blocked.includes(emp.employee_id) && !rule.blocked.includes(emp.name));
        ruleNote += ' [Blocked Agents Excluded]';
      }
    }

    // Date-specific exceptions (BLOCKED ALWAYS WINS)
    const accExceptions = exceptions.filter(e => e.account_name.toLowerCase() === accountName.toLowerCase());
    for (const exc of accExceptions) {
      if (exc.exception_type === 'block' && exc.employee_id) {
        eligible = eligible.filter(e => e.employee_id !== exc.employee_id);
        ruleNote += ` (Exception: Blocked ${exc.employee_name})`;
      } else if (exc.exception_type === 'allow_only' && exc.employee_id) {
        eligible = eligible.filter(e => e.employee_id === exc.employee_id);
        ruleNote = `Exception: Allow Only ${exc.employee_name}`;
      }
    }

    return { eligible, ruleNote };
  }

  // Tracking employee workloads:
  const employeeStatsMap = new Map();
  for (const emp of workingTeam) {
    employeeStatsMap.set(emp.employee_id, {
      employee_id: emp.employee_id,
      employee_name: emp.name,
      department: emp.department,
      team_membership: emp.permanent_team_membership,
      accountsCount: 0,
      ordersCount: 0,
      accountsMap: new Map(), // accountName -> { account, total_orders, new_orders, pending_orders }
      orders: []
    });
  }

  const finalAccountOwners = new Map(); // accountKey -> { account, employee_id, employee_name, method, rule_note, is_override }
  const unassignedAccounts = [];
  let preservedCount = 0;

  // Step 1: Assign already preserved Account Owners, validating stream eligibility
  for (const [accKey, accData] of accountOrdersMap.entries()) {
    if (savedOwnersMap.has(accKey)) {
      const saved = savedOwnersMap.get(accKey);
      const hasNew = accData.newCount > 0;
      const hasPending = accData.pendingCount > 0;
      const { eligible, ruleNote } = resolveAccountEligibility(accData.accountName, hasNew, hasPending);

      // Check if saved owner is still valid for this stream combination
      const isOwnerStillEligible = saved.employee_id && eligible.some(e => e.employee_id === saved.employee_id);

      if (isOwnerStillEligible || saved.is_override) {
        finalAccountOwners.set(accKey, {
          account: accData.accountName,
          employee_id: saved.employee_id,
          employee_name: saved.employee_name,
          method: saved.method || 'Account Owner',
          rule_note: saved.rule_note || 'Preserved Account Owner',
          is_override: saved.is_override ? 1 : 0,
          is_preserved: true,
          has_conflict: false,
          is_split: 0,
          total_orders: accData.orders.length
        });

        if (employeeStatsMap.has(saved.employee_id)) {
          const empStat = employeeStatsMap.get(saved.employee_id);
          empStat.accountsCount++;
          empStat.ordersCount += accData.orders.length;
          empStat.accountsMap.set(accData.accountName, {
            account: accData.accountName,
            total_orders: accData.orders.length,
            new_orders: accData.newCount,
            pending_orders: accData.pendingCount
          });
        }
      } else {
        // Ownership eligibility conflict detected
        const conflictReason = (hasNew && hasPending)
          ? 'Account Owner requires both New and Pending eligibility.'
          : (hasNew ? 'Account Owner requires New eligibility.' : 'Account Owner requires Pending eligibility.');

        finalAccountOwners.set(accKey, {
          account: accData.accountName,
          employee_id: null,
          employee_name: 'UNASSIGNED',
          previous_employee_id: saved.employee_id,
          previous_employee_name: saved.employee_name,
          method: 'Account Owner',
          rule_note: conflictReason,
          conflict_reason: conflictReason,
          has_conflict: true,
          is_override: 0,
          is_preserved: false,
          is_split: 0,
          total_orders: accData.orders.length
        });
        unassignedAccounts.push(accData.accountName);
      }
    }
  }

  // Step 2: For unassigned accounts, resolve eligibility and sort by constraint difficulty
  const accountsToAllocate = [];
  for (const [accKey, accData] of accountOrdersMap.entries()) {
    if (!finalAccountOwners.has(accKey)) {
      const hasNew = accData.newCount > 0;
      const hasPending = accData.pendingCount > 0;
      const { eligible, ruleNote } = resolveAccountEligibility(accData.accountName, hasNew, hasPending);

      accountsToAllocate.push({
        accKey,
        accountName: accData.accountName,
        orders: accData.orders,
        totalOrders: accData.orders.length,
        newCount: accData.newCount,
        pendingCount: accData.pendingCount,
        eligible,
        ruleNote
      });
    }
  }

  // Sort unassigned accounts:
  // 1. Fewest eligible candidates first (Restricted Accounts priority! Section 10)
  // 2. Largest order count first
  accountsToAllocate.sort((a, b) => {
    if (a.eligible.length !== b.eligible.length) {
      return a.eligible.length - b.eligible.length;
    }
    return b.totalOrders - a.totalOrders;
  });

  // Step 3: Fair Account Owner Selection Algorithm (Section 4, 9, 27, 28)
  const splitOrdersAllocMap = new Map(); // order_code -> { employee_id, employee_name, method, rule_note }

  for (const accItem of accountsToAllocate) {
    const { accKey, accountName, orders: accOrders, eligible, ruleNote, totalOrders, newCount, pendingCount } = accItem;
    const hasNew = newCount > 0;
    const hasPending = pendingCount > 0;

    if (eligible.length === 0) {
      let unassignedReason = 'No eligible employee satisfies rules';
      if (hasNew && hasPending) {
        unassignedReason = 'No single eligible employee for both New and Pending (No eligible employee satisfies both streams).';
      } else if (hasNew) {
        unassignedReason = 'No eligible employee for New stream.';
      } else if (hasPending) {
        unassignedReason = 'No eligible employee for Pending stream.';
      }

      finalAccountOwners.set(accKey, {
        account: accountName,
        employee_id: null,
        employee_name: 'UNASSIGNED',
        method: 'Account Owner',
        rule_note: unassignedReason,
        conflict_reason: unassignedReason,
        has_conflict: true,
        is_override: 0,
        is_split: 0,
        total_orders: totalOrders
      });
      unassignedAccounts.push(accountName);
      continue;
    }

    // Smart Split Decision (Sections 8, 9, 10, 19, 22, 23 of spec):
    // Evaluate candidate capacity and score first to answer the central question:
    // "Can one eligible employee reasonably handle the entire Account based on their current remaining capacity?"
    // If YES: KEEP TOGETHER (regardless of whether the account has 40, 60, 80, 100, 120 orders!)
    // If NO: evaluate Smart Split.
    const candidateAssessments = eligible.map(emp => {
      const stat = employeeStatsMap.get(emp.employee_id) || { accountsCount: 0, ordersCount: 0 };
      const prof = performanceProfiles.get(emp.employee_id);
      const scoreDetails = calculateSmartAllocationScore(emp.employee_id, prof, stat, systemWeights);
      return {
        emp,
        stat,
        prof,
        scoreDetails,
        compositeScore: scoreDetails.composite_score,
        remainingCapacity: scoreDetails.remaining_capacity,
        estCapacity: scoreDetails.estimated_daily_capacity,
        histScore: scoreDetails.historical_score,
        histRate: scoreDetails.historical_rate
      };
    });

    const capableCandidates = candidateAssessments.filter(c => c.remainingCapacity >= totalOrders);
    const hasSingleCapableOwner = capableCandidates.length > 0;

    const isSmartSplitEnabled = options.enable_smart_split === true || options.smart_split === true || options.split_policy === 'smart';
    // SMART SPLIT TRIGGERS ONLY WHEN:
    // 1. Multiple eligible candidates exist
    // 2. NO single eligible candidate has sufficient remaining capacity for the full account
    // 3. Smart split is enabled (or requested)
    const shouldSmartSplit = isSmartSplitEnabled && !hasSingleCapableOwner && eligible.length > 1;

    if (shouldSmartSplit) {
      // SMART SPLIT: Distribute proportionally based on performance & capacity
      const candidateCapacities = [...candidateAssessments];

      // Sort by remaining capacity & score
      candidateCapacities.sort((a, b) => {
        if (b.remainingCapacity !== a.remainingCapacity) {
          return b.remainingCapacity - a.remainingCapacity;
        }
        return b.compositeScore - a.compositeScore;
      });

      // Distribute totalOrders proportionally across candidates
      const totalAvailableCap = candidateCapacities.reduce((sum, c) => sum + c.remainingCapacity, 0);
      let remainingToAssign = totalOrders;
      const splitAllocations = [];

      for (let i = 0; i < candidateCapacities.length; i++) {
        const cand = candidateCapacities[i];
        if (remainingToAssign <= 0) break;

        let allocOrdersCount = 0;
        if (i === candidateCapacities.length - 1 || totalAvailableCap === 0) {
          allocOrdersCount = remainingToAssign;
        } else {
          const propRatio = cand.remainingCapacity / totalAvailableCap;
          allocOrdersCount = Math.min(remainingToAssign, Math.max(1, Math.round(totalOrders * propRatio)));
        }
        remainingToAssign -= allocOrdersCount;

        splitAllocations.push({
          employee_id: cand.emp.employee_id,
          employee_name: cand.emp.name,
          orders_count: allocOrdersCount,
          capacity: cand.remainingCapacity,
          score: cand.compositeScore
        });

        const empStat = employeeStatsMap.get(cand.emp.employee_id);
        if (empStat) {
          empStat.accountsCount++;
          empStat.ordersCount += allocOrdersCount;
        }
      }

      // Map orders to the split employees
      let orderIndex = 0;
      for (const sa of splitAllocations) {
        for (let j = 0; j < sa.orders_count && orderIndex < accOrders.length; j++) {
          const ord = accOrders[orderIndex++];
          splitOrdersAllocMap.set(ord.order_code, {
            employee_id: sa.employee_id,
            employee_name: sa.employee_name,
            method: 'Smart Split',
            rule_note: `Smart Split: ${sa.orders_count} orders to ${sa.employee_name} (Capacity: ${sa.capacity}, Score: ${sa.score})`
          });
        }
      }

      const splitEmpNames = splitAllocations.map(s => `${s.employee_name} (${s.orders_count})`).join(', ');
      finalAccountOwners.set(accKey, {
        account: accountName,
        employee_id: splitAllocations[0].employee_id,
        employee_name: `SMART SPLIT (${splitAllocations.map(s => s.employee_name).join(', ')})`,
        method: 'Smart Split',
        rule_note: `Smart Split: Workload of ${totalOrders} orders split across ${splitAllocations.length} employees [${splitEmpNames}] based on capacity & performance`,
        is_override: 0,
        is_split: 1,
        split_details: splitAllocations
      });
      continue;
    }

    let chosen = null;
    let chosenReason = '';

    if (eligible.length === 1) {
      // If only one eligible employee exists: that employee owns the Account
      chosen = eligible[0];
      chosenReason = `${ruleNote} → Assigned to ${chosen.name} (sole eligible candidate)`;
    } else {
      // Primary balancing metric: NUMBER OF ACCOUNTS PER EMPLOYEE (Primary fairness invariant)
      const minAccounts = Math.min(...candidateAssessments.map(c => c.stat.accountsCount));
      let bestCandidates = candidateAssessments.filter(c => c.stat.accountsCount === minAccounts);

      if (bestCandidates.length > 1) {
        // Among tied candidates with min accounts, prioritize candidates with remaining capacity if available
        const capableTied = bestCandidates.filter(c => c.remainingCapacity >= totalOrders);
        const pool = capableTied.length > 0 ? capableTied : bestCandidates;

        // Rank by Smart Allocation Score (Performance + Capacity + Workload)
        pool.sort((a, b) => {
          if (Math.abs(b.compositeScore - a.compositeScore) > 0.05) {
            return b.compositeScore - a.compositeScore;
          }
          return b.remainingCapacity - a.remainingCapacity;
        });
        bestCandidates = pool;
      }

      const topCandidate = bestCandidates[0];
      chosen = topCandidate.emp;

      chosenReason = `Account ${accountName} — ${totalOrders} orders assigned entirely to ${chosen.name} because ${chosen.name} is eligible, has balanced account distribution (${topCandidate.stat.accountsCount} accounts), available capacity (${topCandidate.remainingCapacity} remaining of ${topCandidate.estCapacity}), and strong historical performance/rate (${topCandidate.histScore}) to handle the workload without requiring an unnecessary split.`;
    }

    // Assign the ENTIRE account to this ONE chosen employee
    finalAccountOwners.set(accKey, {
      account: accountName,
      employee_id: chosen.employee_id,
      employee_name: chosen.name,
      method: 'Account Owner',
      rule_note: chosenReason,
      is_override: 0,
      is_split: 0,
      total_orders: totalOrders
    });

    const empStat = employeeStatsMap.get(chosen.employee_id);
    if (empStat) {
      empStat.accountsCount++;
      empStat.ordersCount += totalOrders;
      empStat.accountsMap.set(accountName, {
        account: accountName,
        total_orders: totalOrders,
        new_orders: newCount,
        pending_orders: pendingCount
      });
    }
  }

  // Step 4: Distribute all order codes inheriting the Account Owner or Smart Split
  const rawAllocations = [];
  const unassignedOrdersList = [];

  for (const ord of orders) {
    const accKey = ord.account.toLowerCase();
    const ownerInfo = finalAccountOwners.get(accKey);
    const splitInfo = splitOrdersAllocMap.get(ord.order_code);

    let allocItem;
    if (savedAllocMap.has(ord.order_code)) {
      preservedCount++;
      const saved = savedAllocMap.get(ord.order_code);
      if (saved.is_override) {
        allocItem = {
          order_code: ord.order_code,
          account: ord.account,
          status: ord.status,
          employee_id: saved.employee_id,
          employee_name: saved.employee_name,
          method: saved.method || 'Manual Override',
          rule_note: saved.rule_note || 'Supervisor Manual Override',
          is_override: 1
        };
      } else {
        allocItem = {
          order_code: ord.order_code,
          account: ord.account,
          status: ord.status,
          employee_id: splitInfo ? splitInfo.employee_id : (ownerInfo ? ownerInfo.employee_id : saved.employee_id),
          employee_name: splitInfo ? splitInfo.employee_name : (ownerInfo ? ownerInfo.employee_name : saved.employee_name),
          method: splitInfo ? splitInfo.method : (ownerInfo ? ownerInfo.method : (saved.method || 'Account Owner')),
          rule_note: splitInfo ? splitInfo.rule_note : (ownerInfo ? ownerInfo.rule_note : (saved.rule_note || 'Preserved Account Owner')),
          is_override: 0
        };
      }
    } else if (splitInfo) {
      allocItem = {
        order_code: ord.order_code,
        account: ord.account,
        status: ord.status,
        employee_id: splitInfo.employee_id,
        employee_name: splitInfo.employee_name,
        method: splitInfo.method,
        rule_note: splitInfo.rule_note,
        is_override: 0
      };
    } else {
      allocItem = {
        order_code: ord.order_code,
        account: ord.account,
        status: ord.status,
        employee_id: ownerInfo ? ownerInfo.employee_id : null,
        employee_name: ownerInfo ? ownerInfo.employee_name : 'UNASSIGNED',
        method: ownerInfo ? ownerInfo.method : 'Account Owner',
        rule_note: ownerInfo ? ownerInfo.rule_note : '',
        is_override: 0
      };
    }

    rawAllocations.push(allocItem);

    if (allocItem.employee_id) {
      const empStat = employeeStatsMap.get(allocItem.employee_id);
      if (empStat) {
        empStat.orders.push(allocItem);
      }
    } else {
      unassignedOrdersList.push(allocItem);
    }
  }

  // Step 5: Format By-Employee Structure
  const byEmployee = Array.from(employeeStatsMap.values())
    .filter(e => e.accountsCount > 0 || e.orders.length > 0)
    .map(e => ({
      employee_id: e.employee_id,
      employee_name: e.employee_name,
      department: e.department,
      team_membership: e.team_membership,
      total_accounts: e.accountsCount,
      total_orders: e.orders.length,
      new_orders: e.orders.filter(o => o.status === 'New').length,
      pending_orders: e.orders.filter(o => o.status === 'Pending').length,
      accounts_count: e.accountsCount,
      accounts: Array.from(e.accountsMap.values()),
      orders: e.orders
    }))
    .sort((a, b) => b.total_accounts - a.total_accounts || b.total_orders - a.total_orders);

  const totalAssigned = rawAllocations.filter(a => a.employee_id !== null).length;
  const totalUnassigned = unassignedOrdersList.length;

  const resultPayload = {
    success: true,
    work_date: workDate,
    method: 'Account Fair Balance',
    total_orders: orders.length,
    assigned_orders: totalAssigned,
    unassigned_orders: totalUnassigned,
    total_accounts: accountOrdersMap.size,
    assigned_accounts: finalAccountOwners.size - unassignedAccounts.length,
    unassigned_accounts: unassignedAccounts.length,
    preserved_orders_count: preservedCount,
    new_unallocated_orders_count: orders.length - preservedCount,
    is_incremental: preservedCount > 0,
    by_employee: byEmployee,
    account_owners: Array.from(finalAccountOwners.values()),
    raw_allocations: rawAllocations,
    unassigned_orders_list: unassignedOrdersList
  };

  if (options.auto_save === true) {
    try {
      saveFinalOrderLevelAllocation(workDate, resultPayload, 'Auto Fair Allocation');
    } catch (_) {}
  }

  return resultPayload;
}

/**
 * Defensive Contract Validation for Allocation Payloads
 * Distinguishes between:
 * 1. Valid non-empty allocation (records array with >= 1 valid records)
 * 2. Valid empty allocation (records array with 0 items, e.g. 0 allocatable orders)
 * 3. Invalid allocation payload (null, undefined, missing array, malformed records)
 */
export function validateAllocationPayload(workDate, allocationPayload) {
  if (!allocationPayload || typeof allocationPayload !== 'object') {
    const receivedType = allocationPayload === null ? 'null' : typeof allocationPayload;
    throw new Error(
      `[ALLOCATION CONTRACT VALIDATION ERROR] Invalid allocation payload for date "${workDate}": ` +
      `Expected a non-null object or array, received "${receivedType}".`
    );
  }

  let rawList = null;
  let method = 'Fair Random';
  let byEmployee = [];

  if (Array.isArray(allocationPayload)) {
    rawList = allocationPayload;
  } else {
    method = allocationPayload.method || 'Fair Random';
    byEmployee = Array.isArray(allocationPayload.by_employee) ? allocationPayload.by_employee : [];

    if (Array.isArray(allocationPayload.raw_allocations)) {
      rawList = allocationPayload.raw_allocations;
    } else if (Array.isArray(allocationPayload.allocations)) {
      rawList = allocationPayload.allocations;
    } else if (Array.isArray(allocationPayload.orderLevelAllocations)) {
      rawList = allocationPayload.orderLevelAllocations;
    } else if (Array.isArray(allocationPayload.assignments)) {
      rawList = allocationPayload.assignments;
    }
  }

  if (!rawList) {
    const receivedKeys = Object.keys(allocationPayload).join(', ') || 'none';
    throw new Error(
      `[ALLOCATION CONTRACT VALIDATION ERROR] Invalid allocation payload for date "${workDate}": ` +
      `Missing required allocation records array. Expected one of "raw_allocations", "allocations", "orderLevelAllocations", "assignments", or a root array. ` +
      `Received object keys: [${receivedKeys}].`
    );
  }

  // Valid empty allocation
  if (rawList.length === 0) {
    return {
      isValid: true,
      isEmpty: true,
      records: [],
      method,
      byEmployee
    };
  }

  // Validate non-empty records
  for (let i = 0; i < rawList.length; i++) {
    const item = rawList[i];
    if (!item || typeof item !== 'object') {
      throw new Error(
        `[ALLOCATION CONTRACT VALIDATION ERROR] Malformed allocation record at index ${i} for date "${workDate}": ` +
        `Expected an object record, received "${item === null ? 'null' : typeof item}".`
      );
    }
    if (!item.order_code || typeof item.order_code !== 'string') {
      throw new Error(
        `[ALLOCATION CONTRACT VALIDATION ERROR] Malformed allocation record at index ${i} for date "${workDate}": ` +
        `Missing or non-string "order_code". Received: ${JSON.stringify(item.order_code)}.`
      );
    }
    if (!item.account || typeof item.account !== 'string') {
      throw new Error(
        `[ALLOCATION CONTRACT VALIDATION ERROR] Malformed allocation record at index ${i} for date "${workDate}": ` +
        `Missing or non-string "account" for order "${item.order_code}". Received: ${JSON.stringify(item.account)}.`
      );
    }
  }

  return {
    isValid: true,
    isEmpty: false,
    records: rawList,
    method,
    byEmployee
  };
}

/**
 * Save final order-level allocation permanently by date and version
 */
export function saveFinalOrderLevelAllocation(workDate, allocationPayload, notes = '', generatedBy = 'Supervisor') {
  // Defensive validation of input payload
  const validation = validateAllocationPayload(workDate, allocationPayload);
  const { records: raw_allocations, method = 'Fair Random', byEmployee = [] } = validation;

  // Determine next version number
  const lastVerRow = db.prepare(`
    SELECT MAX(version_number) as max_ver
    FROM allocation_versions
    WHERE allocation_date = ?
  `).get(workDate);
  const versionNumber = (lastVerRow && lastVerRow.max_ver) ? lastVerRow.max_ver + 1 : 1;

  // Handle Valid Empty Allocation (legitimately zero orders to allocate)
  if (validation.isEmpty) {
    db.prepare(`
      INSERT INTO allocation_versions (
        allocation_date, version_number, generated_at, generated_by, method,
        rule_summary, total_orders, assigned_orders, unassigned_orders, allocation_json, is_final
      ) VALUES (?, ?, datetime('now'), ?, ?, ?, 0, 0, 0, '[]', 1)
    `).run(
      workDate,
      versionNumber,
      generatedBy,
      method,
      notes || `Empty Order-Level Allocation v${versionNumber}`
    );

    return {
      success: true,
      work_date: workDate,
      version: versionNumber,
      version_number: versionNumber,
      total_orders: 0,
      assigned_orders: 0,
      unassigned_orders: 0,
      is_empty: true
    };
  }

  const insertOrdAlloc = db.prepare(`
    INSERT INTO order_level_allocations (
      allocation_date, allocation_version, order_code, account, status,
      employee_id, employee_name, method, rule_note, is_override, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const assignedCount = raw_allocations.filter(a => a.employee_id !== null).length;
  const unassignedCount = raw_allocations.filter(a => a.employee_id === null).length;

  const tx = db.transaction(() => {
    // 1. Insert order-level allocations
    for (const item of raw_allocations) {
      insertOrdAlloc.run(
        workDate,
        versionNumber,
        item.order_code,
        item.account,
        item.status,
        item.employee_id || null,
        item.employee_name || 'UNASSIGNED',
        item.method || method,
        item.rule_note || '',
        item.is_override ? 1 : 0
      );
    }

    // 2. Insert Version record
    db.prepare(`
      INSERT INTO allocation_versions (
        allocation_date, version_number, generated_at, generated_by, method,
        rule_summary, total_orders, assigned_orders, unassigned_orders, allocation_json, is_final
      ) VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      workDate,
      versionNumber,
      generatedBy,
      method,
      notes || `Final Order-Level Allocation v${versionNumber}`,
      raw_allocations.length,
      assignedCount,
      unassignedCount,
      JSON.stringify(byEmployee || allocationPayload.by_employee || [])
    );

    // 3. Sync to legacy allocation_headers and allocation_items for backwards compatibility & Copy text
    const insertHeader = db.prepare(`
      INSERT INTO allocation_headers (allocation_date, notes, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(allocation_date) DO UPDATE SET
        notes = excluded.notes,
        updated_at = datetime('now')
    `);
    insertHeader.run(workDate, notes || `v${versionNumber} Order Allocation`);
    const headerId = db.prepare('SELECT id FROM allocation_headers WHERE allocation_date = ?').get(workDate).id;

    db.prepare('DELETE FROM allocation_items WHERE allocation_header_id = ?').run(headerId);
    const insertItem = db.prepare(`
      INSERT INTO allocation_items (allocation_header_id, employee_id, account, status, available_orders_at_assignment)
      VALUES (?, ?, ?, ?, ?)
    `);

    // Group assigned orders by (employee_id, account, status)
    const summaryMap = new Map();
    for (const item of raw_allocations) {
      if (!item.employee_id) continue;
      const key = `${item.employee_id}|${item.account}|${item.status}`;
      if (!summaryMap.has(key)) {
        summaryMap.set(key, {
          employee_id: item.employee_id,
          account: item.account,
          status: item.status,
          count: 0
        });
      }
      summaryMap.get(key).count++;
    }

    for (const s of summaryMap.values()) {
      insertItem.run(headerId, s.employee_id, s.account, s.status, s.count);
    }

    // 4. Sync Account Owners (ONE ACCOUNT = ONE EMPLOYEE)
    const upsertOwner = db.prepare(`
      INSERT INTO account_owners (
        work_date, account, owner_employee_id, owner_employee_name,
        allocation_version, allocation_method, is_override, notes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(work_date, account) DO UPDATE SET
        owner_employee_id = excluded.owner_employee_id,
        owner_employee_name = excluded.owner_employee_name,
        allocation_version = excluded.allocation_version,
        allocation_method = excluded.allocation_method,
        is_override = excluded.is_override,
        notes = excluded.notes,
        updated_at = datetime('now')
    `);

    const accOwnerMap = new Map();
    for (const item of raw_allocations) {
      if (!accOwnerMap.has(item.account.toLowerCase())) {
        accOwnerMap.set(item.account.toLowerCase(), {
          account: item.account,
          employee_id: item.employee_id || null,
          employee_name: item.employee_name || 'UNASSIGNED',
          is_override: item.is_override ? 1 : 0,
          method: item.method || method
        });
      }
    }

    for (const own of accOwnerMap.values()) {
      upsertOwner.run(
        workDate,
        own.account,
        own.employee_id,
        own.employee_name,
        versionNumber,
        own.method,
        own.is_override,
        notes || `Allocation v${versionNumber}`
      );
    }

    // 5. Finalize Preparation Batch
    try {
      db.prepare(`
        UPDATE preparation_batches
        SET status = 'FINALIZED', allocation_version = ?, updated_at = datetime('now')
        WHERE work_date = ?
      `).run(versionNumber, workDate);
    } catch (_) {}
  });

  tx();

  return {
    success: true,
    work_date: workDate,
    version: versionNumber,
    version_number: versionNumber,
    total_orders: raw_allocations.length,
    assigned_orders: assignedCount,
    unassigned_orders: unassignedCount
  };
}

/**
 * Manual Override for an individual order assignment
 */
export function manualOverrideOrderAllocation(workDate, versionNumber, orderCode, newEmployeeId, forceOverride = false) {
  const emp = db.prepare('SELECT id, name, department FROM employees WHERE id = ?').get(newEmployeeId);
  if (!emp) {
    throw new Error(`Employee ID ${newEmployeeId} not found`);
  }
  if (!isCsEmployee(emp) && !forceOverride) {
    throw new Error(`Worker "${emp.name}" (ID #${newEmployeeId}) belongs to department "${emp.department}". Work Allocation requires CS employees only.`);
  }

  const res = db.prepare(`
    UPDATE order_level_allocations
    SET employee_id = ?, employee_name = ?, is_override = 1, method = 'Manual Override', rule_note = 'Supervisor Manual Override'
    WHERE allocation_date = ? AND allocation_version = ? AND order_code = ?
  `).run(emp.id, emp.name, workDate, versionNumber, orderCode);

  if (res.changes === 0) {
    throw new Error(`Order ${orderCode} not found in allocation for ${workDate} v${versionNumber}`);
  }

  return {
    success: true,
    order_code: orderCode,
    new_employee_id: emp.id,
    new_employee_name: emp.name
  };
}

/**
 * Get Saved Order-Level Allocation (latest final or specific version)
 */
export function getOrderLevelAllocation(workDate, versionNumber = null) {
  let ver = versionNumber;
  if (!ver) {
    const lastVer = db.prepare('SELECT MAX(version_number) as max_v FROM allocation_versions WHERE allocation_date = ?').get(workDate);
    ver = lastVer ? lastVer.max_v : null;
  }

  if (!ver) {
    return null;
  }

  const verMeta = db.prepare('SELECT * FROM allocation_versions WHERE allocation_date = ? AND version_number = ?').get(workDate, ver);
  const rows = db.prepare(`
    SELECT *
    FROM order_level_allocations
    WHERE allocation_date = ? AND allocation_version = ?
    ORDER BY account ASC, order_code ASC
  `).all(workDate, ver);

  const byEmployeeMap = new Map();
  const unassigned = [];

  for (const r of rows) {
    if (!r.employee_id) {
      unassigned.push(r);
      continue;
    }

    if (!byEmployeeMap.has(r.employee_id)) {
      const emp = db.prepare('SELECT department, team_membership FROM employees WHERE id = ?').get(r.employee_id) || {};
      byEmployeeMap.set(r.employee_id, {
        employee_id: r.employee_id,
        employee_name: r.employee_name,
        department: emp.department || 'CS',
        team_membership: emp.team_membership || 'Both',
        orders: [],
        accountsMap: new Map()
      });
    }

    const empObj = byEmployeeMap.get(r.employee_id);
    empObj.orders.push(r);
    const accItem = empObj.accountsMap.get(r.account) || { account: r.account, status: r.status, count: 0 };
    accItem.count++;
    empObj.accountsMap.set(r.account, accItem);
  }

  const byEmployee = Array.from(byEmployeeMap.values()).map(e => ({
    employee_id: e.employee_id,
    employee_name: e.employee_name,
    department: e.department,
    team_membership: e.team_membership,
    total_orders: e.orders.length,
    new_orders: e.orders.filter(o => o.status === 'New').length,
    pending_orders: e.orders.filter(o => o.status === 'Pending').length,
    accounts_count: e.accountsMap.size,
    accounts: Array.from(e.accountsMap.values()),
    orders: e.orders
  })).sort((a, b) => b.total_orders - a.total_orders);

  return {
    work_date: workDate,
    version: ver,
    meta: verMeta,
    total_orders: rows.length,
    assigned_orders: rows.length - unassigned.length,
    unassigned_orders: unassigned.length,
    by_employee: byEmployee,
    unassigned_orders_list: unassigned,
    raw_allocations: rows,
    orders: rows
  };
}

/**
 * Get exact assigned orders and metadata for a specific employee
 */
export function getEmployeeAssignedOrders(workDate, employeeId, versionNumber = null) {
  const alloc = getOrderLevelAllocation(workDate, versionNumber);
  if (!alloc) return null;

  const empData = alloc.by_employee.find(e => e.employee_id === Number(employeeId) || e.employee_name === String(employeeId));
  if (!empData) return null;

  return {
    work_date: workDate,
    version: alloc.version,
    generated_at: alloc.meta ? alloc.meta.generated_at : null,
    generated_by: alloc.meta ? alloc.meta.generated_by : 'Supervisor',
    method: alloc.meta ? alloc.meta.method : 'Fair Random',
    notes: alloc.meta ? alloc.meta.rule_summary : '',
    ...empData
  };
}

/**
 * Get all saved allocation versions for a date
 */
export function getAllocationVersions(workDate) {
  return db.prepare(`
    SELECT *
    FROM allocation_versions
    WHERE allocation_date = ?
    ORDER BY version_number DESC
  `).all(workDate);
}

/**
 * ============================================================
 * ROUND-BASED ALLOCATION & SMART REALLOCATION (PART 1)
 * ============================================================
 */

export function generateRoundBasedAllocation(workDate, options = {}) {
  const isReallocation = options.is_reallocation === true;
  const isRegenerate = options.regenerate === true;
  
  // Configurable capacity model:
  // STANDARD_CAPACITY = 40 (target load)
  // CONTROLLED_OVERFLOW = allowed only for qualified high-efficiency employees with verified sustainable capacity
  // ABSOLUTE_SAFETY_CEILING = strict limit
  let cfgStdCap = 40;
  let cfgMaxOverflow = 10;
  let cfgAbsCeiling = 80;
  try {
    const rStd = db.prepare("SELECT value FROM system_configs WHERE key = 'standard_capacity_per_employee'").get();
    if (rStd && !isNaN(parseInt(rStd.value, 10))) cfgStdCap = parseInt(rStd.value, 10);
    const rOvr = db.prepare("SELECT value FROM system_configs WHERE key = 'max_overflow_orders_per_employee'").get();
    if (rOvr && !isNaN(parseInt(rOvr.value, 10))) cfgMaxOverflow = parseInt(rOvr.value, 10);
    const rAbs = db.prepare("SELECT value FROM system_configs WHERE key = 'absolute_max_orders_per_employee'").get();
    if (rAbs && !isNaN(parseInt(rAbs.value, 10))) cfgAbsCeiling = parseInt(rAbs.value, 10);
  } catch (_) {}

  const standardCap = Number(options.standard_capacity_per_employee || options.standard_capacity || options.max_capacity_per_employee || options.max_capacity || cfgStdCap);
  const maxOverflow = Number(options.max_overflow_orders_per_employee !== undefined ? options.max_overflow_orders_per_employee : (options.max_overflow !== undefined ? options.max_overflow : cfgMaxOverflow));
  const absoluteCeiling = Number(options.absolute_max_orders_per_employee !== undefined ? options.absolute_max_orders_per_employee : (options.absolute_ceiling !== undefined ? options.absolute_ceiling : cfgAbsCeiling));
  const allowOverflow = options.allow_overflow !== false && maxOverflow > 0;

  const method = options.method || (isReallocation ? 'Smart Reallocation' : 'Fair Random Round');

  // 1. Fetch current work orders for date
  let orders = db.prepare(`
    SELECT * FROM current_work_orders
    WHERE work_date = ?
    ORDER BY account ASC, order_code ASC
  `).all(workDate);

  if (orders.length === 0) {
    // Check vendoor_orders fallback
    const vOrders = db.prepare(`
      SELECT order_code, account, status, source_date as order_date
      FROM vendoor_orders
      WHERE (business_date = ? OR is_active = 1 OR source_date = ?)
        AND (status IS NULL OR LOWER(status) NOT IN ('cancelled', 'canceled', 'ملغي', 'الغاء', 'إلغاء', 'delivered', 'تم التسليم', 'shipped', 'completed', 'مكتمل', 'processing', 'قيد التجهيز'))
      ORDER BY account ASC, order_code ASC
    `).all(workDate, workDate);

    if (vOrders.length > 0) {
      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO current_work_orders (work_date, order_code, account, status, order_date, source_file_slot, source_type, tracking_id, priority, work_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'REGULAR', 'UNASSIGNED')
      `);
      db.transaction(() => {
        for (let i = 0; i < vOrders.length; i++) {
          const vo = vOrders[i];
          const isPending = (vo.status || '').toLowerCase().includes('pending');
          const slot = isPending ? 2 : 1;
          const sourceType = isPending ? 'PENDING' : 'NEW';
          const trkId = generateTrackingId(vo.order_code, workDate, i + 1);
          insertStmt.run(workDate, vo.order_code, vo.account || 'Unassigned', vo.status || 'New', vo.order_date || workDate, slot, sourceType, trkId);
        }
      })();

      orders = db.prepare(`
        SELECT * FROM current_work_orders
        WHERE work_date = ?
        ORDER BY account ASC, order_code ASC
      `).all(workDate);
    }
  }

  if (orders.length === 0) {
    throw new Error(`No current work orders found for date: ${workDate}. Please upload New and/or Pending Orders first.`);
  }

  // 2. Fetch active working team — STRICT CS ONLY
  const workingTeam = getWorkingTeam(workDate).filter(e => e.is_working && isCSDepartment(e.department, e.name));
  if (workingTeam.length === 0) {
    throw new Error(`SETUP REQUIRED / VALIDATION ERROR: No working employees selected. No active CS employees found in today's working team for date: ${workDate}. Please configure Today's Working Team with CS employees.`);
  }

  // 3. Determine round number
  const maxRoundRow = db.prepare('SELECT MAX(round_number) as max_r FROM current_work_orders WHERE work_date = ?').get(workDate);
  const existingMaxRound = maxRoundRow && maxRoundRow.max_r ? maxRoundRow.max_r : 1;
  let targetRound = 1;
  if (options.round_number !== undefined && options.round_number !== null) {
    targetRound = Number(options.round_number);
  } else if (isReallocation) {
    targetRound = existingMaxRound + 1;
  } else {
    targetRound = existingMaxRound || 1;
  }

  // 4. Ensure every order has tracking_id
  for (let i = 0; i < orders.length; i++) {
    if (!orders[i].tracking_id) {
      const tid = generateTrackingId(orders[i].order_code, workDate, i + 1);
      orders[i].tracking_id = tid;
      db.prepare('UPDATE current_work_orders SET tracking_id = ? WHERE id = ?').run(tid, orders[i].id);
    }
  }

  // 5. Separate Preserved Orders vs Eligible Orders
  // Preservation rule: CLAIMED, IN_PROGRESS, COMPLETED work MUST BE PRESERVED!
  // If regenerate is true, unworked ASSIGNED orders are reset to UNASSIGNED
  const PRESERVED_STATES = new Set(['CLAIMED', 'IN_PROGRESS', 'COMPLETED']);
  const preservedOrders = [];
  const eligibleOrders = [];

  for (const ord of orders) {
    const state = String(ord.work_state || 'UNASSIGNED').toUpperCase();
    if (PRESERVED_STATES.has(state) && ord.assigned_employee_id) {
      preservedOrders.push(ord);
    } else {
      if (isRegenerate && state === 'ASSIGNED') {
        ord.assigned_employee_id = null;
        ord.assigned_employee_name = 'UNASSIGNED';
        ord.work_state = 'UNASSIGNED';
      }
      eligibleOrders.push(ord);
    }
  }

  // 6. Setup Employee Workload, Qualification Profiles & Stream Locks for this round
  const employeeStateMap = new Map();
  for (const emp of workingTeam) {
    const membership = emp.permanent_team_membership || emp.team_membership || 'Both';
    const isNewOnly = membership.toLowerCase() === 'new';
    const isPendingOnly = membership.toLowerCase() === 'pending';

    // Qualification check for controlled overflow:
    // Requires BOTH strong historical performance AND verified sustainable capacity (never based on score alone!)
    let isHighEfficiency = false;
    let hasSustainableCapacity = false;
    let avgHistoricalActions = 0;
    let historicalScore = 0;

    try {
      const snapRows = db.prepare(`
        SELECT performance_score, efficiency_score, grade, real_actions, printed_orders, pending_backlog
        FROM performance_snapshots
        WHERE (employee_id = ? OR employee_name = ?) AND date <= ?
        ORDER BY date DESC LIMIT 5
      `).all(emp.employee_id, emp.name, workDate);

      if (snapRows.length > 0) {
        const totalActions = snapRows.reduce((s, r) => s + (r.real_actions || 0), 0);
        avgHistoricalActions = totalActions / snapRows.length;
        const totalScore = snapRows.reduce((s, r) => s + (r.performance_score || r.efficiency_score || 0), 0);
        historicalScore = totalScore / snapRows.length;
        const latestGrade = snapRows[0].grade || '';

        isHighEfficiency = latestGrade === 'A' || latestGrade === 'B' || historicalScore >= 75 || snapRows[0].efficiency_score >= 75;
        // Verified sustainable capacity requires proven throughput (actions or completed volume >= standardCap or average >= 35)
        hasSustainableCapacity = avgHistoricalActions >= 35 || snapRows.some(r => (r.real_actions || 0) >= standardCap);
      }
    } catch (_) {}

    // Allow explicit option overrides for tests and specific configurations
    if (options.employee_overflow_eligibility && options.employee_overflow_eligibility[emp.employee_id] !== undefined) {
      const elig = options.employee_overflow_eligibility[emp.employee_id];
      isHighEfficiency = Boolean(elig.is_high_efficiency);
      hasSustainableCapacity = Boolean(elig.has_sustainable_capacity);
    }

    const canOverflow = allowOverflow && isHighEfficiency && hasSustainableCapacity;
    const allowedCapacity = canOverflow ? Math.min(absoluteCeiling, standardCap + maxOverflow) : standardCap;

    employeeStateMap.set(emp.employee_id, {
      employee_id: emp.employee_id,
      employee_name: emp.name,
      department: emp.department,
      team_membership: membership,
      allowed_new: Boolean(emp.allowed_new),
      allowed_pending: Boolean(emp.allowed_pending),
      standard_capacity: standardCap,
      max_overflow: maxOverflow,
      absolute_ceiling: absoluteCeiling,
      is_high_efficiency: isHighEfficiency,
      has_sustainable_capacity: hasSustainableCapacity,
      can_overflow: canOverflow,
      allowed_capacity: allowedCapacity,
      historical_score: historicalScore,
      avg_actions: avgHistoricalActions,
      current_load: 0,
      // Round stream lock: for 'Both', lock starts as null each round and is locked upon first stream assigned in this round!
      round_stream_lock: isNewOnly ? 'NEW' : (isPendingOnly ? 'PENDING' : null),
      assigned_orders: []
    });
  }

  // Count preserved orders toward employee capacity
  for (const ord of preservedOrders) {
    if (employeeStateMap.has(ord.assigned_employee_id)) {
      const e = employeeStateMap.get(ord.assigned_employee_id);
      e.current_load++;
      // If preserved order is in this round and employee is Both, update lock
      if (ord.round_number === targetRound && !e.round_stream_lock) {
        const isPend = (ord.status || '').toLowerCase().includes('pending') || (ord.source_type === 'PENDING');
        e.round_stream_lock = isPend ? 'PENDING' : 'NEW';
      }
      e.assigned_orders.push({
        order_code: ord.order_code,
        account: ord.account,
        status: ord.status,
        tracking_id: ord.tracking_id,
        work_state: ord.work_state,
        priority: ord.priority || 'REGULAR',
        round_number: ord.round_number || 1,
        is_preserved: true
      });
    } else {
      const empRow = db.prepare('SELECT id, name, department, team_membership FROM employees WHERE id = ?').get(ord.assigned_employee_id);
      employeeStateMap.set(ord.assigned_employee_id, {
        employee_id: ord.assigned_employee_id,
        employee_name: ord.assigned_employee_name || (empRow ? empRow.name : `Employee ${ord.assigned_employee_id}`),
        department: empRow ? empRow.department : 'CS',
        team_membership: empRow ? empRow.team_membership : 'Both',
        allowed_new: false,
        allowed_pending: false,
        standard_capacity: standardCap,
        max_overflow: 0,
        absolute_ceiling: absoluteCeiling,
        is_high_efficiency: false,
        has_sustainable_capacity: false,
        can_overflow: false,
        allowed_capacity: standardCap,
        historical_score: 0,
        avg_actions: 0,
        current_load: 1,
        round_stream_lock: null,
        is_preserved_only: true,
        assigned_orders: [{
          order_code: ord.order_code,
          account: ord.account,
          status: ord.status,
          tracking_id: ord.tracking_id,
          work_state: ord.work_state,
          priority: ord.priority || 'REGULAR',
          round_number: ord.round_number || 1,
          is_preserved: true
        }]
      });
    }
  }

  // 7. Fetch account rules, sticky owners, and exceptions
  const accountRulesMap = new Map();
  getAccountRules().forEach(r => {
    if (r.active) accountRulesMap.set(r.account_name.toLowerCase(), r);
  });
  const exceptions = getAccountExceptions(workDate);

  const savedOwnersMap = new Map();
  try {
    const existingOwners = db.prepare(`
      SELECT account, owner_employee_id as employee_id, owner_employee_name as employee_name, is_override
      FROM account_owners
      WHERE work_date = ? AND owner_employee_id IS NOT NULL
    `).all(workDate);
    for (const own of existingOwners) {
      if (own.account && own.employee_id) {
        savedOwnersMap.set(own.account.toLowerCase(), own);
      }
    }

    if (options.ignore_sticky !== true) {
      const priorOwners = db.prepare(`
        SELECT account, owner_employee_id as employee_id, owner_employee_name as employee_name, is_override
        FROM account_owners
        WHERE work_date < ? AND owner_employee_id IS NOT NULL
        ORDER BY work_date DESC
      `).all(workDate);
      for (const own of priorOwners) {
        const accLower = (own.account || '').toLowerCase();
        if (accLower && !savedOwnersMap.has(accLower)) {
          savedOwnersMap.set(accLower, own);
        }
      }
    }
  } catch (_) {}

  // 8. Prepare eligible orders:
  // - Fast Track ordered before Regular: FAST_TRACK orders are placed at the beginning!
  // - Mixed account splitting: split into distinct stream groups!
  eligibleOrders.sort((a, b) => {
    const prioA = (a.priority === 'FAST_TRACK') ? 0 : 1;
    const prioB = (b.priority === 'FAST_TRACK') ? 0 : 1;
    if (prioA !== prioB) return prioA - prioB;
    return a.account.localeCompare(b.account);
  });

  // Group into stream sub-pools by (account, stream)
  // Fast Track and Regular orders for the same account and same stream STAY TOGETHER!
  const workGroups = [];
  const accGroupMap = new Map();

  for (const ord of eligibleOrders) {
    const isPending = (ord.status || '').toLowerCase().includes('pending') || (ord.source_type === 'PENDING');
    const stream = isPending ? 'PENDING' : 'NEW';
    const groupKey = `${ord.account.toLowerCase()}|${stream}`;

    if (!accGroupMap.has(groupKey)) {
      const grp = {
        account: ord.account,
        stream,
        has_fast_track: false,
        orders: []
      };
      accGroupMap.set(groupKey, grp);
      workGroups.push(grp);
    }
    const targetGrp = accGroupMap.get(groupKey);
    if (ord.priority === 'FAST_TRACK') {
      targetGrp.has_fast_track = true;
    }
    targetGrp.orders.push(ord);
  }

  // Inside each group, sort so Fast Track orders come first for execution priority
  for (const grp of workGroups) {
    grp.orders.sort((a, b) => {
      const prioA = (a.priority === 'FAST_TRACK') ? 0 : 1;
      const prioB = (b.priority === 'FAST_TRACK') ? 0 : 1;
      return prioA - prioB;
    });
  }

  // Prioritize workGroups:
  // 1. Groups containing Fast Track orders first
  // 2. Large groups first (Decreasing size) to eliminate unnecessary fragmentation
  // 3. Alphabetical tie-breaker
  workGroups.sort((a, b) => {
    if (a.has_fast_track !== b.has_fast_track) {
      return a.has_fast_track ? -1 : 1;
    }
    if (b.orders.length !== a.orders.length) {
      return b.orders.length - a.orders.length;
    }
    return a.account.localeCompare(b.account);
  });

  // Helper to check employee eligibility for a group
  function isCandidateEligible(candidate, accountName, stream) {
    if (candidate.is_preserved_only) return false;
    // 1. Working today & CS: already filtered
    // 2. Stream capability:
    if (stream === 'NEW' && !candidate.allowed_new) return false;
    if (stream === 'PENDING' && !candidate.allowed_pending) return false;

    // 3. Round stream lock:
    // If locked to NEW, CANNOT take PENDING.
    // If locked to PENDING, CANNOT take NEW.
    if (stream === 'NEW' && candidate.round_stream_lock === 'PENDING') return false;
    if (stream === 'PENDING' && candidate.round_stream_lock === 'NEW') return false;

    // 4. Capacity limit: candidate must have remaining capacity
    if (candidate.current_load >= candidate.allowed_capacity) return false;

    // 5. Account rules
    const rule = accountRulesMap.get(accountName.toLowerCase());
    if (rule) {
      if (stream === 'NEW' && Array.isArray(rule.new_eligible) && rule.new_eligible.length > 0) {
        if (!rule.new_eligible.includes(candidate.employee_id) && !rule.new_eligible.includes(candidate.employee_name)) {
          return false;
        }
      }
      if (stream === 'PENDING' && Array.isArray(rule.pending_eligible) && rule.pending_eligible.length > 0) {
        if (!rule.pending_eligible.includes(candidate.employee_id) && !rule.pending_eligible.includes(candidate.employee_name)) {
          return false;
        }
      }
      if (Array.isArray(rule.blocked) && rule.blocked.length > 0) {
        if (rule.blocked.includes(candidate.employee_id) || rule.blocked.includes(candidate.employee_name)) {
          return false;
        }
      }
    }

    // 6. Exceptions
    const accExcs = exceptions.filter(e => e.account_name.toLowerCase() === accountName.toLowerCase());
    for (const exc of accExcs) {
      if (exc.exception_type === 'block' && exc.employee_id === candidate.employee_id) return false;
      if (exc.exception_type === 'allow_only' && exc.employee_id !== candidate.employee_id) return false;
    }

    return true;
  }

  // 9. Allocate each workGroup with MINIMUM FRAGMENTATION
  const unassignedOrders = [];

  for (const grp of workGroups) {
    let remainingOrders = [...grp.orders];

    while (remainingOrders.length > 0) {
      // Find all eligible candidates with available capacity
      const eligibleCandidates = Array.from(employeeStateMap.values()).filter(c => 
        isCandidateEligible(c, grp.account, grp.stream) && (c.allowed_capacity - c.current_load > 0)
      );

      if (eligibleCandidates.length === 0) {
        // No more candidates can take orders from this group -> unassigned
        for (const rem of remainingOrders) {
          unassignedOrders.push({
            order_code: rem.order_code,
            account: rem.account,
            status: rem.status,
            tracking_id: rem.tracking_id,
            work_state: 'UNASSIGNED',
            priority: rem.priority || 'REGULAR',
            round_number: targetRound,
            unassigned_reason: 'No eligible candidate available within capacity or stream lock rules'
          });
        }
        remainingOrders = [];
        break;
      }

      const savedOwner = savedOwnersMap.get(grp.account.toLowerCase());
      const savedOwnerId = savedOwner ? savedOwner.employee_id : null;

      // STEP 1 (PRIMARY COMMERCIAL GOAL): Check if ANY eligible employee can keep the ENTIRE remaining orders intact!
      // This ensures 28 stays with 1 employee, 42 stays with 1 qualified employee, etc. (Zero unnecessary split).
      const singleCandidates = eligibleCandidates.filter(c => (c.allowed_capacity - c.current_load) >= remainingOrders.length);

      let chosenCandidate = null;

      if (singleCandidates.length > 0) {
        // Prioritize candidates who can keep the account completely intact:
        singleCandidates.sort((a, b) => {
          // 1. Sticky owner (if sticky owner can legally keep the whole account, give it to them!)
          const aIsOwner = (savedOwnerId && a.employee_id === savedOwnerId) ? 0 : 1;
          const bIsOwner = (savedOwnerId && b.employee_id === savedOwnerId) ? 0 : 1;
          if (aIsOwner !== bIsOwner) return aIsOwner - bIsOwner;

          // 2. Stream continuity (already locked to this stream)
          const aLocked = (a.round_stream_lock === grp.stream) ? 0 : 1;
          const bLocked = (b.round_stream_lock === grp.stream) ? 0 : 1;
          if (aLocked !== bLocked) return aLocked - bLocked;

          // 3. Prefer standard capacity without overflow over needing overflow
          const aWithinStd = (a.current_load + remainingOrders.length <= a.standard_capacity) ? 0 : 1;
          const bWithinStd = (b.current_load + remainingOrders.length <= b.standard_capacity) ? 0 : 1;
          if (aWithinStd !== bWithinStd) return aWithinStd - bWithinStd;

          // 4. Higher sustainable capacity / performance
          if (b.historical_score !== a.historical_score) return b.historical_score - a.historical_score;

          // 5. Workload balance (lowest current load)
          if (a.current_load !== b.current_load) return a.current_load - b.current_load;

          // 6. Deterministic tie-breaker
          return String(a.employee_id).localeCompare(String(b.employee_id));
        });

        chosenCandidate = singleCandidates[0];
      } else {
        // STEP 2: No single employee can take all orders intact.
        // Split using the MINIMUM feasible number of employees by taking maximum feasible chunks.
        eligibleCandidates.sort((a, b) => {
          // 1. Sticky owner
          const aIsOwner = (savedOwnerId && a.employee_id === savedOwnerId) ? 0 : 1;
          const bIsOwner = (savedOwnerId && b.employee_id === savedOwnerId) ? 0 : 1;
          if (aIsOwner !== bIsOwner) return aIsOwner - bIsOwner;

          // 2. Stream lock continuity
          const aLocked = (a.round_stream_lock === grp.stream) ? 0 : 1;
          const bLocked = (b.round_stream_lock === grp.stream) ? 0 : 1;
          if (aLocked !== bLocked) return aLocked - bLocked;

          // 3. Highest available capacity (to minimize the number of employees required!)
          const aAvail = a.allowed_capacity - a.current_load;
          const bAvail = b.allowed_capacity - b.current_load;
          if (bAvail !== aAvail) return bAvail - aAvail;

          // 4. Higher performance score
          if (b.historical_score !== a.historical_score) return b.historical_score - a.historical_score;

          // 5. Workload balance
          if (a.current_load !== b.current_load) return a.current_load - b.current_load;

          // 6. Deterministic tie-breaker
          return String(a.employee_id).localeCompare(String(b.employee_id));
        });

        chosenCandidate = eligibleCandidates[0];
      }

      const availableCapacity = chosenCandidate.allowed_capacity - chosenCandidate.current_load;
      const takeCount = Math.min(remainingOrders.length, availableCapacity);
      const ordersToAssign = remainingOrders.slice(0, takeCount);
      remainingOrders = remainingOrders.slice(takeCount);

      // Lock candidate to this stream for this round
      chosenCandidate.round_stream_lock = grp.stream;
      chosenCandidate.current_load += takeCount;

      for (const ord of ordersToAssign) {
        chosenCandidate.assigned_orders.push({
          order_code: ord.order_code,
          account: ord.account,
          status: ord.status,
          tracking_id: ord.tracking_id,
          work_state: 'ASSIGNED',
          priority: ord.priority || 'REGULAR',
          round_number: targetRound,
          is_preserved: false,
          previous_employee_id: ord.assigned_employee_id || null,
          previous_employee_name: ord.assigned_employee_name || null
        });
      }
    }
  }

  // 10. STRICT INVARIANT AUDIT BEFORE PERSISTENCE
  // Invariant 1: Allowed Capacity & Absolute Safety Ceiling
  for (const emp of employeeStateMap.values()) {
    if (emp.current_load > emp.allowed_capacity) {
      throw new Error(`CRITICAL ALLOCATION INVARIANT FAILED: Employee ${emp.employee_name} exceeded allowed capacity (${emp.current_load} > ${emp.allowed_capacity})`);
    }
    if (emp.current_load > absoluteCeiling) {
      throw new Error(`CRITICAL ALLOCATION INVARIANT FAILED: Employee ${emp.employee_name} exceeded absolute ceiling (${emp.current_load} > ${absoluteCeiling})`);
    }
  }

  // Invariant 2: Round Stream Lock Invariant
  // No employee can have both NEW and PENDING assigned in the SAME round!
  for (const emp of employeeStateMap.values()) {
    const newAssignedInThisRound = emp.assigned_orders.filter(o => !o.is_preserved || o.round_number === targetRound);
    let hasNew = false;
    let hasPending = false;
    for (const ord of newAssignedInThisRound) {
      if ((ord.status || '').toLowerCase().includes('pending') || ord.source_type === 'PENDING') {
        hasPending = true;
      } else {
        hasNew = true;
      }
    }
    if (hasNew && hasPending) {
      throw new Error(`CRITICAL ALLOCATION INVARIANT FAILED: Employee ${emp.employee_name} was assigned both NEW and PENDING orders in Round ${targetRound}!`);
    }
  }

  // Invariant 3: Total Orders Conservation
  const totalAssignedCount = Array.from(employeeStateMap.values()).reduce((sum, e) => sum + e.assigned_orders.length, 0);
  const totalExpected = orders.length;
  if (totalAssignedCount + unassignedOrders.length !== totalExpected) {
    throw new Error(`CRITICAL ALLOCATION INVARIANT FAILED: Orders count mismatch: assigned (${totalAssignedCount}) + unassigned (${unassignedOrders.length}) != total (${totalExpected})`);
  }

  // Build raw allocations list
  const rawAllocations = [];
  for (const emp of employeeStateMap.values()) {
    for (const ord of emp.assigned_orders) {
      rawAllocations.push({
        order_code: ord.order_code,
        account: ord.account,
        status: ord.status,
        employee_id: emp.employee_id,
        employee_name: emp.employee_name,
        tracking_id: ord.tracking_id,
        work_state: ord.work_state || 'ASSIGNED',
        priority: ord.priority || 'REGULAR',
        round_number: ord.round_number || targetRound,
        is_preserved: ord.is_preserved || false,
        method,
        rule_note: `Round ${targetRound} Assignment`
      });
    }
  }
  for (const u of unassignedOrders) {
    rawAllocations.push({
      order_code: u.order_code,
      account: u.account,
      status: u.status,
      employee_id: null,
      employee_name: 'UNASSIGNED',
      tracking_id: u.tracking_id,
      work_state: 'UNASSIGNED',
      priority: u.priority || 'REGULAR',
      round_number: targetRound,
      is_preserved: false,
      method,
      rule_note: u.unassigned_reason || 'Unassigned'
    });
  }

  // 11. PERSISTENCE IN ATOMIC TRANSACTION
  const newVersionRow = db.prepare('SELECT MAX(version_number) as max_v FROM allocation_versions WHERE allocation_date = ?').get(workDate);
  const nextVersion = (newVersionRow?.max_v || 0) + 1;

  db.transaction(() => {
    // 1. Update current_work_orders
    const updateOrderStmt = db.prepare(`
      UPDATE current_work_orders
      SET work_state = ?,
          round_number = ?,
          assigned_employee_id = ?,
          assigned_employee_name = ?,
          tracking_id = COALESCE(?, tracking_id),
          updated_at = datetime('now')
      WHERE work_date = ? AND order_code = ?
    `);

    // 2. Insert new version rows in order_level_allocations
    const insertAllocStmt = db.prepare(`
      INSERT INTO order_level_allocations (
        allocation_date, allocation_version, order_code, account, status,
        employee_id, employee_name, tracking_id, work_state, priority, round_number, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    // Persist assignments
    for (const emp of employeeStateMap.values()) {
      let newlyAssignedCount = 0;
      for (const ord of emp.assigned_orders) {
        if (!ord.is_preserved) {
          newlyAssignedCount++;
          updateOrderStmt.run('ASSIGNED', targetRound, emp.employee_id, emp.employee_name, ord.tracking_id, workDate, ord.order_code);
          const wasReallocated = ord.previous_employee_id && ord.previous_employee_id !== emp.employee_id;
          recordOrderLifecycleEvent({
            tracking_id: ord.tracking_id,
            order_code: ord.order_code,
            work_date: workDate,
            stage: ord.status,
            work_state: 'ASSIGNED',
            employee_id: emp.employee_id,
            employee_name: emp.employee_name,
            previous_employee_id: ord.previous_employee_id || null,
            previous_employee_name: ord.previous_employee_name || null,
            action: wasReallocated ? 'REASSIGNED' : 'ASSIGNED',
            reason: wasReallocated
              ? `Reallocated from unowned assignment (${ord.previous_employee_name || ord.previous_employee_id}) in Round ${targetRound}`
              : `Assigned in Round ${targetRound}`
          });
        }
        insertAllocStmt.run(
          workDate, nextVersion, ord.order_code, ord.account, ord.status,
          emp.employee_id, emp.employee_name, ord.tracking_id, ord.work_state || 'ASSIGNED',
          ord.priority || 'REGULAR', ord.round_number || targetRound
        );
      }

      if (newlyAssignedCount > 0) {
        logEmployeeActivity({
          work_date: workDate,
          employee_id: emp.employee_id,
          employee_name: emp.employee_name,
          action: 'ASSIGNED',
          details: `Assigned ${newlyAssignedCount} orders in Round ${targetRound} (Stream: ${emp.round_stream_lock})`
        });
      }
    }

    // Persist unassigned orders
    for (const u of unassignedOrders) {
      updateOrderStmt.run('UNASSIGNED', targetRound, null, 'UNASSIGNED', u.tracking_id, workDate, u.order_code);
      insertAllocStmt.run(
        workDate, nextVersion, u.order_code, u.account, u.status,
        null, 'UNASSIGNED', u.tracking_id, 'UNASSIGNED',
        u.priority || 'REGULAR', targetRound
      );
      if (u.assigned_employee_id) {
        recordOrderLifecycleEvent({
          tracking_id: u.tracking_id,
          order_code: u.order_code,
          work_date: workDate,
          stage: u.status,
          work_state: 'UNASSIGNED',
          employee_id: null,
          employee_name: 'UNASSIGNED',
          previous_employee_id: u.assigned_employee_id,
          previous_employee_name: u.assigned_employee_name,
          action: 'UNASSIGNED',
          reason: `Unassigned during Round ${targetRound} reallocation (Unclaimed work reset)`
        });
      }
    }

    // 3. Invariant Check: Verify directly in DB that no employee has both NEW and PENDING in the same round
    const dbViolation = db.prepare(`
      SELECT assigned_employee_id, assigned_employee_name, round_number,
             SUM(CASE WHEN LOWER(status) LIKE '%pending%' OR source_type = 'PENDING' THEN 1 ELSE 0 END) as p_cnt,
             SUM(CASE WHEN LOWER(status) NOT LIKE '%pending%' AND source_type != 'PENDING' THEN 1 ELSE 0 END) as n_cnt
      FROM current_work_orders
      WHERE work_date = ? AND assigned_employee_id IS NOT NULL AND round_number = ?
      GROUP BY assigned_employee_id, round_number
      HAVING p_cnt > 0 AND n_cnt > 0
    `).get(workDate, targetRound);

    if (dbViolation) {
      throw new Error(`CRITICAL DATABASE INVARIANT BREACH: Employee ${dbViolation.assigned_employee_name} (${dbViolation.assigned_employee_id}) has ${dbViolation.n_cnt} NEW and ${dbViolation.p_cnt} PENDING in Round ${targetRound}!`);
    }

    // 4. Sync legacy allocation_headers, allocation_items, and account_owners
    const insertHeader = db.prepare(`
      INSERT INTO allocation_headers (allocation_date, notes, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(allocation_date) DO UPDATE SET
        notes = excluded.notes,
        updated_at = datetime('now')
    `);
    insertHeader.run(workDate, `v${nextVersion} Round ${targetRound} Allocation`);
    const headerRow = db.prepare('SELECT id FROM allocation_headers WHERE allocation_date = ?').get(workDate);
    const headerId = headerRow ? headerRow.id : 1;

    db.prepare('DELETE FROM allocation_items WHERE allocation_header_id = ?').run(headerId);
    const insertItem = db.prepare(`
      INSERT INTO allocation_items (allocation_header_id, employee_id, account, status, available_orders_at_assignment)
      VALUES (?, ?, ?, ?, ?)
    `);

    const summaryMap = new Map();
    for (const item of rawAllocations) {
      if (!item.employee_id) continue;
      const key = `${item.employee_id}|${item.account}|${item.status}`;
      if (!summaryMap.has(key)) {
        summaryMap.set(key, {
          employee_id: item.employee_id,
          account: item.account,
          status: item.status,
          count: 0
        });
      }
      summaryMap.get(key).count++;
    }

    for (const s of summaryMap.values()) {
      insertItem.run(headerId, s.employee_id, s.account, s.status, s.count);
    }

    const upsertOwner = db.prepare(`
      INSERT INTO account_owners (
        work_date, account, owner_employee_id, owner_employee_name,
        allocation_version, allocation_method, is_override, notes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(work_date, account) DO UPDATE SET
        owner_employee_id = excluded.owner_employee_id,
        owner_employee_name = excluded.owner_employee_name,
        allocation_version = excluded.allocation_version,
        allocation_method = excluded.allocation_method,
        notes = excluded.notes,
        updated_at = datetime('now')
    `);

    const accOwnerMap = new Map();
    for (const item of rawAllocations) {
      if (!accOwnerMap.has(item.account.toLowerCase())) {
        accOwnerMap.set(item.account.toLowerCase(), {
          account: item.account,
          employee_id: item.employee_id || null,
          employee_name: item.employee_name || 'UNASSIGNED',
          method: item.method || method
        });
      }
    }

    for (const own of accOwnerMap.values()) {
      upsertOwner.run(
        workDate,
        own.account,
        own.employee_id,
        own.employee_name,
        nextVersion,
        own.method,
        0,
        `Round ${targetRound} Allocation`
      );
    }

    // Save allocation version metadata
    db.prepare(`
      INSERT INTO allocation_versions (
        allocation_date, version_number, generated_at, generated_by, method, rule_summary,
        total_orders, assigned_orders, unassigned_orders, is_final
      ) VALUES (?, ?, datetime('now'), 'Supervisor', ?, ?, ?, ?, ?, 1)
    `).run(
      workDate, nextVersion, method,
      `Round ${targetRound} allocation. Preserved: ${preservedOrders.length}, Assigned: ${totalAssignedCount}, Unassigned: ${unassignedOrders.length}`,
      totalExpected, totalAssignedCount, unassignedOrders.length
    );
  })();

  // 12. Build Return Payload
  const byEmployee = Array.from(employeeStateMap.values()).map(e => {
    const accMap = new Map();
    for (const ord of e.assigned_orders) {
      const isPend = (ord.status || '').toLowerCase().includes('pending') || (ord.source_type === 'PENDING');
      const st = isPend ? 'Pending' : 'New';
      if (!accMap.has(ord.account)) {
        accMap.set(ord.account, {
          account: ord.account,
          status: st,
          total_orders: 0,
          new_orders: 0,
          pending_orders: 0,
          count: 0
        });
      }
      const a = accMap.get(ord.account);
      a.total_orders++;
      a.count++;
      if (isPend) a.pending_orders++;
      else a.new_orders++;
    }

    return {
      employee_id: e.employee_id,
      employee_name: e.employee_name,
      department: e.department,
      team_membership: e.team_membership,
      round_stream_lock: e.round_stream_lock,
      total_accounts: accMap.size,
      accounts_count: accMap.size,
      total_orders: e.assigned_orders.length,
      orders_count: e.assigned_orders.length,
      preserved_count: e.assigned_orders.filter(o => o.is_preserved).length,
      newly_assigned_count: e.assigned_orders.filter(o => !o.is_preserved).length,
      new_orders: e.assigned_orders.filter(o => !((o.status || '').toLowerCase().includes('pending') || o.source_type === 'PENDING')).length,
      pending_orders: e.assigned_orders.filter(o => ((o.status || '').toLowerCase().includes('pending') || o.source_type === 'PENDING')).length,
      accounts: Array.from(accMap.values()),
      orders: e.assigned_orders
    };
  }).filter(e => e.total_orders > 0 || e.team_membership);

  const accountOrdersSet = new Set(orders.map(o => o.account.toLowerCase()));
  const assignedAccountsSet = new Set(rawAllocations.filter(a => a.employee_id !== null).map(a => a.account.toLowerCase()));

  return {
    success: true,
    work_date: workDate,
    round_number: targetRound,
    version_number: nextVersion,
    method,
    is_reallocation: isReallocation,
    total_orders: totalExpected,
    assigned_orders: totalAssignedCount,
    unassigned_orders: unassignedOrders.length,
    preserved_orders: preservedOrders.length,
    preserved_orders_count: preservedOrders.length,
    new_unallocated_orders_count: eligibleOrders.length,
    total_accounts: accountOrdersSet.size,
    assigned_accounts: assignedAccountsSet.size,
    unassigned_accounts: accountOrdersSet.size - assignedAccountsSet.size,
    by_employee: byEmployee,
    account_owners: Array.from(accountOrdersSet).map(acc => {
      const match = rawAllocations.find(a => a.account.toLowerCase() === acc && a.employee_id !== null);
      return {
        account: match ? match.account : acc,
        employee_id: match ? match.employee_id : null,
        employee_name: match ? match.employee_name : 'UNASSIGNED'
      };
    }),
    raw_allocations: rawAllocations,
    unassigned_orders_list: unassignedOrders
  };
}

export function reallocateWorkOrders(workDate, options = {}) {
  return generateRoundBasedAllocation(workDate, {
    ...options,
    is_reallocation: true,
    preserve_worked: true,
    reallocate_unclaimed_only: true
  });
}
