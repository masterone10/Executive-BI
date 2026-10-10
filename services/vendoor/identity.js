/**
 * Deterministic Employee Identity Resolution & Mapping Service (Phase 2 Requirement 4, 5, 6)
 *
 * Rules:
 * - Employee Master (employees table) is STRICTLY AUTHORITATIVE.
 * - NEVER automatically create employees in Employee Master.
 * - Deterministic Priority:
 *   1. Explicit Persistent Mapping (vendoor_identity_mappings table)
 *   2. Exact Normalized Name match with Employee Master (unique candidate)
 *   3. Configured Alias match with Employee Master (unique candidate)
 *   4. Otherwise: UNMATCHED / NEEDS_REVIEW
 * - If multiple candidates match: Mark NEEDS_REVIEW, do not pick arbitrarily.
 */

import { db } from '../../db/index.js';
import { normalizeEmployeeName, isCsDept } from '../parser.js';

export const MATCH_STATUS = {
  EXACT_MATCH: 'EXACT_MATCH',
  EXPLICIT_MAPPING: 'EXPLICIT_MAPPING',
  ALIAS_MATCH: 'ALIAS_MATCH',
  UNMATCHED: 'UNMATCHED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  NON_CS_ACTOR: 'NON_CS_ACTOR'
};

/**
 * Known system aliases (can be extended via explicit mappings in database)
 */
const BASE_ALIASES = new Map([
  // Normalized alias -> Normalized canonical master name
]);

// In-memory resolution cache to make large-scale log analysis instant
const identityResolutionCache = new Map();
const RESOLUTION_CACHE_TTL_MS = 30000;

export function invalidateIdentityResolutionCache() {
  identityResolutionCache.clear();
}

/**
 * Checks whether a raw or normalized actor name belongs to a Merchant, Marketer,
 * non-CS department employee, or system actor. Such actors are strictly excluded from CS matching.
 */
export function isNonCsActor(rawName, normName) {
  if (!rawName && !normName) return false;
  const raw = String(rawName || '').trim();
  const norm = String(normName || normalizeEmployeeName(raw)).toLowerCase();

  const systemActors = ['system', 'vendoor', 'vendoor system', 'admin', 'administrator', 'auto', 'automatic', 'api', 'bot', 'cron', 'integration'];
  if (systemActors.includes(norm) || systemActors.includes(raw.toLowerCase())) return true;

  try {
    // 1. Check merchants table
    const isMerch = db.prepare('SELECT 1 FROM merchants WHERE LOWER(merchant_name) = ? OR LOWER(merchant_code) = ? LIMIT 1').get(norm, norm);
    if (isMerch) return true;

    // 2. Check marketers table
    const isMkt = db.prepare('SELECT 1 FROM marketers WHERE LOWER(marketer_name) = ? OR LOWER(affiliate_name) = ? OR LOWER(affiliate_code) = ? LIMIT 1').get(norm, norm, norm);
    if (isMkt) return true;

    // 3. Check employees master for non-CS department (e.g. Data Entry, Logistics)
    const nonCsEmp = db.prepare("SELECT 1 FROM employees WHERE (LOWER(name) = ? OR LOWER(name) = ?) AND UPPER(department) != 'CS' LIMIT 1").get(raw.toLowerCase(), norm);
    if (nonCsEmp) return true;
  } catch (_) {}

  return false;
}

/**
 * Resolve a Vendoor source employee name against Employee Master
 *
 * @param {string} sourceName - Raw name as observed in Vendoor logs/orders
 * @param {Object} [options]
 * @param {boolean} [options.persistIdentity=true] - Whether to record/update identity entry
 * @returns {{
 *   source_name: string,
 *   normalized_name: string,
 *   status: string,
 *   match_method: string,
 *   employee_id: number|null,
 *   employee_name: string|null,
 *   department: string|null,
 *   confidence: number
 * }}
 */
export function resolveEmployeeIdentity(sourceName, options = {}) {
  const persistIdentity = options.persistIdentity !== false;
  const raw = String(sourceName || '').trim();
  const norm = normalizeEmployeeName(raw);

  if (!raw || !norm) {
    return {
      source_name: raw,
      normalized_name: '',
      status: MATCH_STATUS.UNMATCHED,
      match_method: 'EMPTY_INPUT',
      employee_id: null,
      employee_name: null,
      department: null,
      confidence: 0
    };
  }

  // Check in-memory resolution cache
  const cached = identityResolutionCache.get(raw);
  const now = Date.now();
  if (cached && (now - cached.timestamp < RESOLUTION_CACHE_TTL_MS) && !persistIdentity) {
    return cached.result;
  }

  // 0. Exclude Merchants, Marketers, Non-CS employees, and Vendoor actors
  if (isNonCsActor(raw, norm)) {
    if (persistIdentity) {
      touchIdentityRecord(raw, norm, null, 'NON_CS_ACTOR', 'NON_CS_EXCLUDED', 0.0);
    }
    const nonCsRes = {
      source_name: raw,
      normalized_name: norm,
      status: 'NON_CS_ACTOR',
      match_method: 'NON_CS_EXCLUDED',
      employee_id: null,
      employee_name: null,
      department: 'NON_CS',
      confidence: 0,
      is_cs: false
    };
    identityResolutionCache.set(raw, { timestamp: Date.now(), result: nonCsRes });
    return nonCsRes;
  }

  // 1. Check Explicit Persistent Mapping in DB
  try {
    const mapping = db.prepare(`
      SELECT m.*, e.name as master_emp_name, e.department, e.active
      FROM vendoor_identity_mappings m
      LEFT JOIN employees e ON e.id = m.employee_id
      WHERE LOWER(m.vendoor_name) = LOWER(?) OR LOWER(m.normalized_name) = LOWER(?)
    `).get(raw, norm);

    if (mapping && mapping.status === 'MAPPED' && mapping.employee_id && mapping.master_emp_name && isCsDept(mapping.department)) {
      if (persistIdentity) {
        touchIdentityRecord(raw, norm, mapping.employee_id, MATCH_STATUS.EXPLICIT_MAPPING, 'EXPLICIT_DB_MAPPING', 1.0);
      }
      const res = {
        source_name: raw,
        normalized_name: norm,
        status: MATCH_STATUS.EXPLICIT_MAPPING,
        match_method: 'EXPLICIT_DB_MAPPING',
        employee_id: mapping.employee_id,
        employee_name: mapping.master_emp_name,
        department: mapping.department,
        confidence: 1.0
      };
      identityResolutionCache.set(raw, { timestamp: Date.now(), result: res });
      return res;
    } else if (mapping && mapping.status === 'IGNORED') {
      const res = {
        source_name: raw,
        normalized_name: norm,
        status: MATCH_STATUS.UNMATCHED,
        match_method: 'EXPLICITLY_IGNORED',
        employee_id: null,
        employee_name: null,
        department: null,
        confidence: 0
      };
      identityResolutionCache.set(raw, { timestamp: Date.now(), result: res });
      return res;
    }
  } catch (err) {
    // Database table might not be created yet during initial run
  }

  // 2. Exact Match in Employee Master (Case-insensitive & whitespace-normalized, CS ONLY)
  const masterEmployees = db.prepare('SELECT id, name, department, active FROM employees').all().filter(e => isCsDept(e.department));
  const exactMatches = masterEmployees.filter(e => normalizeEmployeeName(e.name) === norm);

  if (exactMatches.length === 1) {
    const matched = exactMatches[0];
    if (persistIdentity) {
      touchIdentityRecord(raw, norm, matched.id, MATCH_STATUS.EXACT_MATCH, 'EXACT_NORMALIZED_NAME', 1.0);
    }
    const res = {
      source_name: raw,
      normalized_name: norm,
      status: MATCH_STATUS.EXACT_MATCH,
      match_method: 'EXACT_NORMALIZED_NAME',
      employee_id: matched.id,
      employee_name: matched.name,
      department: matched.department,
      confidence: 1.0
    };
    identityResolutionCache.set(raw, { timestamp: Date.now(), result: res });
    return res;
  } else if (exactMatches.length > 1) {
    // Ambiguous exact matches! Do not pick arbitrarily
    if (persistIdentity) {
      touchIdentityRecord(raw, norm, null, MATCH_STATUS.NEEDS_REVIEW, 'AMBIGUOUS_MULTIPLE_EXACT_MATCHES', 0.5);
    }
    const res = {
      source_name: raw,
      normalized_name: norm,
      status: MATCH_STATUS.NEEDS_REVIEW,
      match_method: 'AMBIGUOUS_MULTIPLE_EXACT_MATCHES',
      employee_id: null,
      employee_name: null,
      department: null,
      confidence: 0.5
    };
    identityResolutionCache.set(raw, { timestamp: Date.now(), result: res });
    return res;
  }

  // 2b. Case-insensitive CS suffix token matching (e.g. "Ahmed CS", "Ahmed cs", "Ahmed Cs", "Ahmed cS")
  const stripCsToken = (s) => s.replace(/(?:^|\s+)cs(?:\s+|$)/gi, ' ').trim().replace(/\s+/g, ' ');
  const baseNorm = stripCsToken(norm);
  if (baseNorm.length > 2) {
    const baseMatches = masterEmployees.filter(e => stripCsToken(normalizeEmployeeName(e.name)) === baseNorm);
    if (baseMatches.length === 1) {
      const matched = baseMatches[0];
      if (persistIdentity) {
        touchIdentityRecord(raw, norm, matched.id, MATCH_STATUS.EXACT_MATCH, 'CS_SUFFIX_CASE_INSENSITIVE', 0.98);
      }
      const res = {
        source_name: raw,
        normalized_name: norm,
        status: MATCH_STATUS.EXACT_MATCH,
        match_method: 'CS_SUFFIX_CASE_INSENSITIVE',
        employee_id: matched.id,
        employee_name: matched.name,
        department: matched.department,
        confidence: 0.98
      };
      identityResolutionCache.set(raw, { timestamp: Date.now(), result: res });
      return res;
    } else if (baseMatches.length > 1) {
      if (persistIdentity) {
        touchIdentityRecord(raw, norm, null, MATCH_STATUS.NEEDS_REVIEW, 'AMBIGUOUS_MULTIPLE_CS_TOKEN_MATCHES', 0.5);
      }
      const res = {
        source_name: raw,
        normalized_name: norm,
        status: MATCH_STATUS.NEEDS_REVIEW,
        match_method: 'AMBIGUOUS_MULTIPLE_CS_TOKEN_MATCHES',
        employee_id: null,
        employee_name: null,
        department: null,
        confidence: 0.5
      };
      identityResolutionCache.set(raw, { timestamp: Date.now(), result: res });
      return res;
    }
  }

  // 3. Known Aliases Check
  if (BASE_ALIASES.has(norm)) {
    const canonicalNorm = BASE_ALIASES.get(norm);
    const aliasMatches = masterEmployees.filter(e => normalizeEmployeeName(e.name) === canonicalNorm);
    if (aliasMatches.length === 1) {
      const matched = aliasMatches[0];
      if (persistIdentity) {
        touchIdentityRecord(raw, norm, matched.id, MATCH_STATUS.ALIAS_MATCH, 'BASE_ALIAS_MATCH', 0.95);
      }
      const res = {
        source_name: raw,
        normalized_name: norm,
        status: MATCH_STATUS.ALIAS_MATCH,
        match_method: 'BASE_ALIAS_MATCH',
        employee_id: matched.id,
        employee_name: matched.name,
        department: matched.department,
        confidence: 0.95
      };
      identityResolutionCache.set(raw, { timestamp: Date.now(), result: res });
      return res;
    } else if (aliasMatches.length > 1) {
      if (persistIdentity) {
        touchIdentityRecord(raw, norm, null, MATCH_STATUS.NEEDS_REVIEW, 'AMBIGUOUS_MULTIPLE_ALIAS_MATCHES', 0.5);
      }
      const res = {
        source_name: raw,
        normalized_name: norm,
        status: MATCH_STATUS.NEEDS_REVIEW,
        match_method: 'AMBIGUOUS_MULTIPLE_ALIAS_MATCHES',
        employee_id: null,
        employee_name: null,
        department: null,
        confidence: 0.5
      };
      identityResolutionCache.set(raw, { timestamp: Date.now(), result: res });
      return res;
    }
  }

  // 4. Fallback: UNMATCHED / NEEDS_REVIEW (No silent fuzzy matching!)
  if (persistIdentity) {
    touchIdentityRecord(raw, norm, null, MATCH_STATUS.UNMATCHED, 'NO_MATCH', 0.0);
  }
  const fallbackRes = {
    source_name: raw,
    normalized_name: norm,
    status: MATCH_STATUS.UNMATCHED,
    match_method: 'NO_MATCH',
    employee_id: null,
    employee_name: null,
    department: null,
    confidence: 0.0
  };
  identityResolutionCache.set(raw, { timestamp: Date.now(), result: fallbackRes });
  return fallbackRes;
}

/**
 * Record or update Vendoor identity status in database
 */
function touchIdentityRecord(sourceName, normName, employeeId, status, matchMethod, confidence) {
  try {
    const existing = db.prepare(`
      SELECT id, employee_id, status FROM vendoor_identity_mappings
      WHERE LOWER(vendoor_name) = LOWER(?) OR LOWER(normalized_name) = LOWER(?)
    `).get(sourceName, normName);

    if (existing) {
      // If manually mapped previously, do NOT overwrite the manual assignment
      if (existing.status === 'MAPPED' && existing.employee_id) {
        db.prepare(`
          UPDATE vendoor_identity_mappings
          SET last_seen = datetime('now')
          WHERE id = ?
        `).run(existing.id);
        return;
      }

      db.prepare(`
        UPDATE vendoor_identity_mappings
        SET employee_id = COALESCE(?, employee_id),
            status = CASE WHEN status = 'MAPPED' THEN status ELSE ? END,
            match_method = ?,
            confidence = ?,
            last_seen = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(employeeId, status, matchMethod, confidence, existing.id);
    } else {
      db.prepare(`
        INSERT INTO vendoor_identity_mappings (
          vendoor_name, normalized_name, employee_id, status, match_method, confidence,
          first_seen, last_seen, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'), datetime('now'))
      `).run(sourceName, normName, employeeId, status, matchMethod, confidence);
    }
  } catch (err) {
    // ignore if table does not exist
  }
}

/**
 * Save manual explicit mapping from Vendoor identity to Employee Master
 */
export function saveExplicitIdentityMapping(vendoorName, employeeId, notes = '') {
  const norm = normalizeEmployeeName(vendoorName);
  const emp = db.prepare('SELECT id, name, department FROM employees WHERE id = ?').get(employeeId);
  if (!emp) {
    throw new Error(`Target Employee ID ${employeeId} does not exist in Employee Master.`);
  }

  const stmt = db.prepare(`
    INSERT INTO vendoor_identity_mappings (
      vendoor_name, normalized_name, employee_id, status, match_method, confidence, notes,
      first_seen, last_seen, created_at, updated_at
    ) VALUES (?, ?, ?, 'MAPPED', 'MANUAL_OVERRIDE', 1.0, ?, datetime('now'), datetime('now'), datetime('now'), datetime('now'))
    ON CONFLICT(vendoor_name) DO UPDATE SET
      employee_id = excluded.employee_id,
      normalized_name = excluded.normalized_name,
      status = 'MAPPED',
      match_method = 'MANUAL_OVERRIDE',
      confidence = 1.0,
      notes = excluded.notes,
      updated_at = datetime('now')
  `);

  stmt.run(vendoorName.trim(), norm, emp.id, notes || 'Manually mapped by Supervisor');
  invalidateIdentityResolutionCache();

  return {
    success: true,
    vendoor_name: vendoorName.trim(),
    employee_id: emp.id,
    employee_name: emp.name,
    department: emp.department
  };
}

export const saveIdentityMapping = saveExplicitIdentityMapping;
export const getIdentityMappings = getIdentityMappingsQueue;

/**
 * Retrieve unmatched / needs review queue
 */
export function getUnmatchedEmployeesQueue() {
  const queueRes = getIdentityMappingsQueue('UNMATCHED');
  return queueRes.items || [];
}

/**
 * Delete or reset an explicit mapping
 */
export function deleteExplicitIdentityMapping(mappingId) {
  const res = db.prepare('DELETE FROM vendoor_identity_mappings WHERE id = ?').run(mappingId);
  invalidateIdentityResolutionCache();
  return { success: res.changes > 0, id: mappingId };
}

/**
 * Retrieve identity mappings queue with summary counts
 */
export function getIdentityMappingsQueue(filter = 'ALL') {
  try {
    let query = `
      SELECT m.*, e.name as master_emp_name, e.department as master_department, e.active as master_active
      FROM vendoor_identity_mappings m
      LEFT JOIN employees e ON e.id = m.employee_id
    `;
    const params = [];

    if (filter === 'UNMATCHED') {
      query += ` WHERE m.status IN ('UNMATCHED', 'NEEDS_REVIEW') `;
    } else if (filter === 'MAPPED') {
      query += ` WHERE m.status IN ('MAPPED', 'EXACT_MATCH', 'ALIAS_MATCH') `;
    }

    query += ` ORDER BY m.last_seen DESC, m.vendoor_name ASC `;

    const rows = db.prepare(query).all(...params);

    // Compute activity count for each identity from raw_log_records
    const statsQuery = db.prepare(`
      SELECT employee_name, COUNT(*) as action_count, COUNT(DISTINCT order_code) as order_count
      FROM raw_log_records
      GROUP BY employee_name
    `).all();
    const statsMap = new Map();
    for (const s of statsQuery) {
      statsMap.set(normalizeEmployeeName(s.employee_name), s);
    }

    // Filter out rows that belong to Merchants, Marketers, Non-CS employees, or Vendoor system actors
    const csRows = rows.filter(r => {
      if (r.status === 'NON_CS_ACTOR' || r.status === 'IGNORED') return false;
      if (isNonCsActor(r.vendoor_name, r.normalized_name)) return false;
      return true;
    });

    const items = csRows.map(r => {
      const stats = statsMap.get(normalizeEmployeeName(r.vendoor_name)) || { action_count: 0, order_count: 0 };
      return {
        id: r.id,
        vendoor_name: r.vendoor_name,
        normalized_name: r.normalized_name,
        status: r.status,
        match_method: r.match_method,
        confidence: r.confidence,
        employee_id: r.employee_id,
        master_employee_name: r.master_emp_name || null,
        master_department: r.master_department || null,
        action_count: stats.action_count,
        order_count: stats.order_count,
        first_seen: r.first_seen,
        last_seen: r.last_seen,
        notes: r.notes
      };
    });

    const summary = {
      total: items.length,
      matched: items.filter(i => i.status === 'MAPPED' || i.status === 'EXACT_MATCH' || i.status === 'ALIAS_MATCH').length,
      unmatched: items.filter(i => i.status === 'UNMATCHED').length,
      needs_review: items.filter(i => i.status === 'NEEDS_REVIEW').length
    };

    return { success: true, summary, items };
  } catch (err) {
    return { success: false, error: err.message, summary: { total: 0, matched: 0, unmatched: 0, needs_review: 0 }, items: [] };
  }
}
