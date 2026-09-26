/**
 * services/enterprise_allocation.js
 * 
 * CS Executive BI — Enterprise Allocation Engine
 * Authoritative implementation of:
 * - NEW / PENDING State Machine (P1 -> P2 -> P3 -> NEW -> P4...)
 * - Employee-Specific Workload Capacity & Hard Limits
 * - Account + Status Independent Scheduling & Exact Time Window Boundaries
 * - Daily PENDING Rescue Engine (Operational Pressure Formula)
 * - Two-Level Distribution Uniqueness & Deterministic Regeneration
 * - Full Pre-Allocation Snapshots, Decision Audits & Explainability
 * - Atomic Transactional Execution, Idempotency & Concurrency Protection
 * - Centralized Versioned Configuration Center (Section 133A)
 * - Controlled Modes: OFF, SHADOW, PREVIEW, ACTIVE
 */

import crypto from 'crypto';
import { db } from '../db/index.js';
import { isCsEmployee } from './parser.js';
import { getCairoBusinessDate, getCairoNow, parseCairoTimestamp } from './time_utils.js';
import { generateTrackingId, recordOrderLifecycleEvent, logEmployeeActivity } from './tracking.js';
import { getWorkingTeam } from './allocation.js';

// ============================================================
// CONSTANTS & ERROR CODES
// ============================================================
export const ALLOCATION_MODES = {
  OFF: 'OFF',
  SHADOW: 'SHADOW',
  PREVIEW: 'PREVIEW',
  ACTIVE: 'ACTIVE'
};

export const ALLOCATION_ERROR_CODES = {
  EMPLOYEE_NOT_CS: 'EMPLOYEE_NOT_CS',
  EMPLOYEE_INACTIVE: 'EMPLOYEE_INACTIVE',
  EMPLOYEE_NOT_IN_WORKING_TEAM: 'EMPLOYEE_NOT_IN_WORKING_TEAM',
  EMPLOYEE_ACTIVITY_TOO_OLD: 'EMPLOYEE_ACTIVITY_TOO_OLD',
  EMPLOYEE_CAPACITY_EXHAUSTED: 'EMPLOYEE_CAPACITY_EXHAUSTED',
  ACCOUNT_STATUS_OUTSIDE_TIME_WINDOW: 'ACCOUNT_STATUS_OUTSIDE_TIME_WINDOW',
  ACCOUNT_STATUS_NOT_YET_OPEN: 'ACCOUNT_STATUS_NOT_YET_OPEN',
  ACCOUNT_STATUS_CLOSED: 'ACCOUNT_STATUS_CLOSED',
  ORDER_INVALID: 'ORDER_INVALID',
  DAILY_PENDING_STATE_BLOCKS_NEW: 'DAILY_PENDING_STATE_BLOCKS_NEW',
  RESCUE_CONDITION_NOT_MET: 'RESCUE_CONDITION_NOT_MET',
  DUPLICATE_DISTRIBUTION: 'DUPLICATE_DISTRIBUTION',
  NO_UNIQUE_VALID_DISTRIBUTION: 'NO_UNIQUE_VALID_DISTRIBUTION',
  DATA_INTEGRITY_FAILURE: 'DATA_INTEGRITY_FAILURE',
  INVALID_ACCOUNT_SCHEDULE: 'INVALID_ACCOUNT_SCHEDULE',
  ALLOCATION_CONFLICT: 'ALLOCATION_CONFLICT',
  ALLOCATION_ALREADY_EXECUTED: 'ALLOCATION_ALREADY_EXECUTED',
  PREVIEW_STALE: 'PREVIEW_STALE',
  CONFIGURATION_CONFLICT: 'CONFIGURATION_CONFLICT'
};

// ============================================================
// 1. CONFIGURATION CENTER MANAGEMENT (Section 133A)
// ============================================================

/**
 * Retrieves the latest published allocation configuration
 */
export function getEnterpriseAllocationConfig(workDate = null) {
  const activeVer = db.prepare(`
    SELECT * FROM allocation_configuration_versions 
    WHERE is_active = 1 
    ORDER BY version DESC LIMIT 1
  `).get();

  const currentVersion = activeVer ? activeVer.version : 1;
  const publishedAt = activeVer ? activeVer.published_at : new Date().toISOString();
  const publishedBy = activeVer ? activeVer.published_by : 'System Initializer';

  // 1. Global Settings
  const globalRows = db.prepare('SELECT key, value FROM allocation_global_settings').all();
  const globalSettings = {
    allocation_mode: 'ACTIVE',
    activity_lookback_minutes: 15,
    low_remaining_threshold: 3,
    pending_rescue_threshold: 20,
    large_load_threshold: 1000
  };
  for (const r of globalRows) {
    if (r.key === 'activity_lookback_minutes' || r.key === 'low_remaining_threshold' || 
        r.key === 'pending_rescue_threshold' || r.key === 'large_load_threshold') {
      const val = parseInt(r.value, 10);
      if (!isNaN(val)) globalSettings[r.key] = val;
    } else {
      globalSettings[r.key] = r.value;
    }
  }

  // 2. Account Schedules
  // Get all known accounts from current orders, account rules, account schedules
  const accountRows = db.prepare('SELECT * FROM account_schedules ORDER BY account ASC').all();
  const knownAccountsSet = new Set(accountRows.map(r => r.account));

  try {
    const orderAccs = db.prepare("SELECT DISTINCT account FROM current_work_orders WHERE account IS NOT NULL AND TRIM(account) != ''").all();
    for (const oa of orderAccs) knownAccountsSet.add(oa.account.trim());
  } catch (_) {}
  try {
    const ruleAccs = db.prepare("SELECT DISTINCT account_name FROM account_rules WHERE account_name IS NOT NULL AND TRIM(account_name) != ''").all();
    for (const ra of ruleAccs) knownAccountsSet.add(ra.account_name.trim());
  } catch (_) {}

  const accountSchedMap = new Map(accountRows.map(r => [r.account.toLowerCase(), r]));
  const allAccountsList = Array.from(knownAccountsSet).sort((a, b) => a.localeCompare(b)).map(acc => {
    const existing = accountSchedMap.get(acc.toLowerCase());
    const newStart = existing?.new_start_time ? existing.new_start_time.trim() : '';
    const newEnd = existing?.new_end_time ? existing.new_end_time.trim() : '';
    const pendStart = existing?.pending_start_time ? existing.pending_start_time.trim() : '';
    const pendEnd = existing?.pending_end_time ? existing.pending_end_time.trim() : '';

    return {
      account: acc,
      new_start_time: newStart,
      new_end_time: newEnd,
      pending_start_time: pendStart,
      pending_end_time: pendEnd,
      is_new_all_day: !newStart && !newEnd,
      is_pending_all_day: !pendStart && !pendEnd
    };
  });

  // 3. Employee Capacities
  const activeCsEmployees = db.prepare(`
    SELECT id, name, department, team_membership, active, status
    FROM employees
    WHERE active = 1 AND (status = 'ACTIVE' OR status IS NULL)
    ORDER BY name ASC
  `).all().filter(e => isCsEmployee(e));

  const empCapRows = db.prepare('SELECT employee_id, max_orders FROM employee_capacities').all();
  const empCapMap = new Map(empCapRows.map(r => [r.employee_id, r.max_orders]));

  // Current workload calculation for target date
  const targetDate = workDate || getCairoBusinessDate();
  const workloads = getEmployeesWorkloadMap(targetDate);

  const employeeCapacityList = activeCsEmployees.map(emp => {
    const configuredMax = empCapMap.has(emp.id) ? empCapMap.get(emp.id) : 40;
    const currentLoad = workloads.get(emp.id) || 0;
    const remainingCap = Math.max(0, configuredMax - currentLoad);

    return {
      employee_id: emp.id,
      employee_name: emp.name,
      department: emp.department,
      team_membership: emp.team_membership || 'Both',
      max_orders: configuredMax,
      current_workload: currentLoad,
      remaining_capacity: remainingCap
    };
  });

  return {
    version: currentVersion,
    published_at: publishedAt,
    published_by: publishedBy,
    global_settings: globalSettings,
    accounts: allAccountsList,
    employees: employeeCapacityList
  };
}

/**
 * Validates a complete draft configuration without publishing
 */
export function validateEnterpriseAllocationConfig(draftConfig) {
  const errors = [];

  if (!draftConfig || typeof draftConfig !== 'object') {
    return { valid: false, errors: [{ section: 'root', reason: 'Configuration payload is required' }] };
  }

  // 1. Validate Global Settings
  const globals = draftConfig.global_settings || {};
  if (globals.allocation_mode && !['OFF', 'SHADOW', 'PREVIEW', 'ACTIVE'].includes(globals.allocation_mode)) {
    errors.push({
      section: 'global_settings',
      field: 'allocation_mode',
      value: globals.allocation_mode,
      reason: "Mode must be one of 'OFF', 'SHADOW', 'PREVIEW', 'ACTIVE'"
    });
  }

  if (globals.activity_lookback_minutes !== undefined) {
    const mins = Number(globals.activity_lookback_minutes);
    if (isNaN(mins) || mins < 1 || mins > 1440) {
      errors.push({
        section: 'global_settings',
        field: 'activity_lookback_minutes',
        value: globals.activity_lookback_minutes,
        reason: 'Activity lookback minutes must be a positive integer between 1 and 1440'
      });
    }
  }

  if (globals.low_remaining_threshold !== undefined) {
    const thresh = Number(globals.low_remaining_threshold);
    if (isNaN(thresh) || thresh < 0 || thresh > 500) {
      errors.push({
        section: 'global_settings',
        field: 'low_remaining_threshold',
        value: globals.low_remaining_threshold,
        reason: 'Low remaining threshold must be a non-negative number between 0 and 500'
      });
    }
  }

  if (globals.pending_rescue_threshold !== undefined) {
    const thresh = Number(globals.pending_rescue_threshold);
    if (isNaN(thresh) || thresh < 1 || thresh > 5000) {
      errors.push({
        section: 'global_settings',
        field: 'pending_rescue_threshold',
        value: globals.pending_rescue_threshold,
        reason: 'PENDING rescue threshold must be a positive number between 1 and 5000'
      });
    }
  }

  // 2. Validate Account Schedules
  const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const accounts = Array.isArray(draftConfig.accounts) ? draftConfig.accounts : [];

  for (const acc of accounts) {
    if (!acc.account || !String(acc.account).trim()) {
      errors.push({ section: 'accounts', field: 'account', value: acc.account, reason: 'Account name cannot be empty' });
      continue;
    }
    const accName = String(acc.account).trim();

    // Check NEW schedule
    const ns = (acc.new_start_time || '').trim();
    const ne = (acc.new_end_time || '').trim();
    if ((ns && !ne) || (!ns && ne)) {
      errors.push({
        section: 'accounts',
        account: accName,
        field: 'NEW Schedule',
        value: `${ns} - ${ne}`,
        reason: 'Both Start and End times are required for a bounded NEW schedule (or leave both blank for ALL_DAY)'
      });
    } else if (ns && ne) {
      if (!timeRegex.test(ns) || !timeRegex.test(ne)) {
        errors.push({
          section: 'accounts',
          account: accName,
          field: 'NEW Schedule',
          value: `${ns} - ${ne}`,
          reason: 'Time format must be HH:MM (24-hour)'
        });
      } else if (ns >= ne) {
        errors.push({
          section: 'accounts',
          account: accName,
          field: 'new_end_time',
          value: ne,
          reason: `NEW End time (${ne}) must be strictly after Start time (${ns})`
        });
      }
    }

    // Check PENDING schedule
    const ps = (acc.pending_start_time || '').trim();
    const pe = (acc.pending_end_time || '').trim();
    if ((ps && !pe) || (!ps && pe)) {
      errors.push({
        section: 'accounts',
        account: accName,
        field: 'PENDING Schedule',
        value: `${ps} - ${pe}`,
        reason: 'Both Start and End times are required for a bounded PENDING schedule (or leave both blank for ALL_DAY)'
      });
    } else if (ps && pe) {
      if (!timeRegex.test(ps) || !timeRegex.test(pe)) {
        errors.push({
          section: 'accounts',
          account: accName,
          field: 'PENDING Schedule',
          value: `${ps} - ${pe}`,
          reason: 'Time format must be HH:MM (24-hour)'
        });
      } else if (ps >= pe) {
        errors.push({
          section: 'accounts',
          account: accName,
          field: 'pending_end_time',
          value: pe,
          reason: `PENDING End time (${pe}) must be strictly after Start time (${ps})`
        });
      }
    }
  }

  // 3. Validate Employee Capacities
  const employees = Array.isArray(draftConfig.employees) ? draftConfig.employees : [];
  for (const emp of employees) {
    const id = emp.employee_id || emp.id;
    if (!id) {
      errors.push({ section: 'employees', field: 'employee_id', value: id, reason: 'Employee ID is required' });
      continue;
    }
    const maxOrders = Number(emp.max_orders);
    if (isNaN(maxOrders) || maxOrders < 0 || !Number.isInteger(maxOrders)) {
      errors.push({
        section: 'employees',
        employee: emp.employee_name || id,
        field: 'max_orders',
        value: emp.max_orders,
        reason: 'Maximum orders must be a non-negative integer'
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Atomically saves all validated configuration and creates a new configuration version
 * Enforces all-or-nothing transactional guarantee (Section 133A.5)
 */
export function saveEnterpriseAllocationConfig(draftConfig, operator = 'Supervisor', expectedVersion = null) {
  // 1. Strict pre-validation
  const validation = validateEnterpriseAllocationConfig(draftConfig);
  if (!validation.valid) {
    const err = new Error('Configuration validation failed: ' + validation.errors.map(e => `${e.section}/${e.field || ''}: ${e.reason}`).join('; '));
    err.validation_errors = validation.errors;
    err.code = ALLOCATION_ERROR_CODES.INVALID_ACCOUNT_SCHEDULE;
    throw err;
  }

  // 2. Fetch current active version for optimistic concurrency check
  const activeVerRow = db.prepare('SELECT version FROM allocation_configuration_versions WHERE is_active = 1 ORDER BY version DESC LIMIT 1').get();
  const currentVersion = activeVerRow ? activeVerRow.version : 0;

  if (expectedVersion !== null && expectedVersion !== undefined && Number(expectedVersion) !== currentVersion) {
    const err = new Error(`CONFIGURATION_CONFLICT: Expected configuration version ${expectedVersion} but current version is ${currentVersion}. Refresh and reconcile before publishing.`);
    err.code = ALLOCATION_ERROR_CODES.CONFIGURATION_CONFLICT;
    throw err;
  }

  let newVersion = currentVersion + 1;
  let accountsChangedCount = 0;
  let employeesChangedCount = 0;
  let settingsChangedCount = 0;
  const diffSummary = {
    accounts: [],
    employees: [],
    globals: []
  };

  const tx = db.transaction(() => {
    // A. Persist Global Settings
    const globals = draftConfig.global_settings || {};
    const upsertGlobal = db.prepare(`
      INSERT INTO allocation_global_settings (key, value, description, config_version, updated_at, updated_by)
      VALUES (?, ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        config_version = excluded.config_version,
        updated_at = datetime('now'),
        updated_by = excluded.updated_by
    `);

    for (const [key, val] of Object.entries(globals)) {
      if (val === undefined || val === null) continue;
      const strVal = String(val).trim();
      const existing = db.prepare('SELECT value FROM allocation_global_settings WHERE key = ?').get(key);
      if (!existing || existing.value !== strVal) {
        settingsChangedCount++;
        diffSummary.globals.push({ key, old: existing ? existing.value : null, new: strVal });
      }
      upsertGlobal.run(key, strVal, `Allocation policy setting: ${key}`, newVersion, operator);
    }

    // B. Persist Account Schedules
    const upsertSchedule = db.prepare(`
      INSERT INTO account_schedules (
        account, new_start_time, new_end_time, pending_start_time, pending_end_time,
        config_version, updated_at, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(account) DO UPDATE SET
        new_start_time = excluded.new_start_time,
        new_end_time = excluded.new_end_time,
        pending_start_time = excluded.pending_start_time,
        pending_end_time = excluded.pending_end_time,
        config_version = excluded.config_version,
        updated_at = datetime('now'),
        updated_by = excluded.updated_by
    `);

    const accounts = Array.isArray(draftConfig.accounts) ? draftConfig.accounts : [];
    for (const acc of accounts) {
      const cleanAcc = String(acc.account).trim();
      const ns = (acc.new_start_time || '').trim() || null;
      const ne = (acc.new_end_time || '').trim() || null;
      const ps = (acc.pending_start_time || '').trim() || null;
      const pe = (acc.pending_end_time || '').trim() || null;

      const existing = db.prepare('SELECT * FROM account_schedules WHERE account = ?').get(cleanAcc);
      const changed = !existing || 
        existing.new_start_time !== ns || existing.new_end_time !== ne ||
        existing.pending_start_time !== ps || existing.pending_end_time !== pe;

      if (changed) {
        accountsChangedCount++;
        diffSummary.accounts.push({
          account: cleanAcc,
          old_new: existing ? `${existing.new_start_time || 'ALL'} - ${existing.new_end_time || 'ALL'}` : 'NEW',
          new_new: `${ns || 'ALL'} - ${ne || 'ALL'}`,
          old_pending: existing ? `${existing.pending_start_time || 'ALL'} - ${existing.pending_end_time || 'ALL'}` : 'NEW',
          new_pending: `${ps || 'ALL'} - ${pe || 'ALL'}`
        });
      }

      upsertSchedule.run(cleanAcc, ns, ne, ps, pe, newVersion, operator);
    }

    // C. Persist Employee Capacities
    const upsertCap = db.prepare(`
      INSERT INTO employee_capacities (employee_id, max_orders, config_version, updated_at, updated_by)
      VALUES (?, ?, ?, datetime('now'), ?)
      ON CONFLICT(employee_id) DO UPDATE SET
        max_orders = excluded.max_orders,
        config_version = excluded.config_version,
        updated_at = datetime('now'),
        updated_by = excluded.updated_by
    `);

    const employees = Array.isArray(draftConfig.employees) ? draftConfig.employees : [];
    for (const emp of employees) {
      const empId = Number(emp.employee_id || emp.id);
      const maxOrders = Number(emp.max_orders);
      const existing = db.prepare('SELECT max_orders FROM employee_capacities WHERE employee_id = ?').get(empId);
      if (!existing || existing.max_orders !== maxOrders) {
        employeesChangedCount++;
        diffSummary.employees.push({
          employee_id: empId,
          employee_name: emp.employee_name || emp.name,
          old_max: existing ? existing.max_orders : null,
          new_max: maxOrders
        });
      }
      upsertCap.run(empId, maxOrders, newVersion, operator);
    }

    // D. Mark prior versions inactive and record new version
    db.prepare('UPDATE allocation_configuration_versions SET is_active = 0').run();

    const insertVer = db.prepare(`
      INSERT INTO allocation_configuration_versions (
        version, published_at, published_by, config_json, diff_summary_json,
        accounts_changed, employees_changed, settings_changed, is_active
      ) VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, 1)
    `);

    insertVer.run(
      newVersion,
      operator,
      JSON.stringify(draftConfig),
      JSON.stringify(diffSummary),
      accountsChangedCount,
      employeesChangedCount,
      settingsChangedCount
    );
  });

  tx();

  return {
    success: true,
    version: newVersion,
    published_at: new Date().toISOString(),
    accounts_changed: accountsChangedCount,
    employees_changed: employeesChangedCount,
    settings_changed: settingsChangedCount,
    diff_summary: diffSummary
  };
}

/**
 * Returns historical published configuration versions for audit
 */
export function getEnterpriseConfigurationHistory(limit = 20) {
  const rows = db.prepare(`
    SELECT version, published_at, published_by, accounts_changed, employees_changed, settings_changed, is_active, diff_summary_json
    FROM allocation_configuration_versions
    ORDER BY version DESC
    LIMIT ?
  `).all(limit);

  return rows.map(r => ({
    version: r.version,
    published_at: r.published_at,
    published_by: r.published_by,
    accounts_changed: r.accounts_changed,
    employees_changed: r.employees_changed,
    settings_changed: r.settings_changed,
    is_active: r.is_active === 1,
    diff_summary: r.diff_summary_json ? JSON.parse(r.diff_summary_json) : null
  }));
}

// ============================================================
// 2. ACCOUNT + STATUS SCHEDULE EVALUATION (Sections 43-49, 176)
// ============================================================

/**
 * Deterministically evaluates whether an Account + Work Type is OPEN at operational time
 * START <= current_time < END
 * Exact START = OPEN
 * Exact END = CLOSED
 * Blank Start + Blank End = ALL_DAY (Always OPEN)
 */
export function evaluateAccountTimeStatus(account, workType, currentTimeStr = null) {
  const normType = String(workType || 'NEW').trim().toUpperCase();
  const isPending = normType.includes('PENDING');

  const nowTime = currentTimeStr 
    ? extractTimeHHMM(currentTimeStr)
    : extractTimeHHMM(getCairoNow());

  const sched = db.prepare('SELECT * FROM account_schedules WHERE account = ? COLLATE NOCASE').get(account.trim());

  let start = null;
  let end = null;

  if (sched) {
    if (isPending) {
      start = sched.pending_start_time ? sched.pending_start_time.trim() : null;
      end = sched.pending_end_time ? sched.pending_end_time.trim() : null;
    } else {
      start = sched.new_start_time ? sched.new_start_time.trim() : null;
      end = sched.new_end_time ? sched.new_end_time.trim() : null;
    }
  }

  // Blank start and blank end means ALL_DAY
  if (!start && !end) {
    return {
      account,
      work_type: isPending ? 'PENDING' : 'NEW',
      status: 'ALL_DAY',
      is_open: true,
      start_time: null,
      end_time: null,
      current_time: nowTime,
      time_priority_rank: 4 // 4 = ALL_DAY (Priority dimension 4)
    };
  }

  // Exact boundary comparison
  if (nowTime < start) {
    return {
      account,
      work_type: isPending ? 'PENDING' : 'NEW',
      status: 'NOT_YET_OPEN',
      is_open: false,
      start_time: start,
      end_time: end,
      current_time: nowTime,
      reason_code: ALLOCATION_ERROR_CODES.ACCOUNT_STATUS_NOT_YET_OPEN,
      time_priority_rank: 99
    };
  }

  if (nowTime >= end) {
    return {
      account,
      work_type: isPending ? 'PENDING' : 'NEW',
      status: 'CLOSED',
      is_open: false,
      start_time: start,
      end_time: end,
      current_time: nowTime,
      reason_code: ALLOCATION_ERROR_CODES.ACCOUNT_STATUS_CLOSED,
      time_priority_rank: 99
    };
  }

  // Inside window: START <= nowTime < END
  return {
    account,
    work_type: isPending ? 'PENDING' : 'NEW',
    status: 'OPEN',
    is_open: true,
    start_time: start,
    end_time: end,
    current_time: nowTime,
    time_priority_rank: 1 // 1 = OPEN bounded window (Priority dimension 1)
  };
}

function extractTimeHHMM(timeOrIso) {
  if (!timeOrIso) return '00:00';
  const str = String(timeOrIso).trim();
  if (/^([01]\d|2[0-3]):([0-5]\d)$/.test(str)) {
    return str;
  }
  const match = str.match(/T?(\d{2}):(\d{2})/);
  if (match) {
    return `${match[1]}:${match[2]}`;
  }
  return '00:00';
}

// ============================================================
// 3. EMPLOYEE ELIGIBILITY, CAPACITY & STATE MACHINE
// ============================================================

/**
 * Returns employee authoritative current active workload map for a work date
 */
export function getEmployeesWorkloadMap(workDate) {
  const map = new Map();
  try {
    const rows = db.prepare(`
      SELECT assigned_employee_id, COUNT(*) as cnt
      FROM current_work_orders
      WHERE work_date = ? 
        AND assigned_employee_id IS NOT NULL 
        AND (work_state IS NULL OR work_state NOT IN ('COMPLETED', 'CANCELLED'))
      GROUP BY assigned_employee_id
    `).all(workDate);

    for (const r of rows) {
      if (r.assigned_employee_id) {
        map.set(r.assigned_employee_id, r.cnt);
      }
    }
  } catch (_) {}
  return map;
}

/**
 * Retrieves or initializes employee daily allocation state
 */
export function getEmployeeDailyAllocationState(employeeId, workDate) {
  let row = db.prepare(`
    SELECT * FROM employee_daily_allocation_states
    WHERE work_date = ? AND employee_id = ?
  `).get(workDate, employeeId);

  if (!row) {
    db.prepare(`
      INSERT OR IGNORE INTO employee_daily_allocation_states (
        work_date, employee_id, pending_sequence, new_event_consumed, daily_mode, rescue_state
      ) VALUES (?, ?, 0, 0, 'NORMAL', 'NONE')
    `).run(workDate, employeeId);

    row = db.prepare(`
      SELECT * FROM employee_daily_allocation_states
      WHERE work_date = ? AND employee_id = ?
    `).get(workDate, employeeId);
  }

  return row || {
    work_date: workDate,
    employee_id: employeeId,
    pending_sequence: 0,
    new_event_consumed: 0,
    daily_mode: 'NORMAL',
    rescue_state: 'NONE'
  };
}

function parseEpochNormalized(ts) {
  if (!ts) return null;
  const s = String(ts).trim();
  const clean = s.replace(' ', 'T').replace(/Z|[+-]\d{2}:?\d{2}$/i, '');
  const m = clean.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [_, y, mo, d, hh = '00', mm = '00', ss = '00'] = m;
    return Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss);
  }
  const dt = new Date(ts);
  return isNaN(dt.getTime()) ? null : dt.getTime();
}

/**
 * Evaluates an employee's comprehensive eligibility for allocation
 */
export function evaluateEmployeeAllocationEligibility(employeeId, workDate, options = {}) {
  const exclusionReasons = [];
  const emp = db.prepare('SELECT id, name, department, team_membership, active, status FROM employees WHERE id = ?').get(employeeId);

  if (!emp) {
    return {
      is_eligible: false,
      exclusion_reasons: ['EMPLOYEE_NOT_FOUND'],
      employee: null
    };
  }

  // 1. Employee Master CS Identity
  if (!isCsEmployee(emp)) {
    exclusionReasons.push(ALLOCATION_ERROR_CODES.EMPLOYEE_NOT_CS);
  }

  // 2. Active Employee Master
  const isActive = (emp.active === 1 || emp.active === true) && (emp.status === 'ACTIVE' || emp.status === null);
  if (!isActive) {
    exclusionReasons.push(ALLOCATION_ERROR_CODES.EMPLOYEE_INACTIVE);
  }

  // 3. Today's Working Team
  const dwt = db.prepare('SELECT is_working, last_activity_at FROM daily_working_team WHERE work_date = ? AND employee_id = ?').get(workDate, employeeId);
  const isWorking = dwt && (dwt.is_working === 1 || dwt.is_working === true);
  if (!isWorking && !options.skip_working_team_check) {
    exclusionReasons.push(ALLOCATION_ERROR_CODES.EMPLOYEE_NOT_IN_WORKING_TEAM);
  }

  // 4. Activity Check (Lookback X minutes)
  const lookbackMins = options.activity_lookback_minutes || getGlobalSettingInt('activity_lookback_minutes', 15);
  const canonicalNowMs = options.currentTime ? parseEpochNormalized(options.currentTime) : Date.now();
  const maxStaleMs = lookbackMins * 60 * 1000;

  let lastActivityMs = null;
  let lastActivityTimeStr = null;

  try {
    const actRow = db.prepare(`
      SELECT timestamp FROM employee_activity_log
      WHERE work_date = ? AND employee_id = ?
      ORDER BY timestamp DESC LIMIT 1
    `).get(workDate, employeeId);

    if (actRow && actRow.timestamp) {
      const ms = parseEpochNormalized(actRow.timestamp);
      if (ms) {
        lastActivityMs = ms;
        lastActivityTimeStr = actRow.timestamp;
      }
    }
  } catch (_) {}

  // Fallback to daily_working_team last_activity_at
  if (!lastActivityMs && dwt && dwt.last_activity_at) {
    const ms = parseEpochNormalized(dwt.last_activity_at);
    if (ms) {
      lastActivityMs = ms;
      lastActivityTimeStr = dwt.last_activity_at;
    }
  }

  if (options.require_recent_activity !== false) {
    if (!lastActivityMs || (canonicalNowMs - lastActivityMs > maxStaleMs)) {
      exclusionReasons.push(ALLOCATION_ERROR_CODES.EMPLOYEE_ACTIVITY_TOO_OLD);
    }
  }

  // 5. Individual Capacity Hard Cap
  const capRow = db.prepare('SELECT max_orders FROM employee_capacities WHERE employee_id = ?').get(employeeId);
  const configuredMax = capRow ? capRow.max_orders : 40;
  const currentWorkload = options.currentWorkload !== undefined ? options.currentWorkload : getEmployeeCurrentWorkload(employeeId, workDate);
  const remainingCapacity = Math.max(0, configuredMax - currentWorkload);

  if (remainingCapacity <= 0) {
    exclusionReasons.push(ALLOCATION_ERROR_CODES.EMPLOYEE_CAPACITY_EXHAUSTED);
  }

  // 6. Daily Allocation State Machine
  const dailyState = getEmployeeDailyAllocationState(employeeId, workDate);

  // Derive next allocation event due
  let nextEventDue = 'PENDING';
  let waitingReason = null;

  if (dailyState.daily_mode === 'PENDING_RESCUE') {
    nextEventDue = 'PENDING'; // Normal NEW is forbidden for the rest of the workday
  } else {
    if (dailyState.pending_sequence < 3) {
      nextEventDue = 'PENDING'; // P1, P2, P3
    } else if (dailyState.pending_sequence >= 3 && !dailyState.new_event_consumed) {
      nextEventDue = 'NEW';     // NEW milestone
    } else {
      nextEventDue = 'PENDING'; // P4, P5, P6...
    }
  }

  return {
    is_eligible: exclusionReasons.length === 0,
    exclusion_reasons: exclusionReasons,
    employee: {
      id: emp.id,
      name: emp.name,
      department: emp.department,
      team_membership: emp.team_membership || 'Both',
      configured_max: configuredMax,
      current_workload: currentWorkload,
      remaining_capacity: remainingCapacity,
      last_activity_time: lastActivityTimeStr
    },
    daily_state: dailyState,
    next_event_due: nextEventDue,
    waiting_reason: waitingReason
  };
}

function getEmployeeCurrentWorkload(employeeId, workDate) {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM current_work_orders
    WHERE work_date = ? AND assigned_employee_id = ?
      AND (work_state IS NULL OR work_state NOT IN ('COMPLETED', 'CANCELLED'))
  `).get(workDate, employeeId);
  return row ? row.cnt : 0;
}

function getGlobalSettingInt(key, defaultVal) {
  try {
    const row = db.prepare('SELECT value FROM allocation_global_settings WHERE key = ?').get(key);
    if (row && !isNaN(parseInt(row.value, 10))) return parseInt(row.value, 10);
  } catch (_) {}
  return defaultVal;
}

function getGlobalSettingStr(key, defaultVal) {
  try {
    const row = db.prepare('SELECT value FROM allocation_global_settings WHERE key = ?').get(key);
    if (row && row.value) return row.value.trim();
  } catch (_) {}
  return defaultVal;
}

// ============================================================
// 4. RESCUE ENGINE & PRESSURE EVALUATION (Sections 51-61, 179, 180)
// ============================================================

/**
 * Evaluates concrete operational PENDING pressure units and rescue trigger
 * pending_pressure_units = max(0, eligible_unassigned_pending_orders - total_remaining_capacity_of_eligible_pending_participants)
 * rescue_triggered = pending_pressure_units >= configured_pending_rescue_threshold
 */
export function evaluatePendingRescueOperation(workDate, planningContext = null) {
  const threshold = getGlobalSettingInt('pending_rescue_threshold', 20);

  // 1. Fetch unassigned PENDING orders
  let unassignedPendingOrders = [];
  let unassignedNewOrders = [];

  if (planningContext && planningContext.orders) {
    unassignedPendingOrders = planningContext.orders.filter(o => 
      !o.assigned_employee_id && (String(o.status || '').toLowerCase().includes('pending') || o.source_type === 'PENDING')
    );
    unassignedNewOrders = planningContext.orders.filter(o => 
      !o.assigned_employee_id && !String(o.status || '').toLowerCase().includes('pending') && o.source_type !== 'PENDING'
    );
  } else {
    const rows = db.prepare(`
      SELECT order_code, account, status, source_type, tracking_id
      FROM current_work_orders
      WHERE work_date = ? AND (assigned_employee_id IS NULL OR work_state = 'UNASSIGNED')
    `).all(workDate);

    unassignedPendingOrders = rows.filter(o => (o.status || '').toLowerCase().includes('pending') || o.source_type === 'PENDING');
    unassignedNewOrders = rows.filter(o => !(o.status || '').toLowerCase().includes('pending') && o.source_type !== 'PENDING');
  }

  const currentTimeStr = planningContext?.currentTime || null;

  // Filter unassigned pending orders by Account PENDING time window
  const eligiblePendingOrders = unassignedPendingOrders.filter(o => {
    const status = evaluateAccountTimeStatus(o.account, 'PENDING', currentTimeStr);
    return status.is_open;
  });

  // Filter eligible NEW support orders by Account NEW time window (Rescue does NOT ignore Account NEW schedule!)
  const eligibleNewSupportOrders = unassignedNewOrders.filter(o => {
    const status = evaluateAccountTimeStatus(o.account, 'NEW', currentTimeStr);
    return status.is_open;
  });

  // 2. Fetch eligible PENDING participants and their remaining capacity
  const workingTeam = getWorkingTeam(workDate).filter(e => e.is_working && isCsEmployee(e));
  let totalPendingParticipantsCapacity = 0;
  const eligibleRescueParticipants = [];

  for (const emp of workingTeam) {
    // Check if employee is eligible for PENDING
    const membership = (emp.permanent_team_membership || emp.team_membership || 'Both').toLowerCase();
    if (membership !== 'pending' && membership !== 'both') continue;

    const elig = evaluateEmployeeAllocationEligibility(emp.employee_id, workDate);
    if (elig.is_eligible && elig.employee.remaining_capacity > 0) {
      eligibleRescueParticipants.push(elig.employee);
      totalPendingParticipantsCapacity += elig.employee.remaining_capacity;
    }
  }

  // 3. Calculate concrete operational pressure
  const pendingPressureUnits = Math.max(0, eligiblePendingOrders.length - totalPendingParticipantsCapacity);
  const rescueTriggered = pendingPressureUnits >= threshold && eligibleNewSupportOrders.length > 0;

  // Bounded support quantity: min(eligible_new_support_orders, pending_pressure_units)
  const boundedSupportQuantity = Math.min(eligibleNewSupportOrders.length, pendingPressureUnits);

  return {
    work_date: workDate,
    configured_threshold: threshold,
    unassigned_pending_orders_count: eligiblePendingOrders.length,
    eligible_pending_capacity: totalPendingParticipantsCapacity,
    pending_pressure_units: pendingPressureUnits,
    rescue_triggered: rescueTriggered,
    eligible_new_support_orders_count: eligibleNewSupportOrders.length,
    bounded_support_quantity: boundedSupportQuantity,
    eligible_rescue_participants: eligibleRescueParticipants,
    eligible_support_orders: eligibleNewSupportOrders.slice(0, boundedSupportQuantity),
    status: rescueTriggered ? 'TRIGGERED' : (pendingPressureUnits > 0 ? 'PRESSURE_DETECTED_BELOW_THRESHOLD' : 'NORMAL')
  };
}

// ============================================================
// 5. DISTRIBUTION FINGERPRINT & UNIQUENESS (Sections 66-76, 182)
// ============================================================

/**
 * Computes canonical two-level distribution fingerprint (Batch Uniqueness + Mapping Uniqueness)
 */
export function computeDistributionFingerprint(assignments, workDate, allocationType = 'ENTERPRISE_BATCH') {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    return 'EMPTY_DISTRIBUTION';
  }

  // A. Sorted normalized order codes (Batch uniqueness)
  const sortedOrders = assignments.map(a => String(a.order_code).trim()).sort();

  // B. Sorted normalized recipient mapping (Mapping uniqueness)
  const sortedMappings = assignments.map(a => `${String(a.order_code).trim()}->${a.employee_id || 'UNASSIGNED'}`).sort();

  const payload = JSON.stringify({
    work_date: workDate,
    allocation_type: allocationType,
    orders: sortedOrders,
    mappings: sortedMappings
  });

  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Verifies if fingerprint has been committed previously for this work date
 */
export function checkDistributionUniqueness(fingerprint, workDate) {
  if (!fingerprint || fingerprint === 'EMPTY_DISTRIBUTION') {
    return { is_unique: true, existing_run_id: null };
  }

  const existing = db.prepare('SELECT run_id, work_date, created_at FROM distribution_fingerprints WHERE fingerprint = ?').get(fingerprint);
  if (existing) {
    return {
      is_unique: false,
      existing_run_id: existing.run_id,
      fingerprint
    };
  }

  return {
    is_unique: true,
    existing_run_id: null,
    fingerprint
  };
}

// ============================================================
// 6. THE UNIFIED ENTERPRISE ALLOCATION PLANNER
// ============================================================

/**
 * Canonical Enterprise Allocation Planner
 * Shared across PREVIEW, SHADOW, and ACTIVE execution modes (Section 100, 194)
 */
export function planEnterpriseAllocation(workDate, mode = 'ACTIVE', options = {}) {
  const canonicalNowStr = options.currentTime || getCairoNow();
  const currentTimeHHMM = extractTimeHHMM(canonicalNowStr);
  const runId = options.runId || `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const globalMode = getGlobalSettingStr('allocation_mode', 'ACTIVE');
  const effectiveMode = options.forceMode || (globalMode === 'OFF' ? 'OFF' : mode);

  // 1. Fetch current active configuration version
  const config = getEnterpriseAllocationConfig();
  const configVersion = config.version;

  // 2. Fetch inventory of orders for work date
  let orders = db.prepare(`
    SELECT id, order_code, account, status, source_type, tracking_id, work_state, priority, assigned_employee_id
    FROM current_work_orders
    WHERE work_date = ?
    ORDER BY account ASC, order_code ASC
  `).all(workDate);

  if (orders.length === 0) {
    // If empty in current_work_orders, check if vendoor_orders can be ingested
    const vOrders = db.prepare(`
      SELECT order_code, account, status, source_date as order_date
      FROM vendoor_orders
      WHERE (business_date = ? OR is_active = 1 OR source_date = ?)
        AND (status IS NULL OR LOWER(status) NOT IN ('cancelled', 'canceled', 'delivered', 'shipped', 'completed', 'processing'))
      ORDER BY account ASC, order_code ASC
    `).all(workDate, workDate);

    if (vOrders.length > 0) {
      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO current_work_orders (work_date, order_code, account, status, order_date, source_file_slot, source_type, tracking_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      db.transaction(() => {
        for (let i = 0; i < vOrders.length; i++) {
          const vo = vOrders[i];
          const isPending = (vo.status || '').toLowerCase().includes('pending');
          const slot = isPending ? 2 : 1;
          const srcType = isPending ? 'PENDING' : 'NEW';
          const trkId = generateTrackingId(vo.order_code, workDate, i + 1);
          insertStmt.run(workDate, vo.order_code, vo.account || 'Unassigned', vo.status || 'New', vo.order_date || workDate, slot, srcType, trkId);
        }
      })();

      orders = db.prepare(`
        SELECT id, order_code, account, status, source_type, tracking_id, work_state, priority, assigned_employee_id
        FROM current_work_orders
        WHERE work_date = ?
        ORDER BY account ASC, order_code ASC
      `).all(workDate);
    }
  }

  // System Safety Check: Duplicate order codes detection (Section 163, 165)
  const seenOrderCodes = new Set();
  const duplicateCodes = [];
  for (const o of orders) {
    if (seenOrderCodes.has(o.order_code)) {
      duplicateCodes.push(o.order_code);
    }
    seenOrderCodes.add(o.order_code);
  }
  if (duplicateCodes.length > 0) {
    return {
      run_id: runId,
      work_date: workDate,
      mode: effectiveMode,
      status: 'BLOCKED',
      block_type: 'SYSTEM_SAFETY',
      block_reason: `DATA_INTEGRITY_FAILURE: Duplicate order codes detected in opening inventory: ${duplicateCodes.slice(0, 5).join(', ')}`,
      assignments: [],
      candidate_decisions: [],
      audit_records: []
    };
  }

  // 3. Separate Preserved Orders (ASSIGNED, CLAIMED, IN_PROGRESS, COMPLETED)
  const PRESERVED_STATES = new Set(['ASSIGNED', 'CLAIMED', 'IN_PROGRESS', 'COMPLETED']);
  const preservedOrders = [];
  const unassignedOrders = [];

  for (const ord of orders) {
    const st = String(ord.work_state || 'UNASSIGNED').toUpperCase();
    if (PRESERVED_STATES.has(st) && ord.assigned_employee_id) {
      preservedOrders.push(ord);
    } else {
      unassignedOrders.push(ord);
    }
  }

  // 4. Fetch Active CS Working Team & Setup Planning Candidates
  const workingTeam = getWorkingTeam(workDate).filter(e => e.is_working && isCsEmployee(e));
  if (workingTeam.length === 0) {
    return {
      run_id: runId,
      work_date: workDate,
      mode: effectiveMode,
      status: 'BLOCKED',
      block_type: 'BUSINESS_RULE',
      block_reason: 'No eligible CS employees found in Today\'s Working Team for date: ' + workDate,
      assignments: [],
      candidate_decisions: [],
      audit_records: []
    };
  }

  // Compute workload and eligibility per employee
  const candidateDecisions = [];
  const eligibleCandidates = [];
  const excludedCandidates = [];

  const workloads = getEmployeesWorkloadMap(workDate);

  for (const emp of workingTeam) {
    const elig = evaluateEmployeeAllocationEligibility(emp.employee_id, workDate, {
      currentTime: canonicalNowStr,
      currentWorkload: workloads.get(emp.employee_id) || 0
    });

    candidateDecisions.push({
      employee_id: emp.employee_id,
      employee_name: emp.name,
      is_eligible: elig.is_eligible,
      exclusion_reasons: elig.exclusion_reasons,
      configured_max: elig.employee.configured_max,
      current_workload: elig.employee.current_workload,
      remaining_capacity: elig.employee.remaining_capacity,
      daily_state: elig.daily_state,
      next_event_due: elig.next_event_due
    });

    if (elig.is_eligible) {
      eligibleCandidates.push({
        ...elig.employee,
        daily_state: elig.daily_state,
        next_event_due: elig.next_event_due,
        assigned_in_this_run: 0
      });
    } else {
      excludedCandidates.push({
        employee_id: emp.employee_id,
        employee_name: emp.name,
        reasons: elig.exclusion_reasons
      });
    }
  }

  if (eligibleCandidates.length === 0) {
    return {
      run_id: runId,
      work_date: workDate,
      mode: effectiveMode,
      status: 'BLOCKED',
      block_type: 'BUSINESS_RULE',
      block_reason: 'All working CS employees are currently excluded (e.g. stale activity or capacity exhausted)',
      assignments: [],
      candidate_decisions: candidateDecisions,
      audit_records: []
    };
  }

  // 5. Evaluate Rescue Condition (Section 51-54)
  const rescueEval = evaluatePendingRescueOperation(workDate, { orders });
  const isRescueActive = rescueEval.rescue_triggered;

  // 6. Sticky Ownership & Account Schedule Pre-Check
  const stickyOwners = db.prepare(`
    SELECT account, owner_employee_id as employee_id, owner_employee_name as employee_name, is_override
    FROM account_owners
    WHERE work_date = ? AND owner_employee_id IS NOT NULL
  `).all(workDate);
  const stickyOwnerMap = new Map(stickyOwners.map(o => [o.account.toLowerCase(), o]));

  // 7. Group unassigned orders by Account + Work Type
  // Separate into NEW and PENDING queues
  const scheduledAccountsMap = new Map();
  const auditRecords = [];
  const proposedAssignments = [];

  // Sort orders deterministically (Account, priority, then code)
  unassignedOrders.sort((a, b) => {
    if (a.priority === 'FAST_TRACK' && b.priority !== 'FAST_TRACK') return -1;
    if (b.priority === 'FAST_TRACK' && a.priority !== 'FAST_TRACK') return 1;
    if (a.account !== b.account) return a.account.localeCompare(b.account);
    return a.order_code.localeCompare(b.order_code);
  });

  // Evaluate Account Schedule for each order
  const eligibleOrdersForPlanning = [];
  for (const ord of unassignedOrders) {
    const isPend = (ord.status || '').toLowerCase().includes('pending') || ord.source_type === 'PENDING';
    const workType = isPend ? 'PENDING' : 'NEW';
    const schedKey = `${ord.account}|${workType}`;
    let schedStatus = scheduledAccountsMap.get(schedKey);

    if (!schedStatus) {
      schedStatus = evaluateAccountTimeStatus(ord.account, workType, canonicalNowStr);
      scheduledAccountsMap.set(schedKey, schedStatus);
    }

    if (!schedStatus.is_open) {
      auditRecords.push({
        entity_type: 'ORDER',
        entity_id: ord.order_code,
        decision: 'EXCLUDED',
        reason_code: schedStatus.reason_code || ALLOCATION_ERROR_CODES.ACCOUNT_STATUS_OUTSIDE_TIME_WINDOW,
        reason_details: `Account ${ord.account} for ${workType} is ${schedStatus.status} (${schedStatus.start_time || 'N/A'} - ${schedStatus.end_time || 'N/A'}, current: ${schedStatus.current_time})`
      });
      continue;
    }

    eligibleOrdersForPlanning.push({
      ...ord,
      work_type: workType,
      time_priority_rank: schedStatus.time_priority_rank
    });
  }

  // Sort eligible orders by:
  // 1. Time priority rank (scheduled accounts)
  // 2. Account name (group all orders of each account together to prevent fragmentation)
  // 3. Fast Track orders before Regular
  // 4. Order code
  eligibleOrdersForPlanning.sort((a, b) => {
    if (a.time_priority_rank !== b.time_priority_rank) {
      return a.time_priority_rank - b.time_priority_rank;
    }
    const accComp = (a.account || '').localeCompare(b.account || '');
    if (accComp !== 0) return accComp;
    const prioA = (a.priority === 'FAST_TRACK') ? 0 : 1;
    const prioB = (b.priority === 'FAST_TRACK') ? 0 : 1;
    if (prioA !== prioB) return prioA - prioB;
    return (a.order_code || '').localeCompare(b.order_code || '');
  });

  // 8. Allocation Assignment Loop
  // Match candidate requirements with work types
  // Enforces Account Unification (minimum employees per account: 1 or max 2 agents per account)
  // Allocates both NEW and PENDING orders together
  let rescueSupportOrdersAssigned = 0;
  const accountAssigneesMap = new Map(); // accLower -> Array of employee IDs assigned to this account

  for (const ord of eligibleOrdersForPlanning) {
    const isPendingOrder = ord.work_type === 'PENDING';
    const accLower = (ord.account || '').toLowerCase();
    const stickyOwner = stickyOwnerMap.get(accLower);
    const assignedAgents = accountAssigneesMap.get(accLower) || [];

    let candidate = null;

    // 1. Check if this account already has an active agent assigned in this run with capacity
    // Rule: ONE ACCOUNT = ONE EMPLOYEE (Minimise employees per account to 1 or max 2)
    for (const agentId of assignedAgents) {
      const match = eligibleCandidates.find(c => c.id === agentId);
      if (match && (match.remaining_capacity - match.assigned_in_this_run > 0)) {
        const mem = (match.team_membership || 'Both').toLowerCase();
        if (isPendingOrder && (mem === 'pending' || mem === 'both')) {
          candidate = match;
          break;
        } else if (!isPendingOrder && (mem === 'new' || mem === 'both')) {
          candidate = match;
          break;
        }
      }
    }

    // 2. If no agent assigned yet for this account in this run, check sticky owner from history
    if (!candidate && assignedAgents.length === 0 && stickyOwner && stickyOwner.employee_id) {
      const match = eligibleCandidates.find(c => c.id === stickyOwner.employee_id);
      if (match && (match.remaining_capacity - match.assigned_in_this_run > 0)) {
        const mem = (match.team_membership || 'Both').toLowerCase();
        if (isPendingOrder && (mem === 'pending' || mem === 'both')) {
          candidate = match;
        } else if (!isPendingOrder && (mem === 'new' || mem === 'both')) {
          candidate = match;
        }
      }
    }

    // 3. If primary agent reached capacity, allow at most a 2nd agent for account overflow (Max 2 agents per account)
    // Or if account has no agent yet, pick a new candidate with lowest assigned load
    if (!candidate && assignedAgents.length < 2) {
      // Find candidate with lowest assigned load so far (fair balance preference)
      const matchingCandidates = eligibleCandidates.filter(c => {
        const remaining = c.remaining_capacity - c.assigned_in_this_run;
        if (remaining <= 0) return false;

        const membership = (c.team_membership || 'Both').toLowerCase();

        if (isPendingOrder) {
          if (membership !== 'pending' && membership !== 'both') return false;
          return c.next_event_due === 'PENDING' || c.daily_state.daily_mode === 'PENDING_RESCUE';
        } else {
          // Order is NEW
          // Path 1: Normal or available NEW distribution
          if (c.daily_state.daily_mode !== 'PENDING_RESCUE') {
            if (membership === 'new') return true;
            if (c.next_event_due === 'NEW' && membership === 'both') return true;
            // Also allow 'both' candidates if no 'new' milestone candidate exists
            return membership === 'both';
          }
          // Path 2: PENDING Rescue Support (NEW order helping PENDING team)
          if (isRescueActive && rescueSupportOrdersAssigned < rescueEval.bounded_support_quantity) {
            return membership === 'pending' || membership === 'both';
          }
          return false;
        }
      });

      if (matchingCandidates.length > 0) {
        // Prioritize:
        // For NEW orders: prefer candidates whose next_event_due === 'NEW' first
        // Then sort by fewest assigned in this run, then lowest overall current workload, then stable ID
        matchingCandidates.sort((a, b) => {
          if (!isPendingOrder) {
            const aDue = a.next_event_due === 'NEW' ? 0 : 1;
            const bDue = b.next_event_due === 'NEW' ? 0 : 1;
            if (aDue !== bDue) return aDue - bDue;
          }
          if (a.assigned_in_this_run !== b.assigned_in_this_run) {
            return a.assigned_in_this_run - b.assigned_in_this_run;
          }
          if (a.current_workload !== b.current_workload) {
            return a.current_workload - b.current_workload;
          }
          return a.id - b.id;
        });
        candidate = matchingCandidates[0];
      }
    }

    // 4. Fallback if account has 2 agents already but both full: allow overflow to candidate with capacity
    if (!candidate) {
      const fallbackCandidates = eligibleCandidates.filter(c => {
        const remaining = c.remaining_capacity - c.assigned_in_this_run;
        if (remaining <= 0) return false;
        const membership = (c.team_membership || 'Both').toLowerCase();
        if (isPendingOrder) return membership === 'pending' || membership === 'both';
        return membership === 'new' || membership === 'both';
      });
      if (fallbackCandidates.length > 0) {
        fallbackCandidates.sort((a, b) => a.assigned_in_this_run - b.assigned_in_this_run || a.id - b.id);
        candidate = fallbackCandidates[0];
      }
    }

    if (candidate) {
      if (!assignedAgents.includes(candidate.id)) {
        assignedAgents.push(candidate.id);
        accountAssigneesMap.set(accLower, assignedAgents);
      }
      candidate.assigned_in_this_run++;
      const isRescueSupportAssignment = !isPendingOrder && (candidate.next_event_due === 'PENDING' || candidate.daily_state.daily_mode === 'PENDING_RESCUE');

      if (isRescueSupportAssignment) {
        rescueSupportOrdersAssigned++;
      }

      proposedAssignments.push({
        order_code: ord.order_code,
        account: ord.account,
        status: ord.status,
        tracking_id: ord.tracking_id,
        work_type: ord.work_type,
        employee_id: candidate.id,
        employee_name: candidate.name,
        allocation_mode: isRescueSupportAssignment ? 'PENDING_RESCUE_SUPPORT' : (ord.work_type === 'NEW' ? 'NEW_DISTRIBUTION' : 'PENDING_DISTRIBUTION'),
        is_rescue_support: isRescueSupportAssignment
      });

      auditRecords.push({
        entity_type: 'ORDER',
        entity_id: ord.order_code,
        decision: 'ASSIGNED',
        reason_code: isRescueSupportAssignment ? 'ASSIGNED_RESCUE_SUPPORT' : 'ASSIGNED_NORMAL',
        reason_details: `Assigned to ${candidate.name} (Cap remaining: ${candidate.remaining_capacity - candidate.assigned_in_this_run}, Event: ${candidate.next_event_due})`
      });
    } else {
      auditRecords.push({
        entity_type: 'ORDER',
        entity_id: ord.order_code,
        decision: 'BLOCKED',
        reason_code: isPendingOrder ? 'NO_ELIGIBLE_PENDING_CANDIDATE' : 'NO_ELIGIBLE_NEW_CANDIDATE',
        reason_details: `No eligible candidate with capacity for ${ord.work_type} order on account ${ord.account}`
      });
    }
  }

  // 9. Compute Fingerprint & Uniqueness Validation
  const fingerprint = computeDistributionFingerprint(proposedAssignments, workDate);
  const uniquenessCheck = checkDistributionUniqueness(fingerprint, workDate);

  if (!uniquenessCheck.is_unique) {
    // Exact repeat proposal: attempt deterministic regeneration without randomness (Section 75)
    // Shift candidates by reversing stable tie-breaker
    const regenerated = regenerateDistributionPlan(eligibleOrdersForPlanning, eligibleCandidates, isRescueActive, rescueEval, workDate);
    if (!regenerated.is_unique) {
      return {
        run_id: runId,
        work_date: workDate,
        mode: effectiveMode,
        status: 'BLOCKED',
        block_type: 'BUSINESS_RULE',
        block_reason: 'NO_UNIQUE_VALID_DISTRIBUTION: Generated proposal matches prior historical distribution for date ' + workDate,
        assignments: [],
        candidate_decisions: candidateDecisions,
        audit_records: auditRecords
      };
    } else {
      proposedAssignments.length = 0;
      proposedAssignments.push(...regenerated.assignments);
    }
  }

  // 10. Generate Context Hash
  const contextData = {
    work_date: workDate,
    config_version: configVersion,
    eligible_count: eligibleCandidates.length,
    orders_count: orders.length,
    canonical_time: currentTimeHHMM,
    is_rescue: isRescueActive
  };
  const contextHash = crypto.createHash('sha256').update(JSON.stringify(contextData)).digest('hex');

  // Pre-allocation Snapshot structure
  const snapshotData = {
    work_date: workDate,
    operational_time: canonicalNowStr,
    configuration_version: configVersion,
    context_hash: contextHash,
    new_orders_count: orders.filter(o => !(o.status || '').toLowerCase().includes('pending') && o.source_type !== 'PENDING').length,
    pending_orders_count: orders.filter(o => (o.status || '').toLowerCase().includes('pending') || o.source_type === 'PENDING').length,
    scheduled_accounts: Array.from(scheduledAccountsMap.values()),
    candidate_states: candidateDecisions,
    rescue_state: isRescueActive ? 'ACTIVE' : 'NONE'
  };

  return {
    plan_id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    run_id: runId,
    work_date: workDate,
    mode: effectiveMode,
    status: 'VALID',
    configuration_version: configVersion,
    context_hash: contextHash,
    fingerprint,
    is_rescue_active: isRescueActive,
    rescue_evaluation: rescueEval,
    total_orders_input: orders.length,
    assigned_count: proposedAssignments.length,
    unassigned_count: orders.length - proposedAssignments.length - preservedOrders.length,
    preserved_count: preservedOrders.length,
    assignments: proposedAssignments,
    candidate_decisions: candidateDecisions,
    audit_records: auditRecords,
    snapshot_data: snapshotData
  };
}

/**
 * Deterministically regenerates an alternative distribution when duplicate fingerprint is hit
 */
function regenerateDistributionPlan(orders, eligibleCandidates, isRescueActive, rescueEval, workDate) {
  // Rotate candidate tie-breaker deterministically
  const reversedCandidates = [...eligibleCandidates].reverse();
  for (const c of reversedCandidates) c.assigned_in_this_run = 0;

  const regeneratedAssignments = [];
  let rescueSupportCount = 0;

  for (const ord of orders) {
    const isPendingOrder = ord.work_type === 'PENDING';
    const match = reversedCandidates.find(c => {
      const remaining = c.remaining_capacity - c.assigned_in_this_run;
      if (remaining <= 0) return false;
      const mem = (c.team_membership || 'Both').toLowerCase();
      if (isPendingOrder) {
        if (mem !== 'pending' && mem !== 'both') return false;
        return c.next_event_due === 'PENDING' || c.daily_state.daily_mode === 'PENDING_RESCUE';
      } else {
        if (c.daily_state.daily_mode !== 'PENDING_RESCUE' && c.next_event_due === 'NEW') {
          return mem === 'new' || mem === 'both';
        }
        if (isRescueActive && rescueSupportCount < rescueEval.bounded_support_quantity) {
          return mem === 'pending' || mem === 'both';
        }
        return false;
      }
    });

    if (match) {
      match.assigned_in_this_run++;
      const isRescueSupport = !isPendingOrder && (match.next_event_due === 'PENDING' || match.daily_state.daily_mode === 'PENDING_RESCUE');
      if (isRescueSupport) rescueSupportCount++;
      regeneratedAssignments.push({
        order_code: ord.order_code,
        account: ord.account,
        status: ord.status,
        tracking_id: ord.tracking_id,
        work_type: ord.work_type,
        employee_id: match.id,
        employee_name: match.name,
        allocation_mode: isRescueSupport ? 'PENDING_RESCUE_SUPPORT' : (ord.work_type === 'NEW' ? 'NEW_DISTRIBUTION' : 'PENDING_DISTRIBUTION'),
        is_rescue_support: isRescueSupport
      });
    }
  }

  const newFingerprint = computeDistributionFingerprint(regeneratedAssignments, workDate);
  const check = checkDistributionUniqueness(newFingerprint, workDate);

  return {
    is_unique: check.is_unique,
    assignments: regeneratedAssignments,
    fingerprint: newFingerprint
  };
}

// ============================================================
// 7. TRANSACTIONAL EXECUTION & COMMIT (Sections 101-104, 184, 185)
// ============================================================

/**
 * Authoritative Atomic Execution Engine
 * Enforces all-or-nothing transactional guarantee (Section 101)
 * Advances PENDING sequence and marks NEW consumed ONLY after successful commit (Section 102)
 */
export function executeEnterpriseAllocation(planOrContext, options = {}) {
  let plan = planOrContext;

  // If workDate string passed, plan allocation first
  if (typeof planOrContext === 'string') {
    plan = planEnterpriseAllocation(planOrContext, options.mode || 'ACTIVE', options);
  }

  if (plan.status === 'BLOCKED') {
    // Record blocked run in audit history
    try {
      db.prepare(`
        INSERT INTO enterprise_allocation_runs (
          run_id, work_date, trigger, mode, allocation_type, status, block_type, block_reason,
          context_hash, started_at, completed_at
        ) VALUES (?, ?, ?, ?, 'BLOCKED_RUN', 'BLOCKED', ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        plan.run_id,
        plan.work_date,
        options.trigger || 'MANUAL',
        plan.mode || 'ACTIVE',
        plan.block_type,
        plan.block_reason,
        plan.context_hash || 'none'
      );
    } catch (_) {}

    return {
      success: false,
      status: 'BLOCKED',
      block_type: plan.block_type,
      block_reason: plan.block_reason,
      run_id: plan.run_id,
      assigned_orders: 0,
      assigned_count: 0,
      unassigned_orders: plan.total_orders_input || 0,
      unassigned_count: plan.total_orders_input || 0,
      total_orders: plan.total_orders_input || 0,
      raw_allocations: [],
      allocations: [],
      orderLevelAllocations: [],
      by_employee: [],
      account_owners: [],
      unassigned_orders_list: []
    };
  }

  const executionMode = options.mode || plan.mode || 'ACTIVE';

  // Check Mode
  if (executionMode === 'OFF') {
    return {
      success: false,
      mode: 'OFF',
      status: 'OFF',
      message: 'Enterprise Allocation Engine is configured as OFF. No production changes were committed.',
      run_id: plan.run_id,
      assigned_orders: 0,
      assigned_count: 0,
      total_orders: 0,
      unassigned_orders: 0,
      unassigned_count: 0,
      raw_allocations: [],
      allocations: [],
      orderLevelAllocations: [],
      by_employee: [],
      account_owners: [],
      unassigned_orders_list: []
    };
  }

  if (executionMode === 'PREVIEW') {
    // Preview MUST NOT mutate production state! (Section 98, 100)
    return {
      success: true,
      mode: 'PREVIEW',
      status: 'PREVIEW_GENERATED',
      plan_id: plan.plan_id,
      run_id: plan.run_id,
      work_date: plan.work_date,
      configuration_version: plan.configuration_version,
      context_hash: plan.context_hash,
      fingerprint: plan.fingerprint,
      is_rescue_active: plan.is_rescue_active,
      assigned_count: plan.assignments.length,
      assigned_orders: plan.assignments.length,
      unassigned_count: plan.unassigned_count,
      unassigned_orders: plan.unassigned_count,
      total_orders: plan.total_orders_input,
      assignments: plan.assignments,
      raw_allocations: plan.assignments,
      allocations: plan.assignments,
      orderLevelAllocations: plan.assignments,
      candidate_decisions: plan.candidate_decisions
    };
  }

  if (executionMode === 'SHADOW') {
    // Shadow mode: record diagnostic proposal without mutating production state! (Section 4, 156, 157)
    try {
      db.prepare(`
        INSERT INTO enterprise_allocation_runs (
          run_id, work_date, trigger, mode, allocation_type, status, configuration_version,
          context_hash, fingerprint, total_orders_input, assigned_count, unassigned_count,
          proposal_json, started_at, completed_at
        ) VALUES (?, ?, ?, 'SHADOW', 'SHADOW_EVALUATION', 'SHADOW_RECORDED', ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        plan.run_id,
        plan.work_date,
        options.trigger || 'SHADOW',
        plan.configuration_version,
        plan.context_hash,
        plan.fingerprint,
        plan.total_orders_input,
        plan.assigned_count,
        plan.unassigned_count,
        JSON.stringify(plan.assignments)
      );
    } catch (_) {}

    return {
      success: true,
      mode: 'SHADOW',
      status: 'SHADOW_RECORDED',
      run_id: plan.run_id,
      assignments_count: plan.assignments.length
    };
  }

  // Mode is ACTIVE: execute atomic production mutation
  // Check Staleness if plan was generated from prior preview (Section 99, 133A.44)
  if (options.previewPlanId) {
    const currentCfg = getEnterpriseAllocationConfig();
    if (currentCfg.version !== plan.configuration_version) {
      const err = new Error('PREVIEW_STALE: Configuration version has changed since preview was generated. Re-generate preview.');
      err.code = ALLOCATION_ERROR_CODES.PREVIEW_STALE;
      throw err;
    }
  }

  // ATOMIC TRANSACTION: ALL-OR-NOTHING COMMIT
  const workDate = plan.work_date;
  const assignments = plan.assignments;

  // Determine target allocation version
  const lastVerRow = db.prepare('SELECT MAX(version_number) as max_v FROM allocation_versions WHERE allocation_date = ?').get(workDate);
  const nextVer = (lastVerRow?.max_v || 0) + 1;

  const tx = db.transaction(() => {
    // 1. Record Run in enterprise_allocation_runs
    db.prepare(`
      INSERT INTO enterprise_allocation_runs (
        run_id, work_date, trigger, mode, allocation_type, status, rescue_state,
        configuration_version, context_hash, fingerprint, total_orders_input,
        assigned_count, unassigned_count, eligible_candidates_json, excluded_candidates_json,
        proposal_json, started_at, completed_at
      ) VALUES (?, ?, ?, 'ACTIVE', ?, 'COMMITTED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      plan.run_id,
      workDate,
      options.trigger || 'MANUAL',
      plan.is_rescue_active ? 'PENDING_RESCUE_SUPPORT' : 'ENTERPRISE_BATCH',
      plan.is_rescue_active ? 'ACTIVE' : 'NONE',
      plan.configuration_version,
      plan.context_hash,
      plan.fingerprint,
      plan.total_orders_input,
      assignments.length,
      plan.unassigned_count,
      JSON.stringify(plan.candidate_decisions.filter(c => c.is_eligible)),
      JSON.stringify(plan.candidate_decisions.filter(c => !c.is_eligible)),
      JSON.stringify(assignments)
    );

    // 2. Persist Distribution Fingerprint for uniqueness memory (Section 67, 135)
    db.prepare(`
      INSERT OR IGNORE INTO distribution_fingerprints (
        fingerprint, work_date, run_id, allocation_type, distribution_metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(
      plan.fingerprint,
      workDate,
      plan.run_id,
      plan.is_rescue_active ? 'RESCUE_SUPPORT' : 'ENTERPRISE_BATCH',
      JSON.stringify({ order_count: assignments.length })
    );

    // 3. Persist Pre-allocation Snapshot (Section 96)
    db.prepare(`
      INSERT INTO allocation_snapshots (
        run_id, work_date, configuration_version, context_hash, snapshot_data_json, captured_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(
      plan.run_id,
      workDate,
      plan.configuration_version,
      plan.context_hash,
      JSON.stringify(plan.snapshot_data)
    );

    // 4. Persist Decision Audits (Section 110, 111)
    const insertAudit = db.prepare(`
      INSERT INTO allocation_decision_audits (
        run_id, work_date, configuration_version, entity_type, entity_id, decision, reason_code, reason_details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const aud of plan.audit_records) {
      insertAudit.run(
        plan.run_id,
        workDate,
        plan.configuration_version,
        aud.entity_type,
        aud.entity_id,
        aud.decision,
        aud.reason_code,
        aud.reason_details
      );
    }

    // 5. Update current_work_orders and order_level_allocations
    const updateOrderStmt = db.prepare(`
      UPDATE current_work_orders
      SET assigned_employee_id = ?,
          assigned_employee_name = ?,
          work_state = 'ASSIGNED',
          round_number = COALESCE(round_number, 1),
          updated_at = datetime('now')
      WHERE work_date = ? AND order_code = ?
    `);

    const insertOrderAllocStmt = db.prepare(`
      INSERT INTO order_level_allocations (
        allocation_date, allocation_version, order_code, account, status,
        employee_id, employee_name, tracking_id, work_state, method, rule_note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ASSIGNED', 'Enterprise Engine', ?, datetime('now'))
    `);

    // Track which employees received work in this event
    const recipientEventsMap = new Map(); // empId -> { hasNew: boolean, hasPending: boolean, isRescueSupport: boolean, count: number }

    for (const a of assignments) {
      updateOrderStmt.run(a.employee_id, a.employee_name, workDate, a.order_code);
      insertOrderAllocStmt.run(
        workDate,
        nextVer,
        a.order_code,
        a.account,
        a.status,
        a.employee_id,
        a.employee_name,
        a.tracking_id || a.order_code,
        a.is_rescue_support ? 'Pending Rescue Support' : `${a.work_type} Allocation Event`
      );

      // Record Order Lifecycle Event (Section 12, 13)
      recordOrderLifecycleEvent({
        tracking_id: a.tracking_id || a.order_code,
        order_code: a.order_code,
        work_date: workDate,
        stage: a.status,
        work_state: 'ASSIGNED',
        employee_id: a.employee_id,
        employee_name: a.employee_name,
        action: a.is_rescue_support ? 'RESCUE_SUPPORT_ASSIGNED' : 'ASSIGNED',
        reason: a.is_rescue_support ? 'Assigned as PENDING rescue support' : `Assigned under Enterprise Engine run ${plan.run_id}`
      });

      // Recipient event tracking
      if (!recipientEventsMap.has(a.employee_id)) {
        recipientEventsMap.set(a.employee_id, {
          employee_id: a.employee_id,
          employee_name: a.employee_name,
          hasNew: false,
          hasPending: false,
          isRescueSupport: false,
          count: 0
        });
      }
      const rec = recipientEventsMap.get(a.employee_id);
      rec.count++;
      if (a.is_rescue_support) rec.isRescueSupport = true;
      else if (a.work_type === 'NEW') rec.hasNew = true;
      else rec.hasPending = true;
    }

    // 6. Update Employee Daily State Machine (Sections 16-24, 102)
    // CRITICAL: Advances sequence ONLY upon committed allocation!
    const updateDailyState = db.prepare(`
      INSERT INTO employee_daily_allocation_states (
        work_date, employee_id, pending_sequence, new_event_consumed, daily_mode, rescue_state,
        last_allocation_run_id, last_allocation_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(work_date, employee_id) DO UPDATE SET
        pending_sequence = excluded.pending_sequence,
        new_event_consumed = excluded.new_event_consumed,
        daily_mode = excluded.daily_mode,
        rescue_state = excluded.rescue_state,
        last_allocation_run_id = excluded.last_allocation_run_id,
        last_allocation_at = datetime('now'),
        updated_at = datetime('now')
    `);

    for (const rec of recipientEventsMap.values()) {
      const currentState = getEmployeeDailyAllocationState(rec.employee_id, workDate);
      let newSeq = currentState.pending_sequence;
      let newConsumed = currentState.new_event_consumed;
      let newMode = currentState.daily_mode;
      let newRescue = currentState.rescue_state;

      if (rec.isRescueSupport) {
        // Daily PENDING rescue is a special branch (Section 23, 24)
        // Does NOT consume normal NEW milestone!
        // Does NOT advance PENDING sequence!
        newMode = 'PENDING_RESCUE';
        newRescue = 'ACTIVE';
      } else if (rec.hasNew) {
        // Normal NEW milestone consumed (Section 19, 20)
        // One-time milestone for the employee lifecycle
        newConsumed = 1;
        // NEW does NOT reset PENDING! PENDING remains intact.
      } else if (rec.hasPending) {
        // Normal PENDING allocation event (Section 17)
        // Increments PENDING sequence by 1 for the committed batch (P1 -> P2 -> P3 -> P4...)
        newSeq += 1;
      }

      updateDailyState.run(
        workDate,
        rec.employee_id,
        newSeq,
        newConsumed,
        newMode,
        newRescue,
        plan.run_id
      );

      // Log employee activity with operational timestamp
      const opTime = plan.snapshot_data?.operational_time || new Date().toISOString();
      logEmployeeActivity({
        work_date: workDate,
        employee_id: rec.employee_id,
        employee_name: rec.employee_name,
        action: 'ASSIGNED',
        details: `Enterprise Engine: ${rec.count} orders committed (P-Seq: ${newSeq}, NEW-Consumed: ${newConsumed}, Mode: ${newMode})`,
        timestamp: opTime
      });

      // Update daily_working_team activity timestamp
      db.prepare(`
        UPDATE daily_working_team
        SET last_activity_at = ?, updated_at = datetime('now')
        WHERE work_date = ? AND employee_id = ?
      `).run(opTime, workDate, rec.employee_id);
    }

    // 7. Update allocation_versions for backward compatibility with reports and UI
    db.prepare(`
      INSERT INTO allocation_versions (
        allocation_date, version_number, generated_at, generated_by, method, rule_summary,
        total_orders, assigned_orders, unassigned_orders, is_final
      ) VALUES (?, ?, datetime('now'), 'Enterprise Engine', 'Enterprise Engine', ?, ?, ?, ?, 1)
    `).run(
      workDate,
      nextVer,
      `Enterprise Engine ${plan.run_id}`,
      plan.total_orders_input,
      assignments.length,
      plan.unassigned_count
    );

    // 8. Update Sticky Account Owners (ONE ACCOUNT = ONE EMPLOYEE)
    const upsertOwner = db.prepare(`
      INSERT INTO account_owners (
        work_date, account, owner_employee_id, owner_employee_name,
        allocation_version, allocation_method, is_override, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'Enterprise Engine', 0, datetime('now'))
      ON CONFLICT(work_date, account) DO UPDATE SET
        owner_employee_id = excluded.owner_employee_id,
        owner_employee_name = excluded.owner_employee_name,
        allocation_version = excluded.allocation_version,
        updated_at = datetime('now')
    `);

    const accOwnerMap = new Map();
    for (const a of assignments) {
      if (!accOwnerMap.has(a.account.toLowerCase())) {
        accOwnerMap.set(a.account.toLowerCase(), {
          account: a.account,
          employee_id: a.employee_id,
          employee_name: a.employee_name
        });
      }
    }
    for (const own of accOwnerMap.values()) {
      upsertOwner.run(workDate, own.account, own.employee_id, own.employee_name, nextVer);
    }
  });

  tx();

  // Build canonical raw allocations list
  const rawAllocations = [];
  for (const a of assignments) {
    rawAllocations.push({
      order_code: a.order_code,
      account: a.account,
      status: a.status,
      employee_id: a.employee_id,
      employee_name: a.employee_name,
      tracking_id: a.tracking_id || a.order_code,
      work_state: 'ASSIGNED',
      work_type: a.work_type,
      priority: a.priority || 'REGULAR',
      round_number: 1,
      is_preserved: false,
      method: 'Enterprise Engine',
      rule_note: a.is_rescue_support ? 'Pending Rescue Support' : `${a.work_type} Allocation Event`,
      is_rescue_support: !!a.is_rescue_support
    });
  }

  // Also include unassigned orders for workDate
  const assignedCodes = new Set(assignments.map(a => a.order_code));
  let unassignedList = [];
  try {
    const unassignedRows = db.prepare(`
      SELECT order_code, account, status, tracking_id, priority, work_state
      FROM current_work_orders
      WHERE work_date = ?
    `).all(workDate);
    unassignedList = unassignedRows.filter(r => !assignedCodes.has(r.order_code)).map(u => ({
      order_code: u.order_code,
      account: u.account,
      status: u.status,
      employee_id: null,
      employee_name: 'UNASSIGNED',
      tracking_id: u.tracking_id || u.order_code,
      work_state: 'UNASSIGNED',
      priority: u.priority || 'REGULAR',
      round_number: 1,
      is_preserved: false,
      method: 'Enterprise Engine',
      rule_note: 'Unassigned',
      is_rescue_support: false
    }));
  } catch (_) {}

  for (const u of unassignedList) {
    rawAllocations.push(u);
  }

  // Build canonical by_employee structure
  const byEmpMap = new Map();
  for (const a of assignments) {
    if (!byEmpMap.has(a.employee_id)) {
      byEmpMap.set(a.employee_id, {
        employee_id: a.employee_id,
        employee_name: a.employee_name,
        accountsMap: new Map(),
        orders: [],
        new_orders: 0,
        pending_orders: 0
      });
    }
    const emp = byEmpMap.get(a.employee_id);
    emp.orders.push(a);
    const isPend = (a.status || '').toLowerCase().includes('pending') || a.work_type === 'PENDING';
    if (isPend) emp.pending_orders++;
    else emp.new_orders++;

    const accKey = `${a.account}|${isPend ? 'Pending' : 'New'}`;
    if (!emp.accountsMap.has(accKey)) {
      emp.accountsMap.set(accKey, {
        account: a.account,
        status: isPend ? 'Pending' : 'New',
        count: 0,
        total_orders: 0,
        new_orders: 0,
        pending_orders: 0
      });
    }
    const accItem = emp.accountsMap.get(accKey);
    accItem.count++;
    accItem.total_orders++;
    if (isPend) accItem.pending_orders++;
    else accItem.new_orders++;
  }

  const byEmployee = Array.from(byEmpMap.values()).map(e => ({
    employee_id: e.employee_id,
    employee_name: e.employee_name,
    total_accounts: e.accountsMap.size,
    accounts_count: e.accountsMap.size,
    total_orders: e.orders.length,
    orders_count: e.orders.length,
    preserved_count: 0,
    newly_assigned_count: e.orders.length,
    new_orders: e.new_orders,
    pending_orders: e.pending_orders,
    accounts: Array.from(e.accountsMap.values()),
    orders: e.orders
  }));

  // Account owners list
  const accountOwners = [];
  try {
    const ownersRows = db.prepare(`
      SELECT account, owner_employee_id as employee_id, owner_employee_name as employee_name
      FROM account_owners
      WHERE work_date = ?
    `).all(workDate);
    accountOwners.push(...ownersRows);
  } catch (_) {}

  return {
    success: true,
    status: 'COMMITTED',
    run_id: plan.run_id,
    work_date: workDate,
    version: nextVer,
    version_number: nextVer,
    method: 'Enterprise Engine',
    total_orders: plan.total_orders_input || rawAllocations.length,
    assigned_orders: assignments.length,
    assigned_count: assignments.length,
    unassigned_orders: plan.unassigned_count,
    unassigned_count: plan.unassigned_count,
    preserved_orders: plan.preserved_count || 0,
    preserved_orders_count: plan.preserved_count || 0,
    configuration_version: plan.configuration_version,
    fingerprint: plan.fingerprint,
    is_rescue_active: plan.is_rescue_active,
    already_saved: true,
    raw_allocations: rawAllocations,
    allocations: rawAllocations,
    orderLevelAllocations: rawAllocations,
    by_employee: byEmployee,
    account_owners: accountOwners,
    unassigned_orders_list: unassignedList
  };
}

// ============================================================
// 8. OPERATIONAL MONITORING & REPLENISHMENT ALERTS (Sections 35-37)
// ============================================================

/**
 * Checks operational alerts for remaining workload and upcoming account windows
 * Deduplicated to prevent alert spam (Section 37, 150)
 */
export function checkEnterpriseOperationalAlerts(workDate, currentTimeStr = null) {
  const alerts = [];
  const lowThresh = getGlobalSettingInt('low_remaining_threshold', 3);
  const nowTime = currentTimeStr ? extractTimeHHMM(currentTimeStr) : extractTimeHHMM(getCairoNow());

  // 1. Low Remaining Workload Alerts per Employee
  const workingTeam = getWorkingTeam(workDate).filter(e => e.is_working && isCsEmployee(e));
  const workloads = getEmployeesWorkloadMap(workDate);

  const insertAlert = db.prepare(`
    INSERT INTO allocation_operational_alerts (
      work_date, alert_type, entity_id, details_json, status, created_at
    ) VALUES (?, ?, ?, ?, 'ACTIVE', datetime('now'))
    ON CONFLICT(work_date, alert_type, entity_id) DO UPDATE SET
      details_json = excluded.details_json,
      status = 'ACTIVE'
  `);

  for (const emp of workingTeam) {
    const capRow = db.prepare('SELECT max_orders FROM employee_capacities WHERE employee_id = ?').get(emp.employee_id);
    const maxOrders = capRow ? capRow.max_orders : 40;
    const currentLoad = workloads.get(emp.employee_id) || 0;
    const remaining = Math.max(0, maxOrders - currentLoad);

    if (remaining <= lowThresh) {
      const details = {
        employee_id: emp.employee_id,
        employee_name: emp.name,
        max_orders: maxOrders,
        current_workload: currentLoad,
        remaining_capacity: remaining,
        threshold: lowThresh
      };

      insertAlert.run(workDate, 'LOW_REMAINING', String(emp.employee_id), JSON.stringify(details));
      alerts.push({
        type: 'LOW_REMAINING',
        entity_id: String(emp.employee_id),
        message: `Employee ${emp.name} has ${remaining} orders remaining (Threshold <= ${lowThresh}). Replenishment evaluation required.`,
        details
      });
    }
  }

  // 2. Account Schedule Opening Alerts (Informational only, does NOT allocate early! Section 149)
  const schedules = db.prepare('SELECT * FROM account_schedules').all();
  for (const s of schedules) {
    if (s.new_start_time) {
      const diffMins = calculateMinutesDifference(nowTime, s.new_start_time);
      if (diffMins > 0 && diffMins <= 15) {
        const details = { account: s.account, work_type: 'NEW', start_time: s.new_start_time, minutes_until_open: diffMins };
        insertAlert.run(workDate, 'ACCOUNT_OPENING_SOON', `${s.account}_NEW`, JSON.stringify(details));
        alerts.push({
          type: 'ACCOUNT_OPENING_SOON',
          entity_id: `${s.account}_NEW`,
          message: `Account ${s.account} NEW window opens in ${diffMins} minutes (${s.new_start_time}).`,
          details
        });
      }
    }
  }

  // 3. Pending Pressure / Rescue Alert
  const rescueEval = evaluatePendingRescueOperation(workDate);
  if (rescueEval.rescue_triggered) {
    const details = {
      pending_pressure_units: rescueEval.pending_pressure_units,
      threshold: rescueEval.configured_threshold,
      eligible_support_quantity: rescueEval.bounded_support_quantity
    };
    insertAlert.run(workDate, 'RESCUE_PRESSURE', 'RESCUE_SYSTEM', JSON.stringify(details));
    alerts.push({
      type: 'RESCUE_PRESSURE',
      entity_id: 'RESCUE_SYSTEM',
      message: `PENDING Rescue condition triggered: pressure (${rescueEval.pending_pressure_units}) >= threshold (${rescueEval.configured_threshold}). Eligible NEW support: ${rescueEval.bounded_support_quantity}.`,
      details
    });
  }

  return alerts;
}

function calculateMinutesDifference(currentTimeHHMM, targetTimeHHMM) {
  const [ch, cm] = currentTimeHHMM.split(':').map(Number);
  const [th, tm] = targetTimeHHMM.split(':').map(Number);
  const currentTotal = ch * 60 + cm;
  const targetTotal = th * 60 + tm;
  return targetTotal - currentTotal;
}

// ============================================================
// 9. AUDIT & FORENSIC QUERIES (Sections 110, 200)
// ============================================================

/**
 * Reconstructs the complete forensic audit trail for an allocation run
 */
export function getEnterpriseAllocationRunDetails(runId) {
  const run = db.prepare('SELECT * FROM enterprise_allocation_runs WHERE run_id = ?').get(runId);
  if (!run) return null;

  const snapshot = db.prepare('SELECT * FROM allocation_snapshots WHERE run_id = ?').get(runId);
  const audits = db.prepare('SELECT * FROM allocation_decision_audits WHERE run_id = ? ORDER BY id ASC').all(runId);

  return {
    ...run,
    eligible_candidates: run.eligible_candidates_json ? JSON.parse(run.eligible_candidates_json) : [],
    excluded_candidates: run.excluded_candidates_json ? JSON.parse(run.excluded_candidates_json) : [],
    proposal: run.proposal_json ? JSON.parse(run.proposal_json) : [],
    snapshot: snapshot ? JSON.parse(snapshot.snapshot_data_json) : null,
    audit_trail: audits
  };
}

/**
 * Retrieves historical allocation runs for a date
 */
export function getEnterpriseAllocationHistory(workDate = null, limit = 50) {
  let sql = 'SELECT * FROM enterprise_allocation_runs';
  const params = [];
  if (workDate) {
    sql += ' WHERE work_date = ?';
    params.push(workDate);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  return rows.map(r => ({
    run_id: r.run_id,
    work_date: r.work_date,
    trigger: r.trigger,
    mode: r.mode,
    allocation_type: r.allocation_type,
    status: r.status,
    block_type: r.block_type,
    block_reason: r.block_reason,
    rescue_state: r.rescue_state,
    configuration_version: r.configuration_version,
    total_orders_input: r.total_orders_input,
    assigned_count: r.assigned_count,
    unassigned_count: r.unassigned_count,
    started_at: r.started_at,
    completed_at: r.completed_at
  }));
}
