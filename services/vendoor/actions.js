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
  // Canceled actions (Must be checked FIRST so cancellations are never classified as productive)
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
  },

  // Non-Productive / Administrative / Read-only / Ingestion actions
  {
    type: ACTION_CLASSIFICATIONS.NON_PRODUCTIVE_ACTION,
    patterns: [
      /view/i,
      /عرض/i,
      /معاينة/i,
      /note.*added/i,
      /ملاحظة/i,
      /ملاحظه/i,
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

