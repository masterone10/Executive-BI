import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  normalizePhoneNumber,
  evaluateSecondPhoneQuality,
  evaluateAddressQuality,
  evaluateDeliveryRate,
  enrichOrderOperationalIntelligence
} from '../services/operational_intelligence.js';

describe('Operational Intelligence & Locked Business Rules Suite', () => {

  // =========================================================================
  // 1. FEATURE 1: DISTINCT SECOND PHONE ADDITION
  // =========================================================================
  describe('Feature 1: Distinct Second Phone Evaluation', () => {

    it('Normalizes phone numbers across Arabic/Persian digits, formatting, and country codes', () => {
      // Latin digits with dashes/spaces
      assert.strictEqual(normalizePhoneNumber('011-2345-6789'), '01123456789');
      assert.strictEqual(normalizePhoneNumber('+20 11 2345 6789'), '01123456789');
      assert.strictEqual(normalizePhoneNumber('00201123456789'), '01123456789');

      // Eastern Arabic digits
      assert.strictEqual(normalizePhoneNumber('٠١١٢٣٤٥٦٧٨٩'), '01123456789');

      // Empty / invalid
      assert.strictEqual(normalizePhoneNumber(''), '');
      assert.strictEqual(normalizePhoneNumber(null), '');
      assert.strictEqual(normalizePhoneNumber('abc'), '');
    });

    it('Classifies missing second phone as ALT_PHONE_MISSING', () => {
      const res1 = evaluateSecondPhoneQuality('01123456789', '', true);
      assert.strictEqual(res1.status, 'ALT_PHONE_MISSING');
      assert.strictEqual(res1.is_distinct, false);
      assert.strictEqual(res1.needs_attention, true);

      const res2 = evaluateSecondPhoneQuality('01123456789', null, true);
      assert.strictEqual(res2.status, 'ALT_PHONE_MISSING');
      assert.strictEqual(res2.needs_attention, true);
    });

    it('Classifies identical second phone as ALT_PHONE_DUPLICATE_PRIMARY', () => {
      const res = evaluateSecondPhoneQuality('01123456789', '01123456789', true);
      assert.strictEqual(res.status, 'ALT_PHONE_DUPLICATE_PRIMARY');
      assert.strictEqual(res.is_distinct, false);
      assert.strictEqual(res.needs_attention, true);
    });

    it('Detects duplicate primary phone even with different formatting or country code', () => {
      // Primary in local format, Second in international format
      const res = evaluateSecondPhoneQuality('01123456789', '+20 11 2345 6789', true);
      assert.strictEqual(res.status, 'ALT_PHONE_DUPLICATE_PRIMARY');
      assert.strictEqual(res.is_distinct, false);
      assert.strictEqual(res.needs_attention, true);
      assert.strictEqual(res.primary_normalized, res.second_normalized);
    });

    it('Classifies genuinely distinct second phone as ALT_PHONE_ADDED', () => {
      const res = evaluateSecondPhoneQuality('01123456789', '01098765432', true);
      assert.strictEqual(res.status, 'ALT_PHONE_ADDED');
      assert.strictEqual(res.is_distinct, true);
      assert.strictEqual(res.needs_attention, false);
    });

    it('Does not flag un-actioned orders as needing attention for missing phone', () => {
      const res = evaluateSecondPhoneQuality('01123456789', '', false);
      assert.strictEqual(res.status, 'ALT_PHONE_MISSING');
      assert.strictEqual(res.needs_attention, false);
    });
  });

  // =========================================================================
  // 2. FEATURE 2: ADDRESS QUALITY
  // =========================================================================
  describe('Feature 2: Address Quality Evaluation', () => {

    it('Rejects empty or symbol-only addresses as INVALID', () => {
      assert.strictEqual(evaluateAddressQuality('').status, 'INVALID');
      assert.strictEqual(evaluateAddressQuality('   ').status, 'INVALID');
      assert.strictEqual(evaluateAddressQuality(null).status, 'INVALID');
      assert.strictEqual(evaluateAddressQuality('... --- ///').status, 'INVALID');
    });

    it('Rejects English addresses as INVALID', () => {
      const res = evaluateAddressQuality('Ahmed Cairo Street');
      assert.strictEqual(res.status, 'INVALID');
      assert.strictEqual(res.language, 'ENGLISH');
      assert.strictEqual(res.is_valid, false);
      assert.ok(res.reason.includes('باللغة الإنجليزية'));
    });

    it('Rejects Mixed Arabic and English addresses as INVALID', () => {
      const res = evaluateAddressQuality('شارع Ahmed الثورة القاهرة');
      assert.strictEqual(res.status, 'INVALID');
      assert.strictEqual(res.language, 'MIXED');
      assert.strictEqual(res.is_valid, false);
      assert.ok(res.reason.includes('كلمات إنجليزية'));
    });

    it('Evaluates Arabic addresses based on word count strictly (<= 3 words = INVALID, >= 4 words = VALID)', () => {
      // 1 word -> INVALID
      const r1 = evaluateAddressQuality('القاهرة');
      assert.strictEqual(r1.status, 'INVALID');
      assert.strictEqual(r1.word_count, 1);
      assert.strictEqual(r1.is_valid, false);

      // 2 words -> INVALID
      const r2 = evaluateAddressQuality('مصر الجديدة');
      assert.strictEqual(r2.status, 'INVALID');
      assert.strictEqual(r2.word_count, 2);
      assert.strictEqual(r2.is_valid, false);

      // 3 words -> INVALID
      const r3 = evaluateAddressQuality('شارع الثورة القاهرة');
      assert.strictEqual(r3.status, 'INVALID');
      assert.strictEqual(r3.word_count, 3);
      assert.strictEqual(r3.is_valid, false);

      // 4 words -> VALID
      const r4 = evaluateAddressQuality('شارع الثورة مصر الجديدة');
      assert.strictEqual(r4.status, 'VALID');
      assert.strictEqual(r4.word_count, 4);
      assert.strictEqual(r4.is_valid, true);

      // 5+ words -> VALID
      const r5 = evaluateAddressQuality('شارع الثورة مصر الجديدة بجوار البنك');
      assert.strictEqual(r5.status, 'VALID');
      assert.strictEqual(r5.word_count, 6);
      assert.strictEqual(r5.is_valid, true);
    });

    it('Handles repeated spaces and meaningless punctuation correctly during word normalization', () => {
      const res = evaluateAddressQuality('  شارع   الثورة  ،،  مصر   الجديدة  .. ');
      assert.strictEqual(res.status, 'VALID');
      assert.strictEqual(res.word_count, 4);
      assert.strictEqual(res.is_valid, true);
    });
  });

  // =========================================================================
  // 3. FEATURE 3: DELIVERY RATE BELOW 70%
  // =========================================================================
  describe('Feature 3: Delivery Rate Evaluation', () => {

    it('Flags delivery rate below 70% as DELIVERY_RATE_LOW', () => {
      const r0 = evaluateDeliveryRate(0);
      assert.strictEqual(r0.status, 'DELIVERY_RATE_LOW');
      assert.strictEqual(r0.needs_attention, true);

      const r62 = evaluateDeliveryRate(62);
      assert.strictEqual(r62.status, 'DELIVERY_RATE_LOW');
      assert.strictEqual(r62.needs_attention, true);
      assert.ok(r62.alert.includes('62.0%'));

      const r699 = evaluateDeliveryRate(69.99);
      assert.strictEqual(r699.status, 'DELIVERY_RATE_LOW');
      assert.strictEqual(r699.needs_attention, true);
    });

    it('Accepts delivery rate >= 70% as DELIVERY_RATE_OK', () => {
      const r70 = evaluateDeliveryRate(70);
      assert.strictEqual(r70.status, 'DELIVERY_RATE_OK');
      assert.strictEqual(r70.needs_attention, false);
      assert.strictEqual(r70.alert, null);

      const r7001 = evaluateDeliveryRate(70.01);
      assert.strictEqual(r7001.status, 'DELIVERY_RATE_OK');
      assert.strictEqual(r7001.needs_attention, false);

      const r100 = evaluateDeliveryRate(100);
      assert.strictEqual(r100.status, 'DELIVERY_RATE_OK');
      assert.strictEqual(r100.needs_attention, false);
    });

    it('Treats missing, null, or empty string as DELIVERY_RATE_UNKNOWN without generating false alert', () => {
      const rNull = evaluateDeliveryRate(null);
      assert.strictEqual(rNull.status, 'DELIVERY_RATE_UNKNOWN');
      assert.strictEqual(rNull.needs_attention, false);
      assert.strictEqual(rNull.rate, null);
      assert.strictEqual(rNull.alert, null);

      const rUndef = evaluateDeliveryRate(undefined);
      assert.strictEqual(rUndef.status, 'DELIVERY_RATE_UNKNOWN');
      assert.strictEqual(rUndef.needs_attention, false);

      const rEmpty = evaluateDeliveryRate('');
      assert.strictEqual(rEmpty.status, 'DELIVERY_RATE_UNKNOWN');
      assert.strictEqual(rEmpty.needs_attention, false);
    });
  });

  // =========================================================================
  // 4. ORDER ENRICHMENT INTEGRATION
  // =========================================================================
  describe('Full Order Enrichment Integration', () => {
    it('Correctly enriches order and compiles operational alerts', () => {
      const order = {
        order_code: 'ORD-999',
        status: 'Printed',
        work_state: 'PRINTED',
        phone: '01123456789',
        phone2: '', // missing
        address: 'شارع الثورة', // weak (2 words)
        delivery_rate: 65 // low (< 70%)
      };

      const enriched = enrichOrderOperationalIntelligence(order);
      assert.strictEqual(enriched.is_actioned, true);
      assert.strictEqual(enriched.phone_quality.status, 'ALT_PHONE_MISSING');
      assert.strictEqual(enriched.address_quality.status, 'INVALID');
      assert.strictEqual(enriched.delivery_quality.status, 'DELIVERY_RATE_LOW');
      assert.strictEqual(enriched.needs_attention, true);
      assert.strictEqual(enriched.operational_alerts.length, 3);
    });
  });
});
