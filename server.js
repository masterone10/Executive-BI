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
  deleteSpecificOrdersFile,
  mergeSpecificOrdersPool,
  processAutoDetectedUpload,
  getUploadsBusinessDatesSummary,
  getSpecificOrdersPoolStatus,
  getCurrentOrders,
  getCurrentAccounts,
  getCurrentAccountsWithCounts,
  getAccountAvailableStatuses,
  getAvailableOrdersCount,
  getCurrentWorkOverview,
  saveWorkAllocation,
  getAllocationForDate,
  updateAllocationItem,
  deleteAllocationItem,
  deleteAllocationForDate,
  generateCopyAllocationText,
  getAllocationHistory,
  getAccountRules,
  getAccountRuleForAccount,
  saveAccountRule,
  deleteAccountRule,
  getAllKnownAccounts,
  getAccountExceptions,
  saveAccountException,
  deleteAccountException,
  getEmployeeTeamMemberships,
  updateEmployeeTeamMembership,
  bulkUpdateTeamMembership,
  getWorkingTeam,
  saveWorkingTeam,
  generateOrderLevelAllocation,
  saveFinalOrderLevelAllocation,
  manualOverrideOrderAllocation,
  getOrderLevelAllocation,
  getEmployeeAssignedOrders,
  getAllocationVersions,
  getAccountOwners,
  reassignAccountOwner,
  getAccountReassignmentLogs
} from './services/allocation.js';
import {
  inspectExcelSchema,
  persistDailyLogRecords,
  getOrderTracking,
  getEmployeeTracking,
  getAccountTracking,
  getTrackingOverview,
  getTeamTrackingSummary,
  getSourcesUploadStatus,
  isDailyLogUploaded,
  getRangeTracking,
  getAccountsDirectory,
  getAccountDetailedData,
  getOperationalDashboardData
} from './services/tracking.js';
import {
  createExcelWorkbook,
  createEmployeeAllocationWorkbook,
  createAccountWorkbook,
  createZipFromEmployeeWorkbooks
} from './export_excel.js';
import {
  getSafeVendoorStatus,
  getVendoorConfig,
  performVendoorAutoLogin,
  testVendoorOrdersAccess,
  testVendoorLogsAccess,
  testVendoorAuthAccess,
  setRuntimeVendoorCredentials,
  clearRuntimeVendoorCredentials,
  testVendoorLiveLogin,
  getRecentConnectionTests,
  syncVendoorOrders,
  syncVendoorLogs,
  getSyncRunsHistory,
  getIdentityMappingsQueue,
  saveExplicitIdentityMapping,
  deleteExplicitIdentityMapping,
  getFullEmployeeProductivityProfiles,
  getProductivityConfig,
  getCompletedOrdersForDate,
  getEmployeeWorkloadAndRefillStates,
  getUnallocatedOrdersPool,
  getDispatcherConfig,
  updateDispatcherConfig,
  runDispatcherCycle,
  startContinuousDispatcher,
  stopContinuousDispatcher,
  getDispatcherStatus,
  getDispatcherAuditHistory,
  getDispatcherAlerts,
  reconcileHistoricalWindow,
  startAutonomousVendoorPoller,
  stopAutonomousVendoorPoller,
  getAutonomousPollerStatus,
  getEffectiveWorkDate,
  bootstrapHistoricalTwoMonths,
  getHistoricalBootstrapStatus
} from './services/vendoor/index.js';
import {
  generateExecutiveSummaryReport,
  generateEmployeeReport,
  generateAccountReport,
  generateAllocationReport,
  generateActivityLogsReport,
  generateProductivityReport,
  generateDispatcherReport,
  generateDataQualityReport,
  generateSystemHealthReport,
  exportReportToCSV,
  exportReportToExcel,
  saveReportRecord,
  getReportHistory,
  getReportById
} from './services/reports.js';

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';
const ROOT_DIR = process.cwd();
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

// Process level safety
process.on('uncaughtException', (err) => {
  console.error('CS Executive BI uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('CS Executive BI unhandledRejection:', reason);
});

// Ensure public directory & index.html exist
if (!fs.existsSync(PUBLIC_DIR)) {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}
if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html')) && fs.existsSync(path.join(ROOT_DIR, 'build.js'))) {
  try {
    const { execSync } = await import('child_process');
    console.log('Generating dashboard bundle on server startup...');
    execSync('node build.js', { stdio: 'inherit' });
  } catch (buildErr) {
    console.error('Auto-build failed:', buildErr);
  }
}

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
    let sql = 'SELECT id, name, department, active, team_membership, notes, created_at, updated_at FROM employees WHERE 1=1';
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
    const emp = db.prepare('SELECT id, name, department, active, team_membership, notes, created_at, updated_at FROM employees WHERE id = ?').get(id);
    if (!emp) {
      return res.status(404).json({ success: false, error: 'Employee not found' });
    }
    res.json({ success: true, employee: emp });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/employees', (req, res) => {
  const { name, department, active, team_membership, notes } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, error: 'Employee name is required' });
  }
  const cleanName = name.trim().replace(/\s+/g, ' ');
  const normName = cleanName.toLowerCase();

  try {
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

    let teamMem = 'Both';
    if (team_membership && ['New', 'Pending', 'Both'].includes(team_membership)) {
      teamMem = team_membership;
    }

    const info = db.prepare(
      "INSERT INTO employees (name, department, active, team_membership, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).run(cleanName, dept, activeVal, teamMem, notes || null);

    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(info.lastInsertRowid);
    return res.status(201).json({
      success: true,
      employee,
      id: employee.id,
      name: employee.name,
      department: employee.department,
      active: employee.active,
      team_membership: employee.team_membership,
      notes: employee.notes
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

    const { name, department, active, team_membership, notes } = req.body || {};
    let updatedName = existing.name;
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ success: false, error: 'Employee name cannot be empty' });
      }
      const cleanName = name.trim().replace(/\s+/g, ' ');
      const normName = cleanName.toLowerCase();
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

    let updatedTeamMem = existing.team_membership || 'Both';
    if (team_membership !== undefined && ['New', 'Pending', 'Both'].includes(team_membership)) {
      updatedTeamMem = team_membership;
    }

    let updatedNotes = notes !== undefined ? notes : existing.notes;

    db.prepare(
      "UPDATE employees SET name = ?, department = ?, active = ?, team_membership = ?, notes = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(updatedName, updatedDept, updatedActive, updatedTeamMem, updatedNotes, id);

    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    return res.json({
      success: true,
      employee,
      id: employee.id,
      name: employee.name,
      department: employee.department,
      active: employee.active,
      team_membership: employee.team_membership,
      notes: employee.notes
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
// 2B. TEAM MEMBERSHIP PERMANENT ASSIGNMENT
// -------------------------------------------------------------
app.get('/api/team-membership', (req, res) => {
  try {
    const memberships = getEmployeeTeamMemberships();
    res.json(memberships);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/team-membership/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { team_membership } = req.body;
    const updated = updateEmployeeTeamMembership(id, team_membership);
    res.json({ success: true, employee: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/team-membership/bulk', (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates)) {
      return res.status(400).json({ error: 'updates array is required' });
    }
    const result = bulkUpdateTeamMembership(updates);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 3. TODAY'S WORKING TEAM (Part 12)
// -------------------------------------------------------------
app.get('/api/working-team/:date', (req, res) => {
  try {
    const { date } = req.params;
    const team = getWorkingTeam(date);
    res.json(team);
  } catch (err) {
    console.error('Error fetching working team:', err);
    res.status(500).json({ error: err.message });
  }
});

const handleSaveWorkingTeam = (req, res) => {
  try {
    const { date } = req.params;
    const { employee_ids, employeeIds, ids, members } = req.body;
    let list = [];
    if (Array.isArray(members)) {
      list = members;
    } else if (Array.isArray(employee_ids || employeeIds || ids)) {
      list = (employee_ids || employeeIds || ids).map(id => ({ employee_id: id, is_working: true }));
    } else {
      return res.status(400).json({ error: 'members array or employee_ids array required' });
    }
    const result = saveWorkingTeam(date, list);
    res.json(result);
  } catch (err) {
    console.error('Error setting working team:', err);
    res.status(500).json({ error: err.message });
  }
};

app.post('/api/working-team/:date', handleSaveWorkingTeam);
app.put('/api/working-team/:date', handleSaveWorkingTeam);

// -------------------------------------------------------------
// 3B. ACCOUNT RULES & ACCOUNT EXCEPTIONS
// -------------------------------------------------------------
app.get('/api/account-rules', (req, res) => {
  try {
    const rules = getAccountRules();
    res.json(rules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get(['/api/accounts/all', '/api/accounts-all'], (req, res) => {
  try {
    const accounts = getAllKnownAccounts();
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/account-rules', (req, res) => {
  try {
    const result = saveAccountRule(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/account-rules/:id', (req, res) => {
  try {
    const result = deleteAccountRule(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/account-exceptions', (req, res) => {
  try {
    const exceptions = getAccountExceptions(req.query.date);
    res.json(exceptions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/account-exceptions', (req, res) => {
  try {
    const result = saveAccountException(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/account-exceptions/:id', (req, res) => {
  try {
    const result = deleteAccountException(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 4. WORK ALLOCATION & CURRENT WORK (Parts 13 to 25, 39, 40)
// -------------------------------------------------------------
app.get('/api/global-context', (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const overview = getCurrentWorkOverview(date);
    const vendoor = getSafeVendoorStatus();
    const dispatcher = getDispatcherStatus ? getDispatcherStatus() : { is_running: false };

    res.json({
      work_date: date,
      vendoor: {
        connection_state: vendoor.connection_state || 'NOT_CONFIGURED',
        session_state: vendoor.session_state || 'NOT_AUTHENTICATED',
        has_credentials: Boolean(vendoor.has_credentials),
        has_active_session: Boolean(vendoor.has_active_session),
        auth_method: vendoor.auth_method || 'AUTO_LOGIN',
        email_preview: vendoor.email_preview || null
      },
      working_team_count: overview.working_team_count || 0,
      total_orders: overview.total_orders || 0,
      accounts_count: overview.accounts_count || 0,
      new_orders: overview.new_count || 0,
      pending_orders: overview.pending_count || 0,
      allocated_count: overview.allocated_count || 0,
      unallocated_count: overview.unallocated_count || 0,
      completed_count: overview.completed_count || 0,
      dispatcher: {
        is_running: Boolean(dispatcher && dispatcher.is_running),
        status: dispatcher && dispatcher.is_running ? 'ACTIVE' : 'IDLE',
        polling_interval_ms: dispatcher ? dispatcher.polling_interval_ms : 60000
      }
    });
  } catch (err) {
    console.error('Error in /api/global-context:', err);
    res.status(500).json({ error: err.message });
  }
});

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
    if (req.query.detailed === 'true' || req.query.include_counts === 'true') {
      const accounts = getCurrentAccountsWithCounts(date);
      return res.json(accounts);
    }
    const accounts = getCurrentAccounts(date);
    res.json(accounts);
  } catch (err) {
    console.error('Error in /api/work/accounts:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/work/accounts-detailed', (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const accounts = getCurrentAccountsWithCounts(date);
    res.json(accounts);
  } catch (err) {
    console.error('Error in /api/work/accounts-detailed:', err);
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

/**
 * GENERATE ORDER-LEVEL ALLOCATION (Automatic Engine)
 */
app.post('/api/allocations/:date/generate', (req, res) => {
  const { date } = req.params;
  const { method, account_specific_rules, regenerate } = req.body || {};
  try {
    const result = generateOrderLevelAllocation(date, {
      method: method || 'fair_random',
      account_specific_rules,
      regenerate: regenerate === true
    });
    res.json(result);
  } catch (err) {
    console.error('Error generating allocation:', err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * SAVE FINAL ORDER-LEVEL ALLOCATION
 */
app.post('/api/allocations/:date/save-order-level', (req, res) => {
  const { date } = req.params;
  const { allocations, notes, generated_by } = req.body || {};
  try {
    const result = saveFinalOrderLevelAllocation(date, req.body, notes, generated_by);
    res.json(result);
  } catch (err) {
    console.error('Error saving order level allocation:', err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * MANUAL OVERRIDE SINGLE ORDER ALLOCATION
 */
app.post('/api/allocations/:date/override', (req, res) => {
  const { date } = req.params;
  const { version, order_code, employee_id } = req.body || {};
  if (!order_code || !employee_id) {
    return res.status(400).json({ error: 'order_code and employee_id are required' });
  }
  try {
    const result = manualOverrideOrderAllocation(date, version, order_code, employee_id);
    res.json(result);
  } catch (err) {
    console.error('Error overriding allocation:', err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET ORDER-LEVEL ALLOCATION
 */
app.get('/api/allocations/:date/order-level', (req, res) => {
  const { date } = req.params;
  const { version } = req.query;
  try {
    const data = getOrderLevelAllocation(date, version ? parseInt(version, 10) : undefined);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET ACCOUNT OWNERS FOR DATE
 */
app.get('/api/allocations/:date/account-owners', (req, res) => {
  const { date } = req.params;
  try {
    const owners = getAccountOwners(date);
    res.json(owners);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * REASSIGN ACCOUNT OWNER (Supervisor Reassignment)
 */
app.post('/api/allocations/:date/reassign-account', (req, res) => {
  const { date } = req.params;
  const { account, employee_id, reason, reassigned_by } = req.body || {};
  if (!account || !employee_id) {
    return res.status(400).json({ error: 'account and employee_id are required' });
  }
  try {
    const result = reassignAccountOwner(date, account, employee_id, reason || 'Supervisor Reassignment', reassigned_by || 'Supervisor');
    res.json(result);
  } catch (err) {
    console.error('Error reassigning account owner:', err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET ACCOUNT REASSIGNMENT LOGS
 */
app.get('/api/allocations/:date/reassignment-logs', (req, res) => {
  const { date } = req.params;
  try {
    const logs = getAccountReassignmentLogs(date);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET ALLOCATION VERSIONS
 */
app.get('/api/allocations/:date/versions', (req, res) => {
  const { date } = req.params;
  try {
    const versions = getAllocationVersions(date);
    res.json(versions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * EXPORT SINGLE EMPLOYEE ALLOCATION WORKBOOK
 */
app.get('/api/allocations/:date/export-employee/:employeeId', (req, res) => {
  const { date, employeeId } = req.params;
  const { version } = req.query;
  try {
    const employeeData = getEmployeeAssignedOrders(date, parseInt(employeeId, 10), version ? parseInt(version, 10) : undefined);
    if (!employeeData) {
      return res.status(404).json({ error: 'Employee allocation not found' });
    }
    const wb = createEmployeeAllocationWorkbook(employeeData);
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const safeName = (employeeData.employee_name || 'Employee').replace(/[^a-zA-Z0-9_\u0600-\u06FF]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Allocation_${safeName}_${date}.xlsx"`);
    return res.send(buffer);
  } catch (err) {
    console.error('Export employee workbook error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * EXPORT ALL EMPLOYEES ALLOCATION WORKBOOKS AS ZIP
 */
app.get('/api/allocations/:date/export-all-zip', async (req, res) => {
  const { date } = req.params;
  const { version } = req.query;
  try {
    const alloc = getOrderLevelAllocation(date, version ? parseInt(version, 10) : undefined);
    if (!alloc || !alloc.by_employee || alloc.by_employee.length === 0) {
      return res.status(404).json({ error: 'No employee allocations found for date' });
    }

    const employeeList = alloc.by_employee.map(emp => {
      const orders = (alloc.orders || []).filter(o => o.employee_id === emp.employee_id);
      return {
        employee_id: emp.employee_id,
        employee_name: emp.employee_name,
        date: date,
        orders: orders
      };
    });

    const zipBuffer = await createZipFromEmployeeWorkbooks(employeeList, date);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="All_Allocations_${date}.zip"`);
    return res.send(zipBuffer);
  } catch (err) {
    console.error('Export all ZIP error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Legacy Account-Level Allocation Save & Fetch for backward compatibility
 */
app.post(['/api/allocations', '/api/allocations/:date'], (req, res) => {
  const workDate = req.params.date || req.body.work_date || req.body.date;
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

app.get(['/api/allocations/:date/summary', '/api/allocations/:date/copy-text'], (req, res) => {
  const { date } = req.params;
  const format = req.query.format || 'all_employees';
  const target = req.query.target || req.query.employee_id || req.query.account || null;
  const text = generateCopyAllocationText(date, format, target);
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
    const metrics = computePerformanceFromRecords(records, empMap);

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

    // Persist raw records for Order, Employee, and Account Tracking (Phase 22)
    persistDailyLogRecords(workDate, sourceFileId, records);

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
  const fileSlot = req.body.file_slot ? parseInt(req.body.file_slot, 10) : null;

  try {
    // Stage file in database (dynamic slot: 1, 2, 3...)
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
      message: `Specific Orders file '${req.file.originalname}' (File #${stagedInfo.file_slot}) staged and merged into pool.`,
      staged: stagedInfo,
      merge_summary: mergeSummary,
      summary: mergeSummary ? {
        file_name: req.file.originalname,
        file_slot: stagedInfo.file_slot,
        total_rows: stagedInfo.row_count,
        valid_rows: stagedInfo.valid_orders_count,
        unique_orders: mergeSummary.unique_orders,
        merged_orders: mergeSummary.merged_orders,
        duplicates_count: mergeSummary.duplicates_count,
        duplicates_explanation: mergeSummary.duplicates_explanation,
        current_accounts_count: mergeSummary.accounts_count,
        current_accounts: mergeSummary.accounts,
        files_count: mergeSummary.files_count,
        files: mergeSummary.files
      } : {
        file_name: req.file.originalname,
        file_slot: stagedInfo.file_slot,
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
 * Remove a file from the Specific Orders staging pool
 */
app.delete('/api/uploads/specific-orders/:date/:slot', (req, res) => {
  try {
    const result = deleteSpecificOrdersFile(req.params.date, req.params.slot);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/uploads/specific-orders/remove', (req, res) => {
  const { work_date, file_slot } = req.body;
  if (!work_date || file_slot === undefined) {
    return res.status(400).json({ error: 'work_date and file_slot are required' });
  }
  try {
    const result = deleteSpecificOrdersFile(work_date, file_slot);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Universal Auto-Detect Upload Endpoint (Single or Multi-File)
 * Automatically detects Business Date & Source Type from file contents.
 * Routes records to their correct business dates without forcing today's date.
 */
app.post('/api/uploads/auto-detect', upload.array('files'), (req, res) => {
  const files = req.files || (req.file ? [req.file] : []);
  if (files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  const manualOverrideDate = req.body.work_date || null;
  const processedFiles = [];
  const datesSummaryMap = new Map();
  const errors = [];

  for (const file of files) {
    try {
      const result = processAutoDetectedUpload(
        file.buffer,
        file.originalname,
        manualOverrideDate,
        file.size
      );
      processedFiles.push(result);

      for (const r of result.results_by_date) {
        if (!datesSummaryMap.has(r.business_date)) {
          datesSummaryMap.set(r.business_date, {
            business_date: r.business_date,
            new_orders: 0,
            pending_orders: 0,
            eod_actions: 0,
            unique_orders: 0,
            files_count: 0,
            status: 'Ready for Allocation'
          });
        }
        const s = datesSummaryMap.get(r.business_date);
        s.files_count++;
        if (r.source_type === 'NEW' || r.file_slot === 1) {
          s.new_orders += (r.orders_count || 0);
          s.unique_orders = Math.max(s.unique_orders, r.unique_orders || s.new_orders);
        } else if (r.source_type === 'PENDING' || r.file_slot === 2) {
          s.pending_orders += (r.orders_count || 0);
          s.unique_orders = Math.max(s.unique_orders, r.unique_orders || (s.new_orders + s.pending_orders));
        } else if (r.source_type === 'EOD_DAILY_LOG') {
          s.eod_actions += (r.real_actions || 0);
        }
      }
    } catch (err) {
      console.error(`Error auto-processing file ${file.originalname}:`, err);
      errors.push({
        file_name: file.originalname,
        error: err.message
      });
    }
  }

  // Refresh exact pool metrics from database for each detected date
  for (const [bDate, s] of datesSummaryMap.entries()) {
    try {
      const poolStatus = getSpecificOrdersPoolStatus(bDate);
      if (poolStatus) {
        if (poolStatus.total_orders > 0) {
          s.unique_orders = poolStatus.total_orders;
        }
        if (poolStatus.files_count > 0) {
          s.files_count = poolStatus.files_count;
        }
        if (poolStatus.summary) {
          s.duplicates_count = poolStatus.summary.duplicate_orders_count || 0;
          s.merged_orders = poolStatus.summary.merged_orders_count || 0;
        }
        s.accounts_count = poolStatus.accounts_count || 0;
      }
    } catch (_) {}
  }

  const detectedDates = Array.from(datesSummaryMap.values()).sort((a, b) => b.business_date.localeCompare(a.business_date));

  res.json({
    success: errors.length < files.length,
    total_files_uploaded: files.length,
    processed_count: processedFiles.length,
    failed_count: errors.length,
    files: processedFiles,
    detected_dates: detectedDates,
    errors: errors.length > 0 ? errors : null,
    message: `Processed ${processedFiles.length} file(s) across ${detectedDates.length} detected business date(s).`
  });
});

/**
 * Get summary of all detected business dates and their readiness
 */
app.get('/api/uploads/detected-dates', (req, res) => {
  try {
    const summary = getUploadsBusinessDatesSummary();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
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

/**
 * ============================================================
 * SCHEMA DISCOVERY & REAL FILE INSPECTION API (PHASE 1, 6)
 * ============================================================
 */
app.post('/api/uploads/schema-inspect', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No Excel file provided for inspection' });
  }
  const sourceHint = req.body.source_hint || 'auto';
  try {
    const report = inspectExcelSchema(req.file.buffer, sourceHint);
    res.json({
      success: true,
      file_name: req.file.originalname,
      file_size: req.file.size,
      report,
    });
  } catch (err) {
    res.status(400).json({ error: 'Failed to inspect Excel schema: ' + err.message });
  }
});

/**
 * Upload New Orders (Slot 1 - Opening New Inventory) (Phase 1, 3)
 */
app.post('/api/uploads/new-orders', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No Excel file uploaded' });
  const workDate = req.body.work_date || new Date().toISOString().split('T')[0];
  try {
    const stagedInfo = stageSpecificOrdersFile(workDate, 1, req.file.originalname, req.file.buffer, req.file.size);
    let mergeSummary = null;
    try { mergeSummary = mergeSpecificOrdersPool(workDate); } catch (_) {}
    res.json({
      success: true,
      message: 'New Orders (Opening New Inventory) uploaded and staged in Slot 1.',
      staged: stagedInfo,
      merge_summary: mergeSummary,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Upload Pending Orders (Slot 2 - Opening Pending Inventory) (Phase 1, 3)
 */
app.post('/api/uploads/pending-orders', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No Excel file uploaded' });
  const workDate = req.body.work_date || new Date().toISOString().split('T')[0];
  try {
    const stagedInfo = stageSpecificOrdersFile(workDate, 2, req.file.originalname, req.file.buffer, req.file.size);
    let mergeSummary = null;
    try { mergeSummary = mergeSpecificOrdersPool(workDate); } catch (_) {}
    res.json({
      success: true,
      message: 'Pending Orders (Opening Pending Inventory) uploaded and staged in Slot 2.',
      staged: stagedInfo,
      merge_summary: mergeSummary,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * ============================================================
 * ORDER & EMPLOYEE TRACKING APIS (PHASE 23)
 * ============================================================
 */

// GET /api/tracking/overview (handles ?date=YYYY-MM-DD)
app.get('/api/tracking/overview', (req, res) => {
  const date = req.query.date || req.query.workDate || new Date().toISOString().slice(0, 10);
  try {
    const data = getTrackingOverview(date);
    res.json(data);
  } catch (err) {
    console.error('Tracking overview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tracking/:date/team-summary (Phase 12: Daily Employee & Team Tracking Summary)
app.get('/api/tracking/:date/team-summary', (req, res) => {
  const { date } = req.params;
  try {
    const data = getTeamTrackingSummary(date);
    res.json(data);
  } catch (err) {
    console.error('Tracking team summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tracking/:date/sources-status (Upload source integrity check)
app.get('/api/tracking/:date/sources-status', (req, res) => {
  const { date } = req.params;
  try {
    const data = getSourcesUploadStatus(date);
    res.json(data);
  } catch (err) {
    console.error('Tracking sources status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tracking/:date/audit (Audit & data quality)
app.get('/api/tracking/:date/audit', (req, res) => {
  const { date } = req.params;
  try {
    const data = getTrackingOverview(date);
    res.json(data.data_quality_audit);
  } catch (err) {
    console.error('Tracking audit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tracking/:date (Overview dashboard & audit)
app.get('/api/tracking/:date', (req, res) => {
  const { date } = req.params;
  try {
    const data = getTrackingOverview(date);
    res.json(data);
  } catch (err) {
    console.error('Tracking overview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tracking/:date/order/:orderCode (Order tracking & chronological timeline)
app.get('/api/tracking/:date/order/:orderCode', (req, res) => {
  const { date, orderCode } = req.params;
  try {
    const data = getOrderTracking(date, orderCode);
    res.json(data);
  } catch (err) {
    console.error('Order tracking error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tracking/:date/employee/:employeeId (Employee tracking: assigned vs worked)
app.get('/api/tracking/:date/employee/:employeeId', (req, res) => {
  const { date, employeeId } = req.params;
  try {
    const data = getEmployeeTracking(date, employeeId);
    res.json(data);
  } catch (err) {
    console.error('Employee tracking error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tracking/:date/account/:account (Account tracking: opening vs worked)
app.get('/api/tracking/:date/account/:account', (req, res) => {
  const { date, account } = req.params;
  try {
    const data = getAccountTracking(date, account);
    res.json(data);
  } catch (err) {
    console.error('Account tracking error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts/directory/:date (Accounts Directory)
app.get(['/api/accounts/directory/:date', '/api/accounts-directory/:date', '/api/accounts-list/:date'], (req, res) => {
  const { date } = req.params;
  try {
    const data = getAccountsDirectory(date);
    res.json(data);
  } catch (err) {
    console.error('Accounts directory error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts/details/:date/:account (Account Detailed Data across 4 views)
app.get(['/api/accounts/details/:date/:account', '/api/accounts-details/:date/:account'], (req, res) => {
  const { date, account } = req.params;
  try {
    const data = getAccountDetailedData(date, account);
    res.json(data);
  } catch (err) {
    console.error('Account details error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts/export/:date/:account (Account 4-Sheet Excel Workbook Export)
app.get(['/api/accounts/export/:date/:account', '/api/accounts-export/:date/:account'], (req, res) => {
  const { date, account } = req.params;
  try {
    const accountData = getAccountDetailedData(date, account);
    const wb = createAccountWorkbook(accountData);
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const safeName = (account || 'Account').replace(/[^a-zA-Z0-9_\u0600-\u06FF]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Account_${safeName}_${date}.xlsx"`);
    return res.send(buffer);
  } catch (err) {
    console.error('Export account workbook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tracking/range?start=YYYY-MM-DD&end=YYYY-MM-DD (Multi-day date range tracking)
app.get('/api/tracking/range', (req, res) => {
  const startDate = req.query.start || req.query.startDate;
  const endDate = req.query.end || req.query.endDate;
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'start and end query parameters are required (YYYY-MM-DD)' });
  }
  try {
    const data = getRangeTracking(startDate, endDate);
    res.json(data);
  } catch (err) {
    console.error('Range tracking error:', err);
    res.status(500).json({ error: err.message });
  }
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
  if (snapshots && snapshots.length > 0) {
    const totalActions = snapshots.reduce((s, r) => s + (r.real_actions || 0), 0);
    const totalNew = snapshots.reduce((s, r) => s + (r.new_orders || 0), 0);
    const totalPrinted = snapshots.reduce((s, r) => s + (r.printed_orders || 0), 0);
    const totalPending = snapshots.reduce((s, r) => s + (r.pending_backlog || 0), 0);
    const totalCancelled = snapshots.reduce((s, r) => s + (r.cancelled_orders || 0), 0);
    const totalAlt = snapshots.reduce((s, r) => s + (r.alt_phones || 0), 0);

    return res.json({
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
  }

  // Check daily_metrics_snapshots
  const snap = db.prepare('SELECT metrics_json FROM daily_metrics_snapshots WHERE work_date = ?').get(date);
  if (snap && snap.metrics_json) {
    try {
      const parsed = JSON.parse(snap.metrics_json);
      const emps = parsed.employees || [];
      const tot = parsed.log_totals || {};
      return res.json({
        exists: true,
        date,
        totals: {
          actions: tot.actions || 0,
          new_orders: parsed.hr?.tot_new || 0,
          printed: tot.printed || 0,
          pending: tot.pending || 0,
          cancelled: tot.cancelled || 0,
          alt_phones: tot.alt || 0,
        },
        employees: emps,
        top_performers: [...emps].sort((a,b)=>(b.performance_score||0)-(a.performance_score||0)).slice(0, 10),
        most_active: [...emps].sort((a,b)=>(b.actions||0)-(a.actions||0)).slice(0, 10)
      });
    } catch(e) {}
  }

  return res.status(404).json({ exists: false, date, message: `No performance snapshot found for date: ${date}` });
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

// Helper to reconstruct complete payload from performance snapshots
function reconstructPayloadFromSnapshots(date, rows) {
  const totalActions = rows.reduce((s, r) => s + (r.real_actions || 0), 0);
  const totalNew = rows.reduce((s, r) => s + (r.new_orders || 0), 0);
  const totalPrinted = rows.reduce((s, r) => s + (r.printed_orders || 0), 0);
  const totalPending = rows.reduce((s, r) => s + (r.pending_backlog || 0), 0);
  const totalCancelled = rows.reduce((s, r) => s + (r.cancelled_orders || 0), 0);
  const totalProcessing = rows.reduce((s, r) => s + (r.processing_orders || 0), 0);
  const totalAlt = rows.reduce((s, r) => s + (r.alt_phones || 0), 0);
  const totalAdded = rows.reduce((s, r) => s + (r.added_orders || 0), 0);

  const teamCancelRate = totalActions > 0 ? Math.round((totalCancelled / totalActions) * 1000) / 10 : 0;
  const teamPendingRate = totalActions > 0 ? Math.round((totalPending / totalActions) * 1000) / 10 : 0;

  const employees = rows.map((r, i) => ({
    rank: i + 1,
    name: r.employee_name,
    actions: r.real_actions || 0,
    printed: r.printed_orders || 0,
    pending: r.pending_backlog || 0,
    cancelled: r.cancelled_orders || 0,
    processing: r.processing_orders || 0,
    alt: r.alt_phones || 0,
    added: r.added_orders || 0,
    own_printed_rate: r.own_printed_rate || 0,
    own_pending_rate: r.own_pending_rate || 0,
    own_cancel_rate: r.own_cancel_rate || 0,
    own_proc_rate: r.own_proc_rate || 0,
    own_alt_rate: r.own_alt_rate || 0,
    performance_score: r.performance_score || 0,
    contribution_pct: r.contribution_pct || 0,
    grade: r.grade || 'B',
    segment: r.segment || 'Core Contributor',
    cancel_risk: r.cancel_risk || 'Normal',
  }));

  const csAddedRows = rows
    .filter(r => r.employee_name.toLowerCase().endsWith('cs') && (r.added_orders || 0) > 0)
    .map(r => ({ name: r.employee_name, count: r.added_orders, total: r.added_orders }))
    .sort((a, b) => b.count - a.count);

  const totalCSAdded = csAddedRows.reduce((s, r) => s + r.count, 0);

  return {
    hr: {
      days: 1,
      tot_new: totalNew,
      tot_printed: totalPrinted,
      tot_cancel: totalCancelled,
      tot_add: totalAdded,
      avg_new: totalNew,
      avg_printed_pct: totalNew > 0 ? Math.round((totalPrinted / totalNew) * 1000) / 10 : 0,
      avg_cancel_pct: totalNew > 0 ? Math.round((totalCancelled / totalNew) * 1000) / 10 : 0,
      avg_add_pct: totalNew > 0 ? Math.round((totalAdded / totalNew) * 1000) / 10 : 0,
    },
    daily: [{
      day: date,
      dow: '',
      new: totalNew,
      printed: totalPrinted,
      cancel: totalCancelled,
      add: totalAdded,
      printed_pct: totalNew > 0 ? Math.round((totalPrinted / totalNew) * 1000) / 10 : 0,
      cancel_pct: totalNew > 0 ? Math.round((totalCancelled / totalNew) * 1000) / 10 : 0,
      add_pct: totalNew > 0 ? Math.round((totalAdded / totalNew) * 1000) / 10 : 0,
    }],
    log_totals: {
      actions: totalActions,
      printed: totalPrinted,
      pending: totalPending,
      processing: totalProcessing,
      cancelled: totalCancelled,
      alt: totalAlt,
    },
    status_totals: {
      Printed: totalPrinted,
      Pending: totalPending,
      Processing: totalProcessing,
      Cancelled: totalCancelled,
    },
    dedup: {
      removed: 0,
      removed_pct: 0,
    },
    team_cancel_rate: teamCancelRate,
    team_pending_rate: teamPendingRate,
    employees,
    rankings: {
      printed: [...employees].sort((a, b) => b.printed - a.printed).slice(0, 10).map(e => ({ name: e.name, value: e.printed })),
      pending: [...employees].sort((a, b) => b.pending - a.pending).slice(0, 10).map(e => ({ name: e.name, value: e.pending })),
      cancelled: [...employees].sort((a, b) => b.cancelled - a.cancelled).slice(0, 10).map(e => ({ name: e.name, value: e.cancelled })),
    },
    cancel_rate_rank: [...employees].sort((a, b) => b.own_cancel_rate - a.own_cancel_rate).map(e => ({ name: e.name, value: e.own_cancel_rate })),
    added_all_top: csAddedRows.slice(0, 15),
    added_cs: totalCSAdded,
    added_noncs: Math.max(0, totalAdded - totalCSAdded),
    fromCS: totalCSAdded,
    fromOtherDepartments: Math.max(0, totalAdded - totalCSAdded),
    topCSContributor: csAddedRows[0] ? csAddedRows[0].name : null,
    topCSContributors: csAddedRows.slice(0, 5),
    allCSContributors: csAddedRows,
    addedOrders: {
      totalAdded,
      totalAddedCS: totalCSAdded,
      totalAddedNonCS: Math.max(0, totalAdded - totalCSAdded),
      fromCS: totalCSAdded,
      fromOtherDepartments: Math.max(0, totalAdded - totalCSAdded),
      topCSContributor: csAddedRows[0] ? csAddedRows[0].name : null,
      topCSContributors: csAddedRows.slice(0, 5),
      allCSContributors: csAddedRows,
    },
    insights: [],
    observations: [],
  };
}

// -------------------------------------------------------------
// 7. COMPATIBILITY & EXPORTS (Part 58)
// -------------------------------------------------------------
app.get('/api/data', (req, res) => {
  const reqDate = req.query.date || getEffectiveWorkDate();

  try {
    const dashboardData = getOperationalDashboardData(reqDate);
    return res.json(dashboardData);
  } catch (err) {
    console.error('Failed to get operational dashboard data for date', reqDate, err);
    return res.status(500).json({ exists: false, error: err.message });
  }
});

// Added Orders CS Breakdown API Endpoint (Part 33, 34, 60, 85)
app.get(['/api/added-orders', '/api/reports/added-orders'], (req, res) => {
  const reqDate = req.query.date || getEffectiveWorkDate();

  try {
    // 1. Check daily_metrics_snapshots
    const snap = db.prepare('SELECT metrics_json FROM daily_metrics_snapshots WHERE work_date = ?').get(reqDate);
    if (snap && snap.metrics_json) {
      const parsed = JSON.parse(snap.metrics_json);
      const added = parsed.addedOrders || {};
      return res.json({
        exists: true,
        date: reqDate,
        totalAdded: added.totalAdded || ((parsed.added_cs || 0) + (parsed.added_noncs || 0)),
        fromCS: parsed.fromCS ?? parsed.added_cs ?? 0,
        fromOtherDepartments: parsed.fromOtherDepartments ?? parsed.added_noncs ?? 0,
        topCSContributor: parsed.topCSContributor || added.topCSContributor || null,
        topCSContributors: parsed.topCSContributors || added.topCSContributors || [],
        allCSContributors: parsed.allCSContributors || added.allCSContributors || [],
      });
    }

    // 2. Check performance_snapshots
    const rows = db.prepare('SELECT employee_name, added_orders FROM performance_snapshots WHERE date = ? ORDER BY added_orders DESC').all(reqDate);
    if (rows && rows.length > 0) {
      const csRows = rows
        .filter(r => r.employee_name.toLowerCase().endsWith('cs') && (r.added_orders || 0) > 0)
        .map(r => ({ name: r.employee_name, count: r.added_orders, total: r.added_orders }));
      const totalAdded = rows.reduce((s, r) => s + (r.added_orders || 0), 0);
      const csAdded = csRows.reduce((s, r) => s + r.count, 0);
      return res.json({
        exists: true,
        date: reqDate,
        totalAdded,
        fromCS: csAdded,
        fromOtherDepartments: Math.max(0, totalAdded - csAdded),
        topCSContributor: csRows[0] ? csRows[0].name : null,
        topCSContributors: csRows.slice(0, 5),
        allCSContributors: csRows,
      });
    }

    // 3. Empty state for date with no data
    return res.json({
      exists: false,
      date: reqDate,
      totalAdded: 0,
      fromCS: 0,
      fromOtherDepartments: 0,
      topCSContributor: null,
      topCSContributors: [],
      allCSContributors: [],
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get(['/api/export/excel', '/Executive_Report_v3.xlsx'], (req, res) => {
  const reqDate = req.query.date || getEffectiveWorkDate();
  try {
    const snap = db.prepare('SELECT metrics_json FROM daily_metrics_snapshots WHERE work_date = ?').get(reqDate);
    const data = snap && snap.metrics_json ? JSON.parse(snap.metrics_json) : getOperationalDashboardData(reqDate);
    const wb = createExcelWorkbook(data);
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Executive_Report_v3.xlsx"');
    return res.send(buffer);
  } catch (err) {
    console.error('Failed to generate dynamic Excel:', err);
    const fallbackPath = path.join(PUBLIC_DIR, 'Executive_Report_v3.xlsx');
    if (fs.existsSync(fallbackPath)) {
      return res.sendFile(fallbackPath);
    }
    return res.status(500).send('Failed to generate Excel report');
  }
});

// -------------------------------------------------------------
// 8. VENDOOR INTEGRATION (Phase 1 Access Proof)
// -------------------------------------------------------------
app.get('/api/integrations/vendoor/status', (req, res) => {
  try {
    const status = getSafeVendoorStatus();
    return res.json({ success: true, ...status });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/integrations/vendoor/credentials', (req, res) => {
  try {
    const { email, password, baseUrl, action } = req.body || {};
    if (action === 'clear') {
      clearRuntimeVendoorCredentials();
      return res.json({ success: true, message: 'Runtime Vendoor credentials cleared.', status: getSafeVendoorStatus() });
    }
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Both email and password are required.' });
    }
    setRuntimeVendoorCredentials({ email, password, baseUrl });
    return res.json({
      success: true,
      message: 'Runtime Vendoor credentials configured in memory securely.',
      status: getSafeVendoorStatus()
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/integrations/vendoor/test/login', async (req, res) => {
  try {
    const result = await testVendoorAuthAccess();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/integrations/vendoor/test/orders', async (req, res) => {
  try {
    const { length, fromDate, toDate, statusFilter, search, forceMode } = req.body || {};
    const result = await testVendoorOrdersAccess({
      length,
      fromDate,
      toDate,
      statusFilter,
      search,
      forceMode
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/integrations/vendoor/test/logs', async (req, res) => {
  try {
    const { startDate, endDate, start_date, end_date, forceMode } = req.body || {};
    const result = await testVendoorLogsAccess({
      startDate: startDate || start_date,
      endDate: endDate || end_date,
      forceMode
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/integrations/vendoor/history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const history = getRecentConnectionTests(limit);
    return res.json({ success: true, history });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// 9. VENDOOR PHASE 2: SYNC, IDENTITY MATCHING & PRODUCTIVITY
// -------------------------------------------------------------
app.post('/api/integrations/vendoor/sync/orders', async (req, res) => {
  try {
    const { fromDate, toDate, maxPages, pageSize, statusFilter, forceMode } = req.body || {};
    const result = await syncVendoorOrders({
      fromDate,
      toDate,
      maxPages,
      pageSize,
      statusFilter,
      forceMode
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/integrations/vendoor/sync/logs', async (req, res) => {
  try {
    const { startDate, endDate, start_date, end_date, forceMode } = req.body || {};
    const result = await syncVendoorLogs({
      startDate: startDate || start_date,
      endDate: endDate || end_date,
      forceMode
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/integrations/vendoor/sync/all', async (req, res) => {
  try {
    const { workDate, fromDate, toDate, forceMode } = req.body || {};
    const targetDate = workDate || fromDate || new Date().toISOString().slice(0, 10);
    const targetEndDate = toDate || targetDate;

    // 1. Sync orders
    const ordersResult = await syncVendoorOrders({
      fromDate: targetDate,
      toDate: targetEndDate,
      forceMode
    });

    // 2. Sync logs
    const logsResult = await syncVendoorLogs({
      startDate: targetDate,
      endDate: targetEndDate,
      forceMode
    });

    return res.json({
      success: ordersResult.success && logsResult.success,
      work_date: targetDate,
      orders_sync: ordersResult,
      logs_sync: logsResult
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/integrations/vendoor/sync/history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const runs = getSyncRunsHistory(limit);
    return res.json({ success: true, runs });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/integrations/vendoor/reconcile-history', async (req, res) => {
  try {
    const days = parseInt(req.body?.days, 10) || 3;
    const result = await reconcileHistoricalWindow({ days, forceMode: req.body?.forceMode });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/integrations/vendoor/bootstrap-2months', async (req, res) => {
  try {
    const { endDate, toDate, days, chunkDays } = req.body || {};
    const result = await bootstrapHistoricalTwoMonths({
      endDate: endDate || toDate,
      days: days || 60,
      chunkDays: chunkDays || 2
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/integrations/vendoor/bootstrap-status', (req, res) => {
  try {
    const status = getHistoricalBootstrapStatus();
    return res.json({ success: true, ...status });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/integrations/vendoor/poller/status', (req, res) => {
  try {
    const status = getAutonomousPollerStatus();
    return res.json({ success: true, ...status });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/integrations/vendoor/poller/start', (req, res) => {
  try {
    const intervalMs = parseInt(req.body?.intervalMs, 10) || 60000;
    const result = startAutonomousVendoorPoller({ intervalMs, forceMode: req.body?.forceMode });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/integrations/vendoor/poller/stop', (req, res) => {
  try {
    const result = stopAutonomousVendoorPoller();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/integrations/vendoor/identity/queue', (req, res) => {
  try {
    const filter = req.query.filter || 'ALL';
    const result = getIdentityMappingsQueue(filter);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/integrations/vendoor/identity/map', (req, res) => {
  try {
    const { vendoor_name, employee_id, notes } = req.body || {};
    if (!vendoor_name || !employee_id) {
      return res.status(400).json({ success: false, error: 'Both vendoor_name and employee_id are required' });
    }
    const result = saveExplicitIdentityMapping(vendoor_name, parseInt(employee_id, 10), notes);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/integrations/vendoor/identity/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const result = deleteExplicitIdentityMapping(id);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/integrations/vendoor/productivity', (req, res) => {
  try {
    const workDate = req.query.date || new Date().toISOString().slice(0, 10);
    const profiles = getFullEmployeeProductivityProfiles(workDate);
    const config = getProductivityConfig();
    return res.json({ success: true, date: workDate, config, profiles });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// VENDOOR PHASE 3: CONTINUOUS AUTO DISPATCHER & SMART REFILL
// -------------------------------------------------------------
app.get('/api/vendoor/dispatcher/status', (req, res) => {
  try {
    const status = getDispatcherStatus();
    return res.json({ success: true, ...status });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/vendoor/dispatcher/cycle', async (req, res) => {
  try {
    const { dryRun, workDate, forceRun } = req.body || {};
    const result = await runDispatcherCycle({
      dryRun,
      workDate,
      forceRun: forceRun !== undefined ? forceRun : true, // Explicit trigger can run single cycle
      trigger: 'MANUAL_CYCLE'
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/vendoor/dispatcher/start', (req, res) => {
  try {
    const { interval_ms } = req.body || {};
    const result = startContinuousDispatcher(interval_ms);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/vendoor/dispatcher/stop', (req, res) => {
  try {
    const result = stopContinuousDispatcher();
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/vendoor/dispatcher/config', (req, res) => {
  try {
    const updates = req.body || {};
    for (const [k, v] of Object.entries(updates)) {
      updateDispatcherConfig(k, v);
    }
    const current = getDispatcherConfig();
    return res.json({ success: true, config: current });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/vendoor/dispatcher/workloads', (req, res) => {
  try {
    const workDate = req.query.date || new Date().toISOString().slice(0, 10);
    const workloads = getEmployeeWorkloadAndRefillStates(workDate);
    return res.json({ success: true, date: workDate, workloads });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/vendoor/dispatcher/unallocated', (req, res) => {
  try {
    const workDate = req.query.date || new Date().toISOString().slice(0, 10);
    const limit = parseInt(req.query.limit, 10) || 50;
    const pool = getUnallocatedOrdersPool(workDate, { limit });
    return res.json({ success: true, date: workDate, pool });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/vendoor/dispatcher/completion', (req, res) => {
  try {
    const workDate = req.query.date || new Date().toISOString().slice(0, 10);
    const data = getCompletedOrdersForDate(workDate);
    return res.json({
      success: true,
      date: workDate,
      summary: data.summary,
      unique_completed_count: data.completed_order_codes.size
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/vendoor/dispatcher/audit', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const history = getDispatcherAuditHistory(limit);
    return res.json({ success: true, history });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/vendoor/dispatcher/alerts', (req, res) => {
  try {
    const alerts = getDispatcherAlerts();
    return res.json({ success: true, alerts });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});


// ==========================================
// CENTRALIZED EXECUTIVE-BI REPORTS API ROUTES
// ==========================================

app.get('/api/reports/executive-summary', (req, res) => {
  try {
    const report = generateExecutiveSummaryReport({
      dateMode: req.query.date_mode || req.query.dateMode || 'day',
      targetDate: req.query.target_date || req.query.targetDate || req.query.date,
      startDate: req.query.start_date || req.query.startDate,
      endDate: req.query.end_date || req.query.endDate,
      filters: req.query
    });
    saveReportRecord({
      reportType: 'executive_summary',
      dateMode: report.date_mode,
      startDate: report.start_date,
      endDate: report.end_date,
      filters: req.query,
      generatedBy: req.query.generated_by || 'System User',
      rowCount: report.daily_breakdown?.length || 0,
      reportData: report
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/employee', (req, res) => {
  try {
    const report = generateEmployeeReport({
      dateMode: req.query.date_mode || 'day',
      targetDate: req.query.target_date,
      startDate: req.query.start_date,
      endDate: req.query.end_date,
      filters: req.query
    });
    saveReportRecord({
      reportType: 'employee',
      dateMode: report.date_mode,
      startDate: report.start_date,
      endDate: report.end_date,
      filters: req.query,
      generatedBy: req.query.generated_by || 'System User',
      rowCount: report.total_employees,
      reportData: report
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/account', (req, res) => {
  try {
    const report = generateAccountReport({
      dateMode: req.query.date_mode || 'day',
      targetDate: req.query.target_date,
      startDate: req.query.start_date,
      endDate: req.query.end_date,
      filters: req.query
    });
    saveReportRecord({
      reportType: 'account',
      dateMode: report.date_mode,
      startDate: report.start_date,
      endDate: report.end_date,
      filters: req.query,
      generatedBy: req.query.generated_by || 'System User',
      rowCount: report.total_accounts,
      reportData: report
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/allocation', (req, res) => {
  try {
    const report = generateAllocationReport({
      dateMode: req.query.date_mode || 'day',
      targetDate: req.query.target_date,
      startDate: req.query.start_date,
      endDate: req.query.end_date,
      filters: req.query
    });
    saveReportRecord({
      reportType: 'allocation',
      dateMode: report.date_mode,
      startDate: report.start_date,
      endDate: report.end_date,
      filters: req.query,
      generatedBy: req.query.generated_by || 'System User',
      rowCount: report.total_allocations,
      reportData: report
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/activity-logs', (req, res) => {
  try {
    const report = generateActivityLogsReport({
      dateMode: req.query.date_mode || 'day',
      targetDate: req.query.target_date,
      startDate: req.query.start_date,
      endDate: req.query.end_date,
      limit: req.query.limit,
      filters: req.query
    });
    saveReportRecord({
      reportType: 'activity',
      dateMode: report.date_mode,
      startDate: report.start_date,
      endDate: report.end_date,
      filters: req.query,
      generatedBy: req.query.generated_by || 'System User',
      rowCount: report.total_logs_returned,
      reportData: report
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/productivity', (req, res) => {
  try {
    const report = generateProductivityReport({
      targetDate: req.query.target_date,
      filters: req.query
    });
    saveReportRecord({
      reportType: 'productivity',
      dateMode: 'day',
      startDate: report.work_date,
      endDate: report.work_date,
      filters: req.query,
      generatedBy: req.query.generated_by || 'System User',
      rowCount: report.total_profiles,
      reportData: report
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/dispatcher', (req, res) => {
  try {
    const report = generateDispatcherReport({
      dateMode: req.query.date_mode || 'day',
      targetDate: req.query.target_date,
      startDate: req.query.start_date,
      endDate: req.query.end_date,
      filters: req.query
    });
    saveReportRecord({
      reportType: 'dispatcher',
      dateMode: report.date_mode,
      startDate: report.start_date,
      endDate: report.end_date,
      filters: req.query,
      generatedBy: req.query.generated_by || 'System User',
      rowCount: report.total_cycles,
      reportData: report
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/data-quality', (req, res) => {
  try {
    const report = generateDataQualityReport({
      targetDate: req.query.target_date,
      filters: req.query
    });
    saveReportRecord({
      reportType: 'data_quality',
      dateMode: 'day',
      startDate: report.work_date,
      endDate: report.work_date,
      filters: req.query,
      generatedBy: req.query.generated_by || 'System User',
      rowCount: report.unmatched_identities_count,
      reportData: report
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/system-health', (req, res) => {
  try {
    const report = generateSystemHealthReport({
      targetDate: req.query.target_date
    });
    saveReportRecord({
      reportType: 'system_health',
      dateMode: 'day',
      startDate: report.work_date,
      endDate: report.work_date,
      filters: {},
      generatedBy: req.query.generated_by || 'System User',
      rowCount: 1,
      reportData: report
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const history = getReportHistory(limit);
    res.json({ reports: history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/export/:format', (req, res) => {
  try {
    const format = req.params.format?.toLowerCase();
    const type = req.query.report_type || 'employee';
    let data;

    switch (type) {
      case 'executive_summary':
        data = generateExecutiveSummaryReport(req.query);
        break;
      case 'employee':
        data = generateEmployeeReport(req.query);
        break;
      case 'account':
        data = generateAccountReport(req.query);
        break;
      case 'allocation':
        data = generateAllocationReport(req.query);
        break;
      case 'activity':
      case 'activity_logs':
        data = generateActivityLogsReport(req.query);
        break;
      case 'productivity':
        data = generateProductivityReport(req.query);
        break;
      case 'dispatcher':
        data = generateDispatcherReport(req.query);
        break;
      case 'data_quality':
        data = generateDataQualityReport(req.query);
        break;
      case 'system_health':
        data = generateSystemHealthReport(req.query);
        break;
      default:
        return res.status(400).json({ error: `Unknown report type: ${type}` });
    }

    if (format === 'csv') {
      const csv = exportReportToCSV(data);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${type}_report_${Date.now()}.csv"`);
      return res.send(csv);
    } else if (format === 'xlsx' || format === 'excel') {
      const xlsx = exportReportToExcel(data);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${type}_report_${Date.now()}.xlsx"`);
      return res.send(xlsx);
    } else {
      return res.status(400).json({ error: `Unsupported export format: ${format}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

function seedTrackingDefaults() {
  try {
    const rawCount = db.prepare('SELECT COUNT(*) as c FROM raw_log_records WHERE work_date = ?').get('2026-07-23').c;
    const sampleLogPath = path.join(ROOT_DIR, 'sample_log.xlsx');
    if (rawCount === 0 && fs.existsSync(sampleLogPath)) {
      console.log('Seeding raw log records from sample_log.xlsx for 2026-07-23...');
      const buf = fs.readFileSync(sampleLogPath);
      const { records } = parseDailyLogBuffer(buf);
      persistDailyLogRecords('2026-07-23', null, records);
      console.log('Seeded 2026-07-23 log records successfully.');
    }

    const orderCount23 = db.prepare('SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ?').get('2026-07-23').c;
    if (orderCount23 === 0) {
      const topOrders = db.prepare(`
        SELECT DISTINCT order_code FROM raw_log_records 
        WHERE work_date = '2026-07-23' 
        LIMIT 100
      `).all();

      const sampleAccounts = ['Doby Store', 'Joud Fragrance', 'Orvex X', 'Al-Ahram Express'];
      const insertOrder = db.prepare(`
        INSERT OR IGNORE INTO current_work_orders (work_date, order_code, account, status, source_file_slot)
        VALUES (?, ?, ?, ?, ?)
      `);

      const tx = db.transaction(() => {
        topOrders.forEach((o, i) => {
          const acc = sampleAccounts[i % sampleAccounts.length];
          const st = i % 3 === 0 ? 'Pending' : (i === 5 ? 'Opening Status Conflict' : 'New');
          insertOrder.run('2026-07-23', o.order_code, acc, st, st === 'Pending' ? 2 : 1);
        });
      });
      tx();

      const allocHeader = db.prepare('SELECT id FROM allocation_headers WHERE allocation_date = ?').get('2026-07-23');
      if (!allocHeader) {
        const hRes = db.prepare("INSERT INTO allocation_headers (allocation_date, notes) VALUES (?, 'Baseline Allocation')").run('2026-07-23');
        const hId = hRes.lastInsertRowid;
        const emp1 = db.prepare("SELECT id FROM employees WHERE name LIKE '%Ali Bahlol%' LIMIT 1").get() || { id: 1 };
        const emp2 = db.prepare("SELECT id FROM employees WHERE name LIKE '%BASMA%' LIMIT 1").get() || { id: 2 };
        db.prepare('INSERT OR IGNORE INTO allocation_items (allocation_header_id, employee_id, account, status, available_orders_at_assignment) VALUES (?, ?, ?, ?, ?)').run(hId, emp1.id, 'Doby Store', 'New', 25);
        db.prepare('INSERT OR IGNORE INTO allocation_items (allocation_header_id, employee_id, account, status, available_orders_at_assignment) VALUES (?, ?, ?, ?, ?)').run(hId, emp2.id, 'Joud Fragrance', 'New', 25);
      }
    }
  } catch (err) {
    console.warn('seedTrackingDefaults error:', err.message);
  }
}

if (process.env.SEED_DEMO_DATA === 'true') {
  seedTrackingDefaults();
}

if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, HOST, () => {
    console.log(`CS Executive BI server running on http://${HOST}:${PORT}`);
    try {
      const cfg = getVendoorConfig();
      if (cfg.hasAutoLoginCredentials) {
        performVendoorAutoLogin().then(authRes => {
          if (authRes.success) {
            console.log('[AUTONOMOUS] Live Vendoor session authenticated.');
          }
        }).catch(err => {
          console.warn('[AUTONOMOUS] Initial Vendoor auto-login notice:', err.message);
        });
      }
      startAutonomousVendoorPoller({ intervalMs: 60000 });
      console.log('[AUTONOMOUS] Background Vendoor poller initialized.');
    } catch (pollerErr) {
      console.warn('[AUTONOMOUS] Poller init warning:', pollerErr.message);
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[WARN] Port ${PORT} already in use; another instance may be running.`);
    } else {
      console.error('[ERROR] Server listen error:', err);
    }
  });
}

export { app, db };
