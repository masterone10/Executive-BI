/**
 * CS Executive BI — Enterprise Edition
 * Central Business Configurations & Operational Thresholds
 * 
 * Formalizes all operational thresholds, replacing hardcoded numbers
 * with named, documented, and configurable parameters.
 */

import { db } from '../db/index.js';

export const DEFAULT_CONFIGS = Object.freeze({
  // Hours threshold before an unworked NEW order is deemed Delayed / Overdue
  DELAYED_NEW_THRESHOLD_HOURS: 5,
  // Threshold above which single-employee NEW buffer policy expands across CS capacity
  NEW_EXPANSION_THRESHOLD: 100,
  // 2-minute deduplication window for high-frequency actions
  ACTION_DEDUPLICATION_WINDOW_MS: 120000,
  // Standard default daily maximum capacity per CS employee
  STANDARD_EMPLOYEE_CAPACITY: 40,
  // Directional pressure ratio trigger (e.g. 2.0x PENDING vs NEW)
  PRESSURE_RATIO_TRIGGER: 2.0,
  // Poller master switch default
  VENDOOR_POLLER_ENABLED: false
});

/**
 * Retrieve a named configuration parameter from system_configs with fallback
 */
export function getSystemConfigValue(key, fallback = null) {
  try {
    const row = db.prepare('SELECT value FROM system_configs WHERE key = ?').get(key);
    if (row && row.value !== undefined && row.value !== null) {
      const num = Number(row.value);
      if (!isNaN(num) && typeof fallback === 'number') return num;
      if (row.value === 'true' || row.value === '1') return true;
      if (row.value === 'false' || row.value === '0') return false;
      return row.value;
    }
  } catch (_) {}
  return fallback !== null ? fallback : DEFAULT_CONFIGS[key];
}

/**
 * Update or insert a named configuration parameter in system_configs
 */
export function setSystemConfigValue(key, value) {
  const strVal = String(value);
  db.prepare(`
    INSERT INTO system_configs (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, strVal);
  return { key, value: strVal };
}

export function getDelayedNewThresholdHours() {
  return getSystemConfigValue('DELAYED_NEW_THRESHOLD_HOURS', DEFAULT_CONFIGS.DELAYED_NEW_THRESHOLD_HOURS);
}

export function getNewExpansionThreshold() {
  return getSystemConfigValue('NEW_EXPANSION_THRESHOLD', DEFAULT_CONFIGS.NEW_EXPANSION_THRESHOLD);
}

export function getActionDeduplicationWindowMs() {
  return getSystemConfigValue('ACTION_DEDUPLICATION_WINDOW_MS', DEFAULT_CONFIGS.ACTION_DEDUPLICATION_WINDOW_MS);
}

export function getStandardEmployeeCapacity() {
  return getSystemConfigValue('STANDARD_EMPLOYEE_CAPACITY', DEFAULT_CONFIGS.STANDARD_EMPLOYEE_CAPACITY);
}

export function isMasterPollerEnabled() {
  const val = getSystemConfigValue('vendoor_poller_enabled', null);
  if (val !== null) return Boolean(val);
  return DEFAULT_CONFIGS.VENDOOR_POLLER_ENABLED;
}
