import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import XLSX from 'xlsx';
import { db } from './db/index.js';
import { parseDailyLogBuffer, parseSpecificOrdersBuffer } from './services/parser.js';
import { computePerformanceFromRecords, savePerformanceSnapshotToDB, getSystemWeights } from './services/performance.js';
import {
  saveCurrentWorkOrders,
  stageSpecificOrdersFile,
  mergeSpecificOrdersPool,
  getSpecificOrdersPoolStatus,
  getCurrentOrders,
  getCurrentAccounts,
  getAccountAvailableStatuses,
  getAvailableOrdersCount,
  getCurrentWorkOverview,
  saveWorkAllocation,
  getAllocationForDate,
  updateAllocationItem,
  deleteAllocationItem,
  deleteAllocationForDate,
  generateCopyAllocationText,
  getAllocationHistory
} from './services/allocation.js';
import { createExcelWorkbook } from './export_excel.js';

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';
const ROOT_DIR = process.cwd();
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Multer in-memory storage for Excel uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

// Serve static frontend
app.use(express.static(PUBLIC_DIR));

// -------------------------------------------------------------
// 1. HEALTH & SYSTEM CONFIG
// -------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'CS Executive BI - Enterprise Edition' });
});

app.get('/api/config/weights', (req, res) => {
  res.json(getSystemWeights());
});

app.put('/api/config/weights', (req, res) => {
  const { w_prod, w_print, w_pend, w_canc, w_proc, min_actions } = req.body;
  const update = db.prepare('INSERT INTO system_configs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime("now")');
  const tx = db.transaction(() => {
    if (w_prod !== undefined) update.run('weight_productivity', String(w_prod));
    if (w_print !== undefined) update.run('weight_printed', String(w_print));
    if (w_pend !== undefined) update.run('weight_pending_control', String(w_pend));
    if (w_canc !== undefined) update.run('weight_cancel_control', String(w_canc));
    if (w_proc !== undefined) update.run('weight_processing', String(w_proc));
    if (min_actions !== undefined) update.run('min_actions_threshold', String(min_actions));
  });
  tx();
  res.json({ success: true, weights: getSystemWeights() });
});

// -------------------------------------------------------------
// 2. EMPLOYEE MASTER & TEAM MANAGEMENT (Part 11, 12)
// -------------------------------------------------------------
function normalizeEmpName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

app.get('/api/employees', (req, res) => {
  try {
    const { department, active } = req.query;
    let sql = 'SELECT * FROM employees WHERE 1=1';
    const params = [];
    if (department) {
      sql += ' AND department = ?';
      params.push(department);
    }
    if (active !== undefined) {
      sql += ' AND active = ?';
      params.push(active === 'true' || active === '1' ? 1 : 0);
    }
    sql += ' ORDER BY department ASC, name COLLATE NOCASE ASC';
    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/employees/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid employee ID' });
    }
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    if (!emp) {
      return res.status(404).json({ success: false, error: 'Employee not found' });
    }
    res.json({ success: true, employee: emp });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/employees', (req, res) => {
  const { name, department, active } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, error: 'Employee name is required' });
  }
  const cleanName = name.trim().replace(/\s+/g, ' ');
  const normName = cleanName.toLowerCase();

  try {
    // Sensible normalized duplicate check against existing master
    const allEmployees = db.prepare('SELECT id, name FROM employees').all();
    const duplicate = allEmployees.find(e => normalizeEmpName(e.name) === normName);
    if (duplicate) {
      return res.status(409).json({ success: false, error: `Employee "${duplicate.name}" already exists` });
    }

    const dept = (department && typeof department === 'string' && department.trim())
      ? department.trim()
      : (cleanName.toLowerCase().endsWith('cs') ? 'CS' : 'Data Entry');
    
    let activeVal = 1;
    if (active !== undefined) {
      activeVal = (active === 1 || active === true || active === '1' || active === 'true') ? 1 : 0;
    }

    const info = db.prepare(
      "INSERT INTO employees (name, department, active, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
    ).run(cleanName, dept, activeVal);

    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(info.lastInsertRowid);
    return res.status(201).json({
      success: true,
      employee,
      id: employee.id,
      name: employee.name,
      department: employee.department,
      active: employee.active
    });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ success: false, error: 'Employee already exists' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/employees/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid employee ID' });
  }

  try {
    const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Employee not found' });
    }

    const { name, department, active } = req.body || {};
    let updatedName = existing.name;
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ success: false, error: 'Employee name cannot be empty' });
      }
      const cleanName = name.trim().replace(/\s+/g, ' ');
      const normName = cleanName.toLowerCase();
      // Sensible normalized duplicate check against other employees (ID remains stable!)
      const otherEmployees = db.prepare('SELECT id, name FROM employees WHERE id != ?').all(id);
      const duplicate = otherEmployees.find(e => normalizeEmpName(e.name) === normName);
      if (duplicate) {
        return res.status(409).json({ success: false, error: `Employee "${duplicate.name}" already exists` });
      }
      updatedName = cleanName;
    }

    let updatedDept = existing.department;
    if (department !== undefined && typeof department === 'string' && department.trim()) {
      updatedDept = department.trim();
    }

    let updatedActive = existing.active;
    if (active !== undefined) {
      updatedActive = (active === 1 || active === true || active === '1' || active === 'true') ? 1 : 0;
    }

    db.prepare(
      "UPDATE employees SET name = ?, department = ?, active = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(updatedName, updatedDept, updatedActive, id);

    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    return res.json({
      success: true,
      employee,
      id: employee.id,
      name: employee.name,
      department: employee.department,
      active: employee.active
    });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ success: false, error: 'Employee name already in use' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/employees/:id/status', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid employee ID' });
  }

  try {
    const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Employee not found' });
    }

    const { active } = req.body || {};
    const newActive = (active === 1 || active === true || active === '1' || active === 'true') ? 1 : 0;

    db.prepare("UPDATE employees SET active = ?, updated_at = datetime('now') WHERE id = ?").run(newActive, id);
    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    return res.json({
      success: true,
      employee,
      id: employee.id,
      name: employee.name,
      active: employee.active
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// 3. TODAY'S WORKING TEAM (Part 12)
// -------------------------------------------------------------
app.get('/api/working-team/:date', (req, res) => {
  try {
    const { date } = req.params;
    const rows = db.prepare(`
      SELECT e.id, e.name, e.department, e.active,
        CASE WHEN dwt.id IS NOT NULL AND (dwt.is_working IS NULL OR dwt.is_working = 1) THEN 1 ELSE 0 END as is_working
      FROM employees e
      LEFT JOIN daily_working_team dwt ON e.id = dwt.employee_id AND dwt.work_date = ?
      WHERE e.active = 1 AND e.department = 'CS'
      ORDER BY e.name COLLATE NOCASE ASC
    `).all(date);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching working team:', err);
    res.status(500).json({ error: err.message });
  }
});

const setWorkingTeam = (req, res) => {
  try {
    const { date } = req.params;
    const { employee_ids, members } = req.body; // array of employee IDs or objects
    let idsToSet = [];
    if (Array.isArray(employee_ids)) {
      idsToSet = employee_ids.map(id => typeof id === 'object' ? id.employee_id : parseInt(id, 10)).filter(Boolean);
    } else if (Array.isArray(members)) {
      idsToSet = members.filter(m => m.is_working !== false && m.is_working !== 0).map(m => parseInt(m.employee_id || m.id, 10)).filter(Boolean);
    } else {
      return res.status(400).json({ error: 'employee_ids must be an array' });
    }

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(date);
      const insert = db.prepare('INSERT INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)');
      for (const eid of idsToSet) {
        insert.run(date, eid);
      }
    });

    tx();
    res.json({ success: true, count: idsToSet.length, date });
  } catch (err) {
    console.error('Error setting working team:', err);
    res.status(500).json({ error: err.message });
  }
};

app.post('/api/working-team/:date', setWorkingTeam);
app.put('/api/working-team/:date', setWorkingTeam);

// -------------------------------------------------------------
// 4. WORK ALLOCATION & CURRENT WORK (Parts 13 to 25, 39, 40)
// -------------------------------------------------------------
app.get('/api/work/current', (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const overview = getCurrentWorkOverview(date);
    res.json(overview);
  } catch (err) {
    console.error('Error in /api/work/current:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get(['/api/work/accounts', '/api/accounts/current/:date'], (req, res) => {
  try {
    const date = req.params.date || req.query.date || new Date().toISOString().split('T')[0];
    const accounts = getCurrentAccounts(date);
    res.json(accounts);
  } catch (err) {
    console.error('Error in /api/work/accounts:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/work/account-statuses', (req, res) => {
  try {
    const { date, account } = req.query;
    if (!date || !account) {
      return res.status(400).json({ error: 'date and account are required' });
    }
    const statuses = getAccountAvailableStatuses(date, account);
    res.json(statuses);
  } catch (err) {
    console.error('Error in /api/work/account-statuses:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/work/available-orders', (req, res) => {
  try {
    const { date, account, status } = req.query;
    if (!date || !account || !status) {
      return res.status(400).json({ error: 'date, account and status are required' });
    }
    const countInfo = getAvailableOrdersCount(date, account, status);
    res.json(countInfo);
  } catch (err) {
    console.error('Error in /api/work/available-orders:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/allocations', '/api/allocations/:date'], (req, res) => {
  const workDate = req.params.date || req.body.work_date;
  const { assignments, notes } = req.body;
  if (!workDate || !Array.isArray(assignments)) {
    return res.status(400).json({ error: 'work_date and assignments array are required' });
  }
  try {
    const result = saveWorkAllocation(workDate, assignments, notes);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/allocations/:date', (req, res) => {
  const { date } = req.params;
  const allocation = getAllocationForDate(date);
  if (!allocation) {
    return res.json({ exists: false, date, by_employee: [] });
  }
  res.json({ exists: true, ...allocation });
});

app.put('/api/allocations/:id', (req, res) => {
  const { id } = req.params;
  try {
    const result = updateAllocationItem(parseInt(id, 10), req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/allocations/:id', (req, res) => {
  const { id } = req.params;
  try {
    const result = deleteAllocationItem(parseInt(id, 10));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/allocations/date/:date', (req, res) => {
  const { date } = req.params;
  try {
    const result = deleteAllocationForDate(date);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/allocations/:date/summary', (req, res) => {
  const { date } = req.params;
  const format = req.query.format || 'standard';
  const text = generateCopyAllocationText(date, format);
  res.json({ date, format, text });
});

app.get(['/api/allocations-history', '/api/allocations/history'], (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 60;
  const history = getAllocationHistory(limit);
  res.json(history);
});

// -------------------------------------------------------------
// 5. UPLOADS & SPECIFIC ORDERS TWO-FILE MERGE (Part 4, 30, 54)
// -------------------------------------------------------------
app.post('/api/uploads/daily-log', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No Excel file uploaded' });
  }

  const workDate = req.body.work_date || new Date().toISOString().split('T')[0];

  try {
    // 1. Fetch DB employees map for classification
    const allEmps = db.prepare('SELECT name, department FROM employees').all();
    const empMap = new Map();
    for (const e of allEmps) {
      empMap.set(e.name, e.department);
    }

    // 2. Parse file
    const { records, summary } = parseDailyLogBuffer(req.file.buffer, empMap);

    // 3. Compute deduplicated performance and corrected order-level KPIs
    const metrics = computePerformanceFromRecords(records);

    // 4. Save to uploaded_files audit record
    const insertFile = db.prepare(`
      INSERT INTO uploaded_files (
        file_name, file_type, upload_date, row_count, valid_rows, skipped_rows, notes
      ) VALUES (?, 'daily_log', datetime('now'), ?, ?, ?, ?)
    `);
    const fileRes = insertFile.run(
      req.file.originalname,
      summary.totalRows,
      summary.validRows,
      summary.skippedRows,
      `Parsed ${metrics.summary.totalRealActions} real actions, ${metrics.summary.totalNewOrders} unique orders`
    );
    const sourceFileId = fileRes.lastInsertRowid;

    // 5. Save performance snapshot to DB (without auto-creating employees)
    savePerformanceSnapshotToDB(workDate, metrics, sourceFileId);

    res.json({
      success: true,
      message: 'Daily Log processed and snapshot saved successfully.',
      source_file_id: sourceFileId,
      work_date: workDate,
      summary: {
        file_name: req.file.originalname,
        total_rows: summary.totalRows,
        valid_rows: summary.validRows,
        skipped_rows: summary.skippedRows,
        deduped_actions: metrics.summary.totalRealActions,
        duplicates_removed_pct: metrics.summary.duplicatesRemovedPct,
        unique_new_orders: metrics.summary.totalNewOrders,
        unique_printed_orders: metrics.summary.uniquePrintedOrders,
        current_pending_backlog: metrics.summary.currentPendingBacklog,
        unique_cancelled_orders: metrics.summary.uniqueCancelledOrders,
        total_alt_phones: metrics.summary.totalAltPhones,
        agents_count: metrics.employees.length,
      },
      metrics,
    });
  } catch (err) {
    console.error('Error processing Daily Log:', err);
    res.status(500).json({ error: 'Failed to process Daily Log: ' + err.message });
  }
});

/**
 * Upload Specific Orders file (Slot 1 or Slot 2)
 * Supports Two-File Specific Orders Workflow per day (Part 4, 30, 54)
 */
app.post('/api/uploads/specific-orders', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No Excel file uploaded' });
  }

  const workDate = req.body.work_date || new Date().toISOString().split('T')[0];
  const fileSlot = parseInt(req.body.file_slot, 10) === 2 ? 2 : 1;

  try {
    // Stage file slot in database
    const stagedInfo = stageSpecificOrdersFile(
      workDate,
      fileSlot,
      req.file.originalname,
      req.file.buffer,
      req.file.size
    );

    // Auto-merge staged files into Current Orders Pool
    let mergeSummary = null;
    try {
      mergeSummary = mergeSpecificOrdersPool(workDate);
    } catch (mergeErr) {
      console.warn('Auto-merge note:', mergeErr.message);
    }

    res.json({
      success: true,
      message: `Specific Orders File #${fileSlot} processed and merged into current work pool.`,
      staged: stagedInfo,
      merge_summary: mergeSummary,
      summary: mergeSummary ? {
        file_name: req.file.originalname,
        file_slot: fileSlot,
        total_rows: stagedInfo.row_count,
        valid_rows: stagedInfo.valid_orders_count,
        unique_orders: mergeSummary.unique_orders,
        merged_orders: mergeSummary.merged_orders,
        duplicates_count: mergeSummary.duplicates_count,
        duplicates_explanation: mergeSummary.duplicates_explanation,
        current_accounts_count: mergeSummary.accounts_count,
        current_accounts: mergeSummary.accounts,
      } : {
        file_name: req.file.originalname,
        file_slot: fileSlot,
        total_rows: stagedInfo.row_count,
        valid_rows: stagedInfo.valid_orders_count,
        unique_orders: stagedInfo.valid_orders_count,
      }
    });
  } catch (err) {
    console.error('Error processing Specific Orders:', err);
    res.status(400).json({ error: 'Failed to process Specific Orders: ' + err.message });
  }
});

/**
 * Merge Specific Orders File 1 and File 2 for date
 */
app.post('/api/uploads/specific-orders/merge', (req, res) => {
  const workDate = req.body.work_date || new Date().toISOString().split('T')[0];
  try {
    const summary = mergeSpecificOrdersPool(workDate);
    res.json({
      success: true,
      message: 'Specific Orders File 1 and File 2 merged successfully.',
      ...summary
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Get Specific Orders Pool status & metadata for date
 */
app.get('/api/orders/pool-status/:date', (req, res) => {
  const { date } = req.params;
  const status = getSpecificOrdersPoolStatus(date);
  res.json(status);
});

/**
 * Current Orders Pool orders list with search, filter, and pagination
 */
app.get('/api/orders/current/:date', (req, res) => {
  const { date } = req.params;
  const { account, status, search, limit, offset } = req.query;
  const ordersData = getCurrentOrders(date, {
    account,
    status,
    search,
    limit: parseInt(limit, 10) || 100,
    offset: parseInt(offset, 10) || 0
  });
  const poolStatus = getSpecificOrdersPoolStatus(date);
  res.json({
    ...ordersData,
    pool_status: poolStatus
  });
});

app.get('/api/uploads', (req, res) => {
  const rows = db.prepare('SELECT * FROM uploaded_files ORDER BY upload_date DESC LIMIT 50').all();
  res.json(rows);
});

// -------------------------------------------------------------
// 6. PERFORMANCE & REPORTING (Parts 26, 27, 28, 29, 74, 75)
// -------------------------------------------------------------
app.get('/api/performance/:date', (req, res) => {
  const { date } = req.params;
  const snapshots = db.prepare('SELECT * FROM performance_snapshots WHERE date = ? ORDER BY performance_score DESC').all(date);
  if (!snapshots || snapshots.length === 0) {
    return res.status(404).json({ exists: false, message: `No performance snapshot found for date: ${date}` });
  }
  const totalActions = snapshots.reduce((s, r) => s + (r.real_actions || 0), 0);
  const totalNew = snapshots.reduce((s, r) => s + (r.new_orders || 0), 0);
  const totalPrinted = snapshots.reduce((s, r) => s + (r.printed_orders || 0), 0);
  const totalPending = snapshots.reduce((s, r) => s + (r.pending_backlog || 0), 0);
  const totalCancelled = snapshots.reduce((s, r) => s + (r.cancelled_orders || 0), 0);
  const totalAlt = snapshots.reduce((s, r) => s + (r.alt_phones || 0), 0);

  res.json({
    exists: true,
    date,
    totals: {
      actions: totalActions,
      new_orders: totalNew,
      printed: totalPrinted,
      pending: totalPending,
      cancelled: totalCancelled,
      alt_phones: totalAlt,
    },
    employees: snapshots,
    top_performers: snapshots.slice(0, 10),
    most_active: [...snapshots].sort((a, b) => b.real_actions - a.real_actions).slice(0, 10)
  });
});
app.get('/api/performance/employee/:id', (req, res) => {
  const { id } = req.params;
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  const snapshots = db.prepare(`
    SELECT * FROM performance_snapshots
    WHERE employee_id = ?
    ORDER BY date DESC
  `).all(id);

  res.json({
    employee: emp,
    snapshots,
  });
});

app.get('/api/reports/performance', (req, res) => {
  const { start_date, end_date } = req.query;
  let sql = 'SELECT * FROM performance_snapshots WHERE 1=1';
  const params = [];
  if (start_date) {
    sql += ' AND date >= ?';
    params.push(start_date);
  }
  if (end_date) {
    sql += ' AND date <= ?';
    params.push(end_date);
  }
  sql += ' ORDER BY date ASC, performance_score DESC';

  const rows = db.prepare(sql).all(...params);

  // Group by employee for true weighted aggregation (Part 74, 75)
  const byEmp = new Map();
  for (const r of rows) {
    if (!byEmp.has(r.employee_name)) {
      byEmp.set(r.employee_name, {
        employee_id: r.employee_id,
        name: r.employee_name,
        real_actions: 0,
        printed: 0,
        pending: 0,
        processing: 0,
        cancelled: 0,
        alt: 0,
        added: 0,
        score_sum: 0,
        snapshot_count: 0,
      });
    }
    const acc = byEmp.get(r.employee_name);
    acc.real_actions += r.real_actions;
    acc.printed += r.printed_orders || r.printed_actions;
    acc.pending += r.pending_actions;
    acc.processing += r.processing_actions;
    acc.cancelled += r.cancelled_orders || r.cancelled_actions;
    acc.alt += r.alt_phones;
    acc.added += r.added_orders;
    acc.score_sum += r.performance_score;
    acc.snapshot_count++;
  }

  const aggregated = Array.from(byEmp.values()).map(e => {
    const act = e.real_actions;
    const own_printed_rate = act > 0 ? Math.round((e.printed / act) * 1000) / 10 : 0;
    const own_cancel_rate = act > 0 ? Math.round((e.cancelled / act) * 1000) / 10 : 0;
    const own_pending_rate = act > 0 ? Math.round((e.pending / act) * 1000) / 10 : 0;
    const avg_score = e.snapshot_count > 0 ? Math.round((e.score_sum / e.snapshot_count) * 10) / 10 : 0;
    return {
      ...e,
      own_printed_rate,
      own_cancel_rate,
      own_pending_rate,
      performance_score: avg_score,
    };
  }).sort((a, b) => b.performance_score - a.performance_score);

  res.json({
    date_range: { start_date, end_date },
    records_count: rows.length,
    employees: aggregated,
  });
});

// -------------------------------------------------------------
// 7. COMPATIBILITY & EXPORTS (Part 58)
// -------------------------------------------------------------
app.get('/api/data', (req, res) => {
  const dataJsonPath = path.join(ROOT_DIR, 'data.json');
  if (fs.existsSync(dataJsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(dataJsonPath, 'utf-8'));
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to read data.json' });
    }
  }
  res.status(404).json({ error: 'Data not found' });
});

app.get(['/api/export/excel', '/Executive_Report_v3.xlsx'], (req, res) => {
  const dataJsonPath = path.join(ROOT_DIR, 'data.json');
  if (fs.existsSync(dataJsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(dataJsonPath, 'utf-8'));
      const wb = createExcelWorkbook(data);
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="Executive_Report_v3.xlsx"');
      return res.send(buffer);
    } catch (err) {
      console.error('Failed to generate dynamic Excel:', err);
    }
  }
  const fallbackPath = path.join(PUBLIC_DIR, 'Executive_Report_v3.xlsx');
  if (fs.existsSync(fallbackPath)) {
    return res.sendFile(fallbackPath);
  }
  res.status(404).send('Excel report not found');
});

// Global API error handler ensuring all /api endpoints return JSON, not HTML
app.use('/api', (err, req, res, next) => {
  console.error('Unhandled API Error:', err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
});

// Fallback to index.html
app.get('*', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Dashboard not found.');
  }
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, HOST, () => {
    console.log(`CS Executive BI server running on http://${HOST}:${PORT}`);
  });
}

export { app, db };
