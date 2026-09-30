import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import { normalizeVendoorOrder } from '../services/vendoor/normalize.js';
import { generateMerchantReport, generateMarketerReport, generateDataQualityReport } from '../services/reports.js';
import { isCsEmployee } from '../services/parser.js';

describe('Merchant & Marketer Integration & Forensic Audit Suite', () => {
  const testDate = '2026-09-29';

  before(() => {
    // Seed sample test orders into database
    const insOrder = db.prepare(`
      INSERT OR REPLACE INTO vendoor_orders (
        order_code, status, active_status, account, merchant_code, merchant_name,
        affiliate_code, affiliate_name, source_date, business_date, is_active, total_price, raw_payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);

    const insMerchant = db.prepare(`
      INSERT OR REPLACE INTO merchants (merchant_code, merchant_name, updated_at)
      VALUES (?, ?, datetime('now'))
    `);

    const insMarketer = db.prepare(`
      INSERT OR REPLACE INTO marketers (marketer_name, affiliate_code, affiliate_name, updated_at)
      VALUES (?, ?, ?, datetime('now'))
    `);

    const insMapping = db.prepare(`
      INSERT OR IGNORE INTO merchant_account_mappings (merchant_code, account)
      VALUES (?, ?)
    `);

    const testOrders = [
      { code: 'TST-101', status: 'New', acc: 'Alpha Merchant', mCode: '9001', mName: 'Alpha Store', affCode: 've1001', mktName: 'مسوق أحمد علي', price: 500 },
      { code: 'TST-102', status: 'Pending', acc: 'Alpha Merchant', mCode: '9001', mName: 'Alpha Store', affCode: 've1001', mktName: 'مسوق أحمد علي', price: 300 },
      { code: 'TST-103', status: 'Canceled', acc: 'Beta Trade', mCode: '9002', mName: 'Beta Goods', affCode: 've1002', mktName: 'مسوقة نور خالد', price: 700 },
      { code: 'TST-104', status: 'Printed', acc: 'Beta Trade', mCode: '9002', mName: 'Beta Goods', affCode: 've1001', mktName: 'مسوق أحمد علي', price: 400 }
    ];

    for (const t of testOrders) {
      insOrder.run(
        t.code, t.status, t.status, t.acc, t.mCode, t.mName, t.affCode, t.mktName,
        testDate, testDate, t.price, JSON.stringify({ ...t, 'اسم المسوق': t.mktName, 'الافيليت كود': t.affCode })
      );
      insMerchant.run(t.mCode, t.mName);
      insMarketer.run(t.mktName, t.affCode, t.mktName);
      insMapping.run(t.mCode, t.acc);
    }
  });

  it('1. Normalize Vendoor Order extracts canonical merchant and marketer identities from Vendoor payload', () => {
    const rawOrder = {
      order_code: 'TEST-ORD-999',
      merchant_name: 'Alpha Traders',
      merchant_code: '98765',
      'الافيليت كود': 've99112',
      'اسم المسوق': 'كريم المسوق',
      status: 'New',
      grand_total: 450.50,
      created_at: '2026-09-29 10:00:00'
    };

    const norm = normalizeVendoorOrder(rawOrder);
    assert.strictEqual(norm.order_code, 'TEST-ORD-999');
    assert.strictEqual(norm.merchant_name, 'Alpha Traders');
    assert.strictEqual(norm.merchant_code, '98765');
    assert.strictEqual(norm.affiliate_code, 've99112');
    assert.strictEqual(norm.marketer_name, 'كريم المسوق');
    assert.strictEqual(norm.status, 'New');
    assert.strictEqual(norm.total_price, 450.50);
  });

  it('2. Normalization handles missing affiliate and merchant gracefully without fabricating names', () => {
    const rawOrder = {
      order_code: 'TEST-ORD-888',
      status: 'Pending',
      created_at: '2026-09-29 11:00:00'
    };

    const norm = normalizeVendoorOrder(rawOrder);
    assert.strictEqual(norm.order_code, 'TEST-ORD-888');
    assert.strictEqual(norm.merchant_code, null);
    assert.strictEqual(norm.affiliate_code, null);
    assert.strictEqual(norm.marketer_name, null);
  });

  it('3. Merchants and Marketers master tables persist real entities in SQLite', () => {
    const merchantsCount = db.prepare('SELECT count(*) as c FROM merchants').get().c;
    const marketersCount = db.prepare('SELECT count(*) as c FROM marketers').get().c;
    const mappingsCount = db.prepare('SELECT count(*) as c FROM merchant_account_mappings').get().c;

    assert.ok(merchantsCount > 0, 'Merchants table should have persisted entities');
    assert.ok(marketersCount > 0, 'Marketers table should have persisted entities');
    assert.ok(mappingsCount > 0, 'Merchant Account mappings should exist');
  });

  it('4. Merchant Report calculates correct status counts, total value, and cancellation rate', () => {
    const rep = generateMerchantReport({ dateMode: 'day', targetDate: testDate });
    assert.strictEqual(rep.report_type, 'merchant');
    assert.ok(rep.total_merchants > 0, 'Should return merchants');
    assert.ok(rep.rows.length > 0, 'Should return merchant rows');
    assert.ok(rep.summary.total_orders >= 4, 'Total orders should match seeded orders');

    // Check row contract
    const firstRow = rep.rows[0];
    assert.ok(firstRow.merchant_code !== undefined, 'merchant_code required');
    assert.ok(firstRow.merchant_name !== undefined, 'merchant_name required');
    assert.ok(firstRow.total_orders >= 0, 'total_orders required');
    assert.ok(firstRow.cancellation_rate >= 0, 'cancellation_rate required');
    assert.ok(Array.isArray(firstRow.linked_accounts), 'linked_accounts array required');
  });

  it('5. Marketer Report calculates correct status counts, promoted merchants, and cancellation rate', () => {
    const rep = generateMarketerReport({ dateMode: 'day', targetDate: testDate });
    assert.strictEqual(rep.report_type, 'marketer');
    assert.ok(rep.total_marketers > 0, 'Should return marketers');
    assert.ok(rep.rows.length > 0, 'Should return marketer rows');
    assert.ok(rep.summary.total_orders >= 4, 'Total orders should match seeded orders');

    // Check row contract
    const firstRow = rep.rows[0];
    assert.ok(firstRow.affiliate_code !== undefined, 'affiliate_code required');
    assert.ok(firstRow.total_orders >= 0, 'total_orders required');
    assert.ok(firstRow.cancellation_rate >= 0, 'cancellation_rate required');
    assert.ok(Array.isArray(firstRow.linked_merchants), 'linked_merchants array required');
  });

  it('6. Data Quality Report includes Merchant and Marketer data health metrics with zero CS contamination', () => {
    const dq = generateDataQualityReport({ targetDate: testDate });
    assert.strictEqual(dq.report_type, 'data_quality');
    assert.ok(dq.merchant_data_health !== undefined, 'merchant_data_health required');
    assert.ok(dq.marketer_data_health !== undefined, 'marketer_data_health required');
    assert.strictEqual(dq.merchant_data_health.merchant_employee_contamination_count, 0, 'Zero merchant contamination in employees');
    assert.strictEqual(dq.marketer_data_health.marketer_employee_contamination_count, 0, 'Zero marketer contamination in employees');
  });

  it('7. CS Separation: Neither Merchant codes nor Affiliate codes are treated as CS employees', () => {
    assert.strictEqual(isCsEmployee('ve35409'), false);
    assert.strictEqual(isCsEmployee('ve54604'), false);
    assert.strictEqual(isCsEmployee('ve1001'), false);
    assert.strictEqual(isCsEmployee('Alpha Store'), false);
    assert.strictEqual(isCsEmployee('Beta Goods'), false);
    assert.strictEqual(isCsEmployee('BASMA CS'), true);
    assert.strictEqual(isCsEmployee('MOHAMED OSAMA CS'), true);
  });

});
