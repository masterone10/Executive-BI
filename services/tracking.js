import XLSX from 'xlsx';
import { db } from '../db/index.js';
import { parseDailyLogBuffer, parseDate, matchEmployeeInMaster, normalizeEmployeeName, isCSName, isCsEmployee, isOperationallyActiveCsEmployee } from './parser.js';
import { computePerformanceFromRecords } from './performance.js';
import { extractCanonicalStatus } from './vendoor/actions.js';
import {
  getCairoBusinessDate,
  isTodayBusinessDate,
  isHistoricalBusinessDate,
  parseCairoTimestamp,
  formatCairoTime,
  formatIdleDuration
} from './time_utils.js';

/**
 * ============================================================
 * PHASE 1 & PHASE 6: DISCOVERY & SOURCE MAPPING LAYER
 * ============================================================
 * Inspects any Excel buffer (or workbook) and produces a strict,
 * auditable schema report without making unsafe assumptions.
 */
export function inspectExcelSchema(buffer, sourceHint = 'auto') {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetNames = workbook.SheetNames || [];
  if (sheetNames.length === 0) {
    throw new Error('الملف فارغ ولا يحتوي على أوراق عمل (Workbook contains no sheets)');
  }

  const selectedSheet = sheetNames[0];
  const worksheet = workbook.Sheets[selectedSheet];
  const rawMatrix = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

  if (!rawMatrix || rawMatrix.length === 0) {
    throw new Error('ورقة العمل المحددة فارغة (Selected sheet is empty)');
  }

  const rawHeaders = (rawMatrix[0] || []).map((h, idx) => ({
    index: idx,
    header_name: h !== undefined && h !== null ? String(h).trim() : `Column_${idx + 1}`,
  }));

  const dataRows = rawMatrix.slice(1);
  const totalRows = dataRows.length;

  // Detect merged cells
  const mergedCellsCount = worksheet['!merges'] ? worksheet['!merges'].length : 0;

  // Inspect column types & sample values (first 3 rows)
  const columnsReport = rawHeaders.map((col) => {
    let nonNullCount = 0;
    const sampleValues = [];
    const detectedTypes = new Set();

    for (let i = 0; i < dataRows.length; i++) {
      const val = dataRows[i][col.index];
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        nonNullCount++;
        if (sampleValues.length < 3) {
          sampleValues.push(val);
        }
        if (val instanceof Date) {
          detectedTypes.add('date');
        } else if (typeof val === 'number') {
          detectedTypes.add('number');
        } else if (typeof val === 'boolean') {
          detectedTypes.add('boolean');
        } else {
          detectedTypes.add('string');
        }
      }
    }

    return {
      index: col.index,
      raw_name: col.header_name,
      non_empty_count: nonNullCount,
      empty_count: totalRows - nonNullCount,
      detected_types: Array.from(detectedTypes),
      sample_values: sampleValues,
    };
  });

  // Discover Normalized Mapping Keys
  let orderCodeCol = null;
  let accountCol = null;
  let employeeCol = null;
  let actionCol = null;
  let statusCol = null;
  let timestampCol = null;

  for (const c of columnsReport) {
    const name = c.raw_name.toLowerCase();

    // Order Code
    if (!orderCodeCol && /كود\s*الطلب|كود|رقم\s*الطلب|رقم\s*الاوردر|order\s*code|order\s*id|code/i.test(name)) {
      orderCodeCol = { index: c.index, raw_name: c.raw_name, internal_field: 'orderCode' };
    }
    // Account / Merchant
    if (!accountCol && /اسم\s*التاجر|التاجر|اسم\s*العميل|العميل|الحساب|حساب|merchant|account|store|client/i.test(name)) {
      accountCol = { index: c.index, raw_name: c.raw_name, internal_field: 'account' };
    }
    // Employee
    if (!employeeCol && /الاسم|اسم\s*الموظف|employee|agent|name/i.test(name)) {
      employeeCol = { index: c.index, raw_name: c.raw_name, internal_field: 'employee' };
    }
    // Action
    if (!actionCol && /الاكشن|الحدث|action|event/i.test(name)) {
      actionCol = { index: c.index, raw_name: c.raw_name, internal_field: 'action' };
    }
    // Status
    if (!statusCol && /حالة\s*الطلب|حاله\s*الطلب|الحالة|حالة|status/i.test(name)) {
      statusCol = { index: c.index, raw_name: c.raw_name, internal_field: 'status' };
    }
    // Timestamp
    if (!timestampCol && /التاريخ|تاريخ|timestamp|datetime|date|time/i.test(name)) {
      timestampCol = { index: c.index, raw_name: c.raw_name, internal_field: 'timestamp' };
    }
  }

  // Fallbacks for Daily Log if exact headers weren't named
  if (sourceHint === 'daily_log' || (actionCol && employeeCol)) {
    if (!orderCodeCol && columnsReport[1]) orderCodeCol = { index: 1, raw_name: columnsReport[1].raw_name, internal_field: 'orderCode' };
    if (!employeeCol && columnsReport[2]) employeeCol = { index: 2, raw_name: columnsReport[2].raw_name, internal_field: 'employee' };
    if (!actionCol && columnsReport[3]) actionCol = { index: 3, raw_name: columnsReport[3].raw_name, internal_field: 'action' };
    if (!timestampCol && columnsReport[4]) timestampCol = { index: 4, raw_name: columnsReport[4].raw_name, internal_field: 'timestamp' };
  }

  // Fallbacks for Inventory (New / Pending Orders)
  if (sourceHint === 'inventory' || (!actionCol && !employeeCol)) {
    if (!orderCodeCol && columnsReport[0]) orderCodeCol = { index: 0, raw_name: columnsReport[0].raw_name, internal_field: 'orderCode' };
    if (!accountCol && columnsReport[1]) accountCol = { index: 1, raw_name: columnsReport[1].raw_name, internal_field: 'account' };
  }

  // Assign normalized_role to each column in columnsReport
  for (const col of columnsReport) {
    if (orderCodeCol && col.index === orderCodeCol.index) col.normalized_role = 'order_code';
    else if (accountCol && col.index === accountCol.index) col.normalized_role = 'account';
    else if (employeeCol && col.index === employeeCol.index) col.normalized_role = 'employee_name';
    else if (actionCol && col.index === actionCol.index) col.normalized_role = 'action';
    else if (statusCol && col.index === statusCol.index) col.normalized_role = 'status';
    else if (timestampCol && col.index === timestampCol.index) col.normalized_role = 'timestamp';
    else col.normalized_role = null;
  }

  // Compute Source Metrics & Validation (Phase 7)
  const uniqueOrders = new Set();
  let missingOrderCodes = 0;
  let missingAccounts = 0;
  let duplicateOrdersCount = 0;
  let emptyRowsCount = 0;

  for (const row of dataRows) {
    if (!row || row.length === 0) {
      emptyRowsCount++;
      continue;
    }
    const orderVal = orderCodeCol ? String(row[orderCodeCol.index] || '').trim() : '';
    const accountVal = accountCol ? String(row[accountCol.index] || '').trim() : '';

    if (!orderVal) {
      missingOrderCodes++;
    } else {
      if (uniqueOrders.has(orderVal)) {
        duplicateOrdersCount++;
      } else {
        uniqueOrders.add(orderVal);
      }
    }

    if (accountCol && !accountVal) {
      missingAccounts++;
    }
  }

  const canLinkSafely = Boolean(orderCodeCol && (!accountCol || missingAccounts < totalRows));
  let limitationNote = null;
  if (!orderCodeCol) {
    limitationNote = 'Tracking cannot safely be linked across sources using the current files: Missing reliable Order Code/Identifier column.';
  } else if (!accountCol && sourceHint === 'inventory') {
    limitationNote = 'Account/Merchant column could not be automatically determined. Manual column confirmation required.';
  }

  const missingRequiredKeys = [];
  if (!orderCodeCol) missingRequiredKeys.push('order_code');
  if (sourceHint === 'daily_log') {
    if (!employeeCol) missingRequiredKeys.push('employee_name');
    if (!actionCol && !statusCol) missingRequiredKeys.push('action');
  }

  return {
    workbook_name: workbook.Props?.Title || 'Workbook',
    sheet_names: sheetNames,
    worksheets: sheetNames,
    selected_sheet: selectedSheet,
    total_rows: totalRows,
    empty_rows: emptyRowsCount,
    merged_cells: mergedCellsCount,
    columns: columnsReport,
    is_valid: canLinkSafely && missingRequiredKeys.length === 0,
    missing_required_keys: missingRequiredKeys,
    mapping: {
      orderCode: orderCodeCol,
      account: accountCol,
      employee: employeeCol,
      action: actionCol,
      status: statusCol,
      timestamp: timestampCol,
    },
    validation: {
      total_rows: totalRows,
      valid_rows: totalRows - missingOrderCodes - emptyRowsCount,
      missing_order_codes: missingOrderCodes,
      missing_accounts: missingAccounts,
      unique_orders: uniqueOrders.size,
      duplicate_orders: duplicateOrdersCount,
      can_link_safely: canLinkSafely && missingRequiredKeys.length === 0,
      limitation_note: limitationNote,
    },
  };
}

/**
 * Save raw log records into SQLite raw_log_records table for fast tracking
 */
export function persistDailyLogRecords(workDate, sourceFileId, records) {
  let validFileId = null;
  if (sourceFileId) {
    const exists = db.prepare('SELECT id FROM uploaded_files WHERE id = ?').get(sourceFileId);
    if (exists) validFileId = sourceFileId;
  }

  const insert = db.prepare(`
    INSERT INTO raw_log_records (
      source_file_id, work_date, order_code, employee_name, action, status, event_datetime, is_cs, is_deduped, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const tx = db.transaction(() => {
    // Clear any prior records for this work_date to prevent duplication
    db.prepare('DELETE FROM raw_log_records WHERE work_date = ?').run(workDate);

    for (const r of records) {
      if (!r.order || !r.name) continue;
      const recordWorkDate = r.business_date || workDate;
      const formattedDt = r.cairo_datetime || (r.dt && !isNaN(r.dt) ? new Date(r.dt).toISOString().replace('T', ' ').substring(0, 19) : null);
      insert.run(
        validFileId,
        recordWorkDate,
        String(r.order).trim(),
        String(r.name).trim(),
        r.act || '',
        r.st || null,
        formattedDt,
        r.isCS ? 1 : 0,
        1
      );
    }
  });

  tx();
}

/**
 * ============================================================
 * PHASE 9: ORDER TRACKING & TIMELINE
 * ============================================================
 */
export function getOrderTracking(workDate, orderCode) {
  let cleanCode = String(orderCode || '').trim();

  // 1. Check opening inventory (by order_code or tracking_id)
  let orderRecord = db.prepare(`
    SELECT * FROM current_work_orders 
    WHERE work_date = ? AND (order_code = ? OR tracking_id = ?)
  `).get(workDate, cleanCode, cleanCode);

  if (!orderRecord) {
    const trkRow = db.prepare(`
      SELECT * FROM order_tracking WHERE work_date = ? AND (order_code = ? OR tracking_id = ?)
    `).get(workDate, cleanCode, cleanCode);
    if (trkRow) {
      cleanCode = trkRow.order_code;
    }
  } else {
    cleanCode = orderRecord.order_code;
  }

  let trackingId = orderRecord ? orderRecord.tracking_id : null;
  if (!trackingId) {
    const ev = db.prepare(`
      SELECT tracking_id FROM order_tracking_events 
      WHERE work_date = ? AND (order_code = ? OR tracking_id = ?) 
      LIMIT 1
    `).get(workDate, cleanCode, cleanCode);
    if (ev) trackingId = ev.tracking_id;
  }
  if (!trackingId) {
    const actRow = db.prepare(`
      SELECT tracking_code FROM employee_activity_log
      WHERE work_date = ? AND (order_code = ? OR tracking_code = ?)
      LIMIT 1
    `).get(workDate, cleanCode, cleanCode);
    if (actRow && actRow.tracking_code) trackingId = actRow.tracking_code;
  }
  if (!trackingId) {
    const ot = db.prepare('SELECT tracking_id FROM order_tracking WHERE work_date = ? AND order_code = ?').get(workDate, cleanCode);
    if (ot && ot.tracking_id) trackingId = ot.tracking_id;
  }

  let account = orderRecord ? orderRecord.account : 'Unmatched / Unknown Account';
  let openingStatus = orderRecord ? orderRecord.status : 'Not Found in Opening Inventory';
  let isConflict = orderRecord ? (orderRecord.status === 'Opening Status Conflict' ? 1 : 0) : 0;
  let sourceSlot = orderRecord ? orderRecord.source_file_slot : null;
  let workState = orderRecord ? (orderRecord.work_state || 'UNASSIGNED') : 'UNASSIGNED';
  let priority = orderRecord ? (orderRecord.priority || 'REGULAR') : 'REGULAR';

  // 2. Fetch assigned employees for this order & account
  const assignedEmployees = [];
  let assignedTo = null;

  const orderAllocRow = db.prepare(`
    SELECT employee_name, work_state, priority, tracking_id FROM order_level_allocations
    WHERE allocation_date = ? AND order_code = ?
    ORDER BY allocation_version DESC LIMIT 1
  `).get(workDate, cleanCode);

  if (orderAllocRow && orderAllocRow.employee_name && orderAllocRow.employee_name !== 'UNASSIGNED') {
    assignedEmployees.push(orderAllocRow.employee_name);
    assignedTo = orderAllocRow.employee_name;
    if (orderAllocRow.work_state) workState = orderAllocRow.work_state;
    if (orderAllocRow.priority) priority = orderAllocRow.priority;
    if (!trackingId && orderAllocRow.tracking_id) trackingId = orderAllocRow.tracking_id;
  }

  const ownerRow = db.prepare(`
    SELECT owner_employee_name FROM account_owners
    WHERE work_date = ? AND LOWER(account) = LOWER(?)
  `).get(workDate, account);

  if (ownerRow && ownerRow.owner_employee_name && ownerRow.owner_employee_name !== 'UNASSIGNED') {
    if (!assignedEmployees.includes(ownerRow.owner_employee_name)) {
      assignedEmployees.push(ownerRow.owner_employee_name);
    }
    if (!assignedTo) {
      assignedTo = ownerRow.owner_employee_name;
    }
  }

  const assignedRows = db.prepare(`
    SELECT e.id as employee_id, e.name as employee_name, ai.status as assigned_status
    FROM allocation_items ai
    JOIN allocation_headers ah ON ai.allocation_header_id = ah.id
    JOIN employees e ON ai.employee_id = e.id
    WHERE ah.allocation_date = ? AND ai.account = ?
  `).all(workDate, account);

  for (const r of assignedRows) {
    if (!assignedEmployees.includes(r.employee_name)) {
      assignedEmployees.push(r.employee_name);
    }
  }
  if (!assignedTo && assignedEmployees.length > 0) {
    assignedTo = assignedEmployees.join(', ');
  }

  // 3. Fetch all Daily Log actions for this order on workDate
  const logRows = db.prepare(`
    SELECT id, employee_name, action, status, event_datetime, is_cs
    FROM raw_log_records
    WHERE work_date = ? AND order_code = ?
    ORDER BY event_datetime ASC, id ASC
  `).all(workDate, cleanCode);

  // 4. Deduplicate actions using 120s window
  const deduplicatedActions = [];
  const dedupMap = new Map();

  for (const row of logRows) {
    const dt = row.event_datetime ? new Date(row.event_datetime).getTime() : 0;
    const key = `${row.employee_name}|${row.status || row.action}`;
    const lastTime = dedupMap.get(key) || 0;

    if (dt - lastTime >= 120000 || lastTime === 0) {
      dedupMap.set(key, dt);
      deduplicatedActions.push(row);
    }
  }

  // 5. Fetch lifecycle events and handoffs from order_tracking_events
  const trackingEvents = db.prepare(`
    SELECT stage, work_state, employee_name, previous_employee_name, action, timestamp, reason, source, details
    FROM order_tracking_events
    WHERE work_date = ? AND (order_code = ? OR (tracking_id IS NOT NULL AND tracking_id = ?))
    ORDER BY timestamp ASC, id ASC
  `).all(workDate, cleanCode, trackingId || '');

  // 6. Build Chronological Timeline (Phase 9 & 18 & Part 2)
  const timeline = [];

  // Opening event
  timeline.push({
    step_number: 1,
    type: 'OPENING',
    timestamp: `${workDate} 08:00:00 (Start of Day)`,
    status: openingStatus,
    employee: 'Opening Inventory Pool',
    action_text: isConflict
      ? '⚠️ Opening Status Conflict: Exists in both New Orders and Pending Orders'
      : `Received as opening ${openingStatus} inventory (${sourceSlot === 1 ? 'New Orders' : sourceSlot === 2 ? 'Pending Orders' : 'Slot ' + sourceSlot})`,
    source: sourceSlot === 1 ? 'New Orders File' : sourceSlot === 2 ? 'Pending Orders File' : 'Inventory',
  });

  // Action events from daily log
  const actualEmployeesSet = new Set();
  let lastLoggedStatus = null;
  let firstAction = null;
  let lastAction = null;

  deduplicatedActions.forEach((act, idx) => {
    if (act.is_cs === 1 || (act.is_cs === undefined && isCsEmployee(act.employee_name, null, { strictMaster: true }))) {
      if (isCsEmployee(act.employee_name, null, { strictMaster: true })) {
        actualEmployeesSet.add(act.employee_name);
      }
    }
    if (!firstAction) firstAction = act.event_datetime;
    lastAction = act.event_datetime;
    if (act.status) lastLoggedStatus = act.status;

    timeline.push({
      step_number: timeline.length + 1,
      type: 'ACTION',
      timestamp: act.event_datetime,
      status: act.status || 'Action Recorded',
      employee: act.employee_name,
      action_text: act.action,
      source: 'End-of-Day Daily Log',
    });
  });

  // Tracking events from lifecycle transitions and internal handoffs
  trackingEvents.forEach((ev) => {
    if (ev.employee_name && ev.employee_name !== 'UNASSIGNED' && isCsEmployee(ev.employee_name, null, { strictMaster: true })) {
      actualEmployeesSet.add(ev.employee_name);
    }
    if (!firstAction) firstAction = ev.timestamp;
    lastAction = ev.timestamp;
    if (ev.stage) lastLoggedStatus = ev.stage;
    if (ev.work_state) workState = ev.work_state;

    timeline.push({
      step_number: timeline.length + 1,
      type: ev.action === 'HANDOFF' ? 'HANDOFF' : 'LIFECYCLE',
      timestamp: ev.timestamp,
      status: ev.stage || ev.work_state || 'Updated',
      employee: ev.employee_name || 'System',
      previous_employee: ev.previous_employee_name || null,
      action_text: ev.action === 'HANDOFF'
        ? `Internal Handoff: ${ev.previous_employee_name || 'Previous Agent'} -> ${ev.employee_name || 'New Agent'} [${ev.stage}]`
        : `${ev.action || 'Updated'} (${ev.stage || ev.work_state})`,
      reason: ev.reason || null,
      source: ev.source || 'Operational Workflow',
    });
  });

  const actualEmployees = Array.from(actualEmployeesSet);
  const ordersWorked = deduplicatedActions.length > 0 || trackingEvents.some(e => ['CLAIMED', 'IN_PROGRESS', 'COMPLETED'].includes((e.action || '').toUpperCase()));
  const currentFinalStatus = lastLoggedStatus || openingStatus;

  // Determine alignment
  let isAssignedWork = false;
  if (actualEmployees.length > 0) {
    isAssignedWork = actualEmployees.some(emp => assignedEmployees.includes(emp));
  }

  return {
    order_code: cleanCode,
    tracking_id: trackingId,
    work_date: workDate,
    account,
    opening_status: openingStatus,
    work_state: workState,
    priority: priority,
    is_opening_conflict: isConflict,
    source_file_slot: sourceSlot,
    assigned_to: assignedTo,
    assigned_employees: assignedEmployees,
    actual_employees: actualEmployees,
    orders_worked_today: ordersWorked ? 1 : 0,
    real_actions_count: deduplicatedActions.length + trackingEvents.length,
    first_action: firstAction,
    last_action: lastAction,
    last_logged_status: lastLoggedStatus,
    current_final_status: currentFinalStatus,
    current_status: currentFinalStatus,
    is_assigned_work: isAssignedWork,
    is_worked_outside_allocation: ordersWorked && !isAssignedWork,
    timeline,
  };
}

/**
 * ============================================================
 * HELPER: CHECK IF DAILY LOG IS UPLOADED FOR WORK DATE
 * ============================================================
 */
export function isDailyLogUploaded(workDate) {
  const hasRaw = db.prepare('SELECT 1 FROM raw_log_records WHERE work_date = ? LIMIT 1').get(workDate);
  if (hasRaw) return true;
  const hasSnap = db.prepare('SELECT 1 FROM daily_metrics_snapshots WHERE work_date = ? LIMIT 1').get(workDate);
  if (hasSnap) return true;
  const hasPerf = db.prepare('SELECT 1 FROM performance_snapshots WHERE date = ? LIMIT 1').get(workDate);
  if (hasPerf) return true;
  const hasVendoorLog = db.prepare('SELECT 1 FROM vendoor_logs WHERE work_date = ? LIMIT 1').get(workDate)
    || db.prepare("SELECT 1 FROM vendoor_sync_runs WHERE resource = 'logs' AND status = 'SUCCESS' AND (start_date = ? OR DATE(created_at) = ?) LIMIT 1").get(workDate, workDate);
  if (hasVendoorLog) return true;
  return false;
}

/**
 * ============================================================
 * HELPER: GET SOURCES UPLOAD INTEGRITY STATUS
 * ============================================================
 */
export function getSourcesUploadStatus(workDate) {
  const file1 = db.prepare('SELECT 1 FROM specific_orders_uploads WHERE work_date = ? AND file_slot = 1 LIMIT 1').get(workDate)
    || db.prepare("SELECT 1 FROM current_work_orders WHERE work_date = ? AND (source_file_slot = 1 OR LOWER(status) LIKE '%new%') LIMIT 1").get(workDate)
    || db.prepare("SELECT 1 FROM vendoor_orders WHERE source_date = ? AND (LOWER(status) LIKE '%new%' OR LOWER(status) LIKE '%جديد%') LIMIT 1").get(workDate);
  const file2 = db.prepare('SELECT 1 FROM specific_orders_uploads WHERE work_date = ? AND file_slot = 2 LIMIT 1').get(workDate)
    || db.prepare("SELECT 1 FROM current_work_orders WHERE work_date = ? AND (source_file_slot = 2 OR LOWER(status) LIKE '%pending%') LIMIT 1").get(workDate)
    || db.prepare("SELECT 1 FROM vendoor_orders WHERE source_date = ? AND (LOWER(status) LIKE '%pending%' OR LOWER(status) LIKE '%معلق%') LIMIT 1").get(workDate);
  const openingInv = db.prepare('SELECT 1 FROM current_work_orders WHERE work_date = ? LIMIT 1').get(workDate)
    || db.prepare('SELECT 1 FROM vendoor_orders WHERE source_date = ? LIMIT 1').get(workDate);
  const logUploaded = isDailyLogUploaded(workDate);

  return {
    work_date: workDate,
    new_orders_uploaded: !!file1,
    pending_orders_uploaded: !!file2,
    opening_inventory_available: !!openingInv,
    daily_log_uploaded: !!logUploaded,
  };
}

/**
 * ============================================================
 * PHASE 10 & 11: EMPLOYEE TRACKING (ASSIGNED VS ACTUAL REALITY)
 * ============================================================
 */
export function getEmployeeTracking(workDate, employeeIdOrName) {
  // Authoritative employee lookup
  let emp = null;
  let suppliedId = null;
  let suppliedName = null;

  if (typeof employeeIdOrName === 'object' && employeeIdOrName !== null) {
    if (employeeIdOrName.employee_id !== undefined && employeeIdOrName.employee_id !== null && employeeIdOrName.employee_id !== '') {
      suppliedId = employeeIdOrName.employee_id;
    } else if (employeeIdOrName.id !== undefined && employeeIdOrName.id !== null && employeeIdOrName.id !== '') {
      suppliedId = employeeIdOrName.id;
    }
    suppliedName = employeeIdOrName.name || employeeIdOrName.employee_name || null;
  } else if (typeof employeeIdOrName === 'number') {
    suppliedId = employeeIdOrName;
  } else if (typeof employeeIdOrName === 'string') {
    const trimmed = employeeIdOrName.trim();
    if (/^\d+$/.test(trimmed)) {
      suppliedId = parseInt(trimmed, 10);
    } else {
      suppliedName = trimmed;
    }
  }

  // If employee_id was supplied: resolve ONLY by employee_id. Never fall back to matching by name!
  if (suppliedId !== null) {
    emp = db.prepare('SELECT id, name, department, active, status FROM employees WHERE id = ?').get(suppliedId);
    if (!emp) {
      return null;
    }
  } else if (suppliedName) {
    emp = db.prepare('SELECT id, name, department, active, status FROM employees WHERE name = ? COLLATE NOCASE').get(suppliedName);
    if (!emp) {
      return null;
    }
  } else {
    return null;
  }

  // Non-CS employees cannot be operational CS workers
  if (!isCsEmployee(emp)) {
    return null;
  }

  const empName = emp.name;
  const empId = emp.id;

  // 1. Check if Daily Log was uploaded for workDate
  const dailyLogUploaded = isDailyLogUploaded(workDate);

  // 2. Fetch Assigned Accounts from account_owners, order_level_allocations, or legacy allocation_items
  let assignedAccounts = [];
  if (empId) {
    const ownerRows = db.prepare(`
      SELECT account FROM account_owners
      WHERE work_date = ? AND owner_employee_id = ?
    `).all(workDate, empId);

    if (ownerRows.length > 0) {
      assignedAccounts = ownerRows.map(r => r.account);
    } else {
      const orderRows = db.prepare(`
        SELECT DISTINCT account FROM order_level_allocations
        WHERE allocation_date = ? AND employee_id = ?
      `).all(workDate, empId);

      if (orderRows.length > 0) {
        assignedAccounts = orderRows.map(r => r.account);
      } else {
        const allocRows = db.prepare(`
          SELECT ai.account, ai.status, ai.available_orders_at_assignment
          FROM allocation_items ai
          JOIN allocation_headers ah ON ai.allocation_header_id = ah.id
          WHERE ah.allocation_date = ? AND ai.employee_id = ?
        `).all(workDate, empId);
        assignedAccounts = allocRows.map(r => r.account);
      }
    }
  }

  const assignedSet = new Set(assignedAccounts.map(a => a.toLowerCase()));

  // 3. Fetch all opening work orders for quick account lookup
  const openingOrders = db.prepare('SELECT order_code, account, status FROM current_work_orders WHERE work_date = ?').all(workDate);
  const orderAccountMap = new Map();
  for (const o of openingOrders) {
    orderAccountMap.set(o.order_code, o.account);
  }

  // 4. Fetch all Daily Log actions for this employee with EXACT matching
  const rawActions = db.prepare(`
    SELECT id, order_code, action, status, event_datetime, is_cs
    FROM raw_log_records
    WHERE work_date = ? AND LOWER(TRIM(employee_name)) = LOWER(TRIM(?))
    ORDER BY event_datetime ASC, id ASC
  `).all(workDate, empName);

  // Derive Last Activity and Last Productive Activity from all raw actions
  let lastActivityTime = null;
  let lastProductiveActivityTime = null;
  let lastAction = null;
  let lastProductiveAction = null;
  let lastOrderCode = null;
  let lastAccount = null;

  for (const act of rawActions) {
    const actStr = String(act.action || '');
    const upperAct = actStr.toUpperCase();
    const isProd = PRODUCTIVE_ACTIONS.has(upperAct) ||
      upperAct.includes('PRINT') || upperAct.includes('PROCESS') || upperAct.includes('CANCEL') ||
      upperAct.includes('PEND') || upperAct.includes('STAGE_CHANGE') || upperAct.includes('CLAIM') ||
      actStr.includes('عدل') || actStr.includes('أضاف') || actStr.includes('تغيير') ||
      actStr.includes('طباعة') || actStr.includes('تحويل') || actStr.includes('حذف');

    if (act.event_datetime) {
      lastActivityTime = act.event_datetime;
      lastAction = act.action;
      lastOrderCode = act.order_code;
      lastAccount = orderAccountMap.get(act.order_code) || 'Unmatched Account';

      if (isProd) {
        lastProductiveActivityTime = act.event_datetime;
        lastProductiveAction = act.action;
      }
    }
  }

  // 5. Deduplicate actions using 120s window for real actions count
  const deduplicatedActions = [];
  const dedupMap = new Map();

  for (const act of rawActions) {
    const dt = act.event_datetime ? new Date(act.event_datetime).getTime() : 0;
    const key = `${act.order_code}|${act.status || act.action}`;
    const lastTime = dedupMap.get(key) || 0;

    if (dt - lastTime >= 120000 || lastTime === 0) {
      dedupMap.set(key, dt);
      deduplicatedActions.push(act);
    }
  }

  // 6. Compute Orders Worked Today (Unique Order Codes touched)
  const uniqueOrdersWorkedSet = new Set();
  const accountStatsMap = new Map();
  let printedCount = 0;
  let pendingCount = 0;
  let cancelledCount = 0;
  let processingCount = 0;
  let altCount = 0;
  let addedCount = 0;

  let outsideAllocationActions = 0;
  const outsideAllocationOrdersSet = new Set();

  for (const act of deduplicatedActions) {
    uniqueOrdersWorkedSet.add(act.order_code);
    const orderAccount = orderAccountMap.get(act.order_code) || 'Unmatched Account';
    const isAssigned = assignedSet.has(orderAccount.toLowerCase());

    if (!isAssigned) {
      outsideAllocationActions++;
      outsideAllocationOrdersSet.add(act.order_code);
    }

    if (!accountStatsMap.has(orderAccount)) {
      accountStatsMap.set(orderAccount, {
        account: orderAccount,
        is_assigned: isAssigned,
        unique_orders: new Set(),
        real_actions: 0,
        first_action: act.event_datetime,
        last_action: act.event_datetime,
        latest_status: act.status || 'Action',
        orders: [],
      });
    }

    const accStat = accountStatsMap.get(orderAccount);
    accStat.unique_orders.add(act.order_code);
    accStat.real_actions++;
    accStat.last_action = act.event_datetime;
    if (act.status) accStat.latest_status = act.status;

    accStat.orders.push({
      order_code: act.order_code,
      action: act.action,
      status: act.status,
      timestamp: act.event_datetime,
    });

    if (act.status === 'Printed') printedCount++;
    if (act.status === 'Pending') pendingCount++;
    if (act.status === 'Cancelled') cancelledCount++;
    if (act.status === 'Processing') processingCount++;
    if (/هاتف\s*آخر|تليفون\s*بديل|alt/i.test(act.action)) altCount++;
    if (/أضاف\s*اوردر|added/i.test(act.action)) addedCount++;
  }

  const actuallyWorkedAccounts = Array.from(accountStatsMap.keys());
  const extraUnassignedAccounts = actuallyWorkedAccounts.filter(a => !assignedSet.has(a.toLowerCase()));
  const assignedAccountsNotWorked = assignedAccounts.filter(a => !actuallyWorkedAccounts.some(wa => wa.toLowerCase() === a.toLowerCase()));

  // Build Account Detail breakdown (Phase 14 & 15)
  const accountBreakdown = [];
  for (const [accName, stat] of accountStatsMap.entries()) {
    accountBreakdown.push({
      account: accName,
      is_assigned: stat.is_assigned,
      unique_orders_worked: stat.unique_orders.size,
      real_actions: stat.real_actions,
      first_action: stat.first_action,
      last_action: stat.last_action,
      latest_status: stat.latest_status,
      orders_sample: Array.from(stat.unique_orders).slice(0, 20),
    });
  }

  // Also include assigned accounts with 0 work
  for (const notWorked of assignedAccountsNotWorked) {
    accountBreakdown.push({
      account: notWorked,
      is_assigned: true,
      unique_orders_worked: 0,
      real_actions: 0,
      first_action: null,
      last_action: null,
      latest_status: 'No Activity',
      orders_sample: [],
    });
  }

  // Calculate truth-telling metrics based on Daily Log upload state and actual activity
  let ordersWorkedToday = null;
  let realActions = null;
  let ordersOutsideAllocation = null;
  let actionsCompliancePct = null;
  let statusMessage = 'End-of-Day Log Not Uploaded';

  if (dailyLogUploaded) {
    if (deduplicatedActions.length === 0) {
      // STATE B: Log Uploaded — No Activity Recorded
      ordersWorkedToday = 0;
      realActions = 0;
      ordersOutsideAllocation = 0;
      actionsCompliancePct = null; // Zero activity must NOT be presented as 100% compliance!
      statusMessage = 'Log Uploaded — No Activity Recorded';
    } else {
      // STATE C: Log Uploaded & Employee Has Activity
      const employeeStatusActions = printedCount + pendingCount + cancelledCount + processingCount;
      ordersWorkedToday = uniqueOrdersWorkedSet.size;
      realActions = employeeStatusActions;
      ordersOutsideAllocation = outsideAllocationOrdersSet.size;
      actionsCompliancePct = deduplicatedActions.length > 0 ? Math.round(((deduplicatedActions.length - outsideAllocationActions) / deduplicatedActions.length) * 1000) / 10 : null;
      statusMessage = 'Active';
    }
  } else {
    // STATE A: End-of-Day Log Not Uploaded
    ordersWorkedToday = null;
    realActions = null;
    ordersOutsideAllocation = null;
    actionsCompliancePct = null;
    statusMessage = 'End-of-Day Log Not Uploaded';
  }

  // Live status and idle calculation
  const isHistorical = isHistoricalBusinessDate(workDate);
  let liveStatus = 'NO_ACTIVITY';
  let idleSeconds = null;
  let idleDurationFormatted = '—';

  if (isHistorical) {
    liveStatus = 'HISTORICAL';
    idleSeconds = null;
    idleDurationFormatted = '—';
  } else if (dailyLogUploaded) {
    if (uniqueOrdersWorkedSet.size === 0 && (!deduplicatedActions || deduplicatedActions.length === 0)) {
      liveStatus = 'NO_ACTIVITY';
    } else if (!lastProductiveActivityTime) {
      liveStatus = 'INACTIVE';
    } else {
      const prodDt = parseCairoTimestamp(lastProductiveActivityTime) || new Date(lastProductiveActivityTime);
      const prodMs = prodDt.getTime();
      if (!isNaN(prodMs)) {
        idleSeconds = Math.max(0, Math.floor((Date.now() - prodMs) / 1000));
        idleDurationFormatted = formatIdleDuration(idleSeconds);
        if (idleSeconds <= 15 * 60) {
          liveStatus = 'ACTIVE';
        } else if (idleSeconds <= 45 * 60) {
          liveStatus = 'INACTIVE';
        } else {
          liveStatus = 'CRITICAL';
        }
      }
    }
  }

  return {
    employee_id: empId,
    employee_name: empName,
    work_date: workDate,
    daily_log_uploaded: dailyLogUploaded,
    status_message: statusMessage,
    assigned_accounts: assignedAccounts,
    actually_worked_accounts: actuallyWorkedAccounts,
    extra_unassigned_accounts: extraUnassignedAccounts,
    extra_accounts_worked: extraUnassignedAccounts,
    assigned_accounts_not_worked: assignedAccountsNotWorked,
    orders_worked_today: ordersWorkedToday, // Null if no log, unique orders touched if log uploaded
    orders_worked_outside_allocation: ordersOutsideAllocation,
    real_actions: realActions,              // Null if no log, total deduplicated actions if log uploaded
    allocation_compliance: actionsCompliancePct, // Null (N/A) if no activity or no log
    allocation_compliance_label: actionsCompliancePct !== null ? `${actionsCompliancePct}%` : 'N/A',
    compliance_label: actionsCompliancePct !== null ? `${actionsCompliancePct}%` : 'N/A',
    printed_orders: dailyLogUploaded ? printedCount : null,
    pending_orders: dailyLogUploaded ? pendingCount : null,
    cancelled_orders: dailyLogUploaded ? cancelledCount : null,
    processing_orders: dailyLogUploaded ? processingCount : null,
    alt_phones: dailyLogUploaded ? altCount : null,
    added_orders: dailyLogUploaded ? addedCount : null,
    last_activity_time: lastActivityTime,
    last_productive_activity_time: lastProductiveActivityTime,
    last_activity_action: lastAction,
    last_productive_action: lastProductiveAction,
    last_activity_order_code: lastOrderCode,
    last_activity_account: lastAccount,
    idle_seconds: idleSeconds,
    idle_duration_formatted: idleDurationFormatted,
    live_status: liveStatus,
    outside_allocation: {
      has_unassigned_activity: extraUnassignedAccounts.length > 0,
      extra_accounts_count: extraUnassignedAccounts.length,
      orders_worked_outside: ordersOutsideAllocation,
      real_actions_outside: dailyLogUploaded ? outsideAllocationActions : null,
      actions_compliance_pct: actionsCompliancePct,
    },
    account_breakdown: accountBreakdown,
  };
}

/**
 * ============================================================
 * PHASE 12: DAILY EMPLOYEE & TEAM-LEVEL TRACKING SUMMARY
 * ============================================================
 */
export function getTeamTrackingSummary(workDate) {
  const dailyLogUploaded = isDailyLogUploaded(workDate);
  const sources = getSourcesUploadStatus(workDate);

  // 1. Gather all candidates:
  // - daily_working_team where work_date = ? and is_working = 1
  // - allocation_items for workDate
  // - raw_log_records for workDate
  // - active employees in department 'CS'
  const workingTeamRows = db.prepare(`
    SELECT e.id, e.name, e.department
    FROM daily_working_team dwt
    JOIN employees e ON dwt.employee_id = e.id
    WHERE dwt.work_date = ? AND dwt.is_working = 1
  `).all(workDate);

  const allocEmpRows = db.prepare(`
    SELECT DISTINCT e.id, e.name, e.department
    FROM allocation_items ai
    JOIN allocation_headers ah ON ai.allocation_header_id = ah.id
    JOIN employees e ON ai.employee_id = e.id
    WHERE ah.allocation_date = ?
  `).all(workDate);

  const logEmpRows = db.prepare(`
    SELECT DISTINCT employee_name as name
    FROM raw_log_records
    WHERE work_date = ?
  `).all(workDate);

  const activeCSEmps = db.prepare(`
    SELECT id, name, department
    FROM employees
    WHERE (active = 1 OR status = 'ACTIVE')
      AND UPPER(TRIM(department)) IN ('CS', 'CUSTOMER SERVICE')
    ORDER BY name ASC
  `).all();

  // Combine into a strictly authoritative CS employee set
  const empMap = new Map();
  for (const e of activeCSEmps) {
    empMap.set(e.name, { id: e.id, name: e.name, department: 'CS' });
  }
  for (const e of workingTeamRows) {
    if (isCsEmployee(e)) {
      empMap.set(e.name, { id: e.id, name: e.name, department: 'CS' });
    }
  }
  for (const e of allocEmpRows) {
    if (isCsEmployee(e)) {
      empMap.set(e.name, { id: e.id, name: e.name, department: 'CS' });
    }
  }
  for (const l of logEmpRows) {
    if (!empMap.has(l.name)) {
      const found = db.prepare('SELECT id, name, department, status, active FROM employees WHERE name = ? COLLATE NOCASE').get(l.name);
      if (found && isCsEmployee(found)) {
        empMap.set(found.name, {
          id: found.id,
          name: found.name,
          department: 'CS',
        });
      }
    }
  }

  const employeesList = [];
  let employeesWithActivity = 0;
  let employeesWithoutActivity = 0;
  let employeesWithOutsideActivity = 0;
  let totalRealActionsAcrossTeam = 0;
  const uniqueAccountsWorkedAcrossTeam = new Set();
  const outsideAllocationAccountsSet = new Set();
  let totalOutsideActionsAcrossTeam = 0;
  let totalOutsideOrdersAcrossTeam = 0;

  for (const [name, info] of empMap.entries()) {
    const tracking = getEmployeeTracking(workDate, info.id || name);
    employeesList.push({
      employee_id: tracking.employee_id,
      employee_name: tracking.employee_name,
      department: info.department || 'CS',
      working_today: workingTeamRows.some(w => w.name === name || w.id === info.id),
      live_status: tracking.live_status,
      idle_seconds: tracking.idle_seconds,
      idle_duration_formatted: tracking.idle_duration_formatted,
      last_activity_time: tracking.last_activity_time,
      last_productive_activity_time: tracking.last_productive_activity_time,
      last_activity_action: tracking.last_activity_action,
      last_productive_action: tracking.last_productive_action,
      last_activity_order_code: tracking.last_activity_order_code,
      last_activity_account: tracking.last_activity_account,
      assigned_accounts_count: tracking.assigned_accounts.length,
      assigned_accounts: tracking.assigned_accounts,
      worked_accounts_count: tracking.actually_worked_accounts.length,
      worked_accounts: tracking.actually_worked_accounts,
      extra_accounts_count: tracking.extra_unassigned_accounts.length,
      extra_accounts: tracking.extra_unassigned_accounts,
      assigned_accounts_not_worked: tracking.assigned_accounts_not_worked,
      orders_worked_today: tracking.orders_worked_today,
      real_actions: tracking.real_actions,
      printed: tracking.printed_orders,
      pending: tracking.pending_orders,
      cancelled: tracking.cancelled_orders,
      processing: tracking.processing_orders,
      alt_phones: tracking.alt_phones,
      allocation_compliance: tracking.allocation_compliance,
      allocation_compliance_label: tracking.allocation_compliance_label,
      status_message: tracking.status_message,
      has_outside_activity: tracking.outside_allocation.has_unassigned_activity,
      orders_worked_outside: tracking.orders_worked_outside_allocation,
      real_actions_outside: tracking.outside_allocation.real_actions_outside,
    });

    if (dailyLogUploaded) {
      if (tracking.real_actions && tracking.real_actions > 0) {
        employeesWithActivity++;
        totalRealActionsAcrossTeam += tracking.real_actions;
      } else {
        employeesWithoutActivity++;
      }

      if (tracking.outside_allocation.has_unassigned_activity) {
        employeesWithOutsideActivity++;
        totalOutsideActionsAcrossTeam += (tracking.outside_allocation.real_actions_outside || 0);
        totalOutsideOrdersAcrossTeam += (tracking.orders_worked_outside_allocation || 0);
        for (const acc of tracking.extra_unassigned_accounts) {
          outsideAllocationAccountsSet.add(acc);
        }
      }

      for (const acc of tracking.actually_worked_accounts) {
        uniqueAccountsWorkedAcrossTeam.add(acc);
      }
    } else {
      employeesWithoutActivity++;
    }
  }

  // Get total unique orders worked across team
  const rawOrdersCount = dailyLogUploaded
    ? db.prepare('SELECT COUNT(DISTINCT order_code) as c FROM raw_log_records WHERE work_date = ?').get(workDate).c
    : null;

  // Sort employees: Active with highest orders worked first, then zero-activity by name
  employeesList.sort((a, b) => {
    const aOrders = a.orders_worked_today ?? -1;
    const bOrders = b.orders_worked_today ?? -1;
    if (bOrders !== aOrders) return bOrders - aOrders;
    return a.employee_name.localeCompare(b.employee_name);
  });

  return {
    work_date: workDate,
    daily_log_uploaded: dailyLogUploaded,
    sources,
    team_kpis: {
      total_employees: employeesList.length,
      employees_with_activity: dailyLogUploaded ? employeesWithActivity : null,
      employees_without_activity: dailyLogUploaded ? employeesWithoutActivity : null,
      employees_with_outside_activity: dailyLogUploaded ? employeesWithOutsideActivity : null,
      total_orders_worked_today: dailyLogUploaded ? rawOrdersCount : null,
      total_real_actions: dailyLogUploaded ? totalRealActionsAcrossTeam : null,
      accounts_worked: dailyLogUploaded ? uniqueAccountsWorkedAcrossTeam.size : null,
      outside_allocation_accounts: dailyLogUploaded ? outsideAllocationAccountsSet.size : null,
      outside_orders_count: dailyLogUploaded ? totalOutsideOrdersAcrossTeam : null,
      unassigned_activity_count: dailyLogUploaded ? totalOutsideActionsAcrossTeam : null,
    },
    employees: employeesList,
  };
}

/**
 * ============================================================
 * PHASE 14 & 15: ACCOUNT TRACKING & ORDER-LEVEL DETAIL
 * ============================================================
 */
export function getAccountTracking(workDate, accountName) {
  const cleanAcc = String(accountName || '').trim();

  // 1. Opening inventory orders
  const openingRows = db.prepare(`
    SELECT order_code, status, source_file_slot, order_date
    FROM current_work_orders
    WHERE work_date = ? AND account = ?
  `).all(workDate, cleanAcc);

  const openingTotal = openingRows.length;
  let openingNew = 0;
  let openingPending = 0;
  let openingConflict = 0;
  const orderOpeningMap = new Map();

  for (const r of openingRows) {
    orderOpeningMap.set(r.order_code, r);
    if (r.status === 'New') openingNew++;
    else if (r.status === 'Pending') openingPending++;
    else if (r.status === 'Opening Status Conflict') openingConflict++;
  }

  // 2. Assigned employees from manual allocation
  const assignedRows = db.prepare(`
    SELECT e.id, e.name, ai.status
    FROM allocation_items ai
    JOIN allocation_headers ah ON ai.allocation_header_id = ah.id
    JOIN employees e ON ai.employee_id = e.id
    WHERE ah.allocation_date = ? AND ai.account = ?
  `).all(workDate, cleanAcc);

  const assignedEmployees = assignedRows.map(r => r.name);
  const assignedSet = new Set(assignedEmployees);

  // 3. Daily Log actions on orders belonging to this account
  const orderCodes = openingRows.map(r => `'${r.order_code}'`).join(',');
  let logRows = [];

  if (openingRows.length > 0) {
    logRows = db.prepare(`
      SELECT id, order_code, employee_name, action, status, event_datetime
      FROM raw_log_records
      WHERE work_date = ? AND order_code IN (${orderCodes})
      ORDER BY event_datetime ASC, id ASC
    `).all(workDate);
  }

  // Deduplicate actions
  const dedupMap = new Map();
  const deduplicatedActions = [];

  for (const r of logRows) {
    const dt = r.event_datetime ? new Date(r.event_datetime).getTime() : 0;
    const key = `${r.order_code}|${r.employee_name}|${r.status || r.action}`;
    const lastTime = dedupMap.get(key) || 0;

    if (dt - lastTime >= 120000 || lastTime === 0) {
      dedupMap.set(key, dt);
      deduplicatedActions.push(r);
    }
  }

  // Order-level summary
  const orderDetailsMap = new Map();
  const actualEmployeesSet = new Set();

  for (const act of deduplicatedActions) {
    if (act.is_cs === 1 || isCsEmployee(act.employee_name)) {
      actualEmployeesSet.add(act.employee_name);
    }

    if (!orderDetailsMap.has(act.order_code)) {
      const opening = orderOpeningMap.get(act.order_code);
      orderDetailsMap.set(act.order_code, {
        order_code: act.order_code,
        opening_status: opening ? opening.status : 'Unknown',
        first_action: act.event_datetime,
        last_action: act.event_datetime,
        latest_status: act.status || 'Action',
        action_count: 0,
        actual_employees: new Set(),
        is_assigned_worker: false,
      });
    }

    const ord = orderDetailsMap.get(act.order_code);
    ord.action_count++;
    ord.last_action = act.event_datetime;
    if (act.status) ord.latest_status = act.status;
    if (act.is_cs === 1 || isCsEmployee(act.employee_name)) {
      ord.actual_employees.add(act.employee_name);
      if (assignedSet.has(act.employee_name)) {
        ord.is_assigned_worker = true;
      }
    }
  }

  const actualEmployees = Array.from(actualEmployeesSet);
  const unassignedEmployees = actualEmployees.filter(emp => !assignedSet.has(emp));

  // Build full order list (including unworked orders)
  const ordersList = [];
  for (const r of openingRows) {
    if (orderDetailsMap.has(r.order_code)) {
      const detail = orderDetailsMap.get(r.order_code);
      ordersList.push({
        order_code: r.order_code,
        opening_status: r.status,
        first_action: detail.first_action,
        last_action: detail.last_action,
        latest_status: detail.latest_status,
        action_count: detail.action_count,
        actual_employees: Array.from(detail.actual_employees),
        is_assigned_worker: detail.is_assigned_worker,
        worked: true,
      });
    } else {
      ordersList.push({
        order_code: r.order_code,
        opening_status: r.status,
        first_action: null,
        last_action: null,
        latest_status: r.status,
        action_count: 0,
        actual_employees: [],
        is_assigned_worker: false,
        worked: false,
      });
    }
  }

  return {
    account: cleanAcc,
    work_date: workDate,
    opening_orders: {
      total: openingTotal,
      new: openingNew,
      pending: openingPending,
      conflict: openingConflict,
    },
    assigned_employees: assignedEmployees,
    actual_employees: actualEmployees,
    unassigned_employees: unassignedEmployees,
    has_unassigned_work: unassignedEmployees.length > 0,
    unique_orders_worked: orderDetailsMap.size,
    real_actions_count: deduplicatedActions.length,
    orders: ordersList,
  };
}

/**
 * ============================================================
 * PHASE 19, 20, 24: TRACKING OVERVIEW & AUDIT
 * ============================================================
 */
export function getTrackingOverview(workDate) {
  const dailyLogUploaded = isDailyLogUploaded(workDate);
  const sources = getSourcesUploadStatus(workDate);

  // 1. Opening inventory
  let currentOrders = db.prepare(`
    SELECT order_code, account, status, source_file_slot 
    FROM current_work_orders 
    WHERE work_date = ?
  `).all(workDate);

  // If current_work_orders has not been populated yet for workDate, check vendoor_orders
  if (currentOrders.length === 0) {
    const vOrders = db.prepare(`
      SELECT order_code, account, status 
      FROM vendoor_orders 
      WHERE source_date = ?
    `).all(workDate);
    if (vOrders.length > 0) {
      currentOrders = vOrders.map(v => ({
        order_code: v.order_code,
        account: v.account,
        status: v.status,
        source_file_slot: (v.status && String(v.status).toLowerCase().includes('pending')) ? 2 : 1
      }));
    }
  }

  let openingNew = 0;
  let openingPending = 0;
  let openingConflict = 0;
  const openingConflictCodes = [];
  const orderAccountMap = new Map();
  const distinctAccountsSet = new Set();

  for (const o of currentOrders) {
    distinctAccountsSet.add(o.account);
    orderAccountMap.set(o.order_code, o.account);
    const st = String(o.status || '').toLowerCase();
    if (st.includes('conflict')) {
      openingConflict++;
      openingConflictCodes.push(o.order_code);
    } else if (st.includes('pending') || o.source_file_slot === 2) {
      openingPending++;
    } else {
      openingNew++;
    }
  }

  const openingTotal = currentOrders.length;

  // 2. Manual Allocations
  const allocationRows = db.prepare(`
    SELECT e.id as employee_id, e.name as employee_name, ai.account, ai.status
    FROM allocation_items ai
    JOIN allocation_headers ah ON ai.allocation_header_id = ah.id
    JOIN employees e ON ai.employee_id = e.id
    WHERE ah.allocation_date = ?
  `).all(workDate);

  const empAssignedAccounts = new Map();
  const assignedAccountsSet = new Set();

  for (const a of allocationRows) {
    assignedAccountsSet.add(a.account);
    if (!empAssignedAccounts.has(a.employee_name)) {
      empAssignedAccounts.set(a.employee_name, new Set());
    }
    empAssignedAccounts.get(a.employee_name).add(a.account);
  }

  // 3. Daily Log records
  const logRows = db.prepare(`
    SELECT id, order_code, employee_name, action, status, event_datetime, is_cs
    FROM raw_log_records
    WHERE work_date = ?
    ORDER BY event_datetime ASC, id ASC
  `).all(workDate);

  // 4. Deduplicate Daily Log using 120s window
  const deduplicatedActions = [];
  const dedupMap = new Map();

  for (const r of logRows) {
    const dt = r.event_datetime ? new Date(r.event_datetime).getTime() : 0;
    const key = `${r.order_code}|${r.employee_name}|${r.status || r.action}`;
    const lastTime = dedupMap.get(key) || 0;

    if (dt - lastTime >= 120000 || lastTime === 0) {
      dedupMap.set(key, dt);
      deduplicatedActions.push(r);
    }
  }

  // Group by Employee and Order
  const empWorkedOrders = new Map();
  const empWorkedAccounts = new Map();
  const empRealActions = new Map();
  const empStatuses = new Map();
  const uniqueOrdersWorkedAcrossTeam = new Set();
  const workedAccountsSet = new Set();

  let printedCount = 0;
  let pendingCount = 0;
  let cancelledCount = 0;
  let processingCount = 0;
  let altCount = 0;

  const unmatchedOrderCodes = new Set();

  for (const act of deduplicatedActions) {
    uniqueOrdersWorkedAcrossTeam.add(act.order_code);

    const empName = act.employee_name;
    if (!empWorkedOrders.has(empName)) {
      empWorkedOrders.set(empName, new Set());
      empWorkedAccounts.set(empName, new Set());
      empRealActions.set(empName, 0);
      empStatuses.set(empName, { printed: 0, pending: 0, cancelled: 0, processing: 0, alt: 0 });
    }

    empWorkedOrders.get(empName).add(act.order_code);
    empRealActions.set(empName, empRealActions.get(empName) + 1);

    const acc = orderAccountMap.get(act.order_code);
    if (acc) {
      empWorkedAccounts.get(empName).add(acc);
      workedAccountsSet.add(acc);
    } else {
      unmatchedOrderCodes.add(act.order_code);
    }

    const stObj = empStatuses.get(empName);
    if (act.status === 'Printed') { printedCount++; stObj.printed++; }
    if (act.status === 'Pending') { pendingCount++; stObj.pending++; }
    if (act.status === 'Cancelled') { cancelledCount++; stObj.cancelled++; }
    if (act.status === 'Processing') { processingCount++; stObj.processing++; }
    if (/هاتف.*آخر|هاتف.*اخر|هاتف.*بديل|تليفون.*بديل|رقم.*بديل|رقم.*هاتف|phone|alt/i.test(act.action)) { altCount++; stObj.alt++; }
  }

  // 5. Build Employee Tracking List & Outside Allocation Table
  const employeeTrackingList = [];
  const employeesOutsideAllocation = [];

  // Union of all active/assigned/working employees
  const allEmployeesSet = new Set([...empAssignedAccounts.keys(), ...empWorkedOrders.keys()]);

  for (const empName of allEmployeesSet) {
    if (!isCsEmployee(empName)) continue;
    const assigned = Array.from(empAssignedAccounts.get(empName) || []);
    const assignedSet = new Set(assigned);
    const worked = Array.from(empWorkedAccounts.get(empName) || []);
    const extraAccounts = worked.filter(a => !assignedSet.has(a));
    const assignedNotWorked = assigned.filter(a => !(empWorkedAccounts.get(empName) || new Set()).has(a));

    const ordersWorkedToday = empWorkedOrders.has(empName) ? empWorkedOrders.get(empName).size : 0;
    const realActions = empRealActions.get(empName) || 0;
    const stObj = empStatuses.get(empName) || { printed: 0, pending: 0, cancelled: 0, processing: 0, alt: 0 };

    // Calculate outside allocation orders/actions
    let outsideOrdersCount = 0;
    let outsideActionsCount = 0;

    if (extraAccounts.length > 0 && empWorkedOrders.has(empName)) {
      for (const ordCode of empWorkedOrders.get(empName)) {
        const ordAcc = orderAccountMap.get(ordCode);
        if (ordAcc && !assignedSet.has(ordAcc)) {
          outsideOrdersCount++;
        }
      }
      for (const act of deduplicatedActions) {
        if (act.employee_name === empName) {
          const ordAcc = orderAccountMap.get(act.order_code);
          if (ordAcc && !assignedSet.has(ordAcc)) {
            outsideActionsCount++;
          }
        }
      }
    }

    const compliancePct = (dailyLogUploaded && realActions > 0)
      ? Math.round(((realActions - outsideActionsCount) / realActions) * 1000) / 10
      : null;

    const empData = {
      employee_name: empName,
      assigned_accounts: assigned,
      actually_worked_accounts: worked,
      extra_unassigned_accounts: extraAccounts,
      assigned_accounts_not_worked: assignedNotWorked,
      orders_worked_today: dailyLogUploaded ? ordersWorkedToday : null,
      real_actions: dailyLogUploaded ? realActions : null,
      printed: dailyLogUploaded ? stObj.printed : null,
      pending: dailyLogUploaded ? stObj.pending : null,
      cancelled: dailyLogUploaded ? stObj.cancelled : null,
      processing: dailyLogUploaded ? stObj.processing : null,
      alt_phones: dailyLogUploaded ? stObj.alt : null,
      allocation_compliance: compliancePct,
      allocation_compliance_label: compliancePct !== null ? `${compliancePct}%` : 'N/A',
      status_message: !dailyLogUploaded ? 'End-of-Day Log Not Uploaded' : (realActions === 0 ? 'Log Uploaded — No Activity Recorded' : 'Active'),
      outside_allocation: {
        has_unassigned: extraAccounts.length > 0,
        extra_accounts_count: extraAccounts.length,
        orders_worked_outside: dailyLogUploaded ? outsideOrdersCount : null,
        real_actions_outside: dailyLogUploaded ? outsideActionsCount : null,
      },
    };

    employeeTrackingList.push(empData);

    if (extraAccounts.length > 0) {
      employeesOutsideAllocation.push({
        employee_name: empName,
        assigned_accounts: assigned,
        actual_accounts: worked,
        extra_accounts: extraAccounts,
        orders_worked_outside: dailyLogUploaded ? outsideOrdersCount : null,
        real_actions_outside: dailyLogUploaded ? outsideActionsCount : null,
      });
    }
  }

  // 6. Data Quality & Audit Metrics — Parity with Canonical Performance Engine
  const perfResult = logRows.length > 0 ? computePerformanceFromRecords(logRows) : null;
  const canonicalTotalRealActions = perfResult?.summary?.totalRealActions;
  const statusActionsCount = typeof canonicalTotalRealActions === 'number' ? canonicalTotalRealActions : (printedCount + pendingCount + cancelledCount + processingCount);
  const canonicalPrinted = perfResult?.summary?.printedActions ?? printedCount;
  const canonicalPending = perfResult?.summary?.pendingActions ?? pendingCount;
  const canonicalCancelled = perfResult?.summary?.cancelledActions ?? cancelledCount;
  const canonicalProcessing = perfResult?.summary?.processingActions ?? processingCount;
  const canonicalAlt = perfResult?.summary?.totalAltPhones ?? altCount;

  const openingOrdersWithDailyLog = currentOrders.filter(o => uniqueOrdersWorkedAcrossTeam.has(o.order_code)).length;
  const openingOrdersWithoutDailyLog = currentOrders.filter(o => !uniqueOrdersWorkedAcrossTeam.has(o.order_code)).length;

  // Accounts alignment
  const assignedAccountsList = Array.from(assignedAccountsSet);
  const workedAccountsList = Array.from(workedAccountsSet);
  const extraAccountsWorked = workedAccountsList.filter(a => !assignedAccountsSet.has(a));
  const assignedAccountsNotWorked = assignedAccountsList.filter(a => !workedAccountsSet.has(a));

  const auditData = {
    orders_new_only: openingNew,
    orders_pending_only: openingPending,
    orders_in_both_conflict: openingConflict,
    orders_with_daily_log: dailyLogUploaded ? openingOrdersWithDailyLog : null,
    orders_without_daily_log: dailyLogUploaded ? openingOrdersWithoutDailyLog : null,
    unmatched_order_codes_count: unmatchedOrderCodes.size,
    unmatched_order_codes_sample: Array.from(unmatchedOrderCodes).slice(0, 10),
    unmatched_daily_log_orders: Array.from(unmatchedOrderCodes).map(code => ({ order_code: code })),
    conflicting_opening_orders_count: openingConflictCodes.length,
    conflicting_opening_orders_sample: openingConflictCodes.slice(0, 10),
  };

  return {
    work_date: workDate,
    daily_log_uploaded: dailyLogUploaded,
    sources,
    sources_status: sources,
    opening_inventory: {
      new_orders: openingNew,
      pending_orders: openingPending,
      opening_conflict: openingConflict,
      opening_status_conflicts: openingConflict,
      opening_conflict_orders: openingConflictCodes,
      opening_total: openingTotal,
      untouched_orders: dailyLogUploaded ? openingOrdersWithoutDailyLog : null, // N/A if log not uploaded!
    },
    actual_work: {
      orders_worked_today: dailyLogUploaded ? (openingTotal > 0 ? openingOrdersWithDailyLog : uniqueOrdersWorkedAcrossTeam.size) : null, // Strict Business Date bounded
      orders_worked_in_inventory: dailyLogUploaded ? openingOrdersWithDailyLog : null,
      total_orders_touched_across_logs: dailyLogUploaded ? uniqueOrdersWorkedAcrossTeam.size : null,
      real_actions: dailyLogUploaded ? statusActionsCount : null,                       // Null if no log
      printed_orders: dailyLogUploaded ? canonicalPrinted : null,
      pending_backlog: dailyLogUploaded ? canonicalPending : null,
      cancelled_orders: dailyLogUploaded ? canonicalCancelled : null,
      processing_orders: dailyLogUploaded ? canonicalProcessing : null,
      alt_phones: dailyLogUploaded ? canonicalAlt : null,
      status_message: !dailyLogUploaded ? 'End-of-Day Log Not Uploaded' : (deduplicatedActions.length === 0 ? 'Log Uploaded — No Activity Recorded' : 'Active'),
    },
    allocation_alignment: {
      assigned_accounts_count: assignedAccountsList.length,
      actually_worked_accounts_count: workedAccountsList.length,
      extra_accounts_worked_count: extraAccountsWorked.length,
      assigned_accounts_not_worked_count: assignedAccountsNotWorked.length,
      assigned_accounts: assignedAccountsList,
      actually_worked_accounts: workedAccountsList,
      extra_accounts_worked: extraAccountsWorked,
      assigned_accounts_not_worked: assignedAccountsNotWorked,
    },
    employees_outside_allocation: employeesOutsideAllocation,
    employee_tracking: employeeTrackingList.sort((a, b) => (b.orders_worked_today ?? -1) - (a.orders_worked_today ?? -1)),
    data_quality_audit: auditData,
    audit: auditData,
  };
}

/**
 * ============================================================
 * PHASE 21: MULTI-DAY / DATE RANGE TRACKING (DAY/WEEK/MONTH)
 * ============================================================
 */
export function getRangeTracking(startDate, endDate) {
  // Query all raw log records between startDate and endDate
  const logRows = db.prepare(`
    SELECT work_date, order_code, employee_name, action, status, event_datetime, is_cs
    FROM raw_log_records
    WHERE work_date >= ? AND work_date <= ?
    ORDER BY event_datetime ASC
  `).all(startDate, endDate);

  // Group by date and deduplicate within date
  const dateMap = new Map();
  const overallUniqueOrders = new Set();
  let totalDeduplicatedActions = 0;
  let totalPrinted = 0;
  let totalPending = 0;
  let totalCancelled = 0;
  let totalProcessing = 0;
  let totalAlt = 0;

  let sumOfDailyUniqueOrders = 0;

  for (const r of logRows) {
    if (!dateMap.has(r.work_date)) {
      dateMap.set(r.work_date, []);
    }
    dateMap.get(r.work_date).push(r);
  }

  const dailyBreakdown = [];

  for (const [date, records] of dateMap.entries()) {
    const dedupMap = new Map();
    const dailyUniqueOrders = new Set();
    let dailyActions = 0;

    for (const r of records) {
      const dt = r.event_datetime ? new Date(r.event_datetime).getTime() : 0;
      const key = `${r.order_code}|${r.employee_name}|${r.status || r.action}`;
      const lastTime = dedupMap.get(key) || 0;

      if (dt - lastTime >= 120000 || lastTime === 0) {
        dedupMap.set(key, dt);
        dailyUniqueOrders.add(r.order_code);
        overallUniqueOrders.add(r.order_code);
        dailyActions++;
        totalDeduplicatedActions++;

        if (r.status === 'Printed') totalPrinted++;
        if (r.status === 'Pending') totalPending++;
        if (r.status === 'Cancelled') totalCancelled++;
        if (r.status === 'Processing') totalProcessing++;
        if (/هاتف\s*آخر|تليفون\s*بديل|alt/i.test(r.action)) totalAlt++;
      }
    }

    sumOfDailyUniqueOrders += dailyUniqueOrders.size;

    dailyBreakdown.push({
      date,
      unique_orders_worked: dailyUniqueOrders.size,
      real_actions: dailyActions,
    });
  }

  const sortedBreakdown = dailyBreakdown.sort((a, b) => a.date.localeCompare(b.date));

  return {
    start_date: startDate,
    end_date: endDate,
    days_count: sortedBreakdown.length,
    period_unique_orders_worked: overallUniqueOrders.size, // Deduplicated across entire range
    sum_of_daily_unique_orders: sumOfDailyUniqueOrders,    // Sum of daily values
    total_real_actions: totalDeduplicatedActions,
    total_printed: totalPrinted,
    total_pending: totalPending,
    total_cancelled: totalCancelled,
    total_processing: totalProcessing,
    total_alt_phones: totalAlt,
    summary: {
      days_count: sortedBreakdown.length,
      total_daily_unique_orders_sum: sumOfDailyUniqueOrders,
      unique_orders_in_period: overallUniqueOrders.size,
      total_real_actions: totalDeduplicatedActions,
    },
    daily_breakdown: sortedBreakdown,
  };
}

/**
 * ============================================================
 * ACCOUNTS DIRECTORY & DETAILED DATA
 * (Part 26, 27, 28, 29, 30, 31)
 * ============================================================
 */

export function getAccountsDirectory(workDate) {
  // 1. Get all distinct accounts from current_work_orders and raw_log_records
  const openingAccounts = db.prepare(`
    SELECT 
      account,
      COUNT(id) as total_orders,
      SUM(CASE WHEN status = 'New' THEN 1 ELSE 0 END) as new_orders,
      SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) as pending_orders,
      SUM(CASE WHEN status = 'Opening Status Conflict' THEN 1 ELSE 0 END) as conflict_orders
    FROM current_work_orders
    WHERE work_date = ?
    GROUP BY account
  `).all(workDate);

  const accMap = new Map();
  for (const a of openingAccounts) {
    accMap.set(a.account, {
      account_name: a.account,
      total_orders: a.total_orders,
      new_orders: a.new_orders,
      pending_orders: a.pending_orders,
      conflict_orders: a.conflict_orders,
      assigned_employees: [],
      worked_employees: [],
      outside_employees: [],
      printed: 0,
      pending: 0,
      cancelled: 0,
      processing: 0,
      alt_phones: 0,
      real_actions: 0,
      unique_orders_worked: 0
    });
  }

  // 2. Fetch assigned employees
  const assignedRows = db.prepare(`
    SELECT ai.account, e.name as employee_name
    FROM allocation_items ai
    JOIN allocation_headers ah ON ai.allocation_header_id = ah.id
    JOIN employees e ON ai.employee_id = e.id
    WHERE ah.allocation_date = ?
  `).all(workDate);

  for (const ar of assignedRows) {
    if (!accMap.has(ar.account)) {
      accMap.set(ar.account, {
        account_name: ar.account,
        total_orders: 0,
        new_orders: 0,
        pending_orders: 0,
        conflict_orders: 0,
        assigned_employees: [],
        worked_employees: [],
        outside_employees: [],
        printed: 0,
        pending: 0,
        cancelled: 0,
        processing: 0,
        alt_phones: 0,
        real_actions: 0,
        unique_orders_worked: 0
      });
    }
    const item = accMap.get(ar.account);
    if (!item.assigned_employees.includes(ar.employee_name)) {
      item.assigned_employees.push(ar.employee_name);
    }
  }

  // 3. Process logs if uploaded
  const dailyLogUploaded = isDailyLogUploaded(workDate);
  for (const [accName, item] of accMap.entries()) {
    if (dailyLogUploaded) {
      const tracking = getAccountTracking(workDate, accName);
      item.worked_employees = tracking.actual_employees || [];
      item.outside_employees = tracking.unassigned_employees || [];
      item.unique_orders_worked = tracking.unique_orders_worked || 0;
      item.real_actions = tracking.real_actions_count || 0;
    }
    item.assigned_orders = item.total_orders || 0;
    item.actual_orders_worked = item.unique_orders_worked || 0;
    item.reconciliation_gap = item.assigned_orders - item.actual_orders_worked;
  }

  const list = Array.from(accMap.values()).sort((a, b) => b.total_orders - a.total_orders || a.account_name.localeCompare(b.account_name));

  return {
    work_date: workDate,
    daily_log_uploaded: dailyLogUploaded,
    total_accounts: list.length,
    accounts: list
  };
}

export function getAccountDetailedData(workDate, accountName) {
  const cleanAcc = String(accountName || '').trim();
  const tracking = getAccountTracking(workDate, cleanAcc);

  // Calculate detailed metrics
  let printedCount = 0;
  let pendingCount = 0;
  let cancelledCount = 0;
  let processingCount = 0;
  let altCount = 0;

  // Employee activity map
  const empActivityMap = new Map();
  const assignedSet = new Set(tracking.assigned_employees || []);

  for (const empName of tracking.assigned_employees || []) {
    empActivityMap.set(empName, {
      employee_name: empName,
      is_assigned: true,
      allocated_orders: 0,
      orders_worked: 0,
      real_actions: 0,
      printed: 0,
      pending: 0,
      cancelled: 0,
      alt: 0
    });
  }

  // Timeline events for orders
  const timeline = [];

  // Query raw logs for timeline
  const orderCodes = (tracking.orders || []).map(o => `'${o.order_code}'`).join(',');
  if (orderCodes) {
    const rawLogs = db.prepare(`
      SELECT order_code, employee_name, action, status, event_datetime
      FROM raw_log_records
      WHERE work_date = ? AND order_code IN (${orderCodes})
      ORDER BY event_datetime ASC, id ASC
    `).all(workDate);

    // Dedup 120s
    const dedupMap = new Map();
    let stepNum = 1;

    for (const r of rawLogs) {
      const dt = r.event_datetime ? new Date(r.event_datetime).getTime() : 0;
      const key = `${r.order_code}|${r.employee_name}|${r.status || r.action}`;
      const lastTime = dedupMap.get(key) || 0;

      if (dt - lastTime >= 120000 || lastTime === 0) {
        dedupMap.set(key, dt);

        if (!empActivityMap.has(r.employee_name)) {
          // Strictly CS employees only
          if (isCsEmployee(r.employee_name)) {
            empActivityMap.set(r.employee_name, {
              employee_name: r.employee_name,
              is_assigned: assignedSet.has(r.employee_name),
              allocated_orders: 0,
              orders_worked: 0,
              real_actions: 0,
              printed: 0,
              pending: 0,
              cancelled: 0,
              alt: 0
            });
          }
        }

        const actEmp = empActivityMap.get(r.employee_name);
        if (actEmp) {
          actEmp.real_actions++;
          if (r.status === 'Printed') { actEmp.printed++; printedCount++; }
          if (r.status === 'Pending') { actEmp.pending++; pendingCount++; }
          if (r.status === 'Cancelled') { actEmp.cancelled++; cancelledCount++; }
          if (r.status === 'Processing') processingCount++;
          if (/هاتف\s*آخر|تليفون\s*بديل|alt/i.test(r.action)) { actEmp.alt++; altCount++; }
        }

        timeline.push({
          order_code: r.order_code,
          step_number: stepNum++,
          timestamp: r.event_datetime,
          employee: r.employee_name,
          action_text: r.action,
          status: r.status || 'Action',
          source: 'Daily Log'
        });
      }
    }
  }

  // Count allocated orders per employee if available
  const allocItems = db.prepare(`
    SELECT e.name as employee_name, ai.available_orders_at_assignment as cnt
    FROM allocation_items ai
    JOIN allocation_headers ah ON ai.allocation_header_id = ah.id
    JOIN employees e ON ai.employee_id = e.id
    WHERE ah.allocation_date = ? AND ai.account = ?
  `).all(workDate, cleanAcc);

  for (const ai of allocItems) {
    if (empActivityMap.has(ai.employee_name)) {
      empActivityMap.get(ai.employee_name).allocated_orders = ai.cnt || 0;
    }
  }

  // Count distinct canonical orders worked per employee for this account
  const empUniqueOrdersMap = new Map();
  for (const o of tracking.orders || []) {
    if (!o.worked) continue;
    const emps = Array.isArray(o.actual_employees) ? Array.from(new Set(o.actual_employees)) : [];
    for (const emp of emps) {
      if (!empUniqueOrdersMap.has(emp)) empUniqueOrdersMap.set(emp, new Set());
      empUniqueOrdersMap.get(emp).add(o.order_code);
    }
  }
  for (const [emp, ordSet] of empUniqueOrdersMap.entries()) {
    if (empActivityMap.has(emp)) {
      empActivityMap.get(emp).orders_worked = ordSet.size;
    }
  }

  // Fetch account rule & exceptions for eligibility audit
  const ruleRow = db.prepare('SELECT * FROM account_rules WHERE account_name = ? COLLATE NOCASE').get(cleanAcc);
  const parsedRule = ruleRow ? {
    id: ruleRow.id,
    account_name: ruleRow.account_name,
    new_eligible: ruleRow.new_eligible_json ? JSON.parse(ruleRow.new_eligible_json) : [],
    pending_eligible: ruleRow.pending_eligible_json ? JSON.parse(ruleRow.pending_eligible_json) : [],
    blocked: ruleRow.blocked_json ? JSON.parse(ruleRow.blocked_json) : [],
    active: !!ruleRow.active,
    notes: ruleRow.notes || ''
  } : null;

  const accExceptions = db.prepare(`
    SELECT ae.*, ae.account_name as account, ae.exception_type as action_type, e.name as employee_name
    FROM account_exceptions ae
    LEFT JOIN employees e ON ae.employee_id = e.id
    WHERE ae.account_name = ? COLLATE NOCASE AND (ae.work_date IS NULL OR ae.work_date = ?)
  `).all(cleanAcc, workDate);

  // Compute date-specific eligibility breakdown
  const allEmployeesList = db.prepare('SELECT id, name, department, team_membership, active FROM employees').all();
  const empIdToName = new Map(allEmployeesList.map(e => [e.id, e.name]));
  const resolveNames = list => (Array.isArray(list) ? list.map(item => (typeof item === 'number' ? empIdToName.get(item) || `ID:${item}` : String(item))) : []);

  const allActiveCS = db.prepare(`
    SELECT e.id, e.name, e.department, e.team_membership, COALESCE(dwt.is_working, 0) as is_working
    FROM employees e
    LEFT JOIN daily_working_team dwt ON e.id = dwt.employee_id AND dwt.work_date = ?
    WHERE e.active = 1
    ORDER BY e.name COLLATE NOCASE ASC
  `).all(workDate).filter(e => isCsEmployee(e));

  const workingCS = allActiveCS.filter(e => e.is_working === 1);
  const blockedIdsSet = new Set(parsedRule ? parsedRule.blocked.map(b => (typeof b === 'number' ? b : null)).filter(Boolean) : []);
  const blockedNamesSet = new Set(parsedRule ? parsedRule.blocked.map(b => (typeof b === 'string' ? b.toLowerCase() : null)).filter(Boolean) : []);

  // Check exception blocks
  for (const exc of accExceptions) {
    if (exc.exception_type === 'block' && exc.employee_name) {
      blockedNamesSet.add(exc.employee_name.toLowerCase());
      if (exc.employee_id) blockedIdsSet.add(exc.employee_id);
    }
  }

  const isEmpBlocked = emp => blockedIdsSet.has(emp.id) || blockedNamesSet.has(emp.name.toLowerCase());

  const eligibleNewToday = workingCS.filter(emp => {
    if (isEmpBlocked(emp)) return false;
    if (emp.team_membership !== 'New' && emp.team_membership !== 'Both') return false;
    if (parsedRule && Array.isArray(parsedRule.new_eligible) && parsedRule.new_eligible.length > 0) {
      return parsedRule.new_eligible.includes(emp.id) || parsedRule.new_eligible.some(n => String(n).toLowerCase() === emp.name.toLowerCase());
    }
    return true;
  }).map(e => e.name);

  const eligiblePendingToday = workingCS.filter(emp => {
    if (isEmpBlocked(emp)) return false;
    if (emp.team_membership !== 'Pending' && emp.team_membership !== 'Both') return false;
    if (parsedRule && Array.isArray(parsedRule.pending_eligible) && parsedRule.pending_eligible.length > 0) {
      return parsedRule.pending_eligible.includes(emp.id) || parsedRule.pending_eligible.some(n => String(n).toLowerCase() === emp.name.toLowerCase());
    }
    return true;
  }).map(e => e.name);

  return {
    account_name: cleanAcc,
    work_date: workDate,
    rule: parsedRule,
    exceptions: accExceptions,
    eligibility: {
      rule_configured: !!parsedRule,
      is_active_rule: parsedRule ? parsedRule.active : true,
      configured_new_eligible: parsedRule ? resolveNames(parsedRule.new_eligible) : [],
      configured_pending_eligible: parsedRule ? resolveNames(parsedRule.pending_eligible) : [],
      blocked_employees: parsedRule ? resolveNames(parsedRule.blocked) : [],
      working_cs_count: workingCS.length,
      final_eligible_new_today: eligibleNewToday,
      final_eligible_pending_today: eligiblePendingToday
    },
    metrics: {
      total_orders: tracking.opening_orders ? tracking.opening_orders.total : 0,
      new_orders: tracking.opening_orders ? tracking.opening_orders.new : 0,
      pending_orders: tracking.opening_orders ? tracking.opening_orders.pending : 0,
      conflict_orders: tracking.opening_orders ? tracking.opening_orders.conflict : 0,
      printed_orders: printedCount,
      pending_status_orders: pendingCount,
      cancelled_orders: cancelledCount,
      processing_orders: processingCount,
      alt_phones: altCount,
      unique_orders_worked: tracking.unique_orders_worked || 0,
      real_actions: tracking.real_actions_count || 0
    },
    assigned_employees: tracking.assigned_employees || [],
    worked_employees: tracking.actual_employees || [],
    outside_employees: tracking.unassigned_employees || [],
    has_unassigned_work: (tracking.unassigned_employees || []).length > 0,
    orders: (tracking.orders || []).map(o => ({
      order_code: o.order_code,
      opening_status: o.opening_status,
      last_logged_status: o.latest_status,
      assigned_employee: (tracking.assigned_employees || []).join(', ') || 'Unassigned',
      actual_employees: o.actual_employees,
      first_action: o.first_action,
      last_action: o.last_action,
      real_actions_count: o.action_count,
      orders_worked_today: o.worked ? 1 : 0,
      is_worked_outside_allocation: o.worked && (!o.is_assigned_worker)
    })),
    employee_activity: Array.from(empActivityMap.values()),
    timeline: timeline
  };
}

/**
 * PHASE 59: OPERATIONAL DASHBOARD DATA ENGINE
 * Directly queries SQLite for the selected Business Date.
 * Reconciles Orders Universe, Deduplicated Logs, and Employee Rankings.
 * Strictly guarantees KPI data-scope consistency.
 */
export function getOperationalDashboardData(workDate) {
  const targetDate = workDate || getCairoBusinessDate();

  // 1. Check daily_metrics_snapshots first
  const snap = db.prepare('SELECT metrics_json FROM daily_metrics_snapshots WHERE work_date = ?').get(targetDate);
  if (snap && snap.metrics_json) {
    try {
      const parsed = JSON.parse(snap.metrics_json);
      const emps = (Array.isArray(parsed.employees) ? parsed.employees : []).filter(e => isCsEmployee(e));

      let totalActions = parsed.log_totals?.actions;
      let totalPrinted = parsed.log_totals?.printed;
      let totalPending = parsed.log_totals?.pending;
      let totalCancelled = parsed.log_totals?.cancelled;
      let totalProcessing = parsed.log_totals?.processing;
      let totalAlt = parsed.log_totals?.alt;
      let totalNew = parsed.hr?.tot_new ?? parsed.summary?.totalOrders ?? 0;

      if (totalActions === undefined) {
        totalActions = emps.reduce((s, e) => s + (e.actions || e.real_actions || 0), 0);
      }
      if (totalPrinted === undefined) {
        totalPrinted = emps.reduce((s, e) => s + (e.printed || e.printed_orders || 0), 0);
      }
      if (totalPending === undefined) {
        totalPending = emps.reduce((s, e) => s + (e.pending || e.pending_backlog || e.pending_actions || 0), 0);
      }
      if (totalCancelled === undefined) {
        totalCancelled = emps.reduce((s, e) => s + (e.cancelled || e.cancelled_orders || e.cancelled_actions || 0), 0);
      }
      if (totalProcessing === undefined) {
        totalProcessing = emps.reduce((s, e) => s + (e.processing || e.processing_orders || e.processing_actions || 0), 0);
      }
      if (totalAlt === undefined) {
        totalAlt = emps.reduce((s, e) => s + (e.alt || e.alt_phones || 0), 0);
      }

      const log_totals = {
        actions: totalActions || 0,
        printed: totalPrinted || 0,
        pending: totalPending || 0,
        processing: totalProcessing || 0,
        cancelled: totalCancelled || 0,
        alt: totalAlt || 0,
        ...(parsed.log_totals || {})
      };

      const status_totals = {
        Printed: log_totals.printed,
        Pending: log_totals.pending,
        Processing: log_totals.processing,
        Cancelled: log_totals.cancelled,
        ...(parsed.status_totals || {})
      };

      const team_cancel_rate = parsed.team_cancel_rate ?? (log_totals.actions > 0 ? Number(((log_totals.cancelled / log_totals.actions) * 100).toFixed(1)) : 0.0);
      const team_pending_rate = parsed.team_pending_rate ?? (log_totals.actions > 0 ? Number(((log_totals.pending / log_totals.actions) * 100).toFixed(1)) : 0.0);

      const rankings = {
        printed: ((parsed.rankings?.printed && Array.isArray(parsed.rankings.printed))
          ? parsed.rankings.printed.filter(e => isCsEmployee(e.name || e.employee_name || e))
          : [...emps].sort((a, b) => (b.printed || 0) - (a.printed || 0)).map(e => ({ name: e.name || e.employee_name, value: e.printed || 0 }))).slice(0, 10),
        pending: ((parsed.rankings?.pending && Array.isArray(parsed.rankings.pending))
          ? parsed.rankings.pending.filter(e => isCsEmployee(e.name || e.employee_name || e))
          : [...emps].sort((a, b) => (b.pending || 0) - (a.pending || 0)).map(e => ({ name: e.name || e.employee_name, value: e.pending || 0 }))).slice(0, 10),
        cancelled: ((parsed.rankings?.cancelled && Array.isArray(parsed.rankings.cancelled))
          ? parsed.rankings.cancelled.filter(e => isCsEmployee(e.name || e.employee_name || e))
          : [...emps].sort((a, b) => (b.cancelled || 0) - (a.cancelled || 0)).map(e => ({ name: e.name || e.employee_name, value: e.cancelled || 0 }))).slice(0, 10)
      };

      const cancel_rate_rank = ((parsed.cancel_rate_rank && Array.isArray(parsed.cancel_rate_rank))
        ? parsed.cancel_rate_rank.filter(e => isCsEmployee(e.name || e.employee_name || e))
        : [...emps].sort((a, b) => (b.own_cancel_rate || 0) - (a.own_cancel_rate || 0)).map(e => ({ name: e.name || e.employee_name, value: e.own_cancel_rate || 0 })));

      const hr = parsed.hr || {
        days: 1,
        tot_new: totalNew,
        tot_printed: log_totals.printed,
        tot_cancel: log_totals.cancelled,
        tot_add: parsed.added_orders || parsed.addedOrders?.totalAdded || 0
      };

      const daily = parsed.daily || [{
        date: targetDate,
        new: totalNew,
        printed: log_totals.printed,
        pending: log_totals.pending,
        cancelled: log_totals.cancelled,
        processing: log_totals.processing,
        actions: log_totals.actions,
        alt: log_totals.alt
      }];

      const rawTopCS = (parsed.topCSContributors || parsed.addedOrders?.topCSContributors || []).filter(c => isCsEmployee(c.name || c.employee || c));
      const rawAllCS = (parsed.allCSContributors || parsed.addedOrders?.allCSContributors || []).filter(c => isCsEmployee(c.name || c.employee || c));

      const addedOrders = {
        totalAdded: parsed.addedOrders?.totalAdded || parsed.added_cs || 0,
        totalAddedCS: parsed.addedOrders?.totalAddedCS || parsed.added_cs || 0,
        totalAddedNonCS: parsed.addedOrders?.totalAddedNonCS || parsed.added_noncs || 0,
        fromCS: parsed.fromCS ?? parsed.added_cs ?? 0,
        fromOtherDepartments: parsed.fromOtherDepartments ?? parsed.added_noncs ?? 0,
        topCSContributor: rawTopCS[0] || null,
        topCSContributors: rawTopCS,
        allCSContributors: rawAllCS,
        ...(parsed.addedOrders || {})
      };
      addedOrders.topCSContributor = rawTopCS[0] || null;
      addedOrders.topCSContributors = rawTopCS;
      addedOrders.allCSContributors = rawAllCS;

      const dedup = parsed.dedup || { removed: 0, removed_pct: 0 };

      return {
        exists: parsed.exists ?? (emps.length > 0 || log_totals.actions > 0),
        date: targetDate,
        work_date: targetDate,
        ...parsed,
        employees: emps,
        top10Performers: [...emps].sort((a, b) => (b.performance_score || 0) - (a.performance_score || 0)).slice(0, 10),
        mostActive: [...emps].sort((a, b) => (b.actions || 0) - (a.actions || 0)).slice(0, 10),
        topCSContributor: rawTopCS[0] || null,
        topCSContributors: rawTopCS,
        allCSContributors: rawAllCS,
        rankings,
        cancel_rate_rank,
        addedOrders,
        log_totals,
        status_totals,
        rankings,
        cancel_rate_rank,
        hr,
        daily,
        addedOrders,
        dedup,
        team_cancel_rate,
        team_pending_rate,
        employees: emps
      };
    } catch (e) {}
  }

  const overview = getTrackingOverview(targetDate);

  const totalNew = overview.opening_inventory.new_orders || 0;
  const inventoryPending = overview.opening_inventory.pending_orders || 0;
  const openingTotal = overview.opening_inventory.opening_total || 0;

  let totalActions = 0;
  let totalPrinted = 0;
  let totalPending = 0;
  let totalCancelled = 0;
  let totalProcessing = 0;
  let totalAlt = 0;

  // Track employees for this day
  const employees = (overview.employee_tracking || []).map((e, idx) => {
    const acts = e.real_actions || 0;
    const prn = e.printed || 0;
    const pnd = e.pending || 0;
    const cnl = e.cancelled || 0;
    const prc = e.processing || 0;
    const alt = e.alt_phones || 0;

    totalActions += acts;
    totalPrinted += prn;
    totalCancelled += cnl;
    totalProcessing += prc;
    totalAlt += alt;

    return {
      rank: idx + 1,
      name: e.employee_name,
      actions: acts,
      printed: prn,
      pending: pnd,
      cancelled: cnl,
      processing: prc,
      alt: alt,
      performance_score: acts
    };
  });

  // If no activity in tracking overview, check if raw_log_records or vendoor_logs have activity
  if (totalActions === 0) {
    const rawRows = db.prepare(`
      SELECT employee_name, action, status, order_code, event_datetime, is_cs
      FROM raw_log_records 
      WHERE work_date = ?
    `).all(targetDate);

    if (rawRows.length > 0) {
      const computed = computePerformanceFromRecords(rawRows);
      totalActions = computed.summary.totalRealActions || 0;
      totalPrinted = computed.summary.printedActions || 0;
      totalPending = computed.summary.pendingActions || 0;
      totalCancelled = computed.summary.cancelledActions || 0;
      totalProcessing = computed.summary.processingActions || 0;
      totalAlt = computed.summary.totalAltPhones || 0;

      employees.length = 0;
      (computed.employees || []).forEach((e, idx) => {
        employees.push({
          rank: idx + 1,
          name: e.name || e.employee_name,
          actions: e.actions || e.real_actions || 0,
          printed: e.printed || 0,
          pending: e.pending || 0,
          cancelled: e.cancelled || 0,
          processing: e.processing || 0,
          alt: e.alt || 0,
          performance_score: e.performance_score || e.score || 0
        });
      });
    }
  }

  // If employees list is still empty and day has activity/inventory, populate from active working team for targetDate
  if (employees.length === 0 && (openingTotal > 0 || totalActions > 0)) {
    const teamMembers = db.prepare(`
      SELECT e.id, e.name 
      FROM daily_working_team dwt
      JOIN employees e ON dwt.employee_id = e.id
      WHERE dwt.work_date = ? AND e.active = 1 AND (dwt.is_working = 1 OR dwt.is_working IS NULL)
      ORDER BY e.name ASC
    `).all(targetDate);

    for (let i = 0; i < teamMembers.length; i++) {
      employees.push({
        rank: i + 1,
        name: teamMembers[i].name,
        actions: 0,
        printed: 0,
        pending: 0,
        cancelled: 0,
        processing: 0,
        alt: 0,
        performance_score: 0
      });
    }
  }

  employees.sort((a, b) => b.actions - a.actions);
  employees.forEach((e, i) => { e.rank = i + 1; });

  const teamCancelRate = totalActions > 0
    ? Number(((totalCancelled / totalActions) * 100).toFixed(1))
    : 0.0;

  const teamPendingRate = openingTotal > 0
    ? Number(((totalPending / openingTotal) * 100).toFixed(1))
    : (totalActions > 0 ? Number(((totalPending / totalActions) * 100).toFixed(1)) : 0.0);

  const exists = (openingTotal > 0 || totalActions > 0);

  return {
    exists,
    date: targetDate,
    work_date: targetDate,
    hr: {
      days: 1,
      tot_new: totalNew,
      tot_printed: totalPrinted,
      tot_cancel: totalCancelled,
      tot_add: 0
    },
    status_totals: {
      Printed: totalPrinted,
      Pending: inventoryPending > 0 ? inventoryPending : totalPending,
      Processing: totalProcessing,
      Cancelled: totalCancelled
    },
    log_totals: {
      actions: totalActions,
      printed: totalPrinted,
      pending: totalPending,
      processing: totalProcessing,
      cancelled: totalCancelled,
      alt: totalAlt
    },
    team_cancel_rate: teamCancelRate,
    team_pending_rate: teamPendingRate,
    employees,
    daily: [{
      date: targetDate,
      new: totalNew,
      printed: totalPrinted,
      pending: totalPending,
      cancelled: totalCancelled,
      processing: totalProcessing,
      actions: totalActions,
      alt: totalAlt
    }],
    rankings: {
      printed: [...employees].sort((a, b) => b.printed - a.printed),
      pending: [...employees].sort((a, b) => b.pending - a.pending),
      cancelled: [...employees].sort((a, b) => b.cancelled - a.cancelled)
    },
    cancel_rate_rank: [...employees].sort((a, b) => b.cancelled - a.cancelled),
    addedOrders: {
      totalAdded: 0,
      totalAddedCS: 0,
      totalAddedNonCS: 0,
      fromCS: 0,
      fromOtherDepartments: 0,
      topCSContributors: [],
      allCSContributors: []
    },
    dedup: { removed: 0, removed_pct: 0 }
  };
}

/**
 * ============================================================
 * OPERATIONAL WORKFLOW, INDIVIDUAL TRACKING & LIVE ACTIVITY
 * ============================================================
 */

export const ORDER_WORKFLOW_STATES = [
  'New', 'Printed', 'Sealed', 'Dispatched', 'Delivered', 'Completed', 'Cancelled', 'Refunded', 'Returned'
];

export const WORK_STATES = [
  'UNASSIGNED', 'ASSIGNED', 'CLAIMED', 'IN_PROGRESS', 'COMPLETED'
];

export const PRODUCTIVE_ACTIONS = new Set([
  'ASSIGNED', 'CLAIMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'HANDOFF'
]);

export function generateTrackingId(orderCode, workDate, index = 0) {
  const cleanCode = String(orderCode || '').trim();
  const cleanDate = String(workDate || '').replace(/[^0-9]/g, '');
  const rand = Math.random().toString(36).substring(2, 6);
  return `TRK-${cleanDate}-${cleanCode}-${index || 1}-${rand}`;
}

export function recordOrderLifecycleEvent({
  tracking_id,
  order_code,
  work_date,
  stage,
  work_state = 'UNASSIGNED',
  employee_id = null,
  employee_name = null,
  previous_employee_id = null,
  previous_employee_name = null,
  action = 'STAGE_CHANGE',
  timestamp = null,
  reason = null,
  source = 'SYSTEM',
  details = null
}) {
  const ts = timestamp || new Date().toISOString();
  const cleanCode = String(order_code || '').trim();
  const date = work_date || ts.slice(0, 10);

  let finalTrackingId = tracking_id;
  if (!finalTrackingId) {
    const existing = db.prepare('SELECT tracking_id FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(date, cleanCode);
    finalTrackingId = existing?.tracking_id || generateTrackingId(cleanCode, date);
  }

  const res = db.prepare(`
    INSERT INTO order_tracking_events (
      tracking_id, order_code, work_date, stage, work_state, employee_id, employee_name,
      previous_employee_id, previous_employee_name, action, timestamp, reason, source, details
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    finalTrackingId, cleanCode, date, stage || 'New', work_state, employee_id, employee_name,
    previous_employee_id, previous_employee_name, action, ts, reason, source,
    details ? (typeof details === 'object' ? JSON.stringify(details) : String(details)) : null
  );

  // Sync current_work_orders if present
  try {
    db.prepare(`
      UPDATE current_work_orders 
      SET tracking_id = COALESCE(tracking_id, ?),
          status = COALESCE(?, status),
          work_state = COALESCE(?, work_state),
          updated_at = datetime('now')
      WHERE work_date = ? AND order_code = ?
    `).run(finalTrackingId, stage, work_state, date, cleanCode);
  } catch (_) {}

  // Sync order_tracking
  try {
    db.prepare(`
      INSERT INTO order_tracking (order_code, work_date, status, tracking_id, work_state, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(order_code, work_date) DO UPDATE SET
        tracking_id = COALESCE(excluded.tracking_id, order_tracking.tracking_id),
        status = COALESCE(excluded.status, order_tracking.status),
        work_state = COALESCE(excluded.work_state, order_tracking.work_state),
        updated_at = datetime('now')
    `).run(cleanCode, date, stage, finalTrackingId, work_state);
  } catch (_) {}

  return { success: true, event_id: res.lastInsertRowid, tracking_id: finalTrackingId };
}

export function recordInternalHandoff({
  tracking_id,
  order_code,
  work_date,
  stage,
  previous_employee_id,
  previous_employee_name,
  new_employee_id,
  new_employee_name,
  timestamp = null,
  reason = 'Internal Workflow Handoff',
  source = 'INTERNAL_HANDOFF'
}) {
  const ts = timestamp || new Date().toISOString();
  const date = work_date || getCairoBusinessDate();

  let newEmp = null;
  if (new_employee_id) {
    newEmp = assertActiveCsEmployee(new_employee_id, date);
  }
  let prevEmp = null;
  if (previous_employee_id) {
    prevEmp = assertActiveCsEmployee(previous_employee_id, date);
  }

  // Record in order_tracking_events
  const evResult = recordOrderLifecycleEvent({
    tracking_id,
    order_code,
    work_date: date,
    stage: stage || 'HANDOFF',
    work_state: 'ASSIGNED',
    employee_id: newEmp ? newEmp.id : new_employee_id,
    employee_name: newEmp ? newEmp.name : new_employee_name,
    previous_employee_id: prevEmp ? prevEmp.id : previous_employee_id,
    previous_employee_name: prevEmp ? prevEmp.name : previous_employee_name,
    action: 'HANDOFF',
    timestamp: ts,
    reason,
    source,
    details: `Handoff from ${prevEmp ? prevEmp.name : (previous_employee_name || previous_employee_id)} to ${newEmp ? newEmp.name : (new_employee_name || new_employee_id)}`
  });

  // Log in employee_activity_log for the new employee
  if (newEmp) {
    try {
      logEmployeeActivity({
        work_date: date,
        employee_id: newEmp.id,
        employee_name: newEmp.name,
        action: 'HANDOFF',
        tracking_code: evResult.tracking_id,
        order_code,
        source: 'HANDOFF',
        details: `Received handoff from ${prevEmp ? prevEmp.name : (previous_employee_name || previous_employee_id)}`,
        timestamp: ts
      });
    } catch (_) {}
  }

  return evResult;
}

export function getOrderFullHistory(workDate, orderCodeOrTrackingId) {
  const clean = String(orderCodeOrTrackingId || '').trim();

  // Try to locate order in current_work_orders
  let ord = db.prepare(`
    SELECT * FROM current_work_orders 
    WHERE work_date = ? AND (order_code = ? OR tracking_id = ?)
  `).get(workDate, clean, clean);

  const orderCode = ord ? ord.order_code : clean;
  const trackingId = ord ? ord.tracking_id : null;

  // Fetch all lifecycle events
  const events = db.prepare(`
    SELECT * FROM order_tracking_events
    WHERE work_date = ? AND (order_code = ? OR (tracking_id IS NOT NULL AND tracking_id = ?))
    ORDER BY timestamp ASC, id ASC
  `).all(workDate, orderCode, trackingId || clean);

  // Fetch daily log raw records
  const rawLogs = db.prepare(`
    SELECT * FROM raw_log_records
    WHERE work_date = ? AND order_code = ?
    ORDER BY event_datetime ASC, id ASC
  `).all(workDate, orderCode);

  return {
    order_code: orderCode,
    tracking_id: trackingId || (events[0] ? events[0].tracking_id : null),
    work_date: workDate,
    current_status: ord ? ord.status : (events.length > 0 ? events[events.length - 1].stage : 'UNKNOWN'),
    current_work_state: ord ? ord.work_state : (events.length > 0 ? events[events.length - 1].work_state : 'UNASSIGNED'),
    priority: ord ? (ord.priority || 'REGULAR') : 'REGULAR',
    account: ord ? ord.account : null,
    assigned_employee: ord ? ord.assigned_employee_name : null,
    total_events: events.length + rawLogs.length,
    timeline: events,
    lifecycle_events: events,
    raw_logs: rawLogs
  };
}

export function logEmployeeActivity({
  work_date,
  employee_id,
  employee_name = null,
  action,
  tracking_code = null,
  order_code = null,
  account = null,
  source = 'UI',
  details = null,
  timestamp = null
}) {
  if (!employee_id && !employee_name) throw new Error('employee_id or employee_name is required');
  if (!action) throw new Error('action is required');

  const date = work_date || getCairoBusinessDate();
  const ts = timestamp || new Date().toISOString();

  let emp = null;
  if (employee_id) {
    emp = assertActiveCsEmployee(employee_id, date);
  } else if (employee_name) {
    emp = db.prepare('SELECT id, name, department, active, status FROM employees WHERE name = ? COLLATE NOCASE').get(String(employee_name).trim());
    if (!emp) {
      throw new Error(`Employee with name ${employee_name} not found in master records.`);
    }
    const isCs = String(emp.department || '').trim().toUpperCase() === 'CS';
    if (!isCs) {
      throw new Error(`Employee ${emp.name} is not a CS employee.`);
    }
    const isActive = (emp.active === 1 || emp.active === true || emp.active === '1') &&
                     String(emp.status || '').trim().toUpperCase() === 'ACTIVE';
    if (!isActive) {
      throw new Error(`Employee ${emp.name} is not active.`);
    }
  }

  const actUpper = String(action).trim().toUpperCase();

  const res = db.prepare(`
    INSERT INTO employee_activity_log (
      work_date, timestamp, employee_id, employee_name_snapshot, action,
      tracking_code, order_code, account, source, details
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    date, ts, emp.id, emp.name, actUpper,
    tracking_code, order_code, account, source,
    details ? (typeof details === 'object' ? JSON.stringify(details) : String(details)) : null
  );

  return {
    success: true,
    id: res.lastInsertRowid,
    employee_id: emp.id,
    employee_name: emp.name,
    action: actUpper,
    timestamp: ts
  };
}

/**
 * Authoritative Active CS Employee Validator for operational actions.
 * Verifies Employee Master existence, department = 'CS', and active = 1 / status = 'ACTIVE'.
 */
export function assertActiveCsEmployee(employeeId, workDate = null) {
  if (!employeeId) throw new Error('employee_id is required');
  const emp = db.prepare('SELECT id, name, department, active, status FROM employees WHERE id = ?').get(employeeId);
  if (!emp) {
    throw new Error(`Employee with ID ${employeeId} not found in master records.`);
  }
  const isCs = isCsEmployee(emp);
  if (!isCs) {
    throw new Error(`Employee ${emp.name} (ID ${emp.id}) is not a CS employee (Department: ${emp.department}). Operational mutations are restricted to CS.`);
  }
  const isActive = isOperationallyActiveCsEmployee(emp);
  if (!isActive) {
    throw new Error(`Employee ${emp.name} (ID ${emp.id}) is not active.`);
  }
  return emp;
}

export function claimOrder(workDate, orderCode, employeeId) {
  const date = workDate || getCairoBusinessDate();
  const cleanCode = String(orderCode || '').trim();

  const emp = assertActiveCsEmployee(employeeId, date);

  const order = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(date, cleanCode);
  if (!order) throw new Error(`Order ${cleanCode} not found on date ${date}`);

  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`
      UPDATE current_work_orders 
      SET work_state = 'CLAIMED',
          assigned_employee_id = ?,
          assigned_employee_name = ?,
          claimed_at = ?,
          updated_at = datetime('now')
      WHERE work_date = ? AND order_code = ?
    `).run(emp.id, emp.name, now, date, cleanCode);

    db.prepare(`
      UPDATE order_level_allocations
      SET work_state = 'CLAIMED',
          employee_id = ?,
          employee_name = ?
      WHERE allocation_date = ? AND order_code = ?
    `).run(emp.id, emp.name, date, cleanCode);

    recordOrderLifecycleEvent({
      tracking_id: order.tracking_id,
      order_code: cleanCode,
      work_date: date,
      stage: order.status,
      work_state: 'CLAIMED',
      employee_id: emp.id,
      employee_name: emp.name,
      action: 'CLAIMED',
      timestamp: now,
      source: 'UI_CLAIM'
    });

    logEmployeeActivity({
      work_date: date,
      employee_id: emp.id,
      employee_name: emp.name,
      action: 'CLAIMED',
      tracking_code: order.tracking_id,
      order_code: cleanCode,
      account: order.account,
      timestamp: now
    });
  })();

  return { success: true, work_state: 'CLAIMED', order_code: cleanCode, claimed_by: emp.name };
}

export function startOrderProgress(workDate, orderCode, employeeId) {
  const date = workDate || getCairoBusinessDate();
  const cleanCode = String(orderCode || '').trim();

  const emp = assertActiveCsEmployee(employeeId, date);

  const order = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(date, cleanCode);
  if (!order) throw new Error(`Order ${cleanCode} not found on date ${date}`);

  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`
      UPDATE current_work_orders 
      SET work_state = 'IN_PROGRESS',
          assigned_employee_id = ?,
          assigned_employee_name = ?,
          updated_at = datetime('now')
      WHERE work_date = ? AND order_code = ?
    `).run(emp.id, emp.name, date, cleanCode);

    db.prepare(`
      UPDATE order_level_allocations
      SET work_state = 'IN_PROGRESS',
          employee_id = ?,
          employee_name = ?
      WHERE allocation_date = ? AND order_code = ?
    `).run(emp.id, emp.name, date, cleanCode);

    recordOrderLifecycleEvent({
      tracking_id: order.tracking_id,
      order_code: cleanCode,
      work_date: date,
      stage: order.status,
      work_state: 'IN_PROGRESS',
      employee_id: emp.id,
      employee_name: emp.name,
      action: 'IN_PROGRESS',
      timestamp: now,
      source: 'UI_PROGRESS'
    });

    logEmployeeActivity({
      work_date: date,
      employee_id: emp.id,
      employee_name: emp.name,
      action: 'IN_PROGRESS',
      tracking_code: order.tracking_id,
      order_code: cleanCode,
      account: order.account,
      timestamp: now
    });
  })();

  return { success: true, work_state: 'IN_PROGRESS', order_code: cleanCode };
}

export function completeOrder(workDate, orderCode, employeeId) {
  const date = workDate || getCairoBusinessDate();
  const cleanCode = String(orderCode || '').trim();

  const emp = assertActiveCsEmployee(employeeId, date);

  const order = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(date, cleanCode);
  if (!order) throw new Error(`Order ${cleanCode} not found on date ${date}`);

  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`
      UPDATE current_work_orders 
      SET work_state = 'COMPLETED',
          status = 'Completed',
          assigned_employee_id = ?,
          assigned_employee_name = ?,
          completed_at = ?,
          updated_at = datetime('now')
      WHERE work_date = ? AND order_code = ?
    `).run(emp.id, emp.name, now, date, cleanCode);

    db.prepare(`
      UPDATE order_level_allocations
      SET work_state = 'COMPLETED',
          status = 'Completed',
          employee_id = ?,
          employee_name = ?
      WHERE allocation_date = ? AND order_code = ?
    `).run(emp.id, emp.name, date, cleanCode);

    recordOrderLifecycleEvent({
      tracking_id: order.tracking_id,
      order_code: cleanCode,
      work_date: date,
      stage: 'Completed',
      work_state: 'COMPLETED',
      employee_id: emp.id,
      employee_name: emp.name,
      action: 'COMPLETED',
      timestamp: now,
      source: 'UI_COMPLETE'
    });

    logEmployeeActivity({
      work_date: date,
      employee_id: emp.id,
      employee_name: emp.name,
      action: 'COMPLETED',
      tracking_code: order.tracking_id,
      order_code: cleanCode,
      account: order.account,
      timestamp: now
    });
  })();

  return { success: true, work_state: 'COMPLETED', order_code: cleanCode };
}

export function cancelOrder(workDate, orderCode, employeeId = null, reason = 'Order Cancelled') {
  const date = workDate || getCairoBusinessDate();
  const cleanCode = String(orderCode || '').trim();

  let emp = null;
  if (employeeId) {
    emp = assertActiveCsEmployee(employeeId, date);
  }

  const order = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ? AND order_code = ?').get(date, cleanCode);
  if (!order) throw new Error(`Order ${cleanCode} not found on date ${date}`);

  const now = new Date().toISOString();
  const empId = emp ? emp.id : order.assigned_employee_id;
  const empName = emp ? emp.name : order.assigned_employee_name;

  db.transaction(() => {
    db.prepare(`
      UPDATE current_work_orders 
      SET work_state = 'CANCELLED',
          status = 'Cancelled',
          updated_at = datetime('now')
      WHERE work_date = ? AND order_code = ?
    `).run(date, cleanCode);

    db.prepare(`
      UPDATE order_level_allocations
      SET work_state = 'CANCELLED',
          status = 'Cancelled'
      WHERE allocation_date = ? AND order_code = ?
    `).run(date, cleanCode);

    recordOrderLifecycleEvent({
      tracking_id: order.tracking_id,
      order_code: cleanCode,
      work_date: date,
      stage: 'Cancelled',
      work_state: 'CANCELLED',
      employee_id: empId,
      employee_name: empName,
      action: 'CANCELLED',
      timestamp: now,
      reason: reason || 'Order Cancelled',
      source: 'UI_CANCEL'
    });

    if (empId) {
      logEmployeeActivity({
        work_date: date,
        employee_id: empId,
        employee_name: empName,
        action: 'CANCELLED',
        tracking_code: order.tracking_id,
        order_code: cleanCode,
        account: order.account,
        timestamp: now,
        details: reason
      });
    }
  })();

  return { success: true, work_state: 'CANCELLED', order_code: cleanCode, reason };
}

export function getEmployeeLiveRealtime(workDate, options = {}) {
  const inactiveThreshold = options.inactiveThreshold || 900; // 15 mins (seconds)
  const criticalThreshold = options.criticalThreshold || 2700; // 45 mins (seconds)
  const currentCDate = options.currentTime ? getCairoBusinessDate(options.currentTime) : getCairoBusinessDate();
  const isHistorical = workDate < currentCDate;
  const refTime = options.currentTime 
    ? new Date(options.currentTime).getTime() 
    : (isHistorical ? new Date(`${workDate}T23:59:59.999Z`).getTime() : Date.now());

  // 1. Strict CS Department Only (Non-CS employees never appear as operational CS workers)
  const allEmployees = db.prepare(`
    SELECT id, name, department, team_membership, active
    FROM employees
    WHERE active = 1
    ORDER BY name ASC
  `).all();
  const csEmployees = allEmployees.filter(e => isCsEmployee(e));

  // 2. Daily working team for business date
  const workingRows = db.prepare(`
    SELECT employee_id, is_working, source, observed_at, last_activity_at
    FROM daily_working_team
    WHERE work_date = ?
  `).all(workDate);

  const workingMap = new Map();
  for (const wr of workingRows) {
    if (wr.is_working === 1 || wr.is_working === true || wr.is_working === '1') {
      workingMap.set(wr.employee_id, wr);
    }
  }

  // 3. True order stats from current_work_orders and order_level_allocations
  const unassignedRow = db.prepare(`
    SELECT COUNT(*) as count FROM current_work_orders
    WHERE work_date = ? AND (work_state = 'UNASSIGNED' OR work_state IS NULL OR assigned_employee_id IS NULL)
  `).get(workDate);
  const totalUnassigned = unassignedRow ? unassignedRow.count : 0;

  const employeeOrderStats = new Map();
  const allocOrders = db.prepare(`
    SELECT 
      ola.employee_id,
      COALESCE(cwo.work_state, ola.work_state, 'ASSIGNED') as effective_state
    FROM order_level_allocations ola
    LEFT JOIN current_work_orders cwo ON cwo.work_date = ola.allocation_date AND cwo.order_code = ola.order_code
    WHERE ola.allocation_date = ? AND ola.employee_id IS NOT NULL AND ola.employee_name != 'UNASSIGNED'
      AND ola.id IN (
        SELECT MAX(id) FROM order_level_allocations 
        WHERE allocation_date = ? 
        GROUP BY order_code
      )
  `).all(workDate, workDate);

  for (const row of allocOrders) {
    if (!employeeOrderStats.has(row.employee_id)) {
      employeeOrderStats.set(row.employee_id, {
        assigned: 0,
        claimed: 0,
        in_progress: 0,
        completed: 0
      });
    }
    const st = employeeOrderStats.get(row.employee_id);
    st.assigned++;
    const state = String(row.effective_state || '').toUpperCase();
    if (state === 'CLAIMED') st.claimed++;
    else if (state === 'IN_PROGRESS') st.in_progress++;
    else if (state === 'COMPLETED') st.completed++;
  }

  // 4. Employee activity log records (Phase 3 + Raw Log Records + Vendoor Logs)
  const activityLogs = db.prepare(`
    SELECT id, employee_id, action, timestamp, details, tracking_code, order_code, account
    FROM employee_activity_log
    WHERE work_date = ?
    ORDER BY timestamp ASC, id ASC
  `).all(workDate);

  const empActivities = new Map();
  for (const act of activityLogs) {
    if (!empActivities.has(act.employee_id)) {
      empActivities.set(act.employee_id, []);
    }
    empActivities.get(act.employee_id).push(act);
  }

  // Also ingest raw_log_records for rich, second-by-second activity timestamps
  const nameToEmpId = new Map();
  allEmployees.forEach(e => nameToEmpId.set((e.name || '').toLowerCase().trim(), e.id));

  // Build quick order-to-account map for fast account resolution
  const orderAccountMap = new Map();
  try {
    const cwoRows = db.prepare('SELECT order_code, account FROM current_work_orders WHERE work_date = ?').all(workDate);
    for (const r of cwoRows) {
      if (r.order_code && r.account) orderAccountMap.set(r.order_code, r.account);
    }
  } catch (_) {}

  try {
    const rawLogs = db.prepare(`
      SELECT employee_name, action, status, event_datetime, order_code
      FROM raw_log_records
      WHERE work_date = ?
      ORDER BY event_datetime ASC, id ASC
    `).all(workDate);

    if (rawLogs.length > 0) {
      for (const r of rawLogs) {
        const empId = nameToEmpId.get((r.employee_name || '').toLowerCase().trim());
        if (empId) {
          if (!empActivities.has(empId)) empActivities.set(empId, []);
          const acc = orderAccountMap.get(r.order_code) || null;
          empActivities.get(empId).push({
            id: `raw_${r.order_code}_${r.event_datetime}`,
            employee_id: empId,
            action: r.action,
            status: r.status || extractCanonicalStatus(r.action),
            timestamp: r.event_datetime,
            details: r.action,
            tracking_code: null,
            order_code: r.order_code,
            account: acc
          });
        }
      }
    } else {
      // Fallback to vendoor_logs ONLY if raw_log_records has no entries for this date
      const vLogs = db.prepare(`
        SELECT employee_name, matched_employee_id, action, action_classification, timestamp_str, order_code
        FROM vendoor_logs
        WHERE work_date = ?
        ORDER BY timestamp_str ASC, id ASC
      `).all(workDate);

      for (const vl of vLogs) {
        const empId = vl.matched_employee_id || nameToEmpId.get((vl.employee_name || '').toLowerCase().trim());
        if (empId) {
          if (!empActivities.has(empId)) empActivities.set(empId, []);
          const acc = orderAccountMap.get(vl.order_code) || null;
          empActivities.get(empId).push({
            id: `vl_${vl.order_code}_${vl.timestamp_str}`,
            employee_id: empId,
            action: vl.action,
            status: vl.action_classification || extractCanonicalStatus(vl.action),
            timestamp: vl.timestamp_str,
            details: vl.action,
            tracking_code: null,
            order_code: vl.order_code,
            account: acc
          });
        }
      }
    }
  } catch (_) {}

  // Sort each employee's activities chronologically
  for (const [empId, list] of empActivities.entries()) {
    list.sort((a, b) => {
      const ta = new Date(a.timestamp || 0).getTime() || 0;
      const tb = new Date(b.timestamp || 0).getTime() || 0;
      return ta - tb;
    });
  }

  // 5. Build Live Monitor Payload
  const employeesResult = csEmployees.map(emp => {
    const isWorkingToday = workingMap.has(emp.id);
    const stats = employeeOrderStats.get(emp.id) || { assigned: 0, claimed: 0, in_progress: 0, completed: 0 };
    const acts = empActivities.get(emp.id) || [];

    let lastActivityTime = null;
    let lastProductiveActivityTime = null;
    let lastAction = null;
    let lastProductiveAction = null;
    let lastOrderCode = null;
    let lastAccount = null;
    let lastDetails = null;

    // Deduplicate actions for accurate metric counts
    const dedupMap = new Map();
    const deduplicatedActs = [];
    const uniqueOrdersSet = new Set();
    let printedCount = 0;
    let pendingCount = 0;
    let cancelledCount = 0;
    let processingCount = 0;

    for (const act of acts) {
      lastActivityTime = act.timestamp;
      lastAction = act.action;
      lastOrderCode = act.order_code || lastOrderCode;
      if (act.account) lastAccount = act.account;
      else if (act.order_code && orderAccountMap.has(act.order_code)) lastAccount = orderAccountMap.get(act.order_code);
      lastDetails = act.details || lastDetails;

      if (act.order_code) {
        uniqueOrdersSet.add(act.order_code);
      }
      
      const actStr = String(act.action || '');
      const upperAct = actStr.toUpperCase();
      const isProductive = PRODUCTIVE_ACTIONS.has(upperAct) ||
        upperAct.includes('PRINT') || upperAct.includes('PROCESS') || upperAct.includes('CANCEL') ||
        upperAct.includes('PEND') || upperAct.includes('STAGE_CHANGE') || upperAct.includes('CLAIM') ||
        actStr.includes('عدل') || actStr.includes('أضاف') || actStr.includes('تغيير') ||
        actStr.includes('طباعة') || actStr.includes('تحويل') || actStr.includes('حذف');

      if (isProductive) {
        lastProductiveActivityTime = act.timestamp;
        lastProductiveAction = act.action;
      }

      const dt = act.timestamp ? new Date(act.timestamp).getTime() : 0;
      const actStatus = act.status || null;
      const key = `${act.order_code || 'none'}|${actStatus || act.action}`;
      const lastTime = dedupMap.get(key) || 0;
      if (dt - lastTime >= 120000 || lastTime === 0) {
        dedupMap.set(key, dt);
        deduplicatedActs.push(act);

        if (actStatus === 'Printed') printedCount++;
        else if (actStatus === 'Pending') pendingCount++;
        else if (actStatus === 'Cancelled') cancelledCount++;
        else if (actStatus === 'Processing') processingCount++;
      }
    }

    // Dynamic calculation of idle_seconds
    let idleSeconds = null;
    let idleFormatted = '—';
    let liveStatus = 'NO_ACTIVITY';

    if (isHistorical) {
      liveStatus = acts.length === 0 ? (isWorkingToday ? 'NO_ACTIVITY' : 'OFF_DUTY') : 'HISTORICAL';
      idleSeconds = null;
      idleFormatted = '—';
    } else {
      if (lastProductiveActivityTime) {
        const prodDt = parseCairoTimestamp(lastProductiveActivityTime) || new Date(lastProductiveActivityTime);
        const prodMs = prodDt.getTime();
        if (!isNaN(prodMs)) {
          idleSeconds = Math.max(0, Math.floor((refTime - prodMs) / 1000));
          idleFormatted = formatIdleDuration(idleSeconds);
        }
      }

      // Determine current live status
      if (!isWorkingToday) {
        liveStatus = acts.length > 0 ? (idleSeconds !== null && idleSeconds > criticalThreshold ? 'INACTIVE' : 'ACTIVE') : 'OFF_DUTY';
      } else {
        if (acts.length === 0) {
          liveStatus = 'NO_ACTIVITY';
        } else if (lastProductiveActivityTime === null) {
          liveStatus = 'INACTIVE';
        } else if (idleSeconds !== null) {
          if (idleSeconds <= inactiveThreshold) {
            liveStatus = 'ACTIVE';
          } else if (idleSeconds <= criticalThreshold) {
            liveStatus = 'INACTIVE';
          } else {
            liveStatus = 'CRITICAL';
          }
        }
      }
    }

    // Historical distinct orders worked check
    let historicalOrdersWorked = 0;
    try {
      const histSnap = db.prepare(`
        SELECT SUM(new_orders + printed_orders) as hist_o
        FROM performance_snapshots
        WHERE (employee_id = ? OR employee_name = ?) AND date < ?
      `).get(emp.id, emp.name, workDate);
      if (histSnap && histSnap.hist_o) historicalOrdersWorked = histSnap.hist_o;
    } catch (_) {}

    const statusRealActions = printedCount + pendingCount + cancelledCount + processingCount;

    return {
      employee_id: emp.id,
      employee_name: emp.name,
      department: emp.department,
      team_membership: emp.team_membership,
      working_today: isWorkingToday,
      live_status: liveStatus,
      is_idle: (liveStatus === 'INACTIVE' || liveStatus === 'CRITICAL'),
      assigned_orders: stats.assigned,
      claimed_orders: stats.claimed,
      in_progress_orders: stats.in_progress,
      completed_orders: stats.completed,
      unassigned_relevant_orders: totalUnassigned,
      orders_worked_today: uniqueOrdersSet.size,
      real_actions_today: statusRealActions,
      deduped_actions_today: deduplicatedActs.length,
      printed_orders: printedCount,
      pending_orders: pendingCount,
      cancelled_orders: cancelledCount,
      processing_orders: processingCount,
      historical_orders_worked: historicalOrdersWorked,
      last_activity_time: lastActivityTime,
      last_activity_action: lastAction,
      last_activity_order_code: lastOrderCode,
      last_activity_account: lastAccount,
      last_activity_details: lastDetails,
      last_productive_activity_time: lastProductiveActivityTime,
      last_productive_action: lastProductiveAction,
      idle_seconds: idleSeconds,
      idle_duration_formatted: idleFormatted,
      total_actions_today: acts.length
    };
  });

  return {
    work_date: workDate,
    is_historical: isHistorical,
    reference_time: new Date(refTime).toISOString(),
    unassigned_total: totalUnassigned,
    total_cs_employees: csEmployees.length,
    working_today_count: workingRows.filter(r => r.is_working === 1 || r.is_working === true || r.is_working === '1').length,
    employees: employeesResult
  };
}

export function getTeamLiveStatusSummary(workDate, options = {}) {
  const realtime = getEmployeeLiveRealtime(workDate, options);
  const emps = realtime.employees;

  let activeCount = 0;
  let inactiveCount = 0;
  let criticalCount = 0;
  let noActivityCount = 0;
  let totalAssigned = 0;
  let totalInProgress = 0;
  let totalCompleted = 0;

  for (const e of emps) {
    if (e.working_today) {
      if (e.live_status === 'ACTIVE') activeCount++;
      else if (e.live_status === 'INACTIVE') inactiveCount++;
      else if (e.live_status === 'CRITICAL') criticalCount++;
      else if (e.live_status === 'NO_ACTIVITY') noActivityCount++;

      totalAssigned += e.assigned_orders;
      totalInProgress += e.in_progress_orders;
      totalCompleted += e.completed_orders;
    }
  }

  return {
    work_date: workDate,
    working_today_count: realtime.working_today_count,
    active_count: activeCount,
    inactive_count: inactiveCount,
    critical_count: criticalCount,
    no_activity_count: noActivityCount,
    total_assigned: totalAssigned,
    total_in_progress: totalInProgress,
    total_completed: totalCompleted,
    unassigned_orders: realtime.unassigned_total,
    employees: emps
  };
}

