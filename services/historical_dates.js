/**
 * CS Executive BI — Canonical Historical Date Resolver & Reality Engine
 * 
 * Provides centralized historical date discovery, order resolution,
 * and data parity across all operations, allocations, tracking, and reports.
 */

import { db } from '../db/index.js';
import { getCairoBusinessDate } from './time_utils.js';

let cachedAvailableDates = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5000; // 5-second TTL cache

export function invalidateAvailableDatesCache() {
  cachedAvailableDates = null;
  cacheTimestamp = 0;
}

/**
 * Returns canonical list of all business dates containing operational data
 */
export function getAvailableBusinessDates(forceFresh = false) {
  const now = Date.now();
  if (!forceFresh && cachedAvailableDates && (now - cacheTimestamp < CACHE_TTL_MS)) {
    return cachedAvailableDates;
  }

  const today = getCairoBusinessDate();

  // 1. Efficient Union of all date sources across the system
  const dateRows = db.prepare(`
    WITH all_dates AS (
      SELECT work_date as d FROM current_work_orders WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT business_date as d FROM vendoor_orders WHERE business_date IS NOT NULL AND business_date != ''
      UNION
      SELECT source_date as d FROM vendoor_orders WHERE source_date IS NOT NULL AND source_date != ''
      UNION
      SELECT allocation_date as d FROM order_level_allocations WHERE allocation_date IS NOT NULL AND allocation_date != ''
      UNION
      SELECT work_date as d FROM daily_working_team WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT work_date as d FROM raw_log_records WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT work_date as d FROM vendoor_logs WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT work_date as d FROM order_tracking_events WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT work_date as d FROM daily_metrics_snapshots WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT date as d FROM performance_snapshots WHERE date IS NOT NULL AND date != ''
      UNION
      SELECT work_date as d FROM specific_orders_uploads WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT work_date as d FROM enterprise_allocation_runs WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT work_date as d FROM current_work_pool_summary WHERE work_date IS NOT NULL AND work_date != ''
      UNION
      SELECT ? as d
    )
    SELECT d as date FROM all_dates
    WHERE d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    ORDER BY d DESC
  `).all(today);

  // 2. Compute rich metadata flags per date
  const results = dateRows.map(row => {
    const d = row.date;
    const isToday = (d === today);

    // Orders count from current_work_orders
    const cwoCount = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'New' THEN 1 ELSE 0 END) as n,
        SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) as p
      FROM current_work_orders 
      WHERE work_date = ?
    `).get(d);

    let ordersCount = cwoCount?.total || 0;
    let newCount = cwoCount?.n || 0;
    let pendingCount = cwoCount?.p || 0;

    // Allocations count
    const allocCount = db.prepare(`
      SELECT 
        COUNT(*) as total_alloc,
        COUNT(DISTINCT employee_id) as emps
      FROM order_level_allocations 
      WHERE allocation_date = ? AND employee_name IS NOT NULL AND employee_name != 'UNASSIGNED'
    `).get(d);
    const allocatedCount = allocCount?.total_alloc || 0;

    // If no orders in current_work_orders, fallback to order_level_allocations or vendoor_orders
    if (ordersCount === 0) {
      const allocTotal = db.prepare(`
        SELECT 
          COUNT(DISTINCT order_code) as total,
          SUM(CASE WHEN LOWER(TRIM(status)) = 'new' THEN 1 ELSE 0 END) as n,
          SUM(CASE WHEN LOWER(TRIM(status)) = 'pending' THEN 1 ELSE 0 END) as p
        FROM order_level_allocations 
        WHERE allocation_date = ?
      `).get(d);

      if (allocTotal && allocTotal.total > 0) {
        ordersCount = allocTotal.total;
        newCount = allocTotal.n || 0;
        pendingCount = allocTotal.p || 0;
      } else {
        const voTotal = db.prepare(`
          SELECT 
            COUNT(DISTINCT order_code) as total,
            SUM(CASE WHEN LOWER(TRIM(COALESCE(active_status, status))) = 'new' THEN 1 ELSE 0 END) as n,
            SUM(CASE WHEN LOWER(TRIM(COALESCE(active_status, status))) = 'pending' THEN 1 ELSE 0 END) as p
          FROM vendoor_orders 
          WHERE (business_date = ? OR source_date = ?) AND is_active = 1
        `).get(d, d);

        if (voTotal && voTotal.total > 0) {
          ordersCount = voTotal.total;
          newCount = voTotal.n || 0;
          pendingCount = voTotal.p || 0;
        }
      }
    }

    // Working team count
    const teamRow = db.prepare('SELECT COUNT(*) as c FROM daily_working_team WHERE work_date = ? AND is_working = 1').get(d);
    const teamCount = teamRow?.c || 0;

    // Tracking count
    const rawLogsRow = db.prepare('SELECT COUNT(*) as c FROM raw_log_records WHERE work_date = ?').get(d);
    const vendoorLogsRow = db.prepare('SELECT COUNT(*) as c FROM vendoor_logs WHERE work_date = ?').get(d);
    const oteRow = db.prepare('SELECT COUNT(*) as c FROM order_tracking_events WHERE work_date = ?').get(d);
    const trackingCount = (rawLogsRow?.c || 0) + (vendoorLogsRow?.c || 0) + (oteRow?.c || 0);

    // Performance snapshots
    const dmsRow = db.prepare('SELECT COUNT(*) as c FROM daily_metrics_snapshots WHERE work_date = ?').get(d);
    const psRow = db.prepare('SELECT COUNT(*) as c FROM performance_snapshots WHERE date = ?').get(d);
    const hasPerformance = (dmsRow?.c || 0) > 0 || (psRow?.c || 0) > 0;

    return {
      date: d,
      is_today: isToday,
      has_orders: ordersCount > 0,
      has_allocation: allocatedCount > 0,
      has_working_team: teamCount > 0,
      has_tracking: trackingCount > 0,
      has_performance: hasPerformance,
      orders_count: ordersCount,
      new_count: newCount,
      pending_count: pendingCount,
      allocated_count: allocatedCount,
      working_team_count: teamCount,
      tracking_events_count: trackingCount
    };
  });

  const payload = {
    success: true,
    today,
    count: results.length,
    dates: results
  };

  cachedAvailableDates = payload;
  cacheTimestamp = now;
  return payload;
}

/**
 * Resolves full historical reality for a given workDate without mutating database
 */
export function getHistoricalDayOverview(workDate) {
  const cleanDate = String(workDate || '').trim();
  if (!cleanDate || !/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
    throw new Error(`Invalid workDate: ${workDate}. Expected format YYYY-MM-DD`);
  }

  // 1. Orders resolution
  let ordersSummary = db.prepare(`
    SELECT 
      COUNT(*) as total_orders,
      COUNT(DISTINCT account) as accounts_count,
      SUM(CASE WHEN status = 'New' THEN 1 ELSE 0 END) as new_count,
      SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) as pending_count
    FROM current_work_orders
    WHERE work_date = ?
  `).get(cleanDate);

  let source = 'current_work_orders';

  if (!ordersSummary || ordersSummary.total_orders === 0) {
    // Check order_level_allocations
    const allocSummary = db.prepare(`
      SELECT 
        COUNT(DISTINCT order_code) as total_orders,
        COUNT(DISTINCT account) as accounts_count,
        SUM(CASE WHEN LOWER(TRIM(status)) = 'new' THEN 1 ELSE 0 END) as new_count,
        SUM(CASE WHEN LOWER(TRIM(status)) = 'pending' THEN 1 ELSE 0 END) as pending_count
      FROM order_level_allocations
      WHERE allocation_date = ?
    `).get(cleanDate);

    if (allocSummary && allocSummary.total_orders > 0) {
      ordersSummary = allocSummary;
      source = 'order_level_allocations';
    } else {
      // Check vendoor_orders
      const voSummary = db.prepare(`
        SELECT 
          COUNT(DISTINCT order_code) as total_orders,
          COUNT(DISTINCT account) as accounts_count,
          SUM(CASE WHEN LOWER(TRIM(COALESCE(active_status, status))) = 'new' THEN 1 ELSE 0 END) as new_count,
          SUM(CASE WHEN LOWER(TRIM(COALESCE(active_status, status))) = 'pending' THEN 1 ELSE 0 END) as pending_count
        FROM vendoor_orders
        WHERE (business_date = ? OR source_date = ?) AND is_active = 1
      `).get(cleanDate, cleanDate);

      if (voSummary && voSummary.total_orders > 0) {
        ordersSummary = voSummary;
        source = 'vendoor_orders';
      }
    }
  }

  // 2. Working team resolution
  const teamRow = db.prepare(`
    SELECT 
      COUNT(*) as team_count,
      source
    FROM daily_working_team
    WHERE work_date = ? AND is_working = 1
    GROUP BY source
    ORDER BY CASE WHEN source = 'MANUAL' THEN 1 ELSE 2 END ASC
    LIMIT 1
  `).get(cleanDate);

  const teamCount = teamRow ? teamRow.team_count : 0;
  const teamSource = teamRow ? (teamRow.source || 'MANUAL') : 'MANUAL';

  // 3. Allocations resolution
  const allocRow = db.prepare(`
    SELECT COUNT(*) as allocated_count
    FROM order_level_allocations
    WHERE allocation_date = ? AND employee_name IS NOT NULL AND employee_name != 'UNASSIGNED'
  `).get(cleanDate);
  const allocatedCount = allocRow ? allocRow.allocated_count : 0;

  // 4. Completed orders resolution
  const compRow = db.prepare(`
    SELECT COUNT(DISTINCT order_code) as completed_count
    FROM (
      SELECT order_code FROM raw_log_records WHERE work_date = ? AND UPPER(action) IN ('PRINTED', 'STATUS_CHANGE', 'PROCESSING', 'DELIVERED', 'COMPLETED', 'SEALED', 'DISPATCHED')
      UNION
      SELECT order_code FROM vendoor_logs WHERE work_date = ? AND UPPER(action) IN ('PRINTED', 'STATUS_CHANGE', 'PROCESSING', 'DELIVERED', 'COMPLETED', 'SEALED', 'DISPATCHED')
      UNION
      SELECT order_code FROM order_tracking_events WHERE work_date = ? AND UPPER(action) IN ('PRINTED', 'STATUS_CHANGE', 'PROCESSING', 'DELIVERED', 'COMPLETED', 'SEALED', 'DISPATCHED')
    )
  `).get(cleanDate, cleanDate, cleanDate);
  const completedCount = compRow ? compRow.completed_count : 0;

  const totalOrders = ordersSummary ? (ordersSummary.total_orders || 0) : 0;
  const unallocatedCount = Math.max(0, totalOrders - allocatedCount);

  return {
    work_date: cleanDate,
    source,
    total_orders: totalOrders,
    accounts_count: ordersSummary ? (ordersSummary.accounts_count || 0) : 0,
    new_count: ordersSummary ? (ordersSummary.new_count || 0) : 0,
    pending_count: ordersSummary ? (ordersSummary.pending_count || 0) : 0,
    working_team_count: teamCount,
    working_team_source: teamSource,
    allocated_count: allocatedCount,
    unallocated_count: unallocatedCount,
    completed_count: completedCount
  };
}

/**
 * Resolves order list for a historical date using canonical fallback order:
 * 1. current_work_orders (if present)
 * 2. order_level_allocations (if present)
 * 3. vendoor_orders (if present)
 */
export function getHistoricalOrdersList(workDate, options = {}) {
  const cleanDate = String(workDate || '').trim();
  const { account, status, search, limit = 100, offset = 0 } = options;

  // 1. Try current_work_orders first
  const cwoCheck = db.prepare('SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ?').get(cleanDate);
  if (cwoCheck && cwoCheck.c > 0) {
    let sql = 'SELECT id, order_code, account, status, order_date, source_file_slot, work_state, assigned_employee_id, assigned_employee_name, tracking_id FROM current_work_orders WHERE work_date = ?';
    const params = [cleanDate];

    if (account) { sql += ' AND account = ?'; params.push(account); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (search) { sql += ' AND (order_code LIKE ? OR account LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

    const countSql = sql.replace('SELECT id, order_code, account, status, order_date, source_file_slot, work_state, assigned_employee_id, assigned_employee_name, tracking_id', 'SELECT COUNT(*) as total');
    const total = db.prepare(countSql).get(...params).total;

    sql += ' ORDER BY account ASC, order_code ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return {
      work_date: cleanDate,
      source: 'current_work_orders',
      total,
      limit,
      offset,
      orders: db.prepare(sql).all(...params)
    };
  }

  // 2. Fallback to order_level_allocations
  const allocCheck = db.prepare('SELECT COUNT(*) as c FROM order_level_allocations WHERE allocation_date = ?').get(cleanDate);
  if (allocCheck && allocCheck.c > 0) {
    let sql = 'SELECT id, order_code, account, status, allocation_date as order_date, 1 as source_file_slot, work_state, employee_id as assigned_employee_id, employee_name as assigned_employee_name, tracking_id FROM order_level_allocations WHERE allocation_date = ?';
    const params = [cleanDate];

    if (account) { sql += ' AND account = ?'; params.push(account); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (search) { sql += ' AND (order_code LIKE ? OR account LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

    const countSql = sql.replace('SELECT id, order_code, account, status, allocation_date as order_date, 1 as source_file_slot, work_state, employee_id as assigned_employee_id, employee_name as assigned_employee_name, tracking_id', 'SELECT COUNT(*) as total');
    const total = db.prepare(countSql).get(...params).total;

    sql += ' ORDER BY account ASC, order_code ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return {
      work_date: cleanDate,
      source: 'order_level_allocations',
      total,
      limit,
      offset,
      orders: db.prepare(sql).all(...params)
    };
  }

  // 3. Fallback to vendoor_orders
  const voCheck = db.prepare('SELECT COUNT(*) as c FROM vendoor_orders WHERE (business_date = ? OR source_date = ?) AND is_active = 1').get(cleanDate, cleanDate);
  if (voCheck && voCheck.c > 0) {
    let sql = 'SELECT id, order_code, account, COALESCE(active_status, status) as status, COALESCE(source_date, business_date) as order_date, 1 as source_file_slot, "UNASSIGNED" as work_state, null as assigned_employee_id, "UNASSIGNED" as assigned_employee_name, order_code as tracking_id FROM vendoor_orders WHERE (business_date = ? OR source_date = ?) AND is_active = 1';
    const params = [cleanDate, cleanDate];

    if (account) { sql += ' AND account = ?'; params.push(account); }
    if (status) { sql += ' AND (status = ? OR active_status = ?)'; params.push(status, status); }
    if (search) { sql += ' AND (order_code LIKE ? OR account LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

    const countSql = sql.replace('SELECT id, order_code, account, COALESCE(active_status, status) as status, COALESCE(source_date, business_date) as order_date, 1 as source_file_slot, "UNASSIGNED" as work_state, null as assigned_employee_id, "UNASSIGNED" as assigned_employee_name, order_code as tracking_id', 'SELECT COUNT(*) as total');
    const total = db.prepare(countSql).get(...params).total;

    sql += ' ORDER BY account ASC, order_code ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return {
      work_date: cleanDate,
      source: 'vendoor_orders',
      total,
      limit,
      offset,
      orders: db.prepare(sql).all(...params)
    };
  }

  return {
    work_date: cleanDate,
    source: 'empty',
    total: 0,
    limit,
    offset,
    orders: []
  };
}
