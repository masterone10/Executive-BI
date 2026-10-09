import express from 'express';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import XLSX from 'xlsx';
import { db } from './db/index.js';
import { parseDailyLogBuffer, parseSpecificOrdersBuffer, isCsEmployee } from './services/parser.js';
import { getCairoBusinessDate, getPreviousCompletedWeekRange } from './services/time_utils.js';
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
  getAccountReassignmentLogs,
  generateRoundBasedAllocation,
  reallocateWorkOrders,
  getEnterpriseAllocationConfig,
  validateEnterpriseAllocationConfig,
  saveEnterpriseAllocationConfig,
  saveAccountDaySchedule,
  resetAccountDayScheduleInDb,
  getEnterpriseConfigurationHistory,
  evaluateAccountTimeStatus,
  evaluateEmployeeAllocationEligibility,
  evaluatePendingRescueOperation,
  planEnterpriseAllocation,
  executeEnterpriseAllocation,
  checkEnterpriseOperationalAlerts,
  getEnterpriseAllocationRunDetails,
  getEnterpriseAllocationHistory,
  undoLastAllocation,
  getLatestUndoableAllocationRun
} from './services/allocation.js';
import { createDatabaseBackup, restoreDatabaseFromBackup } from './services/backup_restore.js';
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
  getOperationalDashboardData,
  getHourlyTimeWindowEventData,
  getEmployeeLiveRealtime,
  getTeamLiveStatusSummary,
  logEmployeeActivity,
  claimOrder,
  startOrderProgress,
  completeOrder,
  cancelOrder,
  recordInternalHandoff,
  getOrderFullHistory
} from './services/tracking.js';
import {
  createExcelWorkbook,
  createEmployeeAllocationWorkbook,
  createAccountWorkbook,
  createZipFromEmployeeWorkbooks,
  createContextualExportWorkbook
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
  getHistoricalBootstrapStatus,
  getLatestReconciliationAudit,
  getReconciliationAuditHistory,
  invalidateProductivityCache,
  importWeeklyVendoorLogs,
  getWeeklyLogsImportStatus
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
  generateMerchantReport,
  generateMarketerReport,
  generatePhoneAlertsReport,
  exportReportToCSV,
  exportReportToExcel,
  saveReportRecord,
  getReportHistory,
  getReportById
} from './services/reports.js';
import {
  getEmployeeEvaluation,
  getPhoneMatchAlerts,
  getEmployeeEvaluationDetail,
  getPhoneMatchAlertHistory,
  resolvePhoneMatchAlertById
} from './services/employee_evaluation.js';
import {
  getEmployeeLifecycleProfile,
  getEmployeeActiveOrders,
  analyzeDepartureImpact,
  executeEmployeeDeparture,
  updateEmployeeStatus,
  getEmployeePreservedHistory,
  getLifecycleAuditLogs,
  getOrderReviewQueue,
  resolveReviewQueueItem
} from './services/employee_lifecycle.js';
import {
  getComprehensiveWorkingTeamStatus,
  toggleWorkingTeamMember,
  syncAndRestoreObservedTeam,
  resetToObservedWorkingTeam
} from './services/working_team_ops.js';
import { requireRole, USER_ROLES } from './services/auth_guard.js';
import {
  getAvailableBusinessDates,
  getHistoricalDayOverview,
  getHistoricalOrdersList,
  getHistoricalOrdersForDate,
  getHistoricalPendingOrders,
  getCurrentLivePendingOrders,
  getHistoricalDateRegistryStatus,
  loadOrSyncHistoricalDate,
  invalidateAvailableDatesCache
} from './services/historical_dates.js';
import {
  getOperationalExceptions,
  getEmployeeOperationalMetrics,
  enrichOrderOperationalIntelligence
} from './services/operational_intelligence.js';
import {
  importProductsFromExcel,
  importHistoricalLogsFromExcel,
  autoScanAndSeedAvailableExcelFiles
} from './services/excel_importer.js';

const requireSupervisor = requireRole([USER_ROLES.SUPERVISOR, USER_ROLES.MANAGER, USER_ROLES.ADMIN]);

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
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

// HTTP Compression (gzip / deflate) for lightning-fast payload transfer
app.use(compression({
  threshold: 512,
  level: 6
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Multer in-memory storage for Excel uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

// Serve static frontend with caching headers for static assets (HTML is never cached)
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.png') || filePath.endsWith('.svg') || filePath.endsWith('.ico')) {
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    }
  }
}));

// In-memory read cache with short TTL (6s) to eliminate duplicate calculations
const apiResponseCache = new Map();
const API_RESPONSE_CACHE_TTL = 6000;

export function getCachedApiResponse(key) {
  const item = apiResponseCache.get(key);
  if (!item) return null;
  if (Date.now() - item.timestamp > API_RESPONSE_CACHE_TTL) {
    apiResponseCache.delete(key);
    return null;
  }
  return item.data;
}

export function setCachedApiResponse(key, data) {
  apiResponseCache.set(key, { timestamp: Date.now(), data });
  if (apiResponseCache.size > 200) {
    const firstKey = apiResponseCache.keys().next().value;
    apiResponseCache.delete(firstKey);
  }
}

export function invalidateServerApiCache() {
  apiResponseCache.clear();
  invalidateProductivityCache();
}

// Invalidate server cache on successful data mutations
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const originalSend = res.send;
    res.send = function(...args) {
      if (res.statusCode >= 200 && res.statusCode < 400) {
        invalidateServerApiCache();
      }
      return originalSend.apply(this, args);
    };
  }
  next();
});

// -------------------------------------------------------------
// 1. HEALTH & SYSTEM CONFIG
// -------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'CS Executive BI - Enterprise Edition' });
});

app.get('/api/config/weights', (req, res) => {
  res.json(getSystemWeights());
});

app.put('/api/config/weights', requireSupervisor, (req, res) => {
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
    const { department, active, status } = req.query;
    let sql = `
      SELECT e.id, e.name, e.department, e.active, e.status, e.team_membership, e.notes, 
             e.departure_date, e.departure_reason, e.created_at, e.updated_at,
             COALESCE(c.max_orders, 40) AS max_orders
      FROM employees e
      LEFT JOIN employee_capacities c ON e.id = c.employee_id
      WHERE 1=1
    `;
    const params = [];
    if (department) {
      sql += ' AND e.department = ?';
      params.push(department);
    }
    if (status) {
      sql += ' AND UPPER(e.status) = ?';
      params.push(String(status).trim().toUpperCase());
    }
    if (active !== undefined) {
      sql += ' AND e.active = ?';
      params.push(active === 'true' || active === '1' ? 1 : 0);
    }
    sql += ' ORDER BY e.department ASC, e.name COLLATE NOCASE ASC';
    let rows = db.prepare(sql).all(...params);
    if (department && department.toUpperCase() === 'CS') {
      rows = rows.filter(r => isCsEmployee(r));
    }
    if (req.query.cs_only === 'true' || req.query.csOnly === 'true' || req.query.operational === 'true') {
      rows = rows.filter(r => isCsEmployee(r));
    }
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
    const emp = getEmployeeLifecycleProfile(id);
    if (!emp) {
      return res.status(404).json({ success: false, error: 'Employee not found' });
    }
    res.json({ success: true, employee: emp });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/employees', requireSupervisor, (req, res) => {
  const { name, department, active, status, team_membership, notes } = req.body || {};
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

    let statusVal = status ? String(status).toUpperCase() : (activeVal === 1 ? 'ACTIVE' : 'INACTIVE');
    if (!['ACTIVE', 'INACTIVE', 'DEPARTED'].includes(statusVal)) {
      statusVal = activeVal === 1 ? 'ACTIVE' : 'INACTIVE';
    }

    let teamMem = 'Both';
    if (team_membership && ['New', 'Pending', 'Both'].includes(team_membership)) {
      teamMem = team_membership;
    }

    const info = db.prepare(
      "INSERT INTO employees (name, department, active, status, team_membership, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).run(cleanName, dept, activeVal, statusVal, teamMem, notes || null);

    const employee = getEmployeeLifecycleProfile(info.lastInsertRowid);
    return res.status(201).json({
      success: true,
      employee,
      id: employee.id,
      name: employee.name,
      department: employee.department,
      active: employee.active,
      status: employee.status,
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

app.put('/api/employees/:id', requireSupervisor, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid employee ID' });
  }

  try {
    const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Employee not found' });
    }

    const { name, department, active, status, team_membership, notes, max_orders, capacity } = req.body || {};
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

    let updatedStatus = existing.status || (updatedActive === 1 ? 'ACTIVE' : 'INACTIVE');
    if (status !== undefined) {
      const s = String(status).toUpperCase();
      if (['ACTIVE', 'INACTIVE', 'DEPARTED'].includes(s)) {
        updatedStatus = s;
        if (s === 'DEPARTED' || s === 'INACTIVE') {
          updatedActive = 0;
        } else if (s === 'ACTIVE') {
          updatedActive = 1;
        }
      }
    }

    let updatedTeamMem = existing.team_membership || 'Both';
    if (team_membership !== undefined && ['New', 'Pending', 'Both'].includes(team_membership)) {
      updatedTeamMem = team_membership;
    }

    let updatedNotes = notes !== undefined ? notes : existing.notes;

    db.prepare(
      "UPDATE employees SET name = ?, department = ?, active = ?, status = ?, team_membership = ?, notes = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(updatedName, updatedDept, updatedActive, updatedStatus, updatedTeamMem, updatedNotes, id);

    let updatedCap = undefined;
    if (max_orders !== undefined || capacity !== undefined) {
      updatedCap = Math.max(0, parseInt(max_orders !== undefined ? max_orders : capacity, 10) || 0);
      db.prepare(`
        INSERT INTO employee_capacities (employee_id, max_orders, updated_at, updated_by)
        VALUES (?, ?, datetime('now'), 'ADMIN')
        ON CONFLICT(employee_id) DO UPDATE SET max_orders = excluded.max_orders, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `).run(id, updatedCap);
    } else {
      const existingCap = db.prepare('SELECT max_orders FROM employee_capacities WHERE employee_id = ?').get(id);
      updatedCap = existingCap ? existingCap.max_orders : 40;
    }

    const employee = getEmployeeLifecycleProfile(id);
    return res.json({
      success: true,
      employee,
      id: employee.id,
      name: employee.name,
      department: employee.department,
      active: employee.active,
      status: employee.status,
      team_membership: employee.team_membership,
      max_orders: updatedCap,
      notes: employee.notes
    });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ success: false, error: 'Employee name already in use' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/employees/:id/status', requireSupervisor, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid employee ID' });
  }

  try {
    const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Employee not found' });
    }

    const { active, status, reason, operator, workDate } = req.body || {};
    let targetStatus = status;
    if (!targetStatus && active !== undefined) {
      targetStatus = (active === 1 || active === true || active === '1' || active === 'true') ? 'ACTIVE' : 'INACTIVE';
    }
    if (!targetStatus) {
      return res.status(400).json({ success: false, error: 'active or status is required' });
    }

    const result = updateEmployeeStatus(id, targetStatus, { reason, operator, workDate });
    return res.json({
      success: true,
      employee: result.employee,
      id: result.employee.id,
      name: result.employee.name,
      active: result.employee.active,
      status: result.employee.status
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// 2A. PRODUCTION EMPLOYEE LIFECYCLE & OPERATIONAL ENDPOINTS
// -------------------------------------------------------------

app.get('/api/employees/:id/active-orders', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const workDate = req.query.date || req.query.work_date || getCairoBusinessDate();
    const result = getEmployeeActiveOrders(id, workDate);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/employees/:id/history', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const history = getEmployeePreservedHistory(id);
    if (!history) {
      return res.status(404).json({ success: false, error: 'Employee not found' });
    }
    res.json({ success: true, ...history });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/employees/:id/departure-impact', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const workDate = req.query.date || req.query.work_date || getCairoBusinessDate();
    const impact = analyzeDepartureImpact(id, workDate);
    res.json({ success: true, impact });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/employees/:id/mark-departed', requireSupervisor, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { departureDate, departureReason, reason, operator, reassignSafeOrders, workDate } = req.body || {};
    const result = executeEmployeeDeparture(id, {
      departureDate,
      departureReason: departureReason || reason,
      operator,
      reassignSafeOrders,
      workDate
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/lifecycle/audit', (req, res) => {
  try {
    const logs = getLifecycleAuditLogs({
      employeeId: req.query.employee_id ? parseInt(req.query.employee_id, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 100
    });
    res.json({ success: true, count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/review-queue', (req, res) => {
  try {
    const items = getOrderReviewQueue({
      workDate: req.query.date || req.query.work_date,
      status: req.query.status,
      all: req.query.all === 'true' || req.query.all === '1',
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 200
    });
    res.json({ success: true, count: items.length, items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/review-queue/:id/resolve', requireSupervisor, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { target_employee_id, notes, operator } = req.body || {};
    if (!target_employee_id) {
      return res.status(400).json({ success: false, error: 'target_employee_id is required' });
    }
    const result = resolveReviewQueueItem(id, target_employee_id, { notes, operator });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/operations/working-team/detailed', (req, res) => {
  try {
    const workDate = req.query.date || req.query.work_date || getCairoBusinessDate();
    const result = getComprehensiveWorkingTeamStatus(workDate);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/operations/working-team/toggle', requireSupervisor, (req, res) => {
  try {
    const { date, employee_id, is_working } = req.body || {};
    if (!employee_id) {
      return res.status(400).json({ success: false, error: 'employee_id is required' });
    }
    const workDate = date || getCairoBusinessDate();
    const result = toggleWorkingTeamMember(workDate, parseInt(employee_id, 10), is_working);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/operations/working-team/auto-restore', requireSupervisor, (req, res) => {
  try {
    const workDate = req.body?.date || req.query?.date || getCairoBusinessDate();
    const forceReset = Boolean(req.body?.reset_manual);
    let result;
    if (forceReset) {
      result = resetToObservedWorkingTeam(workDate);
    } else {
      result = syncAndRestoreObservedTeam(workDate);
    }
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/vendoor/logs/live', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const sinceId = parseInt(req.query.since_id, 10) || 0;
    const workDate = req.query.date || req.query.work_date || getCairoBusinessDate();

    let query = `
      SELECT vl.id, vl.employee_name, vl.order_code, vl.action, vl.action_classification,
             vl.is_productive, vl.timestamp_str, vl.work_date, vl.matched_employee_id,
             e.name as matched_employee_name, e.department,
             cwo.account, cwo.status as order_status
      FROM vendoor_logs vl
      LEFT JOIN employees e ON e.id = vl.matched_employee_id
      LEFT JOIN current_work_orders cwo ON cwo.work_date = vl.work_date AND cwo.order_code = vl.order_code
      WHERE vl.work_date = ?
    `;
    const params = [workDate];

    if (sinceId > 0) {
      query += ' AND vl.id > ? ';
      params.push(sinceId);
    }

    if (req.query.employee_id) {
      const empId = parseInt(req.query.employee_id, 10);
      const empRow = db.prepare('SELECT name FROM employees WHERE id = ?').get(empId);
      query += ' AND (vl.matched_employee_id = ? OR LOWER(vl.employee_name) = LOWER(?)) ';
      params.push(empId, empRow ? empRow.name : '');
    }

    query += ' ORDER BY vl.timestamp_str DESC, vl.id DESC LIMIT ? ';
    params.push(limit);

    const logs = db.prepare(query).all(...params);

    const stats = db.prepare(`
      SELECT COUNT(*) as total_logs,
             COUNT(DISTINCT employee_name) as distinct_employees,
             COUNT(DISTINCT order_code) as distinct_orders,
             MAX(timestamp_str) as latest_timestamp
      FROM vendoor_logs
      WHERE work_date = ?
    `).get(workDate);

    res.json({
      success: true,
      work_date: workDate,
      count: logs.length,
      stats: stats || {},
      logs
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

app.put('/api/team-membership/:id', requireSupervisor, (req, res) => {
  try {
    const { id } = req.params;
    const { team_membership } = req.body;
    const updated = updateEmployeeTeamMembership(id, team_membership);
    res.json({ success: true, employee: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/team-membership/bulk', requireSupervisor, (req, res) => {
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

app.post('/api/working-team/:date', requireSupervisor, handleSaveWorkingTeam);
app.put('/api/working-team/:date', requireSupervisor, handleSaveWorkingTeam);

// Production Team-Level Configuration Copy (Team -> Team & Date -> Date fallback)
app.post('/api/team/copy-configuration', requireSupervisor, (req, res) => {
  try {
    const {
      sourceTeam,
      targetTeam,
      sourceTeamId,
      targetTeamId,
      copyCapacities,
      copyMembers,
      sourceDate,
      targetDate,
      copyRoster,
      copySchedules
    } = req.body || {};

    const normalizeTeamId = (t) => {
      if (!t) return null;
      const s = String(t).trim();
      if (s === '1') return 'New';
      if (s === '2') return 'Pending';
      if (s === '3') return 'Both';
      const capitalized = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
      if (['New', 'Pending', 'Both'].includes(capitalized)) return capitalized;
      return s;
    };
    const srcTeam = normalizeTeamId(sourceTeam || sourceTeamId);
    const tgtTeam = normalizeTeamId(targetTeam || targetTeamId);

    // 1. PRIMARY CONCEPT: TEAM -> TEAM CONFIGURATION COPY
    if (srcTeam && tgtTeam) {
      if (srcTeam === tgtTeam) {
        return res.status(400).json({ success: false, error: 'Source Team and Target Team must be different' });
      }
      const validTeams = ['New', 'Pending', 'Both'];
      if (!validTeams.includes(srcTeam) || !validTeams.includes(tgtTeam)) {
        return res.status(400).json({ success: false, error: 'Invalid team identifier. Must be New, Pending, or Both' });
      }

      const tx = db.transaction(() => {
        const sourceMembers = db.prepare(`
          SELECT id, name, department, active, team_membership
          FROM employees
          WHERE team_membership = ? AND active = 1
        `).all(srcTeam);

        const targetMembers = db.prepare(`
          SELECT id, name, department, active, team_membership
          FROM employees
          WHERE team_membership = ? AND active = 1
        `).all(tgtTeam);

        let updatedCapacities = 0;
        let updatedMemberships = 0;

        // A. If copyMembers is explicitly requested: sync members to target team using existing IDs (NO DUPLICATES)
        if (copyMembers === true && sourceMembers.length > 0) {
          const updateMemberStmt = db.prepare("UPDATE employees SET team_membership = ?, updated_at = datetime('now') WHERE id = ?");
          for (const sm of sourceMembers) {
            updateMemberStmt.run(tgtTeam, sm.id);
            updatedMemberships++;
          }
          // Refresh target members after reassignment
          targetMembers = db.prepare(`
            SELECT id, name, department, active, team_membership
            FROM employees
            WHERE team_membership = ? AND active = 1
          `).all(tgtTeam);
        }

        // B. Copy Capacity configuration from source team members (average / baseline max_orders)
        if (copyCapacities !== false && sourceMembers.length > 0 && targetMembers.length > 0) {
          const srcIds = sourceMembers.map(m => m.id);
          const placeholders = srcIds.map(() => '?').join(',');
          const capRows = db.prepare(`SELECT max_orders FROM employee_capacities WHERE employee_id IN (${placeholders})`).all(...srcIds);
          const avgCap = capRows.length > 0
            ? Math.round(capRows.reduce((sum, r) => sum + (r.max_orders || 40), 0) / capRows.length)
            : 40;

          const delCap = db.prepare("DELETE FROM employee_capacities WHERE employee_id = ?");
          const insCap = db.prepare("INSERT INTO employee_capacities (employee_id, max_orders, updated_at, updated_by) VALUES (?, ?, datetime('now'), 'TEAM_COPY')");
          for (const tm of targetMembers) {
            delCap.run(tm.id);
            insCap.run(tm.id, avgCap);
            updatedCapacities++;
          }
        }

        // Audit log
        try {
          db.prepare(`
            INSERT INTO employee_activity_log (actor, action, details, created_at)
            VALUES ('SUPERVISOR', 'TEAM_COPY', ?, datetime('now'))
          `).run(JSON.stringify({ sourceTeam: srcTeam, targetTeam: tgtTeam, updatedCapacities, updatedMemberships }));
        } catch (_) {}

        return {
          sourceTeam: srcTeam,
          targetTeam: tgtTeam,
          sourceMembersCount: sourceMembers.length,
          targetMembersCount: targetMembers.length,
          updatedCapacities,
          updatedMemberships
        };
      });

      const result = tx();
      return res.json({
        success: true,
        message: `Team configuration copied successfully from ${srcTeam} Team to ${tgtTeam} Team.`,
        sourceTeam: srcTeam,
        targetTeam: tgtTeam,
        sourceTeamId: srcTeam,
        targetTeamId: tgtTeam,
        ...result
      });
    }

    // 2. FALLBACK CONCEPT: DATE -> DATE SCHEDULE/ROSTER COPY
    if (!sourceDate || !targetDate) {
      return res.status(400).json({ success: false, error: 'sourceTeam and targetTeam (or sourceDate and targetDate) are required' });
    }
    if (sourceDate === targetDate) {
      return res.status(400).json({ success: false, error: 'Source and Target dates must be different' });
    }

    const tx = db.transaction(() => {
      let copiedMembersCount = 0;
      let copiedSchedulesCount = 0;

      // 1. Copy working team attendance roster (configuration only)
      if (copyRoster !== false) {
        const sourceMembers = db.prepare(`
          SELECT employee_id, is_working
          FROM daily_working_team
          WHERE work_date = ? AND is_working = 1
        `).all(sourceDate);

        if (sourceMembers.length > 0) {
          db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(targetDate);
          const insertStmt = db.prepare(`
            INSERT INTO daily_working_team (work_date, employee_id, is_working, source, updated_at)
            VALUES (?, ?, ?, 'MANUAL_COPY', datetime('now'))
          `);
          for (const m of sourceMembers) {
            insertStmt.run(targetDate, m.employee_id, m.is_working);
          }
          copiedMembersCount = sourceMembers.length;
        }
      }

      // 2. Copy account day schedules if table exists
      if (copySchedules !== false) {
        try {
          const sourceSchedules = db.prepare(`
            SELECT account, day_of_week, time_window_start, time_window_end, is_active, notes
            FROM account_day_schedules
            WHERE work_date = ?
          `).all(sourceDate);

          if (sourceSchedules.length > 0) {
            db.prepare('DELETE FROM account_day_schedules WHERE work_date = ?').run(targetDate);
            const insertSched = db.prepare(`
              INSERT INTO account_day_schedules (account, day_of_week, work_date, time_window_start, time_window_end, is_active, notes)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            for (const s of sourceSchedules) {
              insertSched.run(s.account, s.day_of_week, targetDate, s.time_window_start, s.time_window_end, s.is_active, s.notes);
            }
            copiedSchedulesCount = sourceSchedules.length;
          }
        } catch (_) {}
      }

      return { copiedMembersCount, copiedSchedulesCount };
    });

    const result = tx();
    res.json({
      success: true,
      message: `Configuration copied successfully from ${sourceDate} to ${targetDate}`,
      ...result
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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

app.post('/api/account-rules', requireSupervisor, (req, res) => {
  try {
    const result = saveAccountRule(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/account-rules/:id', requireSupervisor, (req, res) => {
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

app.post('/api/account-exceptions', requireSupervisor, (req, res) => {
  try {
    const result = saveAccountException(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/account-exceptions/:id', requireSupervisor, (req, res) => {
  try {
    const result = deleteAccountException(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 3C. SYSTEM DATABASE BACKUP & SAFE RESTORE
// -------------------------------------------------------------
app.post('/api/system/backup', requireSupervisor, async (req, res) => {
  try {
    const result = await createDatabaseBackup(req.body?.filename);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/system/backups', (req, res) => {
  try {
    const backupsDir = path.join(process.cwd(), 'backups');
    if (!fs.existsSync(backupsDir)) {
      return res.json([]);
    }
    const files = fs.readdirSync(backupsDir)
      .filter(f => f.endsWith('.db'))
      .map(f => {
        const stat = fs.statSync(path.join(backupsDir, f));
        return {
          filename: f,
          size_bytes: stat.size,
          created_at: stat.birthtime.toISOString()
        };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/system/restore', requireSupervisor, (req, res) => {
  try {
    const filename = req.body?.filename;
    if (!filename) return res.status(400).json({ error: 'filename is required for restore' });
    const backupPath = path.join(process.cwd(), 'backups', path.basename(filename));
    const result = restoreDatabaseFromBackup(backupPath);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 4. WORK ALLOCATION & CURRENT WORK (Parts 13 to 25, 39, 40)
// -------------------------------------------------------------
// Canonical Available Business Dates Discovery API (Historical Days First-Class Concept)
app.get(['/api/work/available-dates', '/api/available-dates', '/api/dates/available', '/api/historical/dates'], (req, res) => {
  try {
    const forceFresh = req.query.fresh === 'true';
    const data = getAvailableBusinessDates(forceFresh);
    res.json(data);
  } catch (err) {
    console.error('Error fetching available business dates:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Historical Date Registry Status API
app.get('/api/historical/date-status/:date', (req, res) => {
  try {
    const status = getHistoricalDateRegistryStatus(req.params.date);
    res.json(status);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Automated Historical Date Load & Vendoor Sync API
app.all(['/api/historical/load-date', '/api/historical/select-date'], async (req, res) => {
  try {
    const date = req.body?.date || req.body?.work_date || req.query.date || req.query.work_date;
    if (!date) {
      return res.status(400).json({ success: false, error: 'date parameter is required (YYYY-MM-DD)' });
    }
    const forceSync = req.body?.force_sync === true || req.body?.forceSync === true || req.query.force_sync === 'true';
    const result = await loadOrSyncHistoricalDate(date, { forceSync });
    const dashboardData = getOperationalDashboardData(date);
    res.json({
      success: true,
      work_date: date,
      ...result,
      dashboard: dashboardData
    });
  } catch (err) {
    console.error(`Error in /api/historical/select-date for ${req.body?.date || req.query?.date}:`, err);
    res.status(500).json({ success: false, error: err.message, work_date: req.body?.date || req.query?.date });
  }
});

// Canonical Historical Orders Endpoint (Date-Scoped, Single Source of Truth)
app.get(['/api/orders', '/api/historical/:date/orders', '/api/orders/historical/:date'], (req, res) => {
  try {
    const date = req.params.date || req.query.date || req.query.work_date || getEffectiveWorkDate();
    const result = getHistoricalOrdersList(date, req.query);
    res.json({ success: true, work_date: date, total: result.total, limit: result.limit, offset: result.offset, orders: result.orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, work_date: req.params.date || req.query.date });
  }
});

// Canonical Historical Pending Orders Endpoint (Date-Scoped, Zero Live Queue Contamination)
app.get(['/api/pending-orders', '/api/historical/:date/pending-orders', '/api/pending-orders/historical/:date'], (req, res) => {
  try {
    const date = req.params.date || req.query.date || req.query.work_date;
    if (date) {
      const pendingOrders = getHistoricalPendingOrders(date);
      return res.json({ success: true, work_date: date, count: pendingOrders.length, pending_orders: pendingOrders });
    }
    const livePending = getCurrentLivePendingOrders();
    res.json({ success: true, mode: 'LIVE', count: livePending.length, pending_orders: livePending });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, work_date: req.params.date || req.query.date });
  }
});

// Canonical KPI Summary Endpoint (Date-Scoped)
app.get(['/api/kpi', '/api/kpis'], (req, res) => {
  try {
    const date = req.query.date || req.query.work_date || getEffectiveWorkDate();
    const data = getOperationalDashboardData(date);
    res.json({
      success: true,
      work_date: date,
      summary: data.summary || {
        realActions: data.log_totals?.actions || 0,
        printedActions: data.log_totals?.printed || 0,
        pendingActions: data.log_totals?.pending || 0,
        cancelledActions: data.log_totals?.cancelled || 0,
        processingActions: data.log_totals?.processing || 0,
        totalAltPhones: data.log_totals?.alt || 0,
        totalNewOrders: data.hr?.tot_new || 0
      },
      log_totals: data.log_totals,
      status_totals: data.status_totals,
      team_cancel_rate: data.team_cancel_rate,
      team_pending_rate: data.team_pending_rate,
      dedup: data.dedup,
      employees_count: (data.employees || []).length
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Canonical Employee Performance Breakdown Endpoint (Date-Scoped)
app.get(['/api/employees/performance', '/api/performance/employees'], (req, res) => {
  try {
    const date = req.query.date || req.query.work_date || getEffectiveWorkDate();
    const data = getOperationalDashboardData(date);
    res.json({
      success: true,
      work_date: date,
      employees: data.employees || [],
      rankings: data.rankings || {},
      top10Performers: data.top10Performers || [],
      mostActive: data.mostActive || [],
      topCSContributor: data.topCSContributor || null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Live Pending Queue Endpoint (LIVE_MODE ONLY)
app.get('/api/pending-orders/live', (req, res) => {
  try {
    const livePending = getCurrentLivePendingOrders();
    res.json({ success: true, mode: 'LIVE', count: livePending.length, pending_orders: livePending });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/global-context', (req, res) => {
  try {
    const date = req.query.date || getCairoBusinessDate();
    const cacheKey = `gctx_${date}`;
    const cached = getCachedApiResponse(cacheKey);
    if (cached) {
      return res.json(cached);
    }
    const overview = getCurrentWorkOverview(date);
    const vendoor = getSafeVendoorStatus();
    const poller = getAutonomousPollerStatus();
    const dispatcher = getDispatcherStatus ? getDispatcherStatus() : { is_running: false };

    const now = Date.now();
    const ordersLastSuccess = poller.orders?.last_success_at ? new Date(poller.orders.last_success_at).getTime() : null;
    const ordersSecAgo = ordersLastSuccess !== null ? Math.max(0, Math.floor((now - ordersLastSuccess) / 1000)) : null;
    let ordersSyncState = 'NORMAL';
    if (ordersSecAgo === null) {
      ordersSyncState = 'UNKNOWN';
    } else if ((poller.orders?.consecutive_errors || 0) >= 3 || ordersSecAgo >= 300) {
      ordersSyncState = 'CRITICAL';
    } else if (ordersSecAgo >= 90) {
      ordersSyncState = 'STALE';
    }

    const logsLastSuccess = poller.logs?.last_success_at ? new Date(poller.logs.last_success_at).getTime() : null;
    const logsSecAgo = logsLastSuccess !== null ? Math.max(0, Math.floor((now - logsLastSuccess) / 1000)) : null;
    let logsSyncState = 'NORMAL';
    if (logsSecAgo === null) {
      logsSyncState = 'UNKNOWN';
    } else if ((poller.logs?.consecutive_errors || 0) >= 3 || logsSecAgo >= 300) {
      logsSyncState = 'CRITICAL';
    } else if (logsSecAgo >= 90) {
      logsSyncState = 'STALE';
    }

    const payload = {
      work_date: date,
      vendoor: {
        connection_state: poller.connection_state || vendoor.connection_state || 'NOT_CONFIGURED',
        session_state: vendoor.session_state || 'NOT_AUTHENTICATED',
        has_credentials: Boolean(vendoor.has_credentials),
        has_active_session: Boolean(vendoor.has_active_session),
        auth_method: vendoor.auth_method || 'AUTO_LOGIN',
        email_preview: vendoor.email_preview || null,
        poller: {
          is_running: poller.isRunning,
          orders: poller.orders,
          logs: poller.logs
        },
        last_orders_sync: poller.orders?.last_success_at || poller.orders?.last_run_at || null,
        last_logs_sync: poller.logs?.last_success_at || poller.logs?.last_run_at || null,
        orders_status: poller.orders?.status || 'IDLE',
        logs_status: poller.logs?.status || 'IDLE',
        orders_run_count: poller.orders?.run_count || 0,
        logs_run_count: poller.logs?.run_count || 0,
        sync_indicators: {
          orders: {
            last_success_at: poller.orders?.last_success_at || null,
            seconds_ago: ordersSecAgo,
            state: ordersSyncState,
            status: poller.orders?.status || 'IDLE',
            consecutive_errors: poller.orders?.consecutive_errors || 0
          },
          logs: {
            last_success_at: poller.logs?.last_success_at || null,
            seconds_ago: logsSecAgo,
            state: logsSyncState,
            status: poller.logs?.status || 'IDLE',
            consecutive_errors: poller.logs?.consecutive_errors || 0
          }
        }
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
    };
    setCachedApiResponse(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error('Error in /api/global-context:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/integrations/vendoor/reconciliation/latest (Live Reconciliation Diagnostic Panel - Enhancement 5)
app.get(['/api/integrations/vendoor/reconciliation/latest', '/api/vendoor/reconciliation/latest', '/api/reconciliation/live'], (req, res) => {
  const date = req.query.date || getCairoBusinessDate();
  try {
    const data = getLatestReconciliationAudit(date);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/integrations/vendoor/reconciliation/audit (Historical Audit Logs - Enhancement 4)
app.get(['/api/integrations/vendoor/reconciliation/audit', '/api/vendoor/reconciliation/audit'], (req, res) => {
  const limit = parseInt(req.query.limit || '50', 10);
  try {
    const data = getReconciliationAuditHistory(limit);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/system/trace/data-flow (Data Flow Walkthrough & Traceability - Enhancement 7)
app.get('/api/system/trace/data-flow', (req, res) => {
  res.json({
    step_1_table: "current_work_orders (SQLite table storing current active work pool)",
    step_2_backend_service: "getCurrentWorkOverview(workDate) & getAccountsDirectory(workDate) in services/tracking.js",
    step_3_endpoint: "GET /api/global-context?date=YYYY-MM-DD in server.js",
    step_4_frontend_fetch: "updateGlobalContextBar() & loadInitialData() in public/index.html / template.html",
    step_5_state_update: "Updates DOM elements (gctxOrdersCount, gctxTeamCount, gctxOrdersSyncStatus, etc.)",
    step_6_header_components: "Header UI Global Context Bar & navigation pills",
    step_7_soft_refresh: "Autonomous 30s background poller fetches /api/global-context without triggering window.location.reload()",
    step_8_date_preservation: "currentWorkDate JS variable persists across soft-refresh cycles",
    step_9_stale_response_protection: "If response.work_date !== currentWorkDate, async payload is safely dropped to prevent overwriting active UI date state."
  });
});

// GET /api/system/trace/error-handling (Vendoor Sync Error Handling Observability - Enhancement 8)
app.get('/api/system/trace/error-handling', (req, res) => {
  res.json({
    step_1_request_failure: "Network or HTTP error during Vendoor API call in services/vendoor/client.js",
    step_2_retry_decision: "Catch block triggers bounded exponential backoff retry pass",
    step_3_backoff: "Waits 1000ms, 2000ms, 4000ms before retrying transient errors",
    step_4_reauthentication: "If 401/419 or session expired is returned, invokes ensureAuthenticatedSession() in services/vendoor/auth.js to re-login",
    step_5_retry: "Retries request with newly acquired Vendoor session cookie/token",
    step_6_final_failure: "If max retries reached, records status = 'FAILED' in vendoor_sync_runs and updates pollerState.orders.lastError",
    step_7_stale_data_protection: "Existing current_work_orders and vendoor_orders tables are NOT deleted or cleared on failure",
    step_8_ui_source_health: "Global context connection state transitions to ERROR or RECONNECTING while preserving last-known-good active counts without displaying fake zeros or false CONNECTED state."
  });
});

// GET /api/system/trace/order-identity (Canonical Order Identity & Idempotency - Enhancement 9)
app.get('/api/system/trace/order-identity', (req, res) => {
  res.json({
    step_1_real_order: "Raw order object received from Vendoor /dashboard/orders API",
    step_2_normalization: "normalizeOrder() in services/vendoor/normalize.js trims whitespace, standardizes casing, and extracts order_code",
    step_3_canonical_identifier: "order_code (e.g. 'lz9878') is the single canonical identifier. Database id is internal autoincrement PK. merchant_code is stored separately.",
    step_4_pagination_dedup: "activeOrderCodes Set prevents duplicates across pages during 300-item page retrieval",
    step_5_db_upsert: "vendoor_orders table uses ON CONFLICT(order_code) DO UPDATE SET to update status/account without creating duplicate rows",
    step_6_current_work_orders: "current_work_orders enforces UNIQUE(work_date, order_code) via ON CONFLICT(work_date, order_code) DO UPDATE SET status = excluded.status",
    step_7_cycle_idempotency: "30-second polling cycles execute idempotent ON CONFLICT upserts, maintaining exact 1:1 parity without duplicating records regardless of sync_run_id",
    step_8_history_preservation: "When an order transitions to a non-active status (Processing/Shipped/Cancelled), it is pruned from current_work_orders for today but remains permanently recorded in vendoor_orders with is_active = 0."
  });
});

app.get('/api/work/current', (req, res) => {
  try {
    const date = req.query.date || getCairoBusinessDate();
    const overview = getCurrentWorkOverview(date);
    
    // Enrich orders with 3 locked operational intelligence rules
    if (overview && Array.isArray(overview.orders)) {
      overview.orders = overview.orders.map(enrichOrderOperationalIntelligence);
    }
    
    // Include operational exceptions summary
    const exceptions = getOperationalExceptions(date, {
      employee_name: req.query.employee_name,
      account: req.query.account
    });
    overview.operational_exceptions = exceptions;

    res.json(overview);
  } catch (err) {
    console.error('Error in /api/work/current:', err);
    res.status(500).json({ error: err.message });
  }
});

// Operational Intelligence — Locked Requirements Endpoints
app.get('/api/operational-intelligence/exceptions', (req, res) => {
  try {
    const date = req.query.date || getCairoBusinessDate();
    const exceptions = getOperationalExceptions(date, {
      employee_name: req.query.employee_name,
      account: req.query.account
    });
    res.json({ success: true, ...exceptions });
  } catch (err) {
    console.error('Error in /api/operational-intelligence/exceptions:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/operational-intelligence/employee/:employeeName', (req, res) => {
  try {
    const date = req.query.date || getCairoBusinessDate();
    const metrics = getEmployeeOperationalMetrics(date, req.params.employeeName);
    res.json({ success: true, ...metrics });
  } catch (err) {
    console.error('Error in /api/operational-intelligence/employee:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get(['/api/work/order/:orderCode', '/api/orders/:orderCode'], (req, res) => {
  try {
    const code = req.params.orderCode;
    const date = req.query.date || getCairoBusinessDate();
    
    // Try current_work_orders first
    let row = db.prepare('SELECT * FROM current_work_orders WHERE order_code = ?').get(code);
    if (!row) {
      // Fallback to vendoor_orders or raw_log_records
      try {
        row = db.prepare('SELECT * FROM vendoor_orders WHERE order_code = ?').get(code);
      } catch (_) {}
    }
    if (!row) {
      try {
        row = db.prepare('SELECT * FROM raw_log_records WHERE order_code = ? ORDER BY id DESC LIMIT 1').get(code);
      } catch (_) {}
    }

    if (!row) {
      return res.status(404).json({ success: false, error: 'Order not found', order_code: code });
    }

    const enriched = enrichOrderOperationalIntelligence(row);
    
    // Also pull tracking timeline
    let timeline = [];
    try {
      timeline = db.prepare('SELECT * FROM order_tracking_events WHERE order_code = ? ORDER BY id DESC LIMIT 20').all(code);
    } catch (_) {}

    res.json({
      success: true,
      order: enriched,
      timeline
    });
  } catch (err) {
    console.error('Error in /api/work/order:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get(['/api/work/accounts', '/api/accounts/current/:date'], (req, res) => {
  try {
    const date = req.params.date || req.query.date || getCairoBusinessDate();
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
    const date = req.query.date || getCairoBusinessDate();
    const accounts = getCurrentAccountsWithCounts(date);
    res.json(accounts);
  } catch (err) {
    console.error('Error in /api/work/accounts-detailed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Single unified endpoint to bundle all allocation workspace initialization data
app.get('/api/work/allocation-bundle', (req, res) => {
  try {
    const date = req.query.date || getCairoBusinessDate();
    const overview = getCurrentWorkOverview(date);
    const accounts = getCurrentAccountsWithCounts(date);
    const workingTeam = getWorkingTeam(date);
    const allocRaw = getAllocationForDate(date);
    const allocation = allocRaw ? { exists: true, ...allocRaw } : { exists: false, date, items: [], by_employee: [] };
    res.json({
      success: true,
      date,
      overview,
      accounts,
      workingTeam,
      allocation
    });
  } catch (err) {
    console.error('Error in /api/work/allocation-bundle:', err);
    res.status(500).json({ success: false, error: err.message });
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
 * ============================================================
 * ENTERPRISE ALLOCATION ENGINE ENDPOINTS (Sections 125-141, 133A)
 * ============================================================
 */

// 1. GET Centralized Allocation Configuration
app.get('/api/allocation/configuration', (req, res) => {
  try {
    const config = getEnterpriseAllocationConfig();
    res.json({ success: true, ...config });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. POST Validate Configuration Draft
app.post('/api/allocation/configuration/validate', (req, res) => {
  try {
    const result = validateEnterpriseAllocationConfig(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ valid: false, errors: [{ section: 'general', reason: err.message }] });
  }
});

// 3. POST Save All Configuration (Atomic, Versioned)
app.post('/api/allocation/configuration/save', requireSupervisor, (req, res) => {
  try {
    const operator = req.body.operator || req.headers['x-user'] || 'Supervisor';
    const expectedVersion = req.body.expected_version !== undefined ? req.body.expected_version : null;
    const result = saveEnterpriseAllocationConfig(req.body, operator, expectedVersion);
    res.json(result);
  } catch (err) {
    const status = err.code === 'CONFIGURATION_CONFLICT' ? 409 : 400;
    res.status(status).json({ success: false, error: err.message, code: err.code, validation_errors: err.validation_errors });
  }
});

// 3B. POST Save Specific Account Day Schedule (Atomic, Partial Merge)
app.post('/api/allocation/schedule/day-save', requireSupervisor, (req, res) => {
  try {
    const { account, status, day, start, end, new_start_time, new_end_time, pending_start_time, pending_end_time } = req.body;
    const operator = req.body.operator || req.headers['x-user'] || 'Supervisor';
    if (!account) return res.status(400).json({ success: false, error: 'account is required' });
    if (!day) return res.status(400).json({ success: false, error: 'day is required' });

    const result = saveAccountDaySchedule({
      account,
      status: status || 'NEW',
      day,
      start,
      end,
      new_start_time,
      new_end_time,
      pending_start_time,
      pending_end_time,
      operator
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 3C. POST Reset Specific Account Day Schedule to Default
app.post('/api/allocation/schedule/day-reset', requireSupervisor, (req, res) => {
  try {
    const { account, day } = req.body;
    const operator = req.body.operator || req.headers['x-user'] || 'Supervisor';
    if (!account) return res.status(400).json({ success: false, error: 'account is required' });
    if (!day) return res.status(400).json({ success: false, error: 'day is required' });

    const result = resetAccountDayScheduleInDb(account, day, operator);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 4. GET Configuration Version History
app.get('/api/allocation/configuration/history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const history = getEnterpriseConfigurationHistory(limit);
    res.json({ success: true, count: history.length, history });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. GET Account + Status Schedule Evaluation
app.get('/api/allocation/schedule/status', (req, res) => {
  try {
    const { account, work_type, time, date, workDate } = req.query;
    if (!account) return res.status(400).json({ error: 'account is required' });
    const targetDate = date || workDate || null;
    const status = evaluateAccountTimeStatus(account, work_type || 'NEW', time || null, targetDate);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. GET Employee Eligibility & State
app.get('/api/allocation/employee/eligibility', (req, res) => {
  try {
    const employeeId = parseInt(req.query.employee_id, 10);
    const workDate = req.query.date || getCairoBusinessDate();
    if (!employeeId) return res.status(400).json({ error: 'employee_id is required' });
    const result = evaluateEmployeeAllocationEligibility(employeeId, workDate, req.query);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. GET Rescue Evaluation
app.get('/api/allocation/rescue/status', (req, res) => {
  try {
    const workDate = req.query.date || getCairoBusinessDate();
    const result = evaluatePendingRescueOperation(workDate);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. POST Allocation Preview Plan
app.post(['/api/allocation/preview', '/api/allocations/:date/preview'], (req, res) => {
  const date = req.params.date || req.body?.work_date || req.body?.date || getCairoBusinessDate();
  try {
    const plan = planEnterpriseAllocation(date, 'PREVIEW', req.body || {});
    res.json(plan);
  } catch (err) {
    console.error('Error generating preview:', err);
    res.status(400).json({ error: err.message, code: err.code });
  }
});

// 9. POST Execute Allocation (Atomic Production Write)
app.post(['/api/allocation/execute', '/api/allocations/:date/execute'], requireSupervisor, (req, res) => {
  const date = req.params.date || req.body?.work_date || req.body?.date || getCairoBusinessDate();
  try {
    const result = executeEnterpriseAllocation(req.body?.plan || date, { mode: 'ACTIVE', ...req.body });
    res.json(result);
  } catch (err) {
    console.error('Error executing enterprise allocation:', err);
    res.status(400).json({ error: err.message, code: err.code });
  }
});

// 10. GET Enterprise Allocation History
app.get('/api/allocation/enterprise/history', (req, res) => {
  try {
    const workDate = req.query.date || null;
    const limit = parseInt(req.query.limit, 10) || 50;
    const history = getEnterpriseAllocationHistory(workDate, limit);
    res.json({ success: true, count: history.length, history });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 11. GET Enterprise Allocation Run Details (Audit & Snapshot)
app.get('/api/allocation/enterprise/run/:runId', (req, res) => {
  try {
    const details = getEnterpriseAllocationRunDetails(req.params.runId);
    if (!details) return res.status(404).json({ success: false, error: 'Run not found' });
    res.json({ success: true, run: details });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 12. GET Operational Alerts
app.get(['/api/allocation/alerts', '/api/allocations/:date/alerts'], (req, res) => {
  const date = req.params.date || req.query.date || getCairoBusinessDate();
  try {
    const alerts = checkEnterpriseOperationalAlerts(date);
    res.json({ success: true, count: alerts.length, alerts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 13. POST Undo / Reject Allocation (Rollback to exact pre-allocation state)
app.post(['/api/allocations/:date/undo', '/api/allocation/:date/undo', '/api/allocations/undo', '/api/allocation/undo'], requireSupervisor, (req, res) => {
  const date = req.params.date || req.body?.work_date || req.body?.date || getCairoBusinessDate();
  const { allocation_run_id, run_id, reason, operator, generated_by, forceFailForTest } = req.body || {};
  try {
    const result = undoLastAllocation(date, {
      allocation_run_id: allocation_run_id || run_id,
      reason,
      operator: operator || generated_by || 'Supervisor',
      forceFailForTest: forceFailForTest === true
    });
    console.log(`[ALLOCATION UNDO] Successfully rolled back run ${result.allocation_run_id} for date=${date}: restored=${result.restored_orders_count}, protected=${result.protected_orders_count}`);
    res.json(result);
  } catch (err) {
    console.error(`[ALLOCATION UNDO ERROR] date=${date}, error=${err.message}`);
    res.status(400).json({
      success: false,
      work_date: date,
      allocation_run_id: allocation_run_id || run_id || null,
      undone: false,
      restored_orders_count: 0,
      protected_orders_count: 0,
      skipped_changed_orders_count: 0,
      error: err.message,
      message: err.message
    });
  }
});

// 14. GET Latest Undoable Run Info
app.get(['/api/allocations/:date/latest-undoable-run', '/api/allocation/:date/latest-undoable-run'], (req, res) => {
  const date = req.params.date || req.query.date || getCairoBusinessDate();
  try {
    const run = getLatestUndoableAllocationRun(date);
    res.json({ success: true, work_date: date, run });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 15. GET Allocation Undo History
app.get(['/api/allocations/:date/undo-history', '/api/allocation/:date/undo-history'], (req, res) => {
  const date = req.params.date || req.query.date || getCairoBusinessDate();
  try {
    const logs = db.prepare('SELECT * FROM allocation_undo_logs WHERE work_date = ? ORDER BY created_at DESC').all(date);
    res.json({ success: true, work_date: date, count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post(['/api/allocations/:date/generate', '/api/allocations/generate', '/api/allocation/generate'], requireSupervisor, (req, res) => {
  const date = req.params.date || req.body?.work_date || req.body?.date || getCairoBusinessDate();
  const { method, account_specific_rules, regenerate, round_based, round_number, max_capacity_per_employee, max_capacity, enterprise, use_enterprise } = req.body || {};
  
  // Boundary diagnostic context
  let orderCount = 0;
  let teamCount = 0;
  try {
    const ordRow = db.prepare('SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ?').get(date);
    orderCount = ordRow ? ordRow.c : 0;
    const teamRow = db.prepare('SELECT COUNT(*) as c FROM daily_working_team WHERE work_date = ? AND is_working = 1').get(date);
    teamCount = teamRow ? teamRow.c : 0;
  } catch (_) {}

  const config = getEnterpriseAllocationConfig();
  const mode = config.global_settings?.allocation_mode || 'ACTIVE';
  console.log(`[ALLOCATION BOUNDARY] Generating allocation: date=${date}, mode=${mode}, method=${method || 'fair_random'}, orders=${orderCount}, team=${teamCount}`);

  try {
    let result;
    if (mode === 'OFF') {
      result = executeEnterpriseAllocation(date, { mode: 'OFF', ...req.body });
    } else if (mode === 'ACTIVE' || enterprise === true || use_enterprise === true) {
      result = executeEnterpriseAllocation(date, { mode: 'ACTIVE', ...req.body });
    } else if (mode === 'SHADOW') {
      result = executeEnterpriseAllocation(date, { mode: 'SHADOW', ...req.body });
    } else {
      result = executeEnterpriseAllocation(date, { mode, ...req.body });
    }

    console.log(`[ALLOCATION BOUNDARY] Allocation generated: date=${date}, status=${result.status || 'OK'}, assigned=${result.assigned_orders ?? result.assigned_count ?? 0}, unassigned=${result.unassigned_orders ?? result.unassigned_count ?? 0}`);
    res.json(result);
  } catch (err) {
    console.error(`[ALLOCATION BOUNDARY] Allocation generation failed: date=${date}, error=${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

/**
 * REALLOCATE REMAINING / UNCLAIMED ORDERS (Round 2+)
 */
app.post(['/api/allocations/:date/reallocate', '/api/allocations/reallocate', '/api/allocation/reallocate'], requireSupervisor, (req, res) => {
  const date = req.params.date || req.body?.work_date || req.body?.date || getCairoBusinessDate();
  const { method, max_capacity_per_employee, max_capacity, round_number, use_legacy } = req.body || {};
  try {
    let result;
    if (use_legacy === true) {
      result = reallocateWorkOrders(date, {
        method,
        max_capacity_per_employee: max_capacity_per_employee || max_capacity || 40,
        round_number,
        ...req.body
      });
    } else {
      result = executeEnterpriseAllocation(date, {
        mode: 'ACTIVE',
        isReallocate: true,
        trigger: 'REALLOCATE_EVENT',
        ...req.body
      });
    }
    res.json(result);
  } catch (err) {
    console.error('Error reallocating orders:', err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * SAVE FINAL ORDER-LEVEL ALLOCATION
 */
app.post('/api/allocations/:date/save-order-level', requireSupervisor, (req, res) => {
  const { date } = req.params;
  const { notes, generated_by } = req.body || {};
  const payloadSummary = req.body ? (Array.isArray(req.body) ? `Array(${req.body.length})` : `Object(keys: ${Object.keys(req.body).join(',')})`) : 'empty';
  console.log(`[ALLOCATION BOUNDARY] Saving order level allocation: date=${date}, payload=${payloadSummary}`);

  try {
    const result = saveFinalOrderLevelAllocation(date, req.body, notes, generated_by);
    console.log(`[ALLOCATION BOUNDARY] Order level allocation saved: date=${date}, version=${result.version_number || result.version}, total=${result.total_orders}, assigned=${result.assigned_orders}`);
    res.json(result);
  } catch (err) {
    console.error(`[ALLOCATION BOUNDARY] Error saving order level allocation: date=${date}, payload=${payloadSummary}, error=${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

/**
 * MANUAL OVERRIDE SINGLE ORDER ALLOCATION
 */
app.post('/api/allocations/:date/override', requireSupervisor, (req, res) => {
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
app.post('/api/allocations/:date/reassign-account', requireSupervisor, (req, res) => {
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
app.get(['/api/allocations/:date/export-zip', '/api/allocations/:date/export-all-zip'], async (req, res) => {
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

app.delete(['/api/allocations/date/:date', '/api/allocations/:date'], requireSupervisor, (req, res) => {
  const date = req.params.date || req.body?.work_date || req.body?.date || getCairoBusinessDate();
  try {
    const result = deleteAllocationForDate(date);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post(['/api/allocations/:date/reset', '/api/allocations/reset', '/api/allocation/reset'], requireSupervisor, (req, res) => {
  const date = req.params.date || req.body?.work_date || req.body?.date || getCairoBusinessDate();
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

    // Also extract products, merchant codes and warehouses into order_products
    try {
      if (req.file.buffer && req.file.buffer.length > 0) {
        importProductsFromExcel(req.file.buffer, req.file.originalname);
      }
    } catch (prodErr) {
      console.warn('Auto-import products note:', prodErr.message);
    }

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
 * EXCEL INTEGRATION & IMPORT ENDPOINTS (Management -> System & Integration)
 */
app.post('/api/integrations/excel/import-products', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No Excel file provided' });
  try {
    const summary = importProductsFromExcel(req.file.buffer, req.file.originalname);
    res.json({ success: true, summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/integrations/excel/import-logs', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No Excel file provided' });
  try {
    const summary = importHistoricalLogsFromExcel(req.file.buffer, req.file.originalname);
    res.json({ success: true, summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/integrations/excel/auto-seed', (req, res) => {
  try {
    const results = autoScanAndSeedAvailableExcelFiles();
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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

  if (ordersData && Array.isArray(ordersData.orders)) {
    ordersData.orders = ordersData.orders.map(enrichOrderOperationalIntelligence);
  }

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
 * ORDER & EMPLOYEE TRACKING APIS (PHASE 23 & REALTIME MONITOR)
 * ============================================================
 */

// GET /api/tracking/employee/realtime?date=YYYY-MM-DD (CRITICAL: Must precede /:employeeId)
app.get('/api/tracking/employee/realtime', (req, res) => {
  const date = req.query.date || req.query.workDate || getCairoBusinessDate();
  try {
    const data = getEmployeeLiveRealtime(date, {
      inactiveThreshold: req.query.inactive_threshold ? parseInt(req.query.inactive_threshold, 10) : 900,
      criticalThreshold: req.query.critical_threshold ? parseInt(req.query.critical_threshold, 10) : 2700,
      currentTime: req.query.current_time || null
    });
    res.json(data);
  } catch (err) {
    console.error('Realtime employee tracking error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tracking/team/status/:date (Team live monitoring status)
app.get('/api/tracking/team/status/:date', (req, res) => {
  const { date } = req.params;
  try {
    const data = getTeamLiveStatusSummary(date, {
      inactiveThreshold: req.query.inactive_threshold ? parseInt(req.query.inactive_threshold, 10) : 900,
      criticalThreshold: req.query.critical_threshold ? parseInt(req.query.critical_threshold, 10) : 2700,
      currentTime: req.query.current_time || null
    });
    res.json(data);
  } catch (err) {
    console.error('Team status summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tracking/employee/:employeeId (Employee tracking: assigned vs worked)
app.get('/api/tracking/employee/:employeeId', (req, res) => {
  const { employeeId } = req.params;
  const date = req.query.date || req.query.workDate || getCairoBusinessDate();
  try {
    const data = getEmployeeTracking(date, employeeId);
    res.json(data);
  } catch (err) {
    console.error('Employee tracking error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tracking/log (Log operational employee activity)
app.post('/api/tracking/log', (req, res) => {
  try {
    const result = logEmployeeActivity(req.body || {});
    res.json(result);
  } catch (err) {
    console.error('Log employee activity error:', err);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/tracking/order/claim
app.post('/api/tracking/order/claim', (req, res) => {
  const { work_date, date, order_code, employee_id } = req.body || {};
  const targetDate = work_date || date || getCairoBusinessDate();
  try {
    const result = claimOrder(targetDate, order_code, employee_id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/tracking/order/progress
app.post('/api/tracking/order/progress', (req, res) => {
  const { work_date, date, order_code, employee_id } = req.body || {};
  const targetDate = work_date || date || getCairoBusinessDate();
  try {
    const result = startOrderProgress(targetDate, order_code, employee_id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/tracking/order/complete
app.post('/api/tracking/order/complete', (req, res) => {
  const { work_date, date, order_code, employee_id } = req.body || {};
  const targetDate = work_date || date || getCairoBusinessDate();
  try {
    const result = completeOrder(targetDate, order_code, employee_id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/tracking/order/cancel
app.post('/api/tracking/order/cancel', (req, res) => {
  const { work_date, date, order_code, employee_id, reason } = req.body || {};
  const targetDate = work_date || date || getCairoBusinessDate();
  try {
    const result = cancelOrder(targetDate, order_code, employee_id, reason);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/tracking/order/handoff
app.post('/api/tracking/order/handoff', (req, res) => {
  try {
    const result = recordInternalHandoff(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/tracking/:date/order/:orderCode/history
app.get('/api/tracking/:date/order/:orderCode/history', (req, res) => {
  const { date, orderCode } = req.params;
  try {
    const data = getOrderFullHistory(date, orderCode);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tracking/overview (handles ?date=YYYY-MM-DD)
app.get('/api/tracking/overview', (req, res) => {
  const date = req.query.date || req.query.workDate || getCairoBusinessDate();
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

// GET /api/tracking/time-window & /api/tracking/:date/time-window (True Hourly Event Time Window Filter)
app.get(['/api/tracking/time-window', '/api/tracking/:date/time-window'], (req, res) => {
  const date = req.params.date || req.query.date || req.query.workDate || getCairoBusinessDate();
  const fromTime = req.query.fromTime || req.query.from || req.query.from_time || null;
  const toTime = req.query.toTime || req.query.to || req.query.to_time || null;
  const statusFilter = req.query.status || req.query.statusFilter || 'ALL';
  const employeeFilter = req.query.employee || req.query.employee_name || 'ALL';
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 500;

  try {
    const data = getHourlyTimeWindowEventData(date, fromTime, toTime, {
      statusFilter,
      employeeFilter,
      limit
    });
    res.json(data);
  } catch (err) {
    console.error('Time window filter error:', err);
    res.status(500).json({ success: false, error: err.message });
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

// GET /api/accounts/export/:date/:account (Account Detailed Audit Export: XLSX / CSV)
app.get(['/api/accounts/export/:date/:account', '/api/accounts-export/:date/:account'], (req, res) => {
  const { date, account } = req.params;
  const format = String(req.query.format || 'xlsx').toLowerCase();
  try {
    const accountData = getAccountDetailedData(date, account);
    const safeName = (account || 'Account').replace(/[^a-zA-Z0-9_\u0600-\u06FF]/g, '_');

    if (format === 'csv') {
      let csvContent = `Business Date,Selected Account\n"${date}","${account.replace(/"/g, '""')}"\n\n`;
      csvContent += `=== SHEET 1: RECONCILIATION SUMMARY ===\nMetric,Value\n`;
      csvContent += `"Total Orders in Pool",${accountData.total_orders || 0}\n`;
      csvContent += `"New Orders",${accountData.new_orders || 0}\n`;
      csvContent += `"Pending Orders",${accountData.pending_orders || 0}\n`;
      csvContent += `"Conflict Orders",${accountData.conflict_orders || 0}\n`;
      csvContent += `"Unique Orders Worked",${accountData.unique_orders_worked || 0}\n`;
      csvContent += `"Real Actions",${accountData.real_actions || 0}\n`;
      csvContent += `"Reconciliation Gap",${(accountData.total_orders || 0) - (accountData.unique_orders_worked || 0)}\n\n`;

      csvContent += `=== SHEET 2: ASSIGNED EMPLOYEES ===\nEmployee Name,Is Assigned\n`;
      (accountData.assigned_employees || []).forEach(emp => {
        csvContent += `"${emp.replace(/"/g, '""')}",YES\n`;
      });

      csvContent += `\n=== SHEET 3: WORKED EMPLOYEES & ACTIONS ===\nEmployee Name,Is Assigned,Orders Worked,Real Actions\n`;
      (accountData.worked_employees || []).forEach(emp => {
        const empName = typeof emp === 'string' ? emp : (emp.employee_name || 'Unknown');
        const isAssigned = typeof emp === 'object' ? emp.is_assigned : true;
        const workedCount = typeof emp === 'object' ? (emp.orders_worked || 0) : 0;
        const actionsCount = typeof emp === 'object' ? (emp.real_actions || 0) : 0;
        csvContent += `"${empName.replace(/"/g, '""')}","${isAssigned ? 'YES' : 'NO (Outside)'}",${workedCount},${actionsCount}\n`;
      });

      csvContent += `\n=== SHEET 4: ORDERS LIST & RECONCILIATION DETAILS ===\nOrder Code,Status,Order Date,Assigned Employee,Worked By,Reconciliation State\n`;
      (accountData.orders || []).forEach(ord => {
        csvContent += `"${(ord.order_code || '').replace(/"/g, '""')}","${(ord.status || '').replace(/"/g, '""')}","${(ord.order_date || '').replace(/"/g, '""')}","${(ord.assigned_employee || '').replace(/"/g, '""')}","${(ord.worked_by || '').replace(/"/g, '""')}","${(ord.reconciliation_state || 'NORMAL').replace(/"/g, '""')}"\n`;
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="Account_${safeName}_${date}.csv"`);
      return res.send(csvContent);
    } else {
      const wb = createAccountWorkbook(accountData);
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Account_${safeName}_${date}.xlsx"`);
      return res.send(buffer);
    }
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
    const totalRealActions = snapshots.reduce((s, r) => s + (r.real_actions || 0), 0);
    const totalPrintedActions = snapshots.reduce((s, r) => s + (r.printed_actions || 0), 0);
    const totalPendingActions = snapshots.reduce((s, r) => s + (r.pending_actions || 0), 0);
    const totalCancelledActions = snapshots.reduce((s, r) => s + (r.cancelled_actions || 0), 0);
    const totalProcessingActions = snapshots.reduce((s, r) => s + (r.processing_actions || 0), 0);
    const totalAltPhones = snapshots.reduce((s, r) => s + (r.alt_phones || 0), 0);
    const totalNewOrders = snapshots.reduce((s, r) => s + (r.new_orders || 0), 0);

    const totalPrintedOrders = snapshots.reduce((s, r) => s + (r.printed_orders || 0), 0);
    const totalPendingBacklog = snapshots.reduce((s, r) => s + (r.pending_backlog || 0), 0);
    const totalCancelledOrders = snapshots.reduce((s, r) => s + (r.cancelled_orders || 0), 0);

    let dedupStats = null;
    try {
      const dSnap = db.prepare('SELECT metrics_json FROM daily_metrics_snapshots WHERE work_date = ?').get(date);
      if (dSnap && dSnap.metrics_json) {
        const parsed = JSON.parse(dSnap.metrics_json);
        dedupStats = parsed.dedup || parsed.summary?.duplicatesRemovedPct !== undefined ? parsed.summary : null;
      }
    } catch {}

    const mappedEmployees = snapshots.map(s => ({
      ...s,
      name: s.employee_name,
      actions: s.real_actions,
      printed: s.printed_actions,
      pending: s.pending_actions,
      cancelled: s.cancelled_actions,
      processing: s.processing_actions,
      alt: s.alt_phones
    }));

    return res.json({
      exists: true,
      date,
      summary: {
        totalRealActions,
        printedActions: totalPrintedActions,
        pendingActions: totalPendingActions,
        cancelledActions: totalCancelledActions,
        processingActions: totalProcessingActions,
        totalAltPhones,
        totalNewOrders,
        dedup: dedupStats
      },
      totals: {
        actions: totalRealActions,
        new_orders: totalNewOrders,
        printed: totalPrintedActions,
        pending: totalPendingActions,
        cancelled: totalCancelledActions,
        processing: totalProcessingActions,
        alt_phones: totalAltPhones,
        printed_orders: totalPrintedOrders,
        pending_backlog: totalPendingBacklog,
        cancelled_orders: totalCancelledOrders
      },
      employees: mappedEmployees,
      top_performers: mappedEmployees.slice(0, 10),
      most_active: [...mappedEmployees].sort((a, b) => b.real_actions - a.real_actions).slice(0, 10)
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
  const fromTime = req.query.fromTime || req.query.from || null;
  const toTime = req.query.toTime || req.query.to || null;
  const cacheKey = fromTime || toTime ? `data_${reqDate}_${fromTime}_${toTime}` : `data_${reqDate}`;
  const cached = getCachedApiResponse(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    const dashboardData = getOperationalDashboardData(reqDate, { fromTime, toTime });
    setCachedApiResponse(cacheKey, dashboardData);
    return res.json(dashboardData);
  } catch (err) {
    console.error('Failed to get operational dashboard data for date', reqDate, err);
    return res.status(500).json({ exists: false, error: err.message });
  }
});

// Added Orders CS Breakdown API Endpoint (Part 33, 34, 60, 85)
app.get(['/api/added-orders', '/api/reports/added-orders'], (req, res) => {
  const reqDate = req.query.date || getEffectiveWorkDate();
  const cacheKey = `added_orders_${reqDate}`;
  const cached = getCachedApiResponse(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    // 1. Check daily_metrics_snapshots
    const snap = db.prepare('SELECT metrics_json FROM daily_metrics_snapshots WHERE work_date = ?').get(reqDate);
    if (snap && snap.metrics_json) {
      const parsed = JSON.parse(snap.metrics_json);
      const added = parsed.addedOrders || {};
      const result = {
        exists: true,
        date: reqDate,
        totalAdded: added.totalAdded || ((parsed.added_cs || 0) + (parsed.added_noncs || 0)),
        fromCS: parsed.fromCS ?? parsed.added_cs ?? 0,
        fromOtherDepartments: parsed.fromOtherDepartments ?? parsed.added_noncs ?? 0,
        topCSContributor: parsed.topCSContributor || added.topCSContributor || null,
        topCSContributors: parsed.topCSContributors || added.topCSContributors || [],
        allCSContributors: parsed.allCSContributors || added.allCSContributors || [],
      };
      setCachedApiResponse(cacheKey, result);
      return res.json(result);
    }

    // 2. Check performance_snapshots
    const rows = db.prepare('SELECT employee_name, added_orders FROM performance_snapshots WHERE date = ? ORDER BY added_orders DESC').all(reqDate);
    if (rows && rows.length > 0) {
      const csRows = rows
        .filter(r => r.employee_name.toLowerCase().endsWith('cs') && (r.added_orders || 0) > 0)
        .map(r => ({ name: r.employee_name, count: r.added_orders, total: r.added_orders }));
      const totalAdded = rows.reduce((s, r) => s + (r.added_orders || 0), 0);
      const csAdded = csRows.reduce((s, r) => s + r.count, 0);
      const result = {
        exists: true,
        date: reqDate,
        totalAdded,
        fromCS: csAdded,
        fromOtherDepartments: Math.max(0, totalAdded - csAdded),
        topCSContributor: csRows[0] ? csRows[0].name : null,
        topCSContributors: csRows.slice(0, 5),
        allCSContributors: csRows,
      };
      setCachedApiResponse(cacheKey, result);
      return res.json(result);
    }

    // 3. Empty state for date with no data
    const emptyResult = {
      exists: false,
      date: reqDate,
      totalAdded: 0,
      fromCS: 0,
      fromOtherDepartments: 0,
      topCSContributor: null,
      topCSContributors: [],
      allCSContributors: [],
    };
    setCachedApiResponse(cacheKey, emptyResult);
    return res.json(emptyResult);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Canonical Contextual Export Endpoint (POST /api/exports/xlsx)
// Implements Sections 43-51, 72-75 of Master Architecture Contract
app.post('/api/exports/xlsx', async (req, res) => {
  try {
    const viewCtx = req.body || {};
    const page = String(viewCtx.page || viewCtx.mainPage || 'overview').toLowerCase();
    const tab = String(viewCtx.tab || viewCtx.subPage || 'main').toLowerCase();
    const workDate = String(viewCtx.business_date || viewCtx.date || getEffectiveWorkDate()).trim();
    const timeFrom = viewCtx.time_window?.from || viewCtx.from || null;
    const timeTo = viewCtx.time_window?.to || viewCtx.to || null;
    const filters = viewCtx.filters || {};
    const search = viewCtx.search || '';

    let dataset = { rows: [], columns: [], summary: {} };

    // 1. Resolve dataset based on active page/tab
    if (page === 'work' && tab === 'allocation') {
      const orderAlloc = typeof getOrderLevelAllocation === 'function' ? getOrderLevelAllocation(workDate) : null;
      const allocData = typeof getAllocationForDate === 'function' ? getAllocationForDate(workDate) : null;
      let orders = orderAlloc?.orders || [];
      if (orders.length === 0) {
        orders = db.prepare(`
          SELECT 
            order_code, account, status, 
            assigned_employee_name, work_state,
            created_at as allocated_at
          FROM current_work_orders 
          WHERE work_date = ? AND assigned_employee_id IS NOT NULL
        `).all(workDate);
      }
      if (orders.length === 0 && allocData?.items) {
        orders = allocData.items.map(it => ({
          order_code: `BATCH-${it.id}`,
          account: it.account,
          status: it.status,
          assigned_employee_name: it.employee_name,
          allocated_at: it.created_at
        }));
      }
      dataset.columns = ['Order Code', 'Account', 'Status', 'Assigned Employee', 'Allocated At'];
      dataset.rows = orders.map(o => ({
        'Order Code': o.order_code,
        'Account': o.account,
        'Status': o.status,
        'Assigned Employee': o.assigned_employee_name || 'UNASSIGNED',
        'Allocated At': o.allocated_at || workDate
      }));
      dataset.summary = {
        'Total Allocated Orders': orders.length,
        'Unique Accounts': new Set(orders.map(o => o.account)).size,
        'CS Agents Assigned': new Set(orders.map(o => o.assigned_employee_name).filter(Boolean)).size
      };
    } else if (page === 'work' && (tab === 'orders' || tab === 'orders-pool')) {
      const ordersRes = getCurrentOrders(workDate, { limit: 5000 });
      const orders = ordersRes.orders || [];
      dataset.columns = ['Order Code', 'Account', 'Status', 'Work State', 'Assigned Employee', 'Date'];
      dataset.rows = orders.map(o => ({
        'Order Code': o.order_code,
        'Account': o.account,
        'Status': o.status,
        'Work State': o.work_state || 'UNASSIGNED',
        'Assigned Employee': o.assigned_employee_name || 'UNASSIGNED',
        'Date': o.order_date || workDate
      }));
      dataset.summary = {
        'Total Orders in Pool': orders.length,
        'New Orders': orders.filter(o => o.status === 'New').length,
        'Pending Orders': orders.filter(o => o.status === 'Pending').length
      };
    } else if (page === 'team') {
      const team = getWorkingTeam(workDate);
      dataset.columns = ['ID', 'Employee Name', 'Department', 'Team Membership', 'Status', 'Is Working Today', 'Source'];
      dataset.rows = team.map(e => ({
        'ID': e.id,
        'Employee Name': e.name,
        'Department': e.department,
        'Team Membership': e.team_membership || 'Both',
        'Status': e.status || 'ACTIVE',
        'Is Working Today': e.is_working ? 'Yes' : 'No',
        'Source': e.source || 'MANUAL'
      }));
      dataset.summary = {
        'Total CS Team': team.length,
        'Working Today': team.filter(e => e.is_working).length
      };
    } else {
      // Default: Overview & Performance Scorecard
      const snap = db.prepare('SELECT metrics_json FROM daily_metrics_snapshots WHERE work_date = ?').get(workDate);
      const data = snap && snap.metrics_json ? JSON.parse(snap.metrics_json) : getOperationalDashboardData(workDate);
      const empList = data.employees || [];
      dataset.columns = ['Rank', 'Employee', 'Total Actions', 'Printed', 'Print %', 'Pending', 'Pend %', 'Processing', 'Cancelled', 'Cancel %', 'Alt Phone', 'Grade'];
      dataset.rows = empList.map(e => ({
        'Rank': e.rank || '-',
        'Employee': e.name,
        'Total Actions': e.actions || 0,
        'Printed': e.printed || 0,
        'Print %': `${e.own_printed_rate || 0}%`,
        'Pending': e.pending || 0,
        'Pend %': `${e.own_pending_rate || 0}%`,
        'Processing': e.processing || 0,
        'Cancelled': e.cancelled || 0,
        'Cancel %': `${e.own_cancel_rate || 0}%`,
        'Alt Phone': e.alt || 0,
        'Grade': e.grade || '-'
      }));
      dataset.summary = {
        'Total CS Actions': data.log_totals?.actions || 0,
        'Total Printed': data.log_totals?.printed || 0,
        'Total Cancelled': data.log_totals?.cancelled || 0,
        'Team Cancel Rate': `${data.team_cancel_rate || 0}%`
      };
    }

    const wb = createContextualExportWorkbook(viewCtx, dataset);
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `CS_ExecutiveBI_${page}_${tab}_${workDate}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (err) {
    console.error('Contextual export failed:', err);
    return res.status(500).json({
      success: false,
      code: 'EXPORT_FAILED',
      error: `EXPORT_FAILED: ${err.message}`
    });
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
    res.setHeader('Content-Disposition', `attachment; filename="CS_ExecutiveBI_Executive_Report_${reqDate}.xlsx"`);
    return res.send(buffer);
  } catch (err) {
    console.error('Failed to generate dynamic Excel:', err);
    return res.status(500).json({
      success: false,
      code: 'EXPORT_FAILED',
      error: `EXPORT_FAILED: Failed to generate Excel report for date ${reqDate}. ${err.message}`
    });
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

app.post('/api/integrations/vendoor/credentials', requireSupervisor, (req, res) => {
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
app.post('/api/integrations/vendoor/sync/orders', requireSupervisor, async (req, res) => {
  try {
    const { fromDate, toDate, maxPages, pageSize, statusFilter, forceMode, businessDate, workDate, isHistoricalSync } = req.body || {};
    const result = await syncVendoorOrders({
      fromDate,
      toDate,
      businessDate: businessDate || workDate,
      isHistoricalSync: isHistoricalSync === true,
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

app.post('/api/integrations/vendoor/sync/logs', requireSupervisor, async (req, res) => {
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

app.post(['/api/integrations/vendoor/logs/import-week', '/api/vendoor/logs/import-week'], requireSupervisor, async (req, res) => {
  try {
    const { startDate, endDate, start_date, end_date, forceMode } = req.body || {};
    const result = await importWeeklyVendoorLogs({
      startDate: startDate || start_date,
      endDate: endDate || end_date,
      forceMode
    });
    return res.json(result);
  } catch (err) {
    if (err.code === 'IMPORT_ALREADY_RUNNING') {
      return res.status(409).json({
        success: false,
        code: 'IMPORT_ALREADY_RUNNING',
        error: err.message,
        status: err.status || getWeeklyLogsImportStatus()
      });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get(['/api/integrations/vendoor/logs/import-week/status', '/api/vendoor/logs/import-week/status'], (req, res) => {
  try {
    const status = getWeeklyLogsImportStatus();
    return res.json({ success: true, ...status });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get(['/api/integrations/vendoor/logs/import-week/preview-range', '/api/vendoor/logs/import-week/preview-range'], (req, res) => {
  try {
    const refDate = req.query.ref_date || req.query.date || getCairoBusinessDate();
    const range = getPreviousCompletedWeekRange(refDate);
    return res.json({ success: true, ref_date: refDate, ...range });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/integrations/vendoor/sync/all', async (req, res) => {
  try {
    const { workDate, fromDate, toDate, forceMode, isHistoricalSync } = req.body || {};
    const targetDate = workDate || fromDate || getCairoBusinessDate();
    const targetEndDate = toDate || targetDate;
    const isHistorical = isHistoricalSync === true;

    // 1. Sync orders (status-driven active orders for targetDate business date)
    const ordersResult = await syncVendoorOrders({
      businessDate: targetDate,
      fromDate: isHistorical ? targetDate : undefined,
      toDate: isHistorical ? targetEndDate : undefined,
      isHistoricalSync: isHistorical,
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
    const { endDate, toDate, days, chunkDays, startDate, fromDate, forceMode, today } = req.body || {};
    const result = await bootstrapHistoricalTwoMonths({
      startDate: startDate || fromDate,
      endDate: endDate || toDate,
      days: days || 60,
      chunkDays: chunkDays || 2,
      forceMode,
      today
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

app.post('/api/integrations/vendoor/poller/start', requireSupervisor, (req, res) => {
  try {
    const intervalMs = parseInt(req.body?.intervalMs, 10) || 60000;
    const result = startAutonomousVendoorPoller({ intervalMs, forceMode: req.body?.forceMode });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/integrations/vendoor/poller/stop', requireSupervisor, (req, res) => {
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

app.post('/api/integrations/vendoor/identity/map', requireSupervisor, (req, res) => {
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

app.delete('/api/integrations/vendoor/identity/:id', requireSupervisor, (req, res) => {
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
    const workDate = req.query.date || getCairoBusinessDate();
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

app.post('/api/vendoor/dispatcher/cycle', requireSupervisor, async (req, res) => {
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

app.post('/api/vendoor/dispatcher/start', requireSupervisor, (req, res) => {
  try {
    const { interval_ms } = req.body || {};
    const result = startContinuousDispatcher(interval_ms);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/vendoor/dispatcher/stop', requireSupervisor, (req, res) => {
  try {
    const result = stopContinuousDispatcher();
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/vendoor/dispatcher/config', requireSupervisor, (req, res) => {
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
    const workDate = req.query.date || getCairoBusinessDate();
    const workloads = getEmployeeWorkloadAndRefillStates(workDate);
    return res.json({ success: true, date: workDate, workloads });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/vendoor/dispatcher/unallocated', (req, res) => {
  try {
    const workDate = req.query.date || getCairoBusinessDate();
    const limit = parseInt(req.query.limit, 10) || 50;
    const pool = getUnallocatedOrdersPool(workDate, { limit });
    return res.json({ success: true, date: workDate, pool });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/vendoor/dispatcher/completion', (req, res) => {
  try {
    const workDate = req.query.date || getCairoBusinessDate();
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
    const cacheKey = `rep_exec_${JSON.stringify(req.query)}`;
    const cached = getCachedApiResponse(cacheKey);
    if (cached) return res.json(cached);

    const report = generateExecutiveSummaryReport({
      dateMode: req.query.date_mode || req.query.dateMode || 'day',
      targetDate: req.query.target_date || req.query.targetDate || req.query.date,
      startDate: req.query.start_date || req.query.startDate,
      endDate: req.query.end_date || req.query.endDate,
      filters: req.query
    });
    setCachedApiResponse(cacheKey, report);
    setImmediate(() => {
      try {
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
      } catch (e) {}
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/employee', (req, res) => {
  try {
    const cacheKey = `rep_emp_${JSON.stringify(req.query)}`;
    const cached = getCachedApiResponse(cacheKey);
    if (cached) return res.json(cached);

    const report = generateEmployeeReport({
      dateMode: req.query.date_mode || 'day',
      targetDate: req.query.target_date,
      startDate: req.query.start_date,
      endDate: req.query.end_date,
      filters: req.query
    });
    setCachedApiResponse(cacheKey, report);
    setImmediate(() => {
      try {
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
      } catch (e) {}
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/account', (req, res) => {
  try {
    const cacheKey = `rep_acc_${JSON.stringify(req.query)}`;
    const cached = getCachedApiResponse(cacheKey);
    if (cached) return res.json(cached);

    const report = generateAccountReport({
      dateMode: req.query.date_mode || 'day',
      targetDate: req.query.target_date,
      startDate: req.query.start_date,
      endDate: req.query.end_date,
      filters: req.query
    });
    setCachedApiResponse(cacheKey, report);
    setImmediate(() => {
      try {
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
      } catch (e) {}
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/merchant', (req, res) => {
  try {
    const cacheKey = `rep_merch_${JSON.stringify(req.query)}`;
    const cached = getCachedApiResponse(cacheKey);
    if (cached) return res.json(cached);

    const report = generateMerchantReport({
      dateMode: req.query.date_mode || 'day',
      targetDate: req.query.target_date,
      startDate: req.query.start_date,
      endDate: req.query.end_date,
      filters: req.query
    });
    setCachedApiResponse(cacheKey, report);
    setImmediate(() => {
      try {
        saveReportRecord({
          reportType: 'merchant',
          dateMode: report.date_mode,
          startDate: report.start_date,
          endDate: report.end_date,
          filters: req.query,
          generatedBy: req.query.generated_by || 'System User',
          rowCount: report.total_merchants,
          reportData: report
        });
      } catch (e) {}
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/marketer', (req, res) => {
  try {
    const cacheKey = `rep_mark_${JSON.stringify(req.query)}`;
    const cached = getCachedApiResponse(cacheKey);
    if (cached) return res.json(cached);

    const report = generateMarketerReport({
      dateMode: req.query.date_mode || 'day',
      targetDate: req.query.target_date,
      startDate: req.query.start_date,
      endDate: req.query.end_date,
      filters: req.query
    });
    setCachedApiResponse(cacheKey, report);
    setImmediate(() => {
      try {
        saveReportRecord({
          reportType: 'marketer',
          dateMode: report.date_mode,
          startDate: report.start_date,
          endDate: report.end_date,
          filters: req.query,
          generatedBy: req.query.generated_by || 'System User',
          rowCount: report.total_marketers,
          reportData: report
        });
      } catch (e) {}
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/allocation', (req, res) => {
  try {
    const cacheKey = `rep_alloc_${JSON.stringify(req.query)}`;
    const cached = getCachedApiResponse(cacheKey);
    if (cached) return res.json(cached);

    const report = generateAllocationReport({
      dateMode: req.query.date_mode || 'day',
      targetDate: req.query.target_date,
      startDate: req.query.start_date,
      endDate: req.query.end_date,
      filters: req.query
    });
    setCachedApiResponse(cacheKey, report);
    setImmediate(() => {
      try {
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
      } catch (e) {}
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/activity-logs', (req, res) => {
  try {
    const cacheKey = `rep_act_${JSON.stringify(req.query)}`;
    const cached = getCachedApiResponse(cacheKey);
    if (cached) return res.json(cached);

    const report = generateActivityLogsReport({
      dateMode: req.query.date_mode || 'day',
      targetDate: req.query.target_date,
      startDate: req.query.start_date,
      endDate: req.query.end_date,
      limit: req.query.limit,
      filters: req.query
    });
    setCachedApiResponse(cacheKey, report);
    setImmediate(() => {
      try {
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
      } catch (e) {}
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/productivity', (req, res) => {
  try {
    const cacheKey = `rep_prod_${JSON.stringify(req.query)}`;
    const cached = getCachedApiResponse(cacheKey);
    if (cached) return res.json(cached);

    const report = generateProductivityReport({
      targetDate: req.query.target_date,
      filters: req.query
    });
    setCachedApiResponse(cacheKey, report);
    setImmediate(() => {
      try {
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
      } catch (e) {}
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

app.get('/api/employee-evaluation', (req, res) => {
  try {
    const result = getEmployeeEvaluation(req.query);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/employee-evaluation/:id', (req, res) => {
  try {
    const detail = getEmployeeEvaluationDetail(parseInt(req.params.id, 10), req.query);
    if (!detail) return res.status(404).json({ error: 'Employee not found' });
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/phone-match-alerts', (req, res) => {
  try {
    const result = getPhoneMatchAlerts(req.query);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/phone-match-alerts/history/:orderCode', (req, res) => {
  try {
    const history = getPhoneMatchAlertHistory(req.params.orderCode);
    res.json({
      success: true,
      order_code: req.params.orderCode,
      total_records: history.length,
      history
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/phone-match-alerts/:id/resolve', (req, res) => {
  try {
    const resolved = resolvePhoneMatchAlertById(req.params.id);
    res.json({
      success: resolved,
      id: req.params.id,
      status: resolved ? 'RESOLVED' : 'NOT_FOUND_OR_ALREADY_RESOLVED'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/reports/phone-alerts', (req, res) => {
  try {
    const report = generatePhoneAlertsReport(req.query);
    saveReportRecord({
      reportType: 'phone_alerts',
      dateMode: report.date_mode,
      startDate: report.start_date,
      endDate: report.end_date,
      filters: req.query,
      generatedBy: req.query.generated_by || 'Supervisor',
      rowCount: report.total_alerts,
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
      case 'merchant':
        data = generateMerchantReport(req.query);
        break;
      case 'marketer':
      case 'affiliate':
        data = generateMarketerReport(req.query);
        break;
      case 'phone_alerts':
      case 'phone_match_alerts':
        data = generatePhoneAlertsReport(req.query);
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

// Fallback to index.html with strict no-cache headers
app.get('*', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
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

const isTestExecution = process.env.NODE_ENV === 'test' || process.argv.some(a => typeof a === 'string' && a.includes('test'));
if (!isTestExecution) {
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
          console.log('[AUTONOMOUS] Initial Vendoor auto-login notice:', err.message);
        });
      }
      if (cfg.hasCredentials || cfg.mockMode) {
        startAutonomousVendoorPoller({ intervalMs: 60000, ordersIntervalMs: 60000, logsIntervalMs: 120000 });
        console.log('[AUTONOMOUS] Decoupled background Vendoor poller initialized (Orders 60s, Logs 120s with rate-limit backoff).');
      } else {
        console.log('[AUTONOMOUS] Background Vendoor poller idle (no active credentials configured).');
      }
    try {
      autoScanAndSeedAvailableExcelFiles();
    } catch (seedErr) {
      console.warn('Excel autoScan notice:', seedErr.message);
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[FATAL] Port ${PORT} already in use. Exiting so supervisor can restart cleanly.`);
      process.exit(1);
    } else {
      console.error('[ERROR] Server listen error:', err);
      process.exit(1);
    }
  });

  const handleShutdown = (sig) => {
    console.log(`[SHUTDOWN] Signal ${sig} received, terminating server cleanly...`);
    try { stopAutonomousVendoorPoller(); } catch (_) {}
    server.close(() => {
      console.log('[SHUTDOWN] Server closed cleanly.');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

export { app, db };
