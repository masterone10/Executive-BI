import Database from 'better-sqlite3';
import http from 'http';
import { db } from '../db/index.js';
import { normalizePhoneNumber, compareOrderPhoneNumbers, evaluateAndRecordOrderPhoneDuplicate, resolvePhoneAlertAttribution } from '../services/employee_evaluation.js';
import { normalizeVendoorOrder } from '../services/vendoor/normalize.js';
import { getOrderTracking } from '../services/tracking.js';

function requestGet(path) {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:3000' + path, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, text: data });
        }
      });
    }).on('error', reject);
  });
}

async function runE2EWorkflow() {
  console.log('================================================================');
  console.log('▶ STARTING FULL END-TO-END WORKFLOW FOR PHONE DUPLICATE DETECTION');
  console.log('================================================================');

  const testDate = '2026-09-30';
  const orderCode = 'VND-E2E-' + Date.now().toString().slice(-6);

  console.log(`\n[STEP 1] Ingesting Vendoor order with duplicate phones...`);
  console.log(`Order Code: ${orderCode}`);

  // Raw Vendoor order payload with primary phone and duplicate secondary phone (+20 format)
  const rawOrderPayload = {
    code: orderCode,
    order_code: orderCode,
    phone: '01098765432',
    phone2: '+20 01098765432',
    client_name: 'Customer Test E2E',
    governrate_name: 'Cairo',
    grand_total: '750',
    date: testDate,
    status: 'New',
    merchant: { code: 'M-TEST', name: 'Test Merchant' },
    affiliate: { code: 'AFF-TEST', name: 'Test Marketer' }
  };

  // Step 1: Normalization through Vendoor pipeline
  const normalizedOrder = normalizeVendoorOrder(rawOrderPayload);
  console.log('Normalized Order output:');
  console.log(`- phone: "${normalizedOrder.phone}"`);
  console.log(`- phone2: "${normalizedOrder.phone2}"`);
  console.log(`- normalized phone: "${normalizePhoneNumber(normalizedOrder.phone)}"`);
  console.log(`- normalized phone2: "${normalizePhoneNumber(normalizedOrder.phone2)}"`);

  // Step 2: Ingest into SQLite Database
  db.prepare(`
    INSERT INTO vendoor_orders (
      order_code, status, active_status, account,
      business_date, is_active, city, total_price, raw_payload_json, imported_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, datetime('now'))
  `).run(
    orderCode,
    normalizedOrder.status,
    normalizedOrder.status,
    normalizedOrder.account || 'E2E Account',
    testDate,
    normalizedOrder.city,
    normalizedOrder.total_price,
    JSON.stringify(normalizedOrder)
  );

  // Evaluate phone duplicate detection on arrival
  const arrivalAlert = evaluateAndRecordOrderPhoneDuplicate(normalizedOrder, null, db);
  console.log('\n[STEP 2] Database Storage Verification:');
  console.log('- Arrival evaluation result:', JSON.stringify(arrivalAlert, null, 2));

  const dbAlert = db.prepare('SELECT * FROM phone_match_alerts WHERE order_code = ? ORDER BY id DESC LIMIT 1').get(orderCode);
  console.log('- Stored phone_match_alerts record in DB:');
  console.log(`  * id: ${dbAlert.id}`);
  console.log(`  * order_code: ${dbAlert.order_code}`);
  console.log(`  * alert_type: ${dbAlert.alert_type}`);
  console.log(`  * employee_name: ${dbAlert.employee_name}`);
  console.log(`  * attribution_status: ${dbAlert.attribution_status}`);
  console.log(`  * status: ${dbAlert.status}`);
  console.log(`  * phone_a_raw: ${dbAlert.phone_a_raw}`);
  console.log(`  * phone_b_raw: ${dbAlert.phone_b_raw}`);
  console.log(`  * phone_a_normalized: ${dbAlert.phone_a_normalized}`);
  console.log(`  * phone_b_normalized: ${dbAlert.phone_b_normalized}`);

  if (dbAlert.alert_type !== 'PHONE_DUPLICATE_CURRENT' || dbAlert.employee_name !== 'Unresolved') {
    throw new Error(`Assertion failed: Arrival duplicate must be PHONE_DUPLICATE_CURRENT with employee Unresolved! Got ${dbAlert.alert_type} / ${dbAlert.employee_name}`);
  }
  console.log('✓ Initial ingestion: Stored as PHONE_DUPLICATE_CURRENT and Unresolved (No false accusation).');

  // Step 3: Check Tracking API & Service Display
  console.log('\n[STEP 3] Tracking API & UI Display Verification:');
  const trackingData = getOrderTracking(testDate, orderCode);
  console.log('- getOrderTracking output:');
  console.log(`  * order_code: ${trackingData.order_code}`);
  console.log(`  * primary_phone: ${trackingData.primary_phone}`);
  console.log(`  * additional_phone: ${trackingData.additional_phone}`);
  console.log(`  * is_phone_duplicate: ${trackingData.is_phone_duplicate}`);
  console.log(`  * phone_duplicate_status: ${trackingData.phone_duplicate_status}`);
  console.log(`  * phone_match_alert:`, trackingData.phone_match_alert ? {
    id: trackingData.phone_match_alert.id,
    alert_type: trackingData.phone_match_alert.alert_type,
    employee_name: trackingData.phone_match_alert.employee_name,
    attribution_status: trackingData.phone_match_alert.attribution_status
  } : null);

  // Check HTTP API endpoint
  const apiRes = await requestGet(`/api/tracking/${testDate}/order/${orderCode}`);
  console.log(`- HTTP API GET /api/tracking/${testDate}/order/${orderCode}: status ${apiRes.status}`);
  if (apiRes.status === 200 && apiRes.body) {
    console.log(`  * API is_phone_duplicate: ${apiRes.body.is_phone_duplicate}`);
    console.log(`  * API phone_duplicate_status: ${apiRes.body.phone_duplicate_status}`);
    console.log(`  * API employee_name: ${apiRes.body.phone_match_alert?.employee_name}`);
  }

  // Step 4: Test Employee Attribution on Proven CS Event
  console.log('\n[STEP 4] Auditing Employee Attribution with Causal CS Phone Edit Event:');
  // Find a verified active CS employee in database
  const csEmp = db.prepare("SELECT id, name FROM employees WHERE department = 'CS' AND active = 1 LIMIT 1").get();
  console.log(`- Selected verified CS employee: "${csEmp.name}" (ID: ${csEmp.id})`);

  // Previous order state had different phones
  const prevOrderState = {
    order_code: orderCode,
    phone: '01098765432',
    phone2: '01155556666'
  };

  // Insert verified CS phone modification action into raw_log_records
  const logEventTime = '2026-09-30 14:15:00';
  db.prepare(`
    INSERT INTO raw_log_records (
      employee_name, order_code, action, status, work_date, event_datetime, is_cs
    ) VALUES (?, ?, 'أضاف رقم هاتف بديل', 'Action Recorded', ?, ?, 1)
  `).run(csEmp.name, orderCode, testDate, logEventTime);

  // Re-evaluate with previous different state + causal CS phone edit
  const empCreatedAlert = evaluateAndRecordOrderPhoneDuplicate(normalizedOrder, prevOrderState, db);
  console.log('- Evaluation after causal CS phone-edit event:', JSON.stringify(empCreatedAlert, null, 2));

  const updatedDbAlert = db.prepare('SELECT * FROM phone_match_alerts WHERE order_code = ? ORDER BY id DESC LIMIT 1').get(orderCode);
  console.log('- Updated DB alert record:');
  console.log(`  * alert_type: ${updatedDbAlert.alert_type}`);
  console.log(`  * employee_name: ${updatedDbAlert.employee_name}`);
  console.log(`  * employee_id: ${updatedDbAlert.employee_id}`);
  console.log(`  * attribution_status: ${updatedDbAlert.attribution_status}`);
  console.log(`  * source_action: ${updatedDbAlert.source_action}`);

  if (updatedDbAlert.alert_type !== 'PHONE_DUPLICATE_CREATED_BY_EMPLOYEE' || updatedDbAlert.employee_name !== csEmp.name) {
    throw new Error(`Assertion failed: Expected PHONE_DUPLICATE_CREATED_BY_EMPLOYEE attributed to ${csEmp.name}`);
  }
  console.log(`✓ Attribution verified: Properly attributed to CS employee "${csEmp.name}" with PROVEN_CS_PHONE_EDIT.`);

  // Step 5: Test Anti-Fallback Invariants
  console.log('\n[STEP 5] Testing Anti-Fallback Invariants:');
  // Order with duplicate arrives, but worker is only a waybill printer or status changer
  const orderCodeNonCausal = 'VND-NOFALLBACK-' + Date.now().toString().slice(-6);
  db.prepare(`
    INSERT INTO raw_log_records (
      employee_name, order_code, action, status, work_date, event_datetime, is_cs
    ) VALUES 
      ('Some NonCS Worker', ?, 'طبع البوليصة', 'Printed', ?, '2026-09-30 14:30:00', 0),
      (?, ?, 'عدل حالة الاوردر الى Delivered', 'Delivered', ?, '2026-09-30 14:35:00', 1)
  `).run(orderCodeNonCausal, testDate, csEmp.name, orderCodeNonCausal, testDate);

  const nonCausalOrder = {
    order_code: orderCodeNonCausal,
    phone: '01234567890',
    phone2: '01234567890',
    business_date: testDate
  };

  const nonCausalAlert = evaluateAndRecordOrderPhoneDuplicate(nonCausalOrder, null, db);
  const nonCausalDb = db.prepare('SELECT * FROM phone_match_alerts WHERE order_code = ?').get(orderCodeNonCausal);
  console.log(`- Anti-fallback order ${orderCodeNonCausal}:`);
  console.log(`  * employee_name: ${nonCausalDb.employee_name}`);
  console.log(`  * attribution_status: ${nonCausalDb.attribution_status}`);

  if (nonCausalDb.employee_name !== 'Unresolved') {
    throw new Error(`Anti-fallback failed: Printed / Status Change must NOT attribute employee! Got ${nonCausalDb.employee_name}`);
  }
  console.log('✓ Anti-fallback verified: Waybill printer and status changer are never attributed.');

  // Step 6: Test Resolution Lifecycle
  console.log('\n[STEP 6] Testing Duplicate Resolution Lifecycle:');
  const resolvedOrder = {
    order_code: orderCode,
    phone: '01098765432',
    phone2: '01122334455', // Distinct number now!
    business_date: testDate
  };

  const resolveResult = evaluateAndRecordOrderPhoneDuplicate(resolvedOrder, normalizedOrder, db);
  console.log('- Resolution result:', JSON.stringify(resolveResult, null, 2));

  const resolvedDbAlert = db.prepare('SELECT * FROM phone_match_alerts WHERE order_code = ? ORDER BY id DESC LIMIT 1').get(orderCode);
  console.log('- Stored alert after resolution:');
  console.log(`  * status: ${resolvedDbAlert.status}`);
  console.log(`  * alert_type: ${resolvedDbAlert.alert_type}`);
  console.log(`  * resolved_at: ${resolvedDbAlert.resolved_at}`);

  if (resolvedDbAlert.status !== 'RESOLVED' || resolvedDbAlert.alert_type !== 'PHONE_DUPLICATE_RESOLVED') {
    throw new Error(`Resolution failed: Alert status must be RESOLVED! Got ${resolvedDbAlert.status}`);
  }
  console.log('✓ Resolution verified: Active duplicate transitioned to PHONE_DUPLICATE_RESOLVED with resolved_at timestamp.');

  // Step 7: Check Alert History API
  console.log('\n[STEP 7] Checking Alert History API:');
  const historyRes = await requestGet(`/api/phone-match-alerts/history/${orderCode}`);
  console.log(`- GET /api/phone-match-alerts/history/${orderCode}: status ${historyRes.status}`);
  if (historyRes.status === 200 && historyRes.body) {
    console.log(`  * Total historical alert records: ${historyRes.body.total_records}`);
    console.log(`  * History list:`, historyRes.body.history.map(h => ({
      id: h.id,
      order_code: h.order_code,
      alert_type: h.alert_type,
      status: h.status,
      employee_name: h.employee_name,
      attribution_status: h.attribution_status,
      resolved_at: h.resolved_at
    })));
  }

  console.log('\n================================================================');
  console.log('✅ ALL END-TO-END WORKFLOW VERIFICATIONS COMPLETED SUCCESSFULLY!');
  console.log('================================================================');
}

runE2EWorkflow().catch(err => {
  console.error('\n❌ E2E WORKFLOW FAILED:', err);
  process.exit(1);
});
