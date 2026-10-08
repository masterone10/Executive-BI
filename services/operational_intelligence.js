/**
 * CS EXECUTIVE BI — OPERATIONAL INTELLIGENCE & LOCKED BUSINESS RULES ENGINE
 *
 * Implements 3 Locked Master Requirements:
 * 1. ACTIONED ORDER WITHOUT A REAL SECOND PHONE (DISTINCT SECOND PHONE ADDITION)
 *    - Normalized phone comparison
 *    - Classifications: ALT_PHONE_ADDED, ALT_PHONE_MISSING, ALT_PHONE_DUPLICATE_PRIMARY
 *    - Attention Required on: ALT_PHONE_MISSING & ALT_PHONE_DUPLICATE_PRIMARY
 *    - Employee Metrics: Eligible Orders, Real Second Phones Added, Missing, Same as Primary, Distinct Rate
 *
 * 2. ADDRESS QUALITY
 *    - Arabic language only (no English, no mixed)
 *    - >= 4 words = VALID
 *    - <= 3 words = INVALID / WARNING (weak)
 *    - English or Mixed = INVALID / WARNING
 *    - Empty = INVALID
 *    - Word normalization: trim, collapse spaces, ignore meaningless punctuation, real words only
 *
 * 3. DELIVERY RATE BELOW 70%
 *    - Delivery rate < 70% = DELIVERY_RATE_LOW (Alert ⚠)
 *    - Delivery rate >= 70% = DELIVERY_RATE_OK
 *    - Missing data = DELIVERY_RATE_UNKNOWN (UNKNOWN != 0%, no false alerts)
 *
 * All metrics are strictly Date-Aware and Role-Aware.
 */

import { db } from '../db/index.js';
import { getCairoBusinessDate } from './time_utils.js';

/**
 * Normalizes a phone number strictly:
 * - Eastern Arabic / Persian digits to Latin digits
 * - Strips all non-digit characters (spaces, hyphens, parentheses, pluses, dots)
 * - Normalizes Egyptian domestic prefixes (0020, 20, 01...)
 */
export function normalizePhoneNumber(rawPhone) {
  if (rawPhone === null || rawPhone === undefined) return '';
  let str = String(rawPhone).trim();
  if (!str) return '';

  const easternDigits = '٠١٢٣٤٥٦٧٨٩';
  const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
  str = str.replace(/[٠-٩]/g, d => String(easternDigits.indexOf(d)))
           .replace(/[۰-۹]/g, d => String(persianDigits.indexOf(d)));

  let digits = str.replace(/\D/g, '');
  if (!digits) return '';

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
 * FEATURE 1: Evaluates Second Phone Quality on an order.
 *
 * @param {string} primaryPhone Raw primary phone
 * @param {string} secondPhone Raw second/alternate phone
 * @param {boolean} isActioned Whether the order has been actioned by CS
 * @returns {Object} Evaluation result
 */
export function evaluateSecondPhoneQuality(primaryPhone, secondPhone, isActioned = false) {
  const norm1 = normalizePhoneNumber(primaryPhone);
  const norm2 = normalizePhoneNumber(secondPhone);

  const hasPrimary = Boolean(norm1);
  const hasSecond = Boolean(norm2);

  if (!hasSecond) {
    return {
      status: 'ALT_PHONE_MISSING',
      is_distinct: false,
      needs_attention: isActioned,
      primary_raw: primaryPhone || '',
      second_raw: secondPhone || '',
      primary_normalized: norm1,
      second_normalized: '',
      reason: 'لم يتم إضافة رقم هاتف ثانٍ',
      code: 'MISSING'
    };
  }

  if (hasPrimary && norm1 === norm2) {
    return {
      status: 'ALT_PHONE_DUPLICATE_PRIMARY',
      is_distinct: false,
      needs_attention: isActioned,
      primary_raw: primaryPhone || '',
      second_raw: secondPhone || '',
      primary_normalized: norm1,
      second_normalized: norm2,
      reason: 'الرقم الثاني مكرر لنفس الرقم الأساسي',
      code: 'SAME_AS_PRIMARY'
    };
  }

  return {
    status: 'ALT_PHONE_ADDED',
    is_distinct: true,
    needs_attention: false,
    primary_raw: primaryPhone || '',
    second_raw: secondPhone || '',
    primary_normalized: norm1,
    second_normalized: norm2,
    reason: 'تم إضافة رقم ثانٍ مختلف وصالح',
    code: 'DISTINCT_ADDED'
  };
}

/**
 * FEATURE 2: Evaluates Address Quality strictly according to business requirements:
 * - Must be Arabic only (no English, no mixed)
 * - Must have more than 3 words (4 or more words)
 * - Empty is INVALID
 * - Normalization: trim, collapse repeated spaces, ignore meaningless punctuation
 *
 * @param {string} rawAddress Raw address string
 * @returns {Object} Evaluation result
 */
export function evaluateAddressQuality(rawAddress) {
  if (rawAddress === null || rawAddress === undefined || typeof rawAddress !== 'string' || !rawAddress.trim()) {
    return {
      status: 'INVALID',
      is_valid: false,
      word_count: 0,
      language: 'EMPTY',
      reason: 'العنوان فارغ وغير مسجل',
      code: 'EMPTY'
    };
  }

  // Normalization: trim and collapse repeated spaces
  const trimmed = rawAddress.trim();
  
  // Clean meaningless punctuation, symbols, and Arabic punctuation (comma, semicolon, etc.) into space
  const cleaned = trimmed.replace(/[\.,\/#!$%\^&\*;:{}=\-_`~()?"'«»[\]\\<>\u060C\u061B\u061F\u06D4]/g, ' ')
                         .replace(/\s+/g, ' ')
                         .trim();

  if (!cleaned) {
    return {
      status: 'INVALID',
      is_valid: false,
      word_count: 0,
      language: 'EMPTY',
      reason: 'العنوان يحتوي على رموز فقط بدون كلمات حقيقية',
      code: 'SYMBOLS_ONLY'
    };
  }

  // Language Detection
  const hasEnglish = /[a-zA-Z]/.test(cleaned);
  const hasArabic = /[\u0600-\u06FF]/.test(cleaned);

  if (hasEnglish && !hasArabic) {
    return {
      status: 'INVALID',
      is_valid: false,
      word_count: 0,
      language: 'ENGLISH',
      reason: 'العنوان غير صالح: مكتوب باللغة الإنجليزية والمطلوب بالعربية',
      code: 'ENGLISH_ONLY'
    };
  }

  if (hasEnglish && hasArabic) {
    return {
      status: 'INVALID',
      is_valid: false,
      word_count: 0,
      language: 'MIXED',
      reason: 'العنوان غير صالح: يحتوي على كلمات إنجليزية والمطلوب بالعربية فقط',
      code: 'MIXED_LANGUAGE'
    };
  }

  if (!hasArabic) {
    return {
      status: 'INVALID',
      is_valid: false,
      word_count: 0,
      language: 'NON_ARABIC',
      reason: 'العنوان غير صالح: لا يحتوي على نصوص عربية',
      code: 'NON_ARABIC'
    };
  }

  // Word count on valid Arabic words
  const words = cleaned.split(' ').filter(w => /[\u0600-\u06FF0-9]/.test(w));
  const wordCount = words.length;

  if (wordCount <= 3) {
    return {
      status: 'INVALID',
      is_valid: false,
      word_count: wordCount,
      language: 'ARABIC',
      reason: `العنوان ضعيف: يحتوي على ${wordCount} كلمات فقط (المطلوب 4 كلمات على الأقل)`,
      code: 'WEAK_WORD_COUNT'
    };
  }

  return {
    status: 'VALID',
    is_valid: true,
    word_count: wordCount,
    language: 'ARABIC',
    reason: `العنوان صالح ومكتمل (${wordCount} كلمات عربية)`,
    code: 'VALID'
  };
}

/**
 * FEATURE 3: Evaluates Delivery Rate.
 * - < 70% = DELIVERY_RATE_LOW (needs attention)
 * - >= 70% = DELIVERY_RATE_OK
 * - missing/null/NaN = DELIVERY_RATE_UNKNOWN (UNKNOWN != 0%, no false alarm)
 *
 * @param {number|string|null} rateValue Percentage number (e.g. 65 or '65%')
 * @returns {Object} Evaluation result
 */
export function evaluateDeliveryRate(rateValue) {
  if (rateValue === null || rateValue === undefined || rateValue === '') {
    return {
      status: 'DELIVERY_RATE_UNKNOWN',
      needs_attention: false,
      rate: null,
      alert: null,
      code: 'UNKNOWN'
    };
  }

  let cleanStr = String(rateValue).replace('%', '').trim();
  const num = Number(cleanStr);

  if (isNaN(num)) {
    return {
      status: 'DELIVERY_RATE_UNKNOWN',
      needs_attention: false,
      rate: null,
      alert: null,
      code: 'UNKNOWN'
    };
  }

  if (num < 70) {
    return {
      status: 'DELIVERY_RATE_LOW',
      needs_attention: true,
      rate: num,
      alert: `نسبة التسليم منخفضة: ${num.toFixed(1)}% (أقل من 70%)`,
      code: 'LOW'
    };
  }

  return {
    status: 'DELIVERY_RATE_OK',
    needs_attention: false,
    rate: num,
    alert: null,
    code: 'OK'
  };
}

/**
 * Helper to determine if an order has been actioned by CS.
 */
export function isOrderActionedByCS(order) {
  if (!order) return false;

  if (order.is_actioned !== undefined) return Boolean(order.is_actioned);

  // Status indicators of work done
  const st = String(order.status || '').toLowerCase();
  const isCompletedOrPrinted = st.includes('printed') || st.includes('طبع') || st.includes('completed') || st.includes('تم') || st.includes('delivered') || st.includes('shipped') || st.includes('pending') || st.includes('processing') || st.includes('cancel');
  
  // Work state
  const ws = String(order.work_state || '').toUpperCase();
  const isWorked = ws === 'IN_PROGRESS' || ws === 'PRINTED' || ws === 'COMPLETED' || ws === 'CONFIRMED';

  // Assignment & actions
  const hasAssignee = Boolean(order.assigned_employee_name || order.assigned_employee_id);
  const actionCount = Number(order.action_count || order.cs_actions_count || 0);

  if (isCompletedOrPrinted || isWorked || (hasAssignee && actionCount > 0)) {
    return true;
  }

  // Check raw_log_records if order has recorded CS action
  if (order.order_code) {
    try {
      const logAction = db.prepare('SELECT 1 FROM raw_log_records WHERE order_code = ? AND is_cs = 1 LIMIT 1').get(order.order_code);
      if (logAction) return true;
    } catch (_) {}
  }

  return false;
}

/**
 * Enriches a single order with all 3 Operational Intelligence evaluations.
 *
 * @param {Object} order Raw order object from database or Vendoor
 * @returns {Object} Order enriched with intelligence flags and attention details
 */
export function enrichOrderOperationalIntelligence(order) {
  if (!order) return null;

  let merged = { ...order };
  if ((!order.phone && !order.customer_name) && order.order_code) {
    try {
      const vo = db.prepare('SELECT * FROM vendoor_orders WHERE order_code = ?').get(order.order_code);
      if (vo) {
        let payload = {};
        if (vo.raw_payload_json) {
          try { payload = JSON.parse(vo.raw_payload_json); } catch (_) {}
        }
        merged = { ...payload, ...vo, ...order };
      }
    } catch (_) {}
  }

  const isActioned = isOrderActionedByCS(merged);
  
  // Secondary phone
  const primaryPhone = merged.phone || merged.phone_a || merged.primary_phone || '';
  const secondPhone = merged.phone2 || merged.alt_phone || merged.phone_b || merged.additional_phone || '';
  const phoneEval = evaluateSecondPhoneQuality(primaryPhone, secondPhone, isActioned);

  // Address
  const rawAddress = merged.address || merged.customer_address || merged.shipping_address || '';
  const addressEval = evaluateAddressQuality(rawAddress);

  // Delivery rate
  const rawDeliveryRate = merged.delivery_rate !== undefined ? merged.delivery_rate : (merged.customer_delivery_rate ?? merged.merchant_delivery_rate ?? null);
  const deliveryEval = evaluateDeliveryRate(rawDeliveryRate);

  // Consolidate Alerts
  const alerts = [];
  if (phoneEval.needs_attention) {
    alerts.push({
      type: 'SECOND_PHONE_ISSUE',
      severity: 'WARNING',
      title: phoneEval.status === 'ALT_PHONE_MISSING' ? 'لم يتم إضافة رقم ثانٍ' : 'الرقم الثاني مكرر للأساسي',
      reason: phoneEval.reason
    });
  }

  if (isActioned && !addressEval.is_valid) {
    alerts.push({
      type: 'ADDRESS_ISSUE',
      severity: addressEval.code === 'WEAK_WORD_COUNT' ? 'WARNING' : 'DANGER',
      title: addressEval.code === 'WEAK_WORD_COUNT' ? 'العنوان ضعيف' : 'العنوان غير صالح',
      reason: addressEval.reason
    });
  }

  if (deliveryEval.needs_attention) {
    alerts.push({
      type: 'DELIVERY_RATE_LOW',
      severity: 'WARNING',
      title: 'نسبة التسليم منخفضة',
      reason: deliveryEval.alert
    });
  }

  const needsAttention = alerts.length > 0;

  return {
    ...merged,
    is_actioned: isActioned,
    phone_quality: phoneEval,
    address_quality: addressEval,
    delivery_quality: deliveryEval,
    operational_alerts: alerts,
    needs_attention: needsAttention
  };
}

/**
 * Aggregates Operational Exceptions for a specific business date:
 * Returns counts and preview lists for:
 * 1. Actioned without real second phone
 * 2. Weak / invalid address
 * 3. Delivery rate < 70%
 *
 * @param {string} workDate Business date (YYYY-MM-DD)
 * @param {Object} options Filter options (role, employee_name, account, etc.)
 * @returns {Object} Operational exceptions summary
 */
export function getOperationalExceptions(workDate = getCairoBusinessDate(), options = {}) {
  const isToday = (workDate === getCairoBusinessDate());

  let rawOrders = [];
  try {
    if (isToday) {
      // Query current live operational pool
      let sql = 'SELECT * FROM current_work_orders WHERE work_date = ?';
      const params = [workDate];

      if (options.employee_name) {
        sql += ' AND assigned_employee_name = ?';
        params.push(options.employee_name);
      }
      if (options.account) {
        sql += ' AND account = ?';
        params.push(options.account);
      }
      rawOrders = db.prepare(sql).all(...params);
    } else {
      // Query historical raw logs
      let sql = 'SELECT * FROM raw_log_records WHERE work_date = ?';
      const params = [workDate];
      if (options.employee_name) {
        sql += ' AND employee_name = ?';
        params.push(options.employee_name);
      }
      rawOrders = db.prepare(sql).all(...params);
    }
  } catch (err) {
    console.error(`Error loading orders for exceptions on ${workDate}:`, err);
    rawOrders = [];
  }

  // Enrich each order
  const enriched = rawOrders.map(enrichOrderOperationalIntelligence);

  // Group by exception category
  const missingSecondPhoneOrders = enriched.filter(o => o.phone_quality.needs_attention);
  const invalidAddressOrders = enriched.filter(o => o.is_actioned && !o.address_quality.is_valid);
  const lowDeliveryRateOrders = enriched.filter(o => o.delivery_quality.needs_attention);

  // Distinct attention orders
  const attentionOrders = enriched.filter(o => o.needs_attention);

  return {
    work_date: workDate,
    is_live: isToday,
    total_orders: enriched.length,
    attention_required_total: attentionOrders.length,
    summary: {
      actioned_without_real_second_phone: {
        count: missingSecondPhoneOrders.length,
        missing_count: missingSecondPhoneOrders.filter(o => o.phone_quality.status === 'ALT_PHONE_MISSING').length,
        duplicate_primary_count: missingSecondPhoneOrders.filter(o => o.phone_quality.status === 'ALT_PHONE_DUPLICATE_PRIMARY').length,
        title: 'أوردرات اتعمل عليها Action بدون رقم تليفون ثانٍ حقيقي',
        orders_preview: missingSecondPhoneOrders.slice(0, 50)
      },
      weak_or_invalid_address: {
        count: invalidAddressOrders.length,
        weak_count: invalidAddressOrders.filter(o => o.address_quality.code === 'WEAK_WORD_COUNT').length,
        language_invalid_count: invalidAddressOrders.filter(o => o.address_quality.code === 'ENGLISH_ONLY' || o.address_quality.code === 'MIXED_LANGUAGE').length,
        empty_count: invalidAddressOrders.filter(o => o.address_quality.code === 'EMPTY').length,
        title: 'عناوين ضعيفة أو غير صالحة',
        orders_preview: invalidAddressOrders.slice(0, 50)
      },
      delivery_rate_below_70: {
        count: lowDeliveryRateOrders.length,
        title: 'نسبة تسليم منخفضة (< 70%)',
        orders_preview: lowDeliveryRateOrders.slice(0, 50)
      }
    }
  };
}

/**
 * Computes Employee-Level Operational Metrics (Feature 1 & Feature 2):
 *
 * @param {string} workDate Business date (YYYY-MM-DD)
 * @param {string} employeeName Employee name
 * @returns {Object} Employee operational scorecard
 */
export function getEmployeeOperationalMetrics(workDate = getCairoBusinessDate(), employeeName) {
  if (!employeeName) return null;

  // Find order codes worked by this employee on this date
  const empOrderCodes = new Set();
  try {
    const rawLogs = db.prepare(`
      SELECT DISTINCT order_code FROM raw_log_records 
      WHERE work_date = ? AND employee_name = ? AND is_cs = 1
    `).all(workDate, employeeName);
    rawLogs.forEach(r => empOrderCodes.add(r.order_code));
  } catch (_) {}

  try {
    const cwo = db.prepare(`
      SELECT order_code FROM current_work_orders 
      WHERE work_date = ? AND assigned_employee_name = ?
    `).all(workDate, employeeName);
    cwo.forEach(r => empOrderCodes.add(r.order_code));
  } catch (_) {}

  const orderCodesList = Array.from(empOrderCodes);
  let enriched = [];
  if (orderCodesList.length > 0) {
    for (const code of orderCodesList) {
      let order = db.prepare('SELECT * FROM current_work_orders WHERE order_code = ?').get(code);
      if (!order) {
        order = db.prepare('SELECT * FROM vendoor_orders WHERE order_code = ?').get(code) || { order_code: code, work_date: workDate };
      }
      enriched.push(enrichOrderOperationalIntelligence({ ...order, is_actioned: true, assigned_employee_name: employeeName }));
    }
  }

  const eligibleOrdersCount = enriched.length;
  const distinctAddedCount = enriched.filter(o => o.phone_quality.status === 'ALT_PHONE_ADDED').length;
  const missingPhoneCount = enriched.filter(o => o.phone_quality.status === 'ALT_PHONE_MISSING').length;
  const sameAsPrimaryCount = enriched.filter(o => o.phone_quality.status === 'ALT_PHONE_DUPLICATE_PRIMARY').length;

  const distinctSecondPhoneRate = eligibleOrdersCount > 0 
    ? +((distinctAddedCount / eligibleOrdersCount) * 100).toFixed(1) 
    : 0;

  // Compute Address Quality Metrics for Employee
  const validAddressCount = enriched.filter(o => o.address_quality.is_valid).length;
  const weakInvalidAddressCount = enriched.filter(o => !o.address_quality.is_valid).length;

  const addressQualityRate = eligibleOrdersCount > 0 
    ? +((validAddressCount / eligibleOrdersCount) * 100).toFixed(1) 
    : 0;

  return {
    employee_name: employeeName,
    work_date: workDate,
    second_phone: {
      eligible_orders: eligibleOrdersCount,
      real_second_phones_added: distinctAddedCount,
      missing_second_phone: missingPhoneCount,
      same_as_primary: sameAsPrimaryCount,
      distinct_second_phone_rate: distinctSecondPhoneRate
    },
    address_quality: {
      confirmed_addresses: eligibleOrdersCount,
      valid_addresses: validAddressCount,
      weak_invalid_addresses: weakInvalidAddressCount,
      address_quality_rate: addressQualityRate
    },
    attention_orders_count: enriched.filter(o => o.needs_attention).length
  };
}
