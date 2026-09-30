/**
 * CS Executive BI — Authoritative Employee Operational Evaluation & Phone Comparison Engine
 *
 * Implements the core operational evaluation model:
 * 1. CONFIRMED ORDERS (Attributable to real CS actions: Printed / Confirmed)
 * 2. ADDED PHONE NUMBERS (Attributable to real CS actions: Alternate / Added Phone)
 * 3. TWO-FIELD PHONE COMPARISON & REVIEW ALERTS (phone vs phone2 exact normalized matching)
 * 4. PHONE MATCH RATE & OPERATIONAL COMPARISONS
 *
 * Grounded in real Vendoor operational logs and payloads with zero fake scores.
 */

import { db } from '../db/index.js';
import { isCsEmployee, isCsDept, normalizeEmployeeName } from './parser.js';
import { resolveEmployeeIdentity } from './vendoor/identity.js';
import { ALT_RE, ADDED_RE } from './parser.js';
import { resolveDateRange } from './reports.js';

/**
 * Normalizes a phone number deterministically.
 *
 * Rules:
 * - Trims whitespace
 * - Converts Eastern Arabic numerals (٠-٩) and Persian numerals (۰-۹) to standard Latin digits (0-9)
 * - Removes all non-digit characters (spaces, hyphens, parentheses, pluses, dots)
 * - Normalizes Egyptian mobile prefixes (+20, 0020, 20, 10...) to standard 11-digit format (01xxxxxxxxx)
 * - Returns empty string for empty / missing input
 */
export function normalizePhoneNumber(rawPhone) {
  if (rawPhone === null || rawPhone === undefined) return '';
  let str = String(rawPhone).trim();
  if (!str) return '';

  // Convert Eastern Arabic and Persian numerals
  const easternDigits = '٠١٢٣٤٥٦٧٨٩';
  const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
  str = str.replace(/[٠-٩]/g, d => String(easternDigits.indexOf(d)))
           .replace(/[۰-۹]/g, d => String(persianDigits.indexOf(d)));

  // Remove all non-digits
  let digits = str.replace(/\D/g, '');
  if (!digits) return '';

  // Normalize Egyptian phone prefixes
  if (digits.startsWith('0020')) {
    if (digits.length === 14) {
      digits = '0' + digits.slice(4);
    } else if (digits.length === 15) {
      digits = digits.slice(4);
    }
  } else if (digits.startsWith('20')) {
    if (digits.length === 12) {
      digits = '0' + digits.slice(2);
    } else if (digits.length === 13) {
      digits = digits.slice(2);
    }
  } else if (digits.length === 10 && /^[1][0125]/.test(digits)) {
    digits = '0' + digits;
  }

  return digits;
}

/**
 * Compares two phone number fields for exact normalized equality.
 *
 * Rules:
 * - Returns is_match: true ONLY IF both fields are non-empty AND normalize(A) === normalize(B).
 * - Never matches on empty or missing fields.
 */
export function compareOrderPhoneNumbers(phoneA, phoneB) {
  const normA = normalizePhoneNumber(phoneA);
  const normB = normalizePhoneNumber(phoneB);
  const isBothPresent = Boolean(normA && normB);
  const isMatch = isBothPresent && (normA === normB);

  return {
    is_match: isMatch,
    is_both_present: isBothPresent,
    phone_a_raw: phoneA !== null && phoneA !== undefined ? String(phoneA) : '',
    phone_b_raw: phoneB !== null && phoneB !== undefined ? String(phoneB) : '',
    phone_a_normalized: normA,
    phone_b_normalized: normB,
    match_flag: isMatch ? 1 : 0
  };
}

/**
 * Ensures the phone_match_alerts table exists in the active database.
 */
export function ensurePhoneAlertsTable(database = db) {
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS phone_match_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_date TEXT NOT NULL,
        order_code TEXT NOT NULL,
        employee_id INTEGER,
        employee_name TEXT NOT NULL DEFAULT 'Unassigned',
        raw_actor_name TEXT,
        phone_a_raw TEXT,
        phone_b_raw TEXT,
        phone_a_normalized TEXT,
        phone_b_normalized TEXT,
        match_status TEXT DEFAULT 'MATCH',
        alert_type TEXT DEFAULT 'CURRENT_DUPLICATE',
        attribution_status TEXT DEFAULT 'UNRESOLVED',
        source_action TEXT,
        source_event_timestamp TEXT,
        status TEXT DEFAULT 'ACTIVE',
        source TEXT DEFAULT 'VENDOOR_SYNC',
        details_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_phone_alerts_date ON phone_match_alerts(work_date);
      CREATE INDEX IF NOT EXISTS idx_phone_alerts_emp ON phone_match_alerts(employee_name);
      CREATE INDEX IF NOT EXISTS idx_phone_alerts_order ON phone_match_alerts(order_code);
      CREATE INDEX IF NOT EXISTS idx_phone_alerts_status ON phone_match_alerts(status);
    `);

    // Ensure columns exist on legacy tables without errors
    const columns = [
      { name: 'raw_actor_name', type: 'TEXT' },
      { name: 'match_status', type: "TEXT DEFAULT 'MATCH'" },
      { name: 'attribution_status', type: "TEXT DEFAULT 'UNRESOLVED'" },
      { name: 'source_action', type: 'TEXT' },
      { name: 'source_event_timestamp', type: 'TEXT' },
      { name: 'updated_at', type: "TEXT DEFAULT (datetime('now'))" },
      { name: 'resolved_at', type: 'TEXT' }
    ];

    for (const col of columns) {
      try {
        database.exec(`ALTER TABLE phone_match_alerts ADD COLUMN ${col.name} ${col.type}`);
      } catch (_) {
        // Column already exists
      }
    }
  } catch (err) {
    console.warn('ensurePhoneAlertsTable warning:', err.message);
  }
}

/**
 * Records a phone match review alert in the database with deterministic deduplication & lifecycle management.
 *
 * Rules:
 * - Unchanged duplicate maintains 1 ACTIVE alert per order.
 * - If previously resolved, reopening creates a fresh alert.
 */
export function recordPhoneMatchAlert(alertData, database = db) {
  ensurePhoneAlertsTable(database);

  const workDate = alertData.work_date || new Date().toISOString().slice(0, 10);
  const orderCode = String(alertData.order_code || '').trim();
  const employeeName = String(alertData.employee_name || 'Unassigned').trim();
  const employeeId = alertData.employee_id ? parseInt(alertData.employee_id, 10) : null;
  const rawActorName = alertData.raw_actor_name || (employeeName !== 'Unassigned' ? employeeName : null);
  const alertType = alertData.alert_type || (employeeName !== 'Unassigned' ? 'DUPLICATE_CREATED_BY_EDIT' : 'CURRENT_DUPLICATE');
  const attributionStatus = alertData.attribution_status || (employeeName !== 'Unassigned' ? 'PROVEN_CS_ACTION' : 'UNRESOLVED');
  const matchStatus = alertData.match_status || 'MATCH';
  const status = alertData.status || 'ACTIVE';
  const source = alertData.source || 'VENDOOR_SYNC';
  const sourceAction = alertData.source_action || null;
  const sourceTs = alertData.source_event_timestamp || null;

  if (!orderCode) return false;

  // Check if an active alert already exists for this order
  const existing = database.prepare(`
    SELECT id, status, employee_name, alert_type 
    FROM phone_match_alerts 
    WHERE order_code = ? AND status != 'RESOLVED'
    ORDER BY id DESC LIMIT 1
  `).get(orderCode);

  if (existing) {
    // Update existing active alert in-place
    const updateStmt = database.prepare(`
      UPDATE phone_match_alerts SET
        work_date = ?,
        employee_id = ?,
        employee_name = ?,
        raw_actor_name = ?,
        phone_a_raw = ?,
        phone_b_raw = ?,
        phone_a_normalized = ?,
        phone_b_normalized = ?,
        match_status = ?,
        alert_type = ?,
        attribution_status = ?,
        source_action = ?,
        source_event_timestamp = ?,
        status = ?,
        source = ?,
        details_json = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `);

    try {
      updateStmt.run(
        workDate,
        employeeId,
        employeeName,
        rawActorName,
        alertData.phone_a_raw || '',
        alertData.phone_b_raw || '',
        alertData.phone_a_normalized || '',
        alertData.phone_b_normalized || '',
        matchStatus,
        alertType,
        attributionStatus,
        sourceAction,
        sourceTs,
        status,
        source,
        JSON.stringify(alertData.details || {}),
        existing.id
      );
      return true;
    } catch (err) {
      console.warn('recordPhoneMatchAlert update error:', err.message);
      return false;
    }
  }

  // Insert a new alert record
  const insertStmt = database.prepare(`
    INSERT INTO phone_match_alerts (
      work_date, order_code, employee_id, employee_name, raw_actor_name,
      phone_a_raw, phone_b_raw, phone_a_normalized, phone_b_normalized,
      match_status, alert_type, attribution_status, source_action, source_event_timestamp,
      status, source, details_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);

  try {
    insertStmt.run(
      workDate,
      orderCode,
      employeeId,
      employeeName,
      rawActorName,
      alertData.phone_a_raw || '',
      alertData.phone_b_raw || '',
      alertData.phone_a_normalized || '',
      alertData.phone_b_normalized || '',
      matchStatus,
      alertType,
      attributionStatus,
      sourceAction,
      sourceTs,
      status,
      source,
      JSON.stringify(alertData.details || {})
    );
    return true;
  } catch (err) {
    console.warn('recordPhoneMatchAlert insert error:', err.message);
    return false;
  }
}

/**
 * Resolves an active phone match alert when phone numbers are no longer duplicate.
 */
export function resolveOrderPhoneMatch(orderCode, database = db) {
  ensurePhoneAlertsTable(database);
  if (!orderCode) return false;
  try {
    const res = database.prepare(`
      UPDATE phone_match_alerts 
      SET status = 'RESOLVED', resolved_at = datetime('now'), updated_at = datetime('now')
      WHERE order_code = ? AND status != 'RESOLVED'
    `).run(orderCode);
    return res.changes > 0;
  } catch (err) {
    console.warn('resolveOrderPhoneMatch error:', err.message);
    return false;
  }
}

/**
 * Evaluates a single order for phone duplication and updates alert lifecycle deterministically.
 */
export function evaluateAndRecordOrderPhoneDuplicate(orderData, previousOrderData = null, database = db) {
  if (!orderData || !orderData.order_code) return null;

  const orderCode = String(orderData.order_code).trim();
  const phoneA = orderData.phone || '';
  const phoneB = orderData.phone2 || '';
  const comparison = compareOrderPhoneNumbers(phoneA, phoneB);
  const workDate = orderData.business_date || orderData.date || new Date().toISOString().slice(0, 10);

  if (comparison.is_match) {
    // Check if previously the numbers were different or missing
    let wasDuplicateBefore = false;
    if (previousOrderData) {
      const prevComp = compareOrderPhoneNumbers(previousOrderData.phone || '', previousOrderData.phone2 || '');
      wasDuplicateBefore = prevComp.is_match;
    }

    // Resolve causal CS employee
    const attribution = resolvePhoneAlertAttribution(orderCode, database);
    const hasCsAttribution = attribution.employee_id && attribution.employee_name && attribution.employee_name !== 'Unassigned';

    const empName = hasCsAttribution ? attribution.employee_name : 'Unassigned';
    const empId = hasCsAttribution ? attribution.employee_id : null;
    const alertType = hasCsAttribution 
      ? 'DUPLICATE_CREATED_BY_EDIT' 
      : 'CURRENT_DUPLICATE';
    const attributionStatus = hasCsAttribution ? 'PROVEN_CS_ACTION' : 'UNRESOLVED';

    const recorded = recordPhoneMatchAlert({
      work_date: workDate,
      order_code: orderCode,
      employee_id: empId,
      employee_name: empName,
      raw_actor_name: attribution.raw_actor_name || (hasCsAttribution ? empName : null),
      phone_a_raw: comparison.phone_a_raw,
      phone_b_raw: comparison.phone_b_raw,
      phone_a_normalized: comparison.phone_a_normalized,
      phone_b_normalized: comparison.phone_b_normalized,
      match_status: 'MATCH',
      alert_type: alertType,
      attribution_status: attributionStatus,
      source_action: attribution.action || (hasCsAttribution ? 'MODIFIED_PHONE_IN_ORDER' : 'ORDER_SYNC_EXISTING'),
      source_event_timestamp: attribution.timestamp || null,
      status: 'ACTIVE',
      source: 'VENDOOR_SYNC',
      details: {
        customer_name: orderData.customer_name || '',
        account: orderData.account || '',
        total_price: orderData.total_price || 0,
        causal_type: attribution.causal_type || null,
        causal_action: attribution.action || null,
        was_duplicate_before: wasDuplicateBefore,
        before_phone_a: previousOrderData ? (previousOrderData.phone || '') : null,
        before_phone_b: previousOrderData ? (previousOrderData.phone2 || '') : null
      }
    }, database);

    return { is_duplicate: true, alert_recorded: recorded, alert_type: alertType, attribution };
  } else {
    // If not matching, check if an active alert needs to be resolved
    const resolved = resolveOrderPhoneMatch(orderCode, database);
    return { is_duplicate: false, alert_resolved: resolved };
  }
}

/**
 * Resolves the real CS employee who performed the actual Vendoor activity that caused,
 * modified, created, or confirmed the order with duplicate phone numbers.
 *
 * Rules:
 * - Links strictly through actual causal Vendoor activity log events.
 * - Resolves actor deterministically against Employee Master (CS department only).
 * - Priority order:
 *   1. Direct phone addition / phone modification action (ALT_RE / phone action)
 *   2. Order data edit action (عدل في بيانات الاوردر)
 *   3. Order creation action (ADDED_RE / أضاف اوردر)
 *   4. Order confirmation action (Printed / تأكيد)
 * - If NO causal action by a CS employee exists, returns 'Unassigned' (employee_id: null).
 * - NEVER falls back to current assignment, dispatcher state, or unrelated last-touch logs.
 */
export function resolvePhoneAlertAttribution(orderCode, database = db) {
  if (!orderCode) return { employee_id: null, employee_name: 'Unassigned', reason: 'NO_ORDER_CODE' };

  // Collect all known order identifiers (order_code, tracking_id, aliases)
  const candidateCodes = new Set([String(orderCode).trim()]);
  try {
    const otRows = database.prepare('SELECT order_code, tracking_id FROM order_tracking WHERE order_code = ? OR tracking_id = ?').all(orderCode, orderCode);
    for (const ot of otRows) {
      if (ot.order_code) candidateCodes.add(String(ot.order_code).trim());
      if (ot.tracking_id) candidateCodes.add(String(ot.tracking_id).trim());
    }
  } catch (_) {}

  const codeList = Array.from(candidateCodes).filter(Boolean);
  if (codeList.length === 0) return { employee_id: null, employee_name: 'Unassigned', reason: 'NO_CODES' };

  const placeholders = codeList.map(() => '?').join(',');

  // Query raw logs and vendoor logs for all events on this order
  let rawLogs = [];
  try {
    rawLogs = database.prepare(`
      SELECT employee_name, action, status, event_datetime as ts, 'raw_log_records' as tbl
      FROM raw_log_records
      WHERE order_code IN (${placeholders})
      ORDER BY event_datetime DESC, id DESC
    `).all(...codeList);
  } catch (_) {}

  let vLogs = [];
  try {
    vLogs = database.prepare(`
      SELECT employee_name, action, '' as status, timestamp_str as ts, 'vendoor_logs' as tbl
      FROM vendoor_logs
      WHERE order_code IN (${placeholders})
      ORDER BY timestamp_str DESC, id DESC
    `).all(...codeList);
  } catch (_) {}

  const allLogs = [...rawLogs, ...vLogs];
  if (allLogs.length === 0) {
    return { employee_id: null, employee_name: 'Unassigned', reason: 'NO_LOGS_FOR_ORDER' };
  }

  let bestAttribution = null;
  let highestPriority = 0;

  for (const log of allLogs) {
    if (!log.employee_name) continue;

    // Resolve actor identity to master CS employee strictly
    let identity = null;
    if (database && database !== db) {
      try {
        const empRow = database.prepare('SELECT id, name, department FROM employees WHERE LOWER(name) = LOWER(?)').get(log.employee_name);
        if (empRow) {
          identity = {
            employee_id: empRow.id,
            employee_name: empRow.name,
            department: empRow.department
          };
        }
      } catch (_) {}
    }
    if (!identity) {
      identity = resolveEmployeeIdentity(log.employee_name, { persistIdentity: false });
    }
    if (!identity || !identity.employee_id || !isCsDept(identity.department)) {
      continue; // Strictly ignore non-CS actors (merchants, system, external couriers, etc.)
    }

    const act = String(log.action || '').trim();
    const st = String(log.status || '').trim();
    let priority = 0;
    let causalType = '';

    // Priority 4: Direct phone addition / phone modification action
    if (ALT_RE.test(act) || /رقم.*بديل|تليفون.*بديل|هاتف.*بديل|اضافة.*رقم|إضافة.*رقم|تعديل.*رقم|تحديث.*رقم|رقم.*الهاتف|رقم.*التليفون|alt.*phone|phone/i.test(act)) {
      priority = 4;
      causalType = 'PHONE_MUTATION_ACTION';
    }
    // Priority 3: Order data edit action (modifying order details in Vendoor)
    else if (act.includes('عدل في بيانات') || act.includes('تعديل في بيانات') || act.includes('تعديل الطلب') || act.includes('تحديث بيانات') || act.includes('تعديل بيانات')) {
      priority = 3;
      causalType = 'ORDER_DATA_EDIT_ACTION';
    }
    // Priority 2: Order creation action (CS agent created order with the duplicate phone numbers)
    else if (ADDED_RE.test(act) || /اضافة.*اوردر|أضاف.*اوردر|اضاف.*اوردر|انشاء.*طلب|create.*order/i.test(act)) {
      priority = 2;
      causalType = 'ORDER_CREATION_ACTION';
    }
    // Priority 1: Order confirmation / Printed action by CS agent
    else if (st === 'Printed' || /print|طبع|طباعة|تأكيد|تاكيد|confirmed/i.test(act) || /print|طبع|طباعة|تأكيد|تاكيد|confirmed/i.test(st)) {
      priority = 1;
      causalType = 'ORDER_CONFIRMATION_ACTION';
    }

    if (priority > 0) {
      if (priority > highestPriority) {
        highestPriority = priority;
        bestAttribution = {
          employee_id: identity.employee_id,
          employee_name: identity.employee_name,
          priority,
          causal_type: causalType,
          action: act,
          timestamp: log.ts
        };
      }
    }
  }

  if (bestAttribution) {
    return bestAttribution;
  }

  // If no CS employee performed any causal phone, edit, creation, or confirmation action:
  // Strictly remain Unassigned. Never fallback to current assignment or unrelated last-touch.
  return {
    employee_id: null,
    employee_name: 'Unassigned',
    reason: 'NO_CAUSAL_CS_ACTION'
  };
}

/**
 * Scans orders and logs to detect and persist phone match review alerts.
 */
export function scanAndRecordPhoneMatches(database = db, options = {}) {
  ensurePhoneAlertsTable(database);

  let query = 'SELECT order_code, business_date, raw_payload_json FROM vendoor_orders WHERE raw_payload_json IS NOT NULL';
  const params = [];
  if (options.work_date) {
    query += ' AND business_date = ?';
    params.push(options.work_date);
  }
  if (options.order_code) {
    query += ' AND order_code = ?';
    params.push(options.order_code);
  }

  const orders = database.prepare(query).all(...params);
  let createdCount = 0;

  for (const o of orders) {
    try {
      const p = JSON.parse(o.raw_payload_json);
      if (!p.order_code) p.order_code = o.order_code;
      if (!p.business_date) p.business_date = o.business_date;

      const evalRes = evaluateAndRecordOrderPhoneDuplicate(p, null, database);
      if (evalRes && evalRes.is_duplicate && evalRes.alert_recorded) {
        createdCount++;
      }
    } catch (_) {}
  }

  return createdCount;
}

/**
 * Computes the canonical Operational Employee Evaluation.
 *
 * Core Metrics:
 * - Confirmed Orders
 * - Added Phone Numbers
 * - Phone Match Alerts
 * - Phone Match Rate (%)
 * - Added Orders (Created)
 * - Total Real Actions
 */
export function getEmployeeEvaluation(options = {}, database = db) {
  ensurePhoneAlertsTable(database);
  scanAndRecordPhoneMatches(database, options);

  const range = resolveDateRange(options.dateMode || options.date_mode || 'day', options.targetDate || options.target_date, options.startDate || options.start_date, options.endDate || options.end_date);
  const placeholders = range.dates.map(() => '?').join(',');

  // Query master active CS employees strictly by CS department
  const masterEmps = database.prepare('SELECT id, name, department, team_membership FROM employees WHERE active = 1').all().filter(e => isCsDept(e.department));

  // Query logs in range
  const logs = database.prepare(`
    SELECT employee_name, order_code, action, status, work_date, is_cs
    FROM raw_log_records
    WHERE work_date IN (${placeholders})
  `).all(...range.dates);

  // Group by resolved employee_id
  const empMap = new Map();
  const masterNameMap = new Map();
  for (const emp of masterEmps) {
    masterNameMap.set(normalizeEmployeeName(emp.name), emp);
    empMap.set(emp.id, {
      employee_id: emp.id,
      employee_name: emp.name,
      department: emp.department || 'CS',
      team_membership: emp.team_membership || 'Both',
      confirmed_orders_set: new Set(),
      added_phones_count: 0,
      added_orders_set: new Set(),
      all_orders_set: new Set(),
      real_actions_count: 0
    });
  }

  for (const log of logs) {
    if (!log.employee_name) continue;
    let resolvedEmp = masterNameMap.get(normalizeEmployeeName(log.employee_name));
    if (!resolvedEmp) {
      const resolved = resolveEmployeeIdentity(log.employee_name, { persistIdentity: false });
      if (resolved && resolved.employee_id && (resolved.department === 'CS' || isCsDept(resolved.department))) {
        resolvedEmp = empMap.get(resolved.employee_id);
      }
    }

    if (!resolvedEmp || !resolvedEmp.id) continue;
    const stat = empMap.get(resolvedEmp.id);
    if (!stat) continue;

    stat.real_actions_count++;
    stat.all_orders_set.add(log.order_code);

    const act = log.action || '';
    const st = log.status || '';

    // Confirmed order condition (Printed / Confirmed status transition or action)
    if (st === 'Printed' || /print|طبع|طباعة|تأكيد|تاكيد|confirmed/i.test(act) || /print|طبع|طباعة|تأكيد|تاكيد|confirmed/i.test(st)) {
      stat.confirmed_orders_set.add(log.order_code);
    }

    // Added phone number condition
    if (ALT_RE.test(act) || /رقم.*بديل|تليفون.*بديل|هاتف.*بديل|اضافة.*رقم|إضافة.*رقم/i.test(act)) {
      stat.added_phones_count++;
    }

    // Added order condition
    if (ADDED_RE.test(act) || /اضافة.*اوردر|أضاف.*اوردر|اضاف.*اوردر|انشاء.*طلب/i.test(act)) {
      stat.added_orders_set.add(log.order_code);
    }
  }

  // Query phone match alerts in range
  const alerts = database.prepare(`
    SELECT *
    FROM phone_match_alerts
    WHERE work_date IN (${placeholders})
  `).all(...range.dates);

  const alertMap = new Map();
  for (const a of alerts) {
    if (a.employee_name === 'Unassigned' || !a.employee_id) continue;
    const key = a.employee_id;
    if (!alertMap.has(key)) alertMap.set(key, []);
    alertMap.get(key).push(a);

    const nameKey = normalizeEmployeeName(a.employee_name);
    if (!alertMap.has(nameKey)) alertMap.set(nameKey, []);
    alertMap.get(nameKey).push(a);
  }

  // Construct employee rows
  const rows = [];
  let totalTeamConfirmed = 0;
  let totalTeamAddedPhones = 0;
  let totalTeamAlerts = 0;
  let totalTeamActions = 0;

  for (const emp of masterEmps) {
    const stat = empMap.get(emp.id) || {
      confirmed_orders_set: new Set(),
      added_phones_count: 0,
      added_orders_set: new Set(),
      all_orders_set: new Set(),
      real_actions_count: 0
    };

    const empAlerts = alertMap.get(emp.id) || alertMap.get(emp.name) || [];
    const confirmedCount = stat.confirmed_orders_set.size;
    const addedPhonesCount = stat.added_phones_count;
    const alertsCount = empAlerts.length;
    const matchRate = confirmedCount > 0 ? Number(((alertsCount / confirmedCount) * 100).toFixed(1)) : 0.0;

    totalTeamConfirmed += confirmedCount;
    totalTeamAddedPhones += addedPhonesCount;
    totalTeamAlerts += alertsCount;
    totalTeamActions += stat.real_actions_count;

    // Filter by working only if requested
    if (options.working_only && stat.real_actions_count === 0 && confirmedCount === 0) {
      continue;
    }

    rows.push({
      employee_id: emp.id,
      employee_name: emp.name,
      department: emp.department,
      team_membership: emp.team_membership,
      confirmed_orders: confirmedCount,
      added_phone_numbers: addedPhonesCount,
      added_orders: stat.added_orders_set.size,
      phone_match_alerts: alertsCount,
      phone_match_rate: matchRate,
      real_actions: stat.real_actions_count,
      total_orders_touched: stat.all_orders_set.size,
      alerts_detail: empAlerts
    });
  }

  // Sort by Confirmed Orders DESC, then Added Phones DESC
  rows.sort((a, b) => b.confirmed_orders - a.confirmed_orders || b.added_phone_numbers - a.added_phone_numbers);

  const activeEmpCount = rows.filter(r => r.confirmed_orders > 0 || r.added_phone_numbers > 0 || r.real_actions > 0).length || 1;
  const avgConfirmed = Number((totalTeamConfirmed / activeEmpCount).toFixed(1));
  const avgAddedPhones = Number((totalTeamAddedPhones / activeEmpCount).toFixed(1));
  const overallMatchRate = totalTeamConfirmed > 0 ? Number(((totalTeamAlerts / totalTeamConfirmed) * 100).toFixed(1)) : 0.0;

  // Add relative team comparisons without arbitrary scores
  for (const r of rows) {
    r.comparison_vs_team = {
      confirmed_diff: r.confirmed_orders - avgConfirmed,
      confirmed_pct_of_avg: avgConfirmed > 0 ? Number(((r.confirmed_orders / avgConfirmed) * 100).toFixed(1)) : 100.0,
      added_phones_diff: r.added_phone_numbers - avgAddedPhones,
      added_phones_pct_of_avg: avgAddedPhones > 0 ? Number(((r.added_phone_numbers / avgAddedPhones) * 100).toFixed(1)) : 100.0
    };
  }

  return {
    date_mode: range.dateMode,
    start_date: range.startDate,
    end_date: range.endDate,
    dates: range.dates,
    summary: {
      total_cs_employees: masterEmps.length,
      active_employees: activeEmpCount,
      total_confirmed_orders: totalTeamConfirmed,
      total_added_phones: totalTeamAddedPhones,
      total_phone_match_alerts: totalTeamAlerts,
      total_real_actions: totalTeamActions,
      team_avg_confirmed_orders: avgConfirmed,
      team_avg_added_phones: avgAddedPhones,
      overall_phone_match_rate: overallMatchRate,
      top_confirmed_employee: rows[0]?.confirmed_orders > 0 ? { name: rows[0].employee_name, count: rows[0].confirmed_orders } : null,
      top_phone_adder_employee: [...rows].sort((a, b) => b.added_phone_numbers - a.added_phone_numbers)[0]?.added_phone_numbers > 0
        ? { name: [...rows].sort((a, b) => b.added_phone_numbers - a.added_phone_numbers)[0].employee_name, count: [...rows].sort((a, b) => b.added_phone_numbers - a.added_phone_numbers)[0].added_phone_numbers }
        : null
    },
    employees: rows,
    recent_alerts: alerts.slice(0, 50)
  };
}

/**
 * Returns all phone match review alerts with optional filtering.
 */
export function getPhoneMatchAlerts(options = {}, database = db) {
  ensurePhoneAlertsTable(database);
  scanAndRecordPhoneMatches(database, options);

  let query = 'SELECT * FROM phone_match_alerts WHERE 1=1';
  const params = [];

  if (options.work_date) {
    query += ' AND work_date = ?';
    params.push(options.work_date);
  } else if (options.startDate && options.endDate) {
    query += ' AND work_date BETWEEN ? AND ?';
    params.push(options.startDate, options.endDate);
  }

  if (options.employee_name && options.employee_name !== 'ALL') {
    query += ' AND employee_name = ?';
    params.push(options.employee_name);
  }
  if (options.employee_id) {
    query += ' AND employee_id = ?';
    params.push(parseInt(options.employee_id, 10));
  }
  if (options.order_code) {
    query += ' AND order_code LIKE ?';
    params.push(`%${options.order_code}%`);
  }

  query += ' ORDER BY work_date DESC, id DESC LIMIT 500';
  const rows = database.prepare(query).all(...params);

  return {
    total_alerts: rows.length,
    alerts: rows.map(r => ({
      id: r.id,
      work_date: r.work_date,
      order_code: r.order_code,
      employee_id: r.employee_id,
      employee_name: r.employee_name,
      phone_a_raw: r.phone_a_raw,
      phone_b_raw: r.phone_b_raw,
      phone_a_normalized: r.phone_a_normalized,
      phone_b_normalized: r.phone_b_normalized,
      alert_type: r.alert_type,
      status: r.status || 'REVIEW_REQUIRED',
      source: r.source,
      created_at: r.created_at
    }))
  };
}

/**
 * Returns complete operational evaluation details for a specific employee.
 */
export function getEmployeeEvaluationDetail(employeeId, options = {}, database = db) {
  ensurePhoneAlertsTable(database);
  const emp = database.prepare('SELECT id, name, department, team_membership FROM employees WHERE id = ?').get(employeeId);
  if (!emp) return null;

  const range = resolveDateRange(options.dateMode || 'day', options.targetDate, options.startDate, options.endDate);
  const placeholders = range.dates.map(() => '?').join(',');

  // Query logs for this employee
  const logs = database.prepare(`
    SELECT order_code, action, status, event_datetime, work_date
    FROM raw_log_records
    WHERE employee_name = ? AND work_date IN (${placeholders})
    ORDER BY event_datetime DESC
  `).all(emp.name, ...range.dates);

  const confirmedOrders = new Map();
  const phoneAdditions = [];
  const addedOrders = new Set();

  for (const l of logs) {
    const act = l.action || '';
    const st = l.status || '';

    if (st === 'Printed' || /print|طبع|طباعة|تأكيد|تاكيد|confirmed/i.test(act) || /print|طبع|طباعة|تأكيد|تاكيد|confirmed/i.test(st)) {
      if (!confirmedOrders.has(l.order_code)) {
        confirmedOrders.set(l.order_code, {
          order_code: l.order_code,
          timestamp: l.event_datetime,
          work_date: l.work_date,
          action: act || st
        });
      }
    }

    if (ALT_RE.test(act) || /رقم.*بديل|تليفون.*بديل|هاتف.*بديل|اضافة.*رقم|إضافة.*رقم/i.test(act)) {
      phoneAdditions.push({
        order_code: l.order_code,
        timestamp: l.event_datetime,
        work_date: l.work_date,
        action: act
      });
    }

    if (ADDED_RE.test(act)) {
      addedOrders.add(l.order_code);
    }
  }

  // Query phone alerts for this employee
  const alerts = database.prepare(`
    SELECT *
    FROM phone_match_alerts
    WHERE (employee_id = ? OR employee_name = ?) AND work_date IN (${placeholders})
    ORDER BY id DESC
  `).all(emp.id, emp.name, ...range.dates);

  const confirmedCount = confirmedOrders.size;
  const matchRate = confirmedCount > 0 ? Number(((alerts.length / confirmedCount) * 100).toFixed(1)) : 0.0;

  return {
    employee: {
      id: emp.id,
      name: emp.name,
      department: emp.department,
      team_membership: emp.team_membership
    },
    date_range: {
      start_date: range.startDate,
      end_date: range.endDate,
      dates: range.dates
    },
    metrics: {
      confirmed_orders: confirmedCount,
      added_phone_numbers: phoneAdditions.length,
      added_orders: addedOrders.size,
      phone_match_alerts: alerts.length,
      phone_match_rate: matchRate,
      total_log_actions: logs.length
    },
    confirmed_orders_list: Array.from(confirmedOrders.values()),
    phone_additions_list: phoneAdditions,
    alerts_list: alerts
  };
}
