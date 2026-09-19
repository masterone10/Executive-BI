/**
 * Phase 3 Unallocated Orders Pool Extractor
 *
 * Responsibilities:
 * - Deterministically identify orders that are available for new refill assignment:
 *   1. Must belong to the specified operational workDate.
 *   2. Must NOT be currently assigned to an active employee in order_level_allocations (or assigned to 'UNASSIGNED').
 *   3. Must NOT be already completed in Vendoor logs.
 *   4. Must NOT be canceled, returned, or excluded.
 *   5. Groups orders by account to preserve Account-Centric allocation principles.
 */

import { db } from '../../db/index.js';
import { getCompletedOrdersForDate } from './completion.js';

/**
 * Retrieves the unallocated orders pool for a given operational date.
 *
 * @param {string} workDate - YYYY-MM-DD
 * @param {Object} [options]
 * @param {number|string} [options.limit=1000] - Max orders to return per query ('ALL' or number)
 * @param {string} [options.accountFilter] - Optional account filter
 * @returns {{
 *   total_unallocated_orders: number,
 *   unique_accounts_count: number,
 *   accounts_pool: Map<string, Array<Object>>,
 *   unallocated_orders: Array<Object>,
 *   summary: Object
 * }}
 */
export function getUnallocatedOrdersPool(workDate, options = {}) {
  if (!workDate) {
    throw new Error('workDate is required for getUnallocatedOrdersPool');
  }

  const rawLimit = options.limit;
  const isAll = rawLimit === 'ALL' || rawLimit === Infinity || rawLimit === 0;

  // 1. Fetch already completed orders for today
  const completionData = getCompletedOrdersForDate(workDate);
  const completedCodes = completionData.completed_order_codes;

  // 2. Fetch assigned order codes from order_level_allocations (latest version)
  const latestVersionRow = db.prepare(`
    SELECT MAX(allocation_version) as max_v
    FROM order_level_allocations
    WHERE allocation_date = ?
  `).get(workDate);

  const latestVersion = latestVersionRow ? (latestVersionRow.max_v || 1) : 1;

  const assignedRows = db.prepare(`
    SELECT order_code, employee_id, employee_name
    FROM order_level_allocations
    WHERE allocation_date = ? AND allocation_version = ?
  `).all(workDate, latestVersion);

  const assignedCodes = new Set();
  for (const r of assignedRows) {
    if (r.employee_name && r.employee_name !== 'UNASSIGNED' && r.employee_id) {
      assignedCodes.add(r.order_code);
    }
  }

  // 3. Query candidate orders from vendoor_orders AND current_work_orders
  // Workload rule: Only active New or Pending orders are unallocated candidates
  const vendoorCandidates = db.prepare(`
    SELECT 
      order_code, account, status, source_date as date, city, total_price
    FROM vendoor_orders
    WHERE (business_date = ? OR is_active = 1 OR source_date = ?)
      AND (status IS NULL OR LOWER(status) NOT IN ('cancelled', 'canceled', 'ملغي', 'الغاء', 'إلغاء', 'delivered', 'تم التسليم', 'shipped', 'completed', 'مكتمل', 'processing', 'قيد التجهيز'))
    ORDER BY id ASC
  `).all(workDate, workDate);

  const currentWorkCandidates = db.prepare(`
    SELECT 
      order_code, account, status, COALESCE(order_date, work_date) as date
    FROM current_work_orders
    WHERE work_date = ?
      AND (status IS NULL OR LOWER(status) NOT IN ('cancelled', 'canceled', 'ملغي', 'الغاء', 'إلغاء', 'delivered', 'تم التسليم', 'shipped', 'completed', 'مكتمل', 'processing', 'قيد التجهيز'))
    ORDER BY id ASC
  `).all(workDate);

  // Combine and deduplicate candidates by order_code
  const seenCodes = new Set();
  const poolList = [];
  const accountsMap = new Map(); // account -> Array<order>

  const evaluateCandidate = (ord) => {
    const code = String(ord.order_code || '').trim();
    if (!code) return;
    if (seenCodes.has(code)) return;
    seenCodes.add(code);

    // Rule 1: Must NOT be already assigned in allocation table
    if (assignedCodes.has(code)) return;

    // Rule 2: Must NOT be already completed in logs
    if (completedCodes.has(code)) return;

    // Rule 3: Account filter if provided
    const acc = ord.account || 'General Pool';
    if (options.accountFilter && acc !== options.accountFilter) return;

    const normalizedOrder = {
      order_code: code,
      account: acc,
      status: ord.status || 'New',
      date: ord.date || workDate,
      city: ord.city || '',
      total_price: parseFloat(ord.total_price) || 0
    };

    poolList.push(normalizedOrder);

    if (!accountsMap.has(acc)) {
      accountsMap.set(acc, []);
    }
    accountsMap.get(acc).push(normalizedOrder);
  };

  for (const o of vendoorCandidates) evaluateCandidate(o);
  for (const o of currentWorkCandidates) evaluateCandidate(o);

  const effectiveLimit = isAll ? poolList.length : Math.min(10000, Math.max(1, parseInt(rawLimit, 10) || 1000));
  const limitedPool = poolList.slice(0, effectiveLimit);

  return {
    success: true,
    total_unallocated_orders: poolList.length,
    returned_orders_count: limitedPool.length,
    unique_accounts_count: accountsMap.size,
    accounts_pool: accountsMap,
    unallocated_orders: limitedPool,
    summary: {
      work_date: workDate,
      candidates_evaluated: seenCodes.size,
      already_assigned_excluded: assignedCodes.size,
      already_completed_excluded: completedCodes.size,
      unallocated_available: poolList.length
    }
  };
}
