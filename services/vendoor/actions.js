/**
 * Vendoor Action Classification Layer (Phase 2 Requirement 7 & 8)
 *
 * Explicitly classifies every action observed in Vendoor logs:
 * - VALID_PRODUCTIVE_ACTION: Real operational actions that represent productive work (Printed, Processing, Confirmed, Alt Phone, etc.)
 * - NON_PRODUCTIVE_ACTION: Informational / read-only events (Views, Notes, Internal comments, Login, etc.)
 * - CANCELED_ACTION: Cancellations, customer rejects, refused orders (MUST NEVER count toward productive throughput)
 * - UNKNOWN_ACTION: Unrecognized actions (MUST NOT count toward productivity)
 */

export const ACTION_CLASSIFICATIONS = {
  VALID_PRODUCTIVE_ACTION: 'VALID_PRODUCTIVE_ACTION',
  NON_PRODUCTIVE_ACTION: 'NON_PRODUCTIVE_ACTION',
  CANCELED_ACTION: 'CANCELED_ACTION',
  UNKNOWN_ACTION: 'UNKNOWN_ACTION'
};

// Explicit mappings for known Arabic and English action keywords in Vendoor logs
const ACTION_RULES = [
  // Non-Productive / Notes / Administrative (Checked FIRST so notes are never classified as cancellations or status changes)
  {
    type: ACTION_CLASSIFICATIONS.NON_PRODUCTIVE_ACTION,
    patterns: [
      /ملاحظة/i,
      /ملاحظه/i,
      /note.*added/i,
      /view/i,
      /عرض/i,
      /معاينة/i,
      /login/i,
      /تسجيل.*دخول/i,
      /export/i,
      /تصدير/i,
      /search/i,
      /بحث/i,
      /filter/i,
      /فلتر/i,
      /tag/i,
      /وسم/i,
      /assigned/i,
      /اسناد/i,
      /إسناد/i,
      /order.*created/i,
      /انشاء.*طلب/i,
      /إنشاء.*طلب/i,
      /اضافة.*طلب/i,
      /اضاف.*اوردر/i,
      /أضاف.*اوردر/i,
      /ايزي.*اوردر/i
    ]
  },

  // Canceled actions (Real cancellation events)
  {
    type: ACTION_CLASSIFICATIONS.CANCELED_ACTION,
    patterns: [
      /cancel/i,
      /ملغي/i,
      /إلغاء/i,
      /الغاء/i,
      /رفض/i,
      /مرتجع/i,
      /reject/i,
      /refused/i,
      /customer.*reject/i,
      /cancelled.*by.*customer/i
    ]
  },

  // Valid Productive Actions (Verified CS Order Operations: Print, Confirm, Status change, Address/Phone update)
  {
    type: ACTION_CLASSIFICATIONS.VALID_PRODUCTIVE_ACTION,
    patterns: [
      /print/i,
      /طبع/i,
      /طباعة/i,
      /تم.*الطباعة/i,
      /processing/i,
      /قيد.*التجهيز/i,
      /تجهيز/i,
      /confirmed/i,
      /تأكيد/i,
      /تاكيد/i,
      /pending/i,
      /معلق/i,
      /قيد.*الانتظار/i,
      /alt.*phone/i,
      /رقم.*بديل/i,
      /هاتف.*بديل/i,
      /تليفون.*بديل/i,
      /رقم.*هاتف.*آخر/i,
      /رقم.*هاتف.*اخر/i,
      /اضافة.*رقم/i,
      /إضافة.*رقم/i,
      /status.*updated/i,
      /حالة.*الطلب/i,
      /تحديث.*الحالة/i,
      /تغيير.*الحالة/i,
      /عدل.*العنوان/i,
      /تعديل.*العنوان/i,
      /عدل.*اسم.*العميل/i,
      /تعديل.*اسم.*العميل/i,
      /action.*done/i,
      /action.*recorded/i,
      /delivered/i,
      /تم.*التسليم/i,
      /shipping/i,
      /شحن/i
    ]
  }
];

/**
 * Classifies an action string into one of the 4 strict categories
 *
 * @param {string} actionText
 * @param {string} [statusText]
 * @returns {{
 *   classification: string,
 *   is_productive: boolean,
 *   is_canceled: boolean,
 *   is_unknown: boolean,
 *   raw_action: string,
 *   rule_matched: string
 * }}
 */
export function classifyVendoorAction(actionText, statusText = '') {
  const combined = `${actionText || ''} ${statusText || ''}`.trim();

  if (!combined) {
    return {
      classification: ACTION_CLASSIFICATIONS.UNKNOWN_ACTION,
      is_productive: false,
      is_canceled: false,
      is_unknown: true,
      raw_action: '',
      rule_matched: 'EMPTY_ACTION'
    };
  }

  for (const rule of ACTION_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(combined)) {
        return {
          classification: rule.type,
          is_productive: rule.type === ACTION_CLASSIFICATIONS.VALID_PRODUCTIVE_ACTION,
          is_canceled: rule.type === ACTION_CLASSIFICATIONS.CANCELED_ACTION,
          is_unknown: false,
          raw_action: combined,
          rule_matched: String(pattern)
        };
      }
    }
  }

  return {
    classification: ACTION_CLASSIFICATIONS.UNKNOWN_ACTION,
    is_productive: false,
    is_canceled: false,
    is_unknown: true,
    raw_action: combined,
    rule_matched: 'NO_PATTERN_MATCH'
  };
}

/**
 * Quick predicate helper for valid productive actions
 */
export function isValidProductiveAction(actionText, statusText = '') {
  const res = classifyVendoorAction(actionText, statusText);
  return res.is_productive;
}

export const isProductiveVendoorAction = isValidProductiveAction;

/**
 * Canonical status extractor for universal normalization across Vendoor logs & SQL queries.
 * Maps any Arabic / English action or status string to standard canonical status:
 * 'Printed' | 'Pending' | 'Cancelled' | 'Processing' | 'Delivered' | 'Shipping' | 'Collected' | 'New' | 'Alt Phone' | 'Action Recorded'
 */
export function extractCanonicalStatus(actionText, statusText = '') {
  const combined = `${actionText || ''} ${statusText || ''}`.trim();
  if (!combined) return 'Action Recorded';

  // Notes and remarks are strictly non-status events and must never be treated as status transitions
  if (/ملاحظة|ملاحظه|note/i.test(combined)) {
    return 'Action Recorded';
  }

  // Check for target state in transition "من ... إلى (Target)"
  const toMatch = combined.match(/(?:إلى|الى|to)\s*['"]?([A-Za-z \u0600-\u06FF]+)['"]?\s*$/i);
  const targetText = toMatch ? toMatch[1].trim() : '';

  if (targetText) {
    if (/cancel|ملغي|إلغاء|الغاء|رفض|مرتجع|reject|refused/i.test(targetText)) return 'Cancelled';
    if (/print|طبع|طباعة/i.test(targetText)) return 'Printed';
    if (/pending|معلق|قيد.*الانتظار/i.test(targetText)) return 'Pending';
    if (/processing|تجهيز|قيد.*التجهيز/i.test(targetText)) return 'Processing';
    if (/delivered|تسليم|تم.*التسليم/i.test(targetText)) return 'Delivered';
    if (/shipping|شحن/i.test(targetText)) return 'Shipping';
    if (/collected|تحصيل|تم.*التحصيل/i.test(targetText)) return 'Collected';
    if (/new|جديد/i.test(targetText)) return 'New';
  }

  if (/cancel|ملغي|إلغاء|الغاء|رفض|مرتجع|reject|refused/i.test(combined)) {
    return 'Cancelled';
  }
  if (/print|طبع|طباعة/i.test(combined)) {
    return 'Printed';
  }
  if (/pending|معلق|قيد.*الانتظار/i.test(combined)) {
    return 'Pending';
  }
  if (/processing|تجهيز|قيد.*التجهيز/i.test(combined)) {
    return 'Processing';
  }
  if (/delivered|تسليم|تم.*التسليم/i.test(combined)) {
    return 'Delivered';
  }
  if (/shipping|شحن/i.test(combined)) {
    return 'Shipping';
  }
  if (/collected|تحصيل|تم.*التحصيل/i.test(combined)) {
    return 'Collected';
  }
  if (/أضاف.*اوردر|اضاف.*اوردر|انشاء.*اوردر|إنشاء.*اوردر|اضافة.*اوردر|ايزي.*اوردر/i.test(combined)) {
    return 'New';
  }
  if (/alt.*phone|رقم.*بديل|هاتف.*بديل|تليفون.*بديل|رقم.*هاتف.*آخر|رقم.*هاتف.*اخر/i.test(combined)) {
    return 'Alt Phone';
  }

  return 'Action Recorded';
}

