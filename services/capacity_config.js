/**
 * services/capacity_config.js
 * Capacity Model & Employee-Specific Controlled Overflow Engine
 * Standard Capacity = 40 (Target load)
 * Controlled Overflow = Eligible for verified high-efficiency and sustainable-capacity CS agents
 * Absolute Safety Ceiling = Hard limit
 */

import db from '../db/index.js';

export const DEFAULT_STANDARD_CAPACITY = 40;
export const DEFAULT_MAX_OVERFLOW = 10;
export const DEFAULT_ABSOLUTE_CEILING = 80;

/**
 * Reads capacity settings from database system_configs, merged with runtime options
 */
export function getCapacityConfig(options = {}) {
  let cfgStd = DEFAULT_STANDARD_CAPACITY;
  let cfgOverflow = DEFAULT_MAX_OVERFLOW;
  let cfgCeiling = DEFAULT_ABSOLUTE_CEILING;

  try {
    const rStd = db.prepare("SELECT value FROM system_configs WHERE key = 'standard_capacity_per_employee'").get();
    if (rStd && !isNaN(parseInt(rStd.value, 10))) cfgStd = parseInt(rStd.value, 10);
    const rOvr = db.prepare("SELECT value FROM system_configs WHERE key = 'max_overflow_orders_per_employee'").get();
    if (rOvr && !isNaN(parseInt(rOvr.value, 10))) cfgOverflow = parseInt(rOvr.value, 10);
    const rAbs = db.prepare("SELECT value FROM system_configs WHERE key = 'absolute_max_orders_per_employee'").get();
    if (rAbs && !isNaN(parseInt(rAbs.value, 10))) cfgCeiling = parseInt(rAbs.value, 10);
  } catch (_) {}

  const standard_capacity = Number(
    options.standard_capacity_per_employee ??
    options.standard_capacity ??
    options.max_capacity_per_employee ??
    options.max_capacity ??
    cfgStd
  );

  const max_overflow = Number(
    options.max_overflow_orders_per_employee ??
    options.max_overflow ??
    cfgOverflow
  );

  const absolute_ceiling = Number(
    options.absolute_max_orders_per_employee ??
    options.absolute_ceiling ??
    cfgCeiling
  );

  const allow_overflow = options.allow_overflow !== false && max_overflow > 0;

  return {
    standard_capacity,
    max_overflow,
    absolute_ceiling,
    allow_overflow
  };
}

/**
 * Evaluates an employee's qualification for controlled overflow based on verified historical evidence
 * Requires BOTH:
 * 1. High Efficiency (Grade A/B, or recent score >= 75)
 * 2. Verified Sustainable Capacity (Proven average throughput >= 35 or single day >= 40)
 */
export function evaluateEmployeeQualification(employeeId, employeeName, workDate, options = {}) {
  // Allow explicit test / options overrides
  if (options.employee_overflow_eligibility && options.employee_overflow_eligibility[employeeId] !== undefined) {
    const elig = options.employee_overflow_eligibility[employeeId];
    return {
      is_high_efficiency: Boolean(elig.is_high_efficiency),
      has_sustainable_capacity: Boolean(elig.has_sustainable_capacity),
      historical_score: elig.score ?? (elig.is_high_efficiency ? 85 : 50),
      avg_actions: elig.avg_actions ?? (elig.has_sustainable_capacity ? 40 : 20),
      reason: elig.reason || 'Configured via operational override'
    };
  }

  let isHighEfficiency = false;
  let hasSustainableCapacity = false;
  let avgHistoricalActions = 0;
  let historicalScore = 0;
  let latestGrade = '';

  try {
    const snapRows = db.prepare(`
      SELECT performance_score, efficiency_score, grade, real_actions, printed_orders, pending_backlog
      FROM performance_snapshots
      WHERE (employee_id = ? OR employee_name = ?) AND date <= ?
      ORDER BY date DESC LIMIT 5
    `).all(employeeId, employeeName, workDate);

    if (snapRows.length > 0) {
      const totalActions = snapRows.reduce((s, r) => s + (r.real_actions || 0), 0);
      avgHistoricalActions = totalActions / snapRows.length;
      const totalScore = snapRows.reduce((s, r) => s + (r.performance_score || r.efficiency_score || 0), 0);
      historicalScore = totalScore / snapRows.length;
      latestGrade = snapRows[0].grade || '';

      isHighEfficiency = latestGrade === 'A' || latestGrade === 'B' || historicalScore >= 75 || (snapRows[0].efficiency_score || 0) >= 75;
      hasSustainableCapacity = avgHistoricalActions >= 35 || snapRows.some(r => (r.real_actions || 0) >= DEFAULT_STANDARD_CAPACITY);
    }
  } catch (_) {}

  return {
    is_high_efficiency: isHighEfficiency,
    has_sustainable_capacity: hasSustainableCapacity,
    historical_score: historicalScore,
    avg_actions: avgHistoricalActions,
    latest_grade: latestGrade,
    reason: isHighEfficiency && hasSustainableCapacity
      ? `Qualified: Grade ${latestGrade || 'N/A'}, Score ${Math.round(historicalScore)}, Avg Actions ${Math.round(avgHistoricalActions)}`
      : `Standard: HighEff=${isHighEfficiency}, SustCap=${hasSustainableCapacity}`
  };
}

/**
 * Returns employee-specific effective maximum capacity
 * Normal employee -> standard_capacity (40)
 * Qualified employee -> min(absolute_ceiling, standard_capacity + max_overflow)
 */
export function getEmployeeEffectiveCapacity(employeeId, employeeName, workDate, config, options = {}) {
  const qual = evaluateEmployeeQualification(employeeId, employeeName, workDate, options);
  const canOverflow = config.allow_overflow && qual.is_high_efficiency && qual.has_sustainable_capacity;
  const effectiveMax = canOverflow
    ? Math.min(config.absolute_ceiling, config.standard_capacity + config.max_overflow)
    : config.standard_capacity;

  return {
    standard_capacity: config.standard_capacity,
    max_overflow: config.max_overflow,
    absolute_ceiling: config.absolute_ceiling,
    is_high_efficiency: qual.is_high_efficiency,
    has_sustainable_capacity: qual.has_sustainable_capacity,
    can_overflow: canOverflow,
    effective_max: effectiveMax,
    historical_score: qual.historical_score,
    avg_actions: qual.avg_actions,
    reason: qual.reason
  };
}
