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
      result: 'ADDRESS_WEAK',
      address_status: 'ADDRESS_WEAK',
      is_valid: false,
      word_count: wordCount,
      language: 'ARABIC',
      reason: `العنوان ضعيف: يحتوي على ${wordCount} كلمات فقط (المطلوب 4 كلمات على الأقل)`,
      code: 'WEAK_WORD_COUNT'
    };
  }

  return {
    status: 'VALID',
    result: 'ADDRESS_VALID',
    address_status: 'ADDRESS_VALID',
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
/**
 * FEATURE 4: Extracts warehouse from product name or row columns.
 *
 * @param {string} productName Name of product, e.g. "سليبر جلد كود DOL2 ( مخزن 77 )"
 * @param {Object} row Raw row object from Excel
 * @returns {string|null} Extracted warehouse string or null
 */
export function extractWarehouse(productName, row = {}) {
  if (row && typeof row === 'object') {
    const colVal = String(
      row['المخزن'] || row['كود المخزن'] || row['اسم المخزن'] || 
      row['Warehouse'] || row['Warehouse Code'] || row['warehouse'] || row['warehouse_code'] || ''
    ).trim();
    if (colVal && colVal !== '-' && colVal !== 'undefined') return colVal;
  }
  if (productName && typeof productName === 'string') {
    const m = productName.match(/\(([^)]*مخزن[^)]*)\)/i);
    if (m && m[1]) return m[1].trim();
    const m2 = productName.match(/مخزن\s*[\w\d-]+/i);
    if (m2 && m2[0]) return m2[0].trim();
  }
  return null;
}

/**
 * Evaluates whether confirmed order contains multiple products with conflicting merchant codes.
 *
 * Rules:
 * - Only evaluates if order is actually confirmed (isConfirmed === true).
 * - Examines products inside the SAME Order ID only.
 * - If merchant codes differ: triggers MERCHANT_CODE_MISMATCH.
 * - If codes match: no alert.
 * - If data is incomplete: returns status UNKNOWN (no false alarm).
 *
 * @param {Array} products Array of product items for this order
 * @param {boolean} isConfirmed Whether order is confirmed
 * @param {string} orderCode Order code
 * @returns {Object} Evaluation result
 */
export function evaluateMerchantCodeConsistency(products = [], isConfirmed = false, orderCode = '') {
  if (!isConfirmed) {
    return {
      has_mismatch: false,
      status: 'NOT_EVALUATED_UNCONFIRMED',
      alert: null
    };
  }

  if (!products || products.length <= 1) {
    return {
      has_mismatch: false,
      status: 'MATCH',
      alert: null
    };
  }

  const codes = [];
  let hasIncomplete = false;

  for (const p of products) {
    const code = p.merchant_code !== null && p.merchant_code !== undefined ? String(p.merchant_code).trim() : '';
    if (!code || code === '-' || code.toUpperCase() === 'UNKNOWN') {
      hasIncomplete = true;
    } else {
      codes.push(code);
    }
  }

  if (hasIncomplete || codes.length < products.length) {
    return {
      has_mismatch: false,
      status: 'UNKNOWN',
      alert: null,
      reason: 'Incomplete merchant code data on some items'
    };
  }

  const distinctCodes = Array.from(new Set(codes));
  if (distinctCodes.length > 1) {
    const productNames = products.map(p => p.product_name || 'Product');
    return {
      has_mismatch: true,
      status: 'MERCHANT_CODE_MISMATCH',
      order_code: orderCode,
      product_names: productNames,
      merchant_codes: distinctCodes,
      alert: {
        type: 'MERCHANT_CODE_MISMATCH',
        severity: 'DANGER',
        title: 'اختلاف أكواد التجار في نفس الطلب (MERCHANT_CODE_MISMATCH)',
        reason: `الطلب مؤكد ويحتوي على منتجات بأكواد تجار مختلفة: ${distinctCodes.join(', ')}`,
        order_code: orderCode,
        product_names: productNames,
        merchant_codes: distinctCodes
      }
    };
  }

  return {
    has_mismatch: false,
    status: 'MATCH',
    alert: null
  };
}

/**
 * Evaluates whether PRINTED order has products assigned to different warehouses.
 *
 * Rules:
 * - Only evaluates when order is in PRINTED state (isPrinted === true).
 * - If products have different verified warehouses: triggers PRINTED_WAREHOUSE_MISMATCH.
 * - If all products from same warehouse: no alert.
 * - If warehouse missing or unverifiable: uses WAREHOUSE_UNKNOWN (no false alarm).
 *
 * @param {Array} products Array of product items for this order
 * @param {boolean} isPrinted Whether order is in printed state
 * @param {string} orderCode Order code
 * @returns {Object} Evaluation result
 */
export function evaluatePrintedWarehouseConsistency(products = [], isPrinted = false, orderCode = '') {
  if (!isPrinted) {
    return {
      has_mismatch: false,
      status: 'NOT_EVALUATED_NOT_PRINTED',
      alert: null
    };
  }

  if (!products || products.length === 0) {
    return {
      has_mismatch: false,
      status: 'WAREHOUSE_UNKNOWN',
      alert: null
    };
  }

  const warehouses = [];
  let hasMissingWarehouse = false;

  for (const p of products) {
    const wh = p.warehouse !== null && p.warehouse !== undefined ? String(p.warehouse).trim() : '';
    if (!wh || wh === '-' || wh.toUpperCase() === 'WAREHOUSE_UNKNOWN' || wh.toUpperCase() === 'UNKNOWN') {
      hasMissingWarehouse = true;
    } else {
      warehouses.push(wh);
    }
  }

  if (hasMissingWarehouse) {
    return {
      has_mismatch: false,
      status: 'WAREHOUSE_UNKNOWN',
      alert: null,
      reason: 'Warehouse missing or unverifiable on one or more items'
    };
  }

  const distinctWarehouses = Array.from(new Set(warehouses));
  if (distinctWarehouses.length > 1) {
    const productNames = products.map(p => p.product_name || 'Product');
    const merchantCodes = Array.from(new Set(products.map(p => p.merchant_code).filter(Boolean)));
    return {
      has_mismatch: true,
      status: 'PRINTED_WAREHOUSE_MISMATCH',
      order_code: orderCode,
      product_names: productNames,
      merchant_codes: merchantCodes,
      warehouses: distinctWarehouses,
      alert: {
        type: 'PRINTED_WAREHOUSE_MISMATCH',
        severity: 'DANGER',
        title: 'اختلاف المخازن بعد الطباعة (PRINTED_WAREHOUSE_MISMATCH)',
        reason: `الطلب مطبوع لكن منتجاته مسجلة في مخازن مختلفة: ${distinctWarehouses.join(', ')}`,
        order_code: orderCode,
        product_names: productNames,
        merchant_codes: merchantCodes,
        warehouses: distinctWarehouses
      }
    };
  }

  return {
    has_mismatch: false,
    status: 'MATCH',
    alert: null
  };
}

/**
 * Authoritative Customer Delivery Rate Engine
 * Calculates customer delivery rate from historical orders or payload.
 *
 * Rules:
 * - < 70% = DELIVERY_RATE_LOW
 * - >= 70% = DELIVERY_RATE_OK
 * - Missing/no historical data = DELIVERY_RATE_UNKNOWN (rate: null, UNKNOWN != 0)
 *
 * @param {Object} order Raw order object
 * @returns {Object} Delivery rate metrics & evaluation
 */
export function computeCustomerDeliveryRate(order) {
  if (!order) {
    return {
      status: 'DELIVERY_RATE_UNKNOWN',
      rate: null,
      alert: null,
      needs_attention: false,
      code: 'UNKNOWN',
      total_orders: 0,
      delivered_orders: 0,
      cancelled_orders: 0
    };
  }

  // 1. Direct explicit rate on order if provided
  const directRate = order.delivery_rate !== undefined ? order.delivery_rate : (order.customer_delivery_rate ?? null);
  if (directRate !== null && directRate !== undefined && directRate !== '') {
    const cleanNum = Number(String(directRate).replace('%', '').trim());
    if (!isNaN(cleanNum)) {
      const evalRes = evaluateDeliveryRate(cleanNum);
      return {
        ...evalRes,
        total_orders: order.customer_total_orders || order.total_orders || 1,
        delivered_orders: order.customer_delivered_orders || (cleanNum >= 70 ? 1 : 0),
        cancelled_orders: order.customer_cancelled_orders || (cleanNum < 70 ? 1 : 0)
      };
    }
  }

  // 2. Resolve customer by normalized primary phone
  const rawPhone = order.phone || order.phone_a || order.primary_phone || '';
  const normPhone = normalizePhoneNumber(rawPhone);
  if (!normPhone || normPhone.length < 9) {
    return {
      status: 'DELIVERY_RATE_UNKNOWN',
      rate: null,
      alert: null,
      needs_attention: false,
      code: 'UNKNOWN',
      total_orders: 0,
      delivered_orders: 0,
      cancelled_orders: 0
    };
  }

  // 3. Query historical records for this customer
  try {
    let totalCount = 0;
    let deliveredCount = 0;
    let cancelledCount = 0;

    const matchingOrders = db.prepare(`
      SELECT status, raw_payload_json FROM vendoor_orders 
      WHERE raw_payload_json LIKE ?
    `).all(`%${normPhone}%`);

    for (const vo of matchingOrders) {
      let payload = {};
      try { payload = JSON.parse(vo.raw_payload_json); } catch (_) {}
      const p1 = normalizePhoneNumber(payload.phone || payload['موبايل(1)'] || '');
      const p2 = normalizePhoneNumber(payload.phone2 || payload['موبايل(2)'] || '');
      if (p1 === normPhone || p2 === normPhone) {
        totalCount++;
        const st = String(vo.status || payload.status || '').toLowerCase();
        if (st.includes('deliver') || st.includes('استلام') || st.includes('completed') || st.includes('مكتمل') || st.includes('تحصيل')) {
          deliveredCount++;
        } else if (st.includes('cancel') || st.includes('ملغي')) {
          cancelledCount++;
        }
      }
    }

    const finished = deliveredCount + cancelledCount;
    if (finished > 0) {
      const rate = +((deliveredCount / finished) * 100).toFixed(1);
      const evalRes = evaluateDeliveryRate(rate);
      return {
        ...evalRes,
        total_orders: totalCount,
        delivered_orders: deliveredCount,
        cancelled_orders: cancelledCount
      };
    } else if (totalCount > 0 && deliveredCount > 0) {
      const rate = +((deliveredCount / totalCount) * 100).toFixed(1);
      const evalRes = evaluateDeliveryRate(rate);
      return {
        ...evalRes,
        total_orders: totalCount,
        delivered_orders: deliveredCount,
        cancelled_orders: cancelledCount
      };
    }
  } catch (err) {
    console.warn('Error querying customer delivery history:', err.message);
  }

  return {
    status: 'DELIVERY_RATE_UNKNOWN',
    rate: null,
    alert: null,
    needs_attention: false,
    code: 'UNKNOWN',
    total_orders: 0,
    delivered_orders: 0,
    cancelled_orders: 0
  };
}

/**
 * Derives the unified Operational Quality Summary according to locked business rules:
 *
 * Statuses:
 * - QUALITY_ISSUES_FOUND: 1 or more confirmed quality issues.
 * - QUALITY_PENDING: Unsettled / unconfirmed checks, insufficient to declare CLEAR.
 * - QUALITY_CLEAR: All required checks completed and fully valid.
 * - QUALITY_UNKNOWN: Data insufficient to judge.
 *
 * Rules:
 * - Never auto-transition UNKNOWN to CLEAR.
 * - A confirmed issue cannot be erased by pending/unknown checks.
 * - Decouples data quality issues from completed-action exceptions and pending actions.
 *
 * @param {Object} params Check evaluations
 * @returns {Object} Unified quality summary
 */
export function deriveOperationalQualitySummary({
  address_quality,
  phone_quality,
  delivery_quality,
  merchant_code_quality,
  warehouse_quality,
  is_actioned = false,
  has_data = true
}) {
  const issues = [];

  // 1. Address quality checks (Data Quality issue)
  if (address_quality) {
    if (!address_quality.is_valid) {
      const isWeak = address_quality.result === 'ADDRESS_WEAK' || address_quality.code === 'WEAK_WORD_COUNT';
      issues.push({
        type: isWeak ? 'ADDRESS_WEAK' : 'ADDRESS_ISSUE',
        category: 'DATA_QUALITY',
        severity: isWeak ? 'WARNING' : 'DANGER',
        title: isWeak ? 'العنوان ضعيف' : 'العنوان غير صالح',
        reason: address_quality.reason || 'العنوان غير مستوفٍ للشروط'
      });
    }
  }

  // 2. Phone quality checks
  if (phone_quality) {
    if (phone_quality.status === 'ALT_PHONE_DUPLICATE_PRIMARY') {
      issues.push({
        type: 'ALT_PHONE_DUPLICATE_PRIMARY',
        category: 'DATA_QUALITY',
        severity: 'WARNING',
        title: 'الرقم الثاني مكرر للأساسي',
        reason: phone_quality.reason || 'الرقم الثاني مكرر لنفس الرقم الأساسي'
      });
    } else if (is_actioned && phone_quality.status === 'ALT_PHONE_MISSING') {
      issues.push({
        type: 'ALT_PHONE_MISSING',
        category: 'COMPLETED_ACTION_EXCEPTION',
        severity: 'WARNING',
        title: 'تم تأكيد الإجراء بدون رقم ثانٍ',
        reason: phone_quality.reason || 'تم تأكيد الإجراء بدون إضافة رقم هاتف ثانٍ'
      });
    }
  }

  // 3. Delivery rate checks (Data Quality issue)
  if (delivery_quality && delivery_quality.status === 'DELIVERY_RATE_LOW') {
    issues.push({
      type: 'DELIVERY_RATE_LOW',
      category: 'DATA_QUALITY',
      severity: 'WARNING',
      title: 'نسبة التسليم منخفضة',
      reason: delivery_quality.alert || `نسبة التسليم منخفضة (${delivery_quality.rate}%)`
    });
  }

  // 4. Merchant code checks (Data Quality issue)
  if (merchant_code_quality && merchant_code_quality.has_mismatch && merchant_code_quality.alert) {
    issues.push({
      type: 'MERCHANT_CODE_MISMATCH',
      category: 'DATA_QUALITY',
      severity: 'DANGER',
      title: 'اختلاف أكواد التجار',
      reason: merchant_code_quality.alert.reason || 'الطلب يحتوي على منتجات بأكواد تجار مختلفة'
    });
  }

  // 5. Warehouse checks (Data Quality issue)
  if (warehouse_quality && warehouse_quality.has_mismatch && warehouse_quality.alert) {
    issues.push({
      type: 'PRINTED_WAREHOUSE_MISMATCH',
      category: 'DATA_QUALITY',
      severity: 'DANGER',
      title: 'اختلاف المخازن بعد الطباعة',
      reason: warehouse_quality.alert.reason || 'الطلب مطبوع لكن منتجاته مسجلة في مخازن مختلفة'
    });
  }

  // Final Status Derivation according to locked business rules
  let status;
  let badge_label;
  let title;
  let description;

  if (issues.length > 0) {
    // 1. Confirmed issues found — never erased by pending/unknown checks
    status = 'QUALITY_ISSUES_FOUND';
    badge_label = `مشاكل جودة (${issues.length}) ⚠`;
    title = 'تم اكتشاف مشاكل جودة';
    if (!is_actioned) {
      description = `الطلب يحتوي على ملاحظات جودة (${issues.map(i => i.title).join('، ')})، والإجراء لم يتأكد بعد (Action Confirmed = No).`;
    } else {
      description = `الطلب يحتوي على مشاكل جودة مؤكدة (${issues.map(i => i.title).join('، ')}) بعد تأكيد الإجراء.`;
    }
  } else if (!has_data || (!address_quality?.language && !phone_quality?.primary_normalized)) {
    // 2. Unknown / Insufficient data (Never auto-transition to CLEAR)
    status = 'QUALITY_UNKNOWN';
    badge_label = 'غير محدد ❓';
    title = 'بيانات غير كافية للحكم';
    description = 'البيانات المسجلة غير كافية لاعتماد استيفاء الطلب لمعايير الجودة.';
  } else if (!is_actioned && phone_quality?.status === 'ALT_PHONE_MISSING') {
    // 3. Pending checks (Action not yet confirmed and second phone awaiting addition)
    status = 'QUALITY_PENDING';
    badge_label = 'في الانتظار ⏳';
    title = 'في انتظار حسم الإجراء';
    description = 'الطلب في انتظار استكمال الإجراء وإضافة الرقم الثاني، ولا يمكن اعتماد سلامته قبل الحسم.';
  } else if (
    address_quality?.is_valid &&
    phone_quality?.status === 'ALT_PHONE_ADDED' &&
    (!delivery_quality || delivery_quality.status !== 'DELIVERY_RATE_LOW') &&
    (!merchant_code_quality || !merchant_code_quality.has_mismatch) &&
    (!warehouse_quality || !warehouse_quality.has_mismatch)
  ) {
    // 4. All required checks completed and fully valid
    status = 'QUALITY_CLEAR';
    badge_label = 'مستوفي المعايير ✓';
    title = 'الطلب مستوفي معايير الجودة';
    description = 'الطلب مستوفي معايير الجودة بالكامل ولا توجد استثناءات معلقة.';
  } else {
    // Fallback if any check is unsettled
    status = !is_actioned ? 'QUALITY_PENDING' : 'QUALITY_UNKNOWN';
    badge_label = status === 'QUALITY_PENDING' ? 'في الانتظار ⏳' : 'غير محدد ❓';
    title = status === 'QUALITY_PENDING' ? 'فحوص غير مكتملة' : 'بيانات غير مكتملة';
    description = 'توجد فحوص لم تُحسم بعد، ولا توجد نتيجة كافية لاعتماد سلامة الطلب.';
  }

  return {
    status,
    badge_label,
    title,
    description,
    issues,
    issues_count: issues.length,
    action_confirmed: Boolean(is_actioned),
    action_status: is_actioned ? 'CONFIRMED' : 'PENDING'
  };
}

/**
 * Enriches a single order with all Operational Intelligence evaluations.
 *
 * @param {Object} order Raw order object from database or Vendoor
 * @returns {Object} Order enriched with intelligence flags and attention details
 */
export function enrichOrderOperationalIntelligence(order) {
  if (!order) return null;

  let merged = { ...order };
  if (order.order_code) {
    try {
      const vo = db.prepare('SELECT * FROM vendoor_orders WHERE order_code = ?').get(order.order_code);
      if (vo) {
        let payload = {};
        if (vo.raw_payload_json) {
          try { payload = JSON.parse(vo.raw_payload_json); } catch (_) {}
        }
        // Base is payload
        merged = { ...payload };
        // Overlay non-empty properties from vo
        for (const [k, v] of Object.entries(vo)) {
          if (v !== null && v !== undefined && v !== '') {
            merged[k] = v;
          }
        }
        // Overlay non-empty properties from order
        for (const [k, v] of Object.entries(order)) {
          if (v !== null && v !== undefined && v !== '') {
            merged[k] = v;
          }
        }
      }
    } catch (_) {}
  }

  const isActioned = isOrderActionedByCS(merged);
  const stUpper = String(merged.status || '').toUpperCase();
  const wsUpper = String(merged.work_state || '').toUpperCase();
  const isPrinted = stUpper.includes('PRINT') || wsUpper === 'PRINTED';
  const isConfirmed = isActioned || stUpper.includes('CONFIRM') || stUpper.includes('PRINT') || merged.is_confirmed === true;

  // Secondary phone
  const primaryPhone = merged.phone || merged.phone_a || merged.primary_phone || '';
  const secondPhone = merged.phone2 || merged.alt_phone || merged.phone_b || merged.additional_phone || '';
  const phoneEval = evaluateSecondPhoneQuality(primaryPhone, secondPhone, isActioned);

  // Address
  const rawAddress = merged.address || merged.customer_address || merged.shipping_address || '';
  const addressEval = evaluateAddressQuality(rawAddress);

  // Delivery rate (authoritative calculation)
  const deliveryEval = computeCustomerDeliveryRate(merged);

  // Load products for this order if available
  let products = [];
  try {
    products = db.prepare(`
      SELECT * FROM order_products 
      WHERE order_code = ? OR (order_id IS NOT NULL AND order_id = ?)
    `).all(merged.order_code, merged.order_id || merged.order_code);
  } catch (_) {}

  // Determine real product details without generic placeholder 'Product'
  const rawProd = merged.product_name !== null && merged.product_name !== undefined ? String(merged.product_name).trim() : '';
  const realProductName = (rawProd && rawProd !== 'Product') ? rawProd : (merged.raw_product_name || (rawProd === 'Product' ? 'Product' : ''));
  const productSku = merged.product_sku || merged.sku || null;
  const merchantCode = merged.merchant_code || null;
  const merchantName = merged.merchant_name || merged.account || null;
  const warehouse = merged.warehouse || extractWarehouse(realProductName, merged) || null;

  if (products.length === 0 && (realProductName || productSku || merchantCode)) {
    products = [{
      product_name: realProductName || '',
      product_sku: productSku,
      merchant_code: merchantCode,
      merchant_name: merchantName,
      warehouse: warehouse,
      quantity: Number(merged.quantity || merged.qty || 1) || 1,
      unit_price: Number(merged.total_price || merged.price || 0) || 0,
      source: realProductName === 'Product' ? 'EXPLICIT_SOURCE_LITERAL' : (realProductName ? 'SOURCE_PAYLOAD' : 'EMPTY')
    }];
  }

  // Populate primary product and merchant code
  const primaryProduct = products[0] || {};
  const finalRealProductName = primaryProduct.product_name || realProductName;
  const finalSku = primaryProduct.product_sku || productSku;
  const finalMerchantCode = primaryProduct.merchant_code || merchantCode;
  const finalMerchantName = primaryProduct.merchant_name || merchantName;
  const finalWarehouse = primaryProduct.warehouse || warehouse;

  // Evaluate Merchant Code Mismatch
  const merchantCodeEval = evaluateMerchantCodeConsistency(products, isConfirmed, merged.order_code);

  // Evaluate Printed Warehouse Mismatch
  const warehouseEval = evaluatePrintedWarehouseConsistency(products, isPrinted, merged.order_code);

  // Unified Quality Summary
  const overallQuality = deriveOperationalQualitySummary({
    address_quality: addressEval,
    phone_quality: phoneEval,
    delivery_quality: deliveryEval,
    merchant_code_quality: merchantCodeEval,
    warehouse_quality: warehouseEval,
    is_actioned: isActioned,
    has_data: Boolean(rawAddress || primaryPhone || merged.customer_name)
  });

  const alerts = overallQuality.issues;
  const needsAttention = (overallQuality.status === 'QUALITY_ISSUES_FOUND');

  return {
    ...merged,
    is_actioned: isActioned,
    is_confirmed: isConfirmed,
    is_printed: isPrinted,
    real_product_name: finalRealProductName,
    product_name: finalRealProductName,
    product_sku: finalSku,
    merchant_code: finalMerchantCode,
    merchant_name: finalMerchantName,
    warehouse: finalWarehouse,
    products: products,
    products_count: products.length,
    phone_quality: phoneEval,
    address_quality: addressEval,
    delivery_quality: deliveryEval,
    merchant_code_quality: merchantCodeEval,
    warehouse_quality: warehouseEval,
    operational_alerts: alerts,
    overall_quality: overallQuality,
    needs_attention: needsAttention
  };
}

/**
 * Aggregates Operational Exceptions for a specific business date:
 * Returns counts and preview lists for:
 * 1. Actioned without real second phone
 * 2. Weak / invalid address
 * 3. Delivery rate < 70%
 * 4. Merchant code mismatch
 * 5. Printed warehouse mismatch
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
  // 1. Completed action exception: Actioned order without real second phone (requires is_actioned)
  const missingSecondPhoneOrders = enriched.filter(o => o.phone_quality.needs_attention);
  
  // 2. Data quality: weak or invalid address (tracks all invalid addresses)
  const invalidAddressOrders = enriched.filter(o => !o.address_quality.is_valid);
  
  // 3. Data quality: low delivery rate
  const lowDeliveryRateOrders = enriched.filter(o => o.delivery_quality.needs_attention);
  
  // 4. Data quality: merchant mismatch
  const merchantMismatchOrders = enriched.filter(o => o.merchant_code_quality?.has_mismatch);
  
  // 5. Data quality: printed warehouse mismatch
  const warehouseMismatchOrders = enriched.filter(o => o.warehouse_quality?.has_mismatch);

  // Distinct attention orders (orders with confirmed quality issues)
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
        weak_count: invalidAddressOrders.filter(o => o.address_quality.code === 'WEAK_WORD_COUNT' || o.address_quality.result === 'ADDRESS_WEAK').length,
        language_invalid_count: invalidAddressOrders.filter(o => o.address_quality.code === 'ENGLISH_ONLY' || o.address_quality.code === 'MIXED_LANGUAGE').length,
        empty_count: invalidAddressOrders.filter(o => o.address_quality.code === 'EMPTY').length,
        title: 'عناوين ضعيفة أو غير صالحة',
        orders_preview: invalidAddressOrders.slice(0, 50)
      },
      delivery_rate_below_70: {
        count: lowDeliveryRateOrders.length,
        title: 'نسبة تسليم منخفضة (< 70%)',
        orders_preview: lowDeliveryRateOrders.slice(0, 50)
      },
      merchant_code_mismatch: {
        count: merchantMismatchOrders.length,
        title: 'اختلاف أكواد التجار في نفس الطلب (MERCHANT_CODE_MISMATCH)',
        orders_preview: merchantMismatchOrders.slice(0, 50)
      },
      printed_warehouse_mismatch: {
        count: warehouseMismatchOrders.length,
        title: 'اختلاف المخازن بعد الطباعة (PRINTED_WAREHOUSE_MISMATCH)',
        orders_preview: warehouseMismatchOrders.slice(0, 50)
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
