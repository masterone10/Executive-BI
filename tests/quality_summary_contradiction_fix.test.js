import assert from 'node:assert';
import { describe, it, before } from 'node:test';
import Database from 'better-sqlite3';
import { db } from '../db/index.js';
import {
  evaluateAddressQuality,
  evaluateSecondPhoneQuality,
  deriveOperationalQualitySummary,
  enrichOrderOperationalIntelligence,
  getOperationalExceptions
} from '../services/operational_intelligence.js';

describe('Operational Quality Summary Contradiction Fix & Parity Suite', () => {

  before(() => {
    // Ensure order 2224493 exists in the current active test DB with authentic payload
    const existing = db.prepare('SELECT 1 FROM vendoor_orders WHERE order_code = ?').get('2224493');
    if (!existing) {
      let livePayload = null;
      let liveVo = null;
      let liveCwo = null;
      try {
        const liveDb = new Database('./data.db', { readonly: true });
        liveVo = liveDb.prepare('SELECT * FROM vendoor_orders WHERE order_code = ?').get('2224493');
        liveCwo = liveDb.prepare('SELECT * FROM current_work_orders WHERE order_code = ?').get('2224493');
        liveDb.close();
      } catch (_) {}

      const rawJson = (liveVo && liveVo.raw_payload_json) ? liveVo.raw_payload_json : JSON.stringify({
        order_code: '2224493',
        status: 'New',
        account: 'Doby Store',
        merchant_name: 'Doby Store',
        merchant_code: '36735',
        customer_name: 'مدحت محمود',
        phone: '01032840177',
        phone2: '01032840177',
        address: 'المنصور جمص',
        product_name: 'شبشب رجالى برادا صابع كـود111 (مخزن 100)',
        product_sku: 'prada111-#DCDCDC-42',
        total_price: 588
      });

      db.prepare(`
        INSERT OR REPLACE INTO vendoor_orders (
          order_code, status, active_status, account, merchant_code, merchant_name,
          source_date, business_date, is_active, total_price, raw_payload_json,
          product_name, warehouse
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        '2224493',
        'New',
        'New',
        'Doby Store',
        '36735',
        'Doby Store',
        '2026-10-10',
        '2026-10-10',
        1,
        588,
        rawJson,
        'شبشب رجالى برادا صابع كـود111 (مخزن 100)',
        'مخزن 100'
      );

      db.prepare(`
        INSERT OR REPLACE INTO current_work_orders (
          work_date, order_code, account, status, order_date, source_file_slot, source_type,
          merchant_code, merchant_name, product_name, warehouse
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        '2026-10-10',
        '2224493',
        'Doby Store',
        'New',
        '2026-10-10',
        1,
        'NEW',
        '36735',
        'Doby Store',
        'شبشب رجالى برادا صابع كـود111 (مخزن 100)',
        'مخزن 100'
      );

      db.prepare(`
        INSERT OR IGNORE INTO order_products (
          order_code, order_id, product_name, product_sku, merchant_code, merchant_name, warehouse, quantity, unit_price
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        '2224493',
        '2224493',
        'شبشب رجالى برادا صابع كـود111 (مخزن 100)',
        'prada111-#DCDCDC-42',
        '36735',
        'Doby Store',
        'مخزن 100',
        1,
        588
      );
    }
  });

  // Test Case 1: عنوان ضعيف مع عدم تأكيد الإجراء
  it('1. Weak address with unconfirmed action maintains ADDRESS_WEAK, Action Confirmed = No, and QUALITY_ISSUES_FOUND', () => {
    const rawAddress = 'المنصور جمص'; // 2 words
    const addr = evaluateAddressQuality(rawAddress);
    assert.strictEqual(addr.is_valid, false, 'Address must be invalid');
    assert.strictEqual(addr.word_count, 2, 'Address word count must be 2');
    assert.strictEqual(addr.result, 'ADDRESS_WEAK', 'Address result must be ADDRESS_WEAK');
    assert.strictEqual(addr.code, 'WEAK_WORD_COUNT');

    const summary = deriveOperationalQualitySummary({
      address_quality: addr,
      phone_quality: evaluateSecondPhoneQuality('01011112222', '01233334444', false),
      is_actioned: false,
      has_data: true
    });

    assert.strictEqual(summary.status, 'QUALITY_ISSUES_FOUND', 'Weak address must produce QUALITY_ISSUES_FOUND even without action confirmed');
    assert.strictEqual(summary.action_confirmed, false, 'Action confirmed must be false');
    assert.strictEqual(summary.action_status, 'PENDING');
    assert.ok(summary.issues.some(i => i.type === 'ADDRESS_WEAK' || i.title.includes('العنوان ضعيف')));
    assert.ok(summary.description.includes('Action Confirmed = No') || summary.description.includes('لم يتأكد'));
  });

  // Test Case 2: رقم ثانٍ مطابق للرقم الأساسي
  it('2. Second phone matching primary phone evaluates to ALT_PHONE_DUPLICATE_PRIMARY', () => {
    const phoneRes = evaluateSecondPhoneQuality('01032840177', '01032840177', false);
    assert.strictEqual(phoneRes.status, 'ALT_PHONE_DUPLICATE_PRIMARY');
    assert.strictEqual(phoneRes.is_distinct, false);
    assert.strictEqual(phoneRes.primary_normalized, '01032840177');
    assert.strictEqual(phoneRes.second_normalized, '01032840177');
    assert.ok(phoneRes.reason.includes('مكرر'));

    const summary = deriveOperationalQualitySummary({
      address_quality: evaluateAddressQuality('شارع الثورة مصر الجديدة القاهرة مصر'),
      phone_quality: phoneRes,
      is_actioned: false,
      has_data: true
    });

    assert.strictEqual(summary.status, 'QUALITY_ISSUES_FOUND');
    assert.ok(summary.issues.some(i => i.type === 'ALT_PHONE_DUPLICATE_PRIMARY'));
  });

  // Test Case 3: عنوان ضعيف ورقم ثانٍ مكرر في أوردر واحد (نفس حالة الأوردر 2224493)
  it('3. Both weak address and duplicate secondary phone on single order generates unified QUALITY_ISSUES_FOUND with 2 issues', () => {
    const addr = evaluateAddressQuality('المنصور جمص');
    const phone = evaluateSecondPhoneQuality('01032840177', '01032840177', false);

    const summary = deriveOperationalQualitySummary({
      address_quality: addr,
      phone_quality: phone,
      is_actioned: false,
      has_data: true
    });

    assert.strictEqual(summary.status, 'QUALITY_ISSUES_FOUND');
    assert.strictEqual(summary.issues_count, 2);
    assert.strictEqual(summary.action_confirmed, false);
    assert.ok(summary.issues.some(i => i.type === 'ADDRESS_WEAK'));
    assert.ok(summary.issues.some(i => i.type === 'ALT_PHONE_DUPLICATE_PRIMARY'));
    assert.ok(!summary.description.includes('مستوفي معايير الجودة ولا توجد استثناءات'));
  });

  // Test Case 4: فحوص سليمة بالكامل
  it('4. Fully valid checks produce QUALITY_CLEAR with zero issues', () => {
    const validAddr = evaluateAddressQuality('شارع الجمهورية عمارة النيل الدور الرابع القاهرة');
    const validPhone = evaluateSecondPhoneQuality('01011112222', '01299998888', true);

    const summary = deriveOperationalQualitySummary({
      address_quality: validAddr,
      phone_quality: validPhone,
      delivery_quality: { status: 'DELIVERY_RATE_OK', needs_attention: false, rate: 85 },
      merchant_code_quality: { has_mismatch: false, status: 'MATCH' },
      warehouse_quality: { has_mismatch: false, status: 'MATCH' },
      is_actioned: true,
      has_data: true
    });

    assert.strictEqual(summary.status, 'QUALITY_CLEAR');
    assert.strictEqual(summary.issues_count, 0);
    assert.strictEqual(summary.action_confirmed, true);
    assert.ok(summary.description.includes('مستوفي معايير الجودة بالكامل'));
  });

  // Test Case 5: بيانات ناقصة أو غير مؤكدة (QUALITY_UNKNOWN و QUALITY_PENDING)
  it('5. Incomplete / unconfirmed data yields QUALITY_UNKNOWN or QUALITY_PENDING, never auto-clearing to CLEAR', () => {
    // 5a. Missing data -> QUALITY_UNKNOWN
    const unknownSummary = deriveOperationalQualitySummary({
      address_quality: null,
      phone_quality: null,
      is_actioned: false,
      has_data: false
    });
    assert.strictEqual(unknownSummary.status, 'QUALITY_UNKNOWN');
    assert.notStrictEqual(unknownSummary.status, 'QUALITY_CLEAR');

    // 5b. Valid address, unconfirmed order with missing second phone awaiting CS -> QUALITY_PENDING
    const pendingSummary = deriveOperationalQualitySummary({
      address_quality: evaluateAddressQuality('شارع التحرير الدقي الجيزة مصر'),
      phone_quality: evaluateSecondPhoneQuality('01011112222', '', false), // missing 2nd phone, un-actioned
      is_actioned: false,
      has_data: true
    });
    assert.strictEqual(pendingSummary.status, 'QUALITY_PENDING');
    assert.notStrictEqual(pendingSummary.status, 'QUALITY_CLEAR');
  });

  // Test Case 6: عدم احتساب إجراء غير مؤكد ضمن مؤشرات الإجراءات المكتملة
  it('6. Unconfirmed action (is_actioned=false) is excluded from completed-action metrics', () => {
    const dummyDate = '2029-01-01';
    // Test that an order with is_actioned=false does NOT trigger actioned_without_real_second_phone
    const unconfirmedOrder = {
      order_code: 'TEST_UNCONFIRMED_999',
      phone: '01012345678',
      phone2: '01012345678', // duplicate
      address: 'المنصور جمص', // weak
      is_actioned: false,
      status: 'New',
      work_state: 'UNASSIGNED'
    };

    const enriched = enrichOrderOperationalIntelligence(unconfirmedOrder);
    assert.strictEqual(enriched.is_actioned, false);
    assert.strictEqual(enriched.phone_quality.needs_attention, false, 'Needs attention for actioned metric must be false when is_actioned is false');

    // Grouping invariant verification:
    const mockList = [enriched];
    const completedActionExceptions = mockList.filter(o => o.phone_quality.needs_attention);
    assert.strictEqual(completedActionExceptions.length, 0, 'Must NOT be counted in completed action exceptions');

    // But MUST be included in data quality attention & invalid address
    const invalidAddressList = mockList.filter(o => !o.address_quality.is_valid);
    assert.strictEqual(invalidAddressList.length, 1, 'Must be counted in weak/invalid address data issue');
    assert.strictEqual(enriched.needs_attention, true, 'Overall order must require attention due to data quality');
  });

  // Test Case 7: اتساق Overall Quality مع التفاصيل على الأوردر 2224493 الفعلي
  it('7. Order 2224493 shows absolute consistency between Overall Quality, Attention Required, Drawer, and Details', () => {
    const row = db.prepare('SELECT * FROM current_work_orders WHERE order_code = ?').get('2224493')
             || db.prepare('SELECT * FROM vendoor_orders WHERE order_code = ?').get('2224493');
    assert.ok(row, 'Order 2224493 must exist in database');

    const enriched = enrichOrderOperationalIntelligence(row);

    // 1. Overall Quality
    assert.strictEqual(enriched.overall_quality.status, 'QUALITY_ISSUES_FOUND');
    assert.strictEqual(enriched.overall_quality.action_confirmed, false);

    // 2. Attention Required
    assert.strictEqual(enriched.needs_attention, true);
    assert.strictEqual(enriched.operational_alerts.length, 2);

    // 3. Second Phone Quality
    assert.strictEqual(enriched.phone_quality.status, 'ALT_PHONE_DUPLICATE_PRIMARY');
    assert.strictEqual(enriched.phone_quality.primary_normalized, enriched.phone_quality.second_normalized);

    // 4. Address Quality
    assert.strictEqual(enriched.address_quality.is_valid, false);
    assert.strictEqual(enriched.address_quality.result, 'ADDRESS_WEAK');
    assert.strictEqual(enriched.address_quality.word_count, 2);

    // 5. Drawer & Action Confirmed
    assert.strictEqual(enriched.is_actioned, false);
    assert.notStrictEqual(enriched.overall_quality.description, 'الطلب مستوفي معايير الجودة ولا توجد استثناءات معلقة.');
  });

  // Test Case 8: صحة ربط اسم المنتج وكود الصنف وكود التاجر والمخزن
  it('8. Verifies correct mapping of Product Name, Product SKU, Merchant Code, and Warehouse on Order 2224493', () => {
    const row = db.prepare('SELECT * FROM current_work_orders WHERE order_code = ?').get('2224493')
             || db.prepare('SELECT * FROM vendoor_orders WHERE order_code = ?').get('2224493');
    const enriched = enrichOrderOperationalIntelligence(row);

    // Real Product Name must NOT be generic fallback 'Product'
    assert.strictEqual(enriched.real_product_name, 'شبشب رجالى برادا صابع كـود111 (مخزن 100)');
    assert.strictEqual(enriched.product_name, 'شبشب رجالى برادا صابع كـود111 (مخزن 100)');

    // Product SKU / Code
    assert.strictEqual(enriched.product_sku, 'prada111-#DCDCDC-42');

    // Merchant Code distinct from both
    assert.strictEqual(enriched.merchant_code, '36735');
    assert.notStrictEqual(enriched.merchant_code, enriched.real_product_name);
    assert.notStrictEqual(enriched.merchant_code, enriched.product_sku);

    // Warehouse identifier distinct from them
    assert.strictEqual(enriched.warehouse, 'مخزن 100');
    assert.notStrictEqual(enriched.warehouse, enriched.merchant_code);

    // Products array has authentic items
    assert.ok(enriched.products.length >= 1);
    const p0 = enriched.products[0];
    assert.strictEqual(p0.product_name, 'شبشب رجالى برادا صابع كـود111 (مخزن 100)');
    assert.strictEqual(p0.product_sku, 'prada111-#DCDCDC-42');
    assert.strictEqual(p0.merchant_code, '36735');
    assert.strictEqual(p0.warehouse, 'مخزن 100');
  });

});
