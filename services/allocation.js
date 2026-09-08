import { db } from '../db/index.js';
import { parseSpecificOrdersBuffer } from './parser.js';

/**
 * Stage an uploaded Specific Orders file (Slot 1 or Slot 2) for a given date
 * (Part 4, 30, 54)
 */
export function stageSpecificOrdersFile(workDate, fileSlot, fileName, bufferOrOrders, fileSize = 0) {
  const slot = parseInt(fileSlot, 10) === 2 ? 2 : 1;
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
 * Merge Specific Orders File 1 and File 2 into ONE Current Orders Pool for that day
 * Deterministic deduplication, account preservation, and clear audit metrics
 * (Part 4, 30, 54)
 */
export function mergeSpecificOrdersPool(workDate) {
  const file1 = db.prepare('SELECT * FROM specific_orders_uploads WHERE work_date = ? AND file_slot = 1').get(workDate);
  const file2 = db.prepare('SELECT * FROM specific_orders_uploads WHERE work_date = ? AND file_slot = 2').get(workDate);

  if (!file1 && !file2) {
    throw new Error(`No Specific Orders files have been uploaded for date: ${workDate}. Please upload File #1 and/or File #2.`);
  }

  const orders1 = file1 ? JSON.parse(file1.raw_orders_json || '[]') : [];
  const orders2 = file2 ? JSON.parse(file2.raw_orders_json || '[]') : [];
  const mergedOrdersCount = orders1.length + orders2.length;

  const consolidatedMap = new Map();
  const duplicates = [];
  let intra1Dups = 0;
  let intra2Dups = 0;
  let crossDups = 0;

  // 1. Process File 1
  for (const ord of orders1) {
    if (!consolidatedMap.has(ord.order_code)) {
      consolidatedMap.set(ord.order_code, { ...ord, source_file_slot: 1 });
    } else {
      intra1Dups++;
      duplicates.push({
        order_code: ord.order_code,
        account: ord.account,
        file_slot: 1,
        status: ord.status,
        reason: 'Duplicate order code within File 1'
      });
    }
  }

  // 2. Process File 2
  for (const ord of orders2) {
    if (!consolidatedMap.has(ord.order_code)) {
      consolidatedMap.set(ord.order_code, { ...ord, source_file_slot: 2 });
    } else {
      const existing = consolidatedMap.get(ord.order_code);
      crossDups++;
      let resolvedStatus = existing.status;
      let reason = 'Duplicate order code in both File 1 and File 2.';
      if (existing.status !== ord.status) {
        resolvedStatus = (existing.status === 'Pending' || ord.status === 'Pending') ? 'Pending' : ord.status;
        reason += ` Status differed ('${existing.status}' vs '${ord.status}'). Resolved to '${resolvedStatus}'.`;
      } else {
        reason += ' Preserved unique order.';
      }
      duplicates.push({
        order_code: ord.order_code,
        account: ord.account || existing.account,
        file_slot: 2,
        status: ord.status,
        existing_status: existing.status,
        resolved_status: resolvedStatus,
        reason
      });
      existing.status = resolvedStatus;
    }
  }

  const uniqueOrders = Array.from(consolidatedMap.values());
  const duplicateOrdersCount = mergedOrdersCount - uniqueOrders.length;
  const duplicatesExplanation = duplicateOrdersCount > 0
    ? `Consolidated ${mergedOrdersCount} orders across files into ${uniqueOrders.length} unique orders. Resolved ${duplicateOrdersCount} duplicate occurrences (${crossDups} cross-file, ${intra1Dups + intra2Dups} intra-file). Active statuses and merchant accounts preserved without double-counting.`
    : 'All orders are distinct across uploaded files. No duplicates detected.';

  // Save to database
  const insertOrder = db.prepare(`
    INSERT INTO current_work_orders (
      source_file_id, work_date, order_code, account, status, order_date, source_file_slot
    ) VALUES (null, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    // Clear today's current orders
    db.prepare('DELETE FROM current_work_orders WHERE work_date = ?').run(workDate);

    for (const ord of uniqueOrders) {
      insertOrder.run(
        workDate,
        ord.order_code,
        ord.account,
        ord.status,
        ord.order_date || null,
        ord.source_file_slot || 1
      );
    }

    const insertSummary = db.prepare(`
      INSERT INTO current_work_pool_summary (
        work_date,
        file1_name, file1_rows, file1_orders,
        file2_name, file2_rows, file2_orders,
        merged_orders_count, unique_orders_count, duplicate_orders_count,
        duplicate_details_json, duplicates_explanation, merged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(work_date) DO UPDATE SET
        file1_name = excluded.file1_name,
        file1_rows = excluded.file1_rows,
        file1_orders = excluded.file1_orders,
        file2_name = excluded.file2_name,
        file2_rows = excluded.file2_rows,
        file2_orders = excluded.file2_orders,
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
  const file1 = db.prepare('SELECT id, work_date, file_slot, file_name, file_size, row_count, valid_orders_count, upload_date FROM specific_orders_uploads WHERE work_date = ? AND file_slot = 1').get(workDate);
  const file2 = db.prepare('SELECT id, work_date, file_slot, file_name, file_size, row_count, valid_orders_count, upload_date FROM specific_orders_uploads WHERE work_date = ? AND file_slot = 2').get(workDate);
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
    INSERT INTO current_work_orders (source_file_id, work_date, order_code, account, status, order_date)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_date, order_code) DO UPDATE SET
      account = excluded.account,
      status = excluded.status,
      order_date = excluded.order_date,
      updated_at = datetime('now')
  `);

  const tx = db.transaction(() => {
    for (const ord of orders) {
      insertOrder.run(
        fileId,
        workDate,
        ord.order_code,
        ord.account,
        ord.status,
        ord.order_date
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
export function getCurrentAccounts(workDate) {
  const rows = db.prepare(`
    SELECT DISTINCT account
    FROM current_work_orders
    WHERE work_date = ?
    ORDER BY account COLLATE NOCASE ASC
  `).all(workDate);

  return rows.map(r => r.account);
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
  try {
    const teamRow = db.prepare(`
      SELECT COUNT(*) as team_count
      FROM daily_working_team
      WHERE work_date = ? AND is_working = 1
    `).get(workDate);
    teamCount = teamRow ? (teamRow.team_count || 0) : 0;
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

  return {
    work_date: workDate,
    total_orders: orderRow ? (orderRow.total_orders || 0) : 0,
    accounts_count: orderRow ? (orderRow.accounts_count || 0) : 0,
    new_count: orderRow ? (orderRow.new_count || 0) : 0,
    pending_count: orderRow ? (orderRow.pending_count || 0) : 0,
    working_team_count: teamCount,
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
  `).all(header.id);

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
 * Generate formatted text for WhatsApp/Teams (Standard & Compact)
 * (Part 23, 24, 52)
 */
export function generateCopyAllocationText(workDate, format = 'standard') {
  const alloc = getAllocationForDate(workDate);
  if (!alloc || alloc.by_employee.length === 0) {
    return 'لا يوجد توزيع مسجل لهذا اليوم.';
  }

  const d = new Date(workDate);
  const formattedDate = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  if (format === 'compact') {
    const lines = [`📋 توزيع شغل اليوم (${formattedDate})`];
    for (const emp of alloc.by_employee) {
      const accStr = emp.accounts.map(a => `${a.account} - ${a.status}`).join(' | ');
      lines.push(`${emp.employee_name}: ${accStr}`);
    }
    return lines.join('\n\n');
  }

  // Standard clean format requested in Part 23 & 52
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
