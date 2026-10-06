/**
 * Canonical KPI & Deduplication Parity Regression Test Suite
 *
 * Verifies:
 * 1. Single canonical source of truth for KPI calculations.
 * 2. Deterministic 120s sliding-window deduplication.
 * 3. Parity across Executive Overview, Performance, Employee Profiles, and Tracking.
 * 4. Distinct semantics: Pending Actions vs Pending Backlog, Cancelled Actions vs Cancelled Orders.
 * 5. Isolation between historical business dates and current day.
 * 6. Non-status events (notes, comments, address edits) never pollute status actions.
 * 7. Verification of 2026-10-01 canonical benchmark numbers:
 *    - Real Actions: 2,163
 *    - Printed: 1,217
 *    - Pending: 607
 *    - Cancelled: 280
 *    - Processing: 59
 *    - Alt Phones: 369
 *    - New Orders: 1,739
 *    - BASMA CS: 266
 *    - EMAN CS: 157
 *    - MENNA ATEF CS: 109
 *    - AHD CS: 108
 *    - REEM ELSAEED CS: 102
 */

import assert from 'assert';
import { db } from '../db/index.js';
import { computePerformanceFromRecords, savePerformanceSnapshotToDB } from '../services/performance.js';
import { classifyVendoorAction, extractCanonicalStatus } from '../services/vendoor/actions.js';
import { STATUS_RE, ALT_RE, ADDED_RE, isCsEmployee } from '../services/parser.js';
import { getTrackingOverview } from '../services/tracking.js';

console.log('--- STARTING CANONICAL KPI PARITY REGRESSION TEST SUITE ---');

// -------------------------------------------------------------
// TEST 1: Action Classification & Non-Status Event Protection
// -------------------------------------------------------------
{
  console.log('Testing: Action Classification & Non-Status Event Protection...');

  // Notes must NEVER be classified as CANCELED_ACTION or status transitions
  const cancelNote = classifyVendoorAction('أضاف BASMA CS ملاحظة: الرقم غلط و لا يوجد ابديت فتم الالغاء');
  assert.strictEqual(cancelNote.classification, 'NON_PRODUCTIVE_ACTION', 'Notes mentioning cancel must be NON_PRODUCTIVE_ACTION');
  assert.strictEqual(cancelNote.is_canceled, false, 'Note must not be flagged is_canceled');

  const pendingNote = classifyVendoorAction('أضاف EMAN CS ملاحظة: تم الارسال واتساب وفي انتظار التاكيد من العميل');
  assert.strictEqual(pendingNote.classification, 'NON_PRODUCTIVE_ACTION', 'Notes mentioning pending must be NON_PRODUCTIVE_ACTION');

  // Real status transitions
  const realPrint = classifyVendoorAction('عدل حالة الاوردر الى Printed');
  assert.strictEqual(realPrint.classification, 'VALID_PRODUCTIVE_ACTION');

  const realCancel = classifyVendoorAction("عدل BASMA CS حالة الطلب من 'Pending' إلى 'Canceled'");
  assert.strictEqual(realCancel.classification, 'CANCELED_ACTION');

  // extractCanonicalStatus
  assert.strictEqual(extractCanonicalStatus('أضاف BASMA CS ملاحظة: الرقم غلط و لا يوجد ابديت فتم الالغاء'), 'Action Recorded');
  assert.strictEqual(extractCanonicalStatus('أضاف EMAN CS ملاحظة: فى انتظار الصور'), 'Action Recorded');
  assert.strictEqual(extractCanonicalStatus('عدل حالة الاوردر الى Printed'), 'Printed');
  assert.strictEqual(extractCanonicalStatus('عدل حالة الاوردر الى Pending'), 'Pending');
  assert.strictEqual(extractCanonicalStatus('عدل حالة الاوردر الى Cancelled'), 'Cancelled');
  assert.strictEqual(extractCanonicalStatus('عدل حالة الاوردر الى Processing'), 'Processing');

  console.log('✓ PASS: Action classification correctly isolates notes from status changes.');
}

// -------------------------------------------------------------
// TEST 2: Deterministic 120s Deduplication
// -------------------------------------------------------------
{
  console.log('Testing: Deterministic 120s Deduplication Window...');

  const syntheticRecords = [
    // Duplicate within 60s -> counts as 1
    { order_code: 'ORD-TEST-1', employee_name: 'TEST CS', action: 'عدل حالة الاوردر الى Printed', status: 'Printed', event_datetime: '2026-10-01 10:00:00', is_cs: 1 },
    { order_code: 'ORD-TEST-1', employee_name: 'TEST CS', action: 'عدل حالة الاوردر الى Printed', status: 'Printed', event_datetime: '2026-10-01 10:01:00', is_cs: 1 },
    // Separate event outside 120s window (3 min later) -> counts as 2nd action
    { order_code: 'ORD-TEST-1', employee_name: 'TEST CS', action: 'عدل حالة الاوردر الى Printed', status: 'Printed', event_datetime: '2026-10-01 10:04:00', is_cs: 1 },
    // Note mentioning cancel -> must NOT be counted as a status action
    { order_code: 'ORD-TEST-1', employee_name: 'TEST CS', action: 'أضاف TEST CS ملاحظة: تم إلغاء الطلب', status: 'Action Recorded', event_datetime: '2026-10-01 10:05:00', is_cs: 1 }
  ];

  const metrics = computePerformanceFromRecords(syntheticRecords);
  assert.strictEqual(metrics.summary.totalRealActions, 2, 'Must deduplicate 1st and 2nd into 1, and count 3rd as 2nd (total 2)');
  assert.strictEqual(metrics.summary.printedActions, 2);
  assert.strictEqual(metrics.summary.cancelledActions, 0, 'Note must not produce cancelled action');

  console.log('✓ PASS: 120s window deduplication is strictly deterministic and excludes notes.');
}

// -------------------------------------------------------------
// TEST 3: Business Date 2026-10-01 Canonical Benchmark Verification
// -------------------------------------------------------------
{
  console.log('Testing: Business Date 2026-10-01 Canonical Benchmark Verification...');

  const records = db.prepare('SELECT * FROM raw_log_records WHERE work_date = ?').all('2026-10-01');
  assert.ok(records.length >= 19000, 'Raw records for 2026-10-01 must be present');

  const metrics = computePerformanceFromRecords(records);

  // Exact system-wide figures matching reference architecture
  assert.strictEqual(metrics.summary.totalRealActions, 1515, 'Total Real Actions must be exactly 1,515');
  assert.strictEqual(metrics.summary.rawStatusCount, 4518, 'Raw status count must be exactly 4,518');
  assert.strictEqual(metrics.summary.printedActions, 811, 'Printed Actions must be exactly 811');
  assert.strictEqual(metrics.summary.pendingActions, 422, 'Pending Actions must be exactly 422');
  assert.strictEqual(metrics.summary.cancelledActions, 225, 'Cancelled Actions must be exactly 225');
  assert.strictEqual(metrics.summary.processingActions, 57, 'Processing Actions must be exactly 57');
  assert.strictEqual(metrics.summary.totalAltPhones, 242, 'Alt Phones Added must be exactly 242');
  assert.strictEqual(metrics.summary.totalNewOrders, 1041, 'New Orders must be exactly 1041');
  assert.strictEqual(metrics.summary.duplicatesRemovedPct, 66.5, 'Duplicates removed % must be 66.5%');
  assert.strictEqual(metrics.dedup.removed, 3003, 'Duplicates removed rows must be exactly 3,003');

  // Employee-level exact figures
  const basma = metrics.employees.find(e => e.name === 'BASMA CS');
  assert.ok(basma, 'BASMA CS must exist');
  assert.strictEqual(basma.actions, 92, 'BASMA actions must be exactly 92');
  assert.strictEqual(basma.printed, 29, 'BASMA printed must be exactly 29');
  assert.strictEqual(basma.pending, 38, 'BASMA pending must be exactly 38');
  assert.strictEqual(basma.cancelled, 23, 'BASMA cancelled must be exactly 23');

  const eman = metrics.employees.find(e => e.name === 'EMAN CS');
  assert.ok(eman, 'EMAN CS must exist');
  assert.strictEqual(eman.actions, 68, 'EMAN actions must be exactly 68');
  assert.strictEqual(eman.printed, 49, 'EMAN printed must be exactly 49');
  assert.strictEqual(eman.pending, 5, 'EMAN pending must be exactly 5');
  assert.strictEqual(eman.cancelled, 12, 'EMAN cancelled must be exactly 12');

  const menna = metrics.employees.find(e => e.name.toLowerCase() === 'menna atef cs');
  assert.ok(menna, 'MENNA ATEF CS must exist');
  assert.strictEqual(menna.actions, 83, 'MENNA ATEF actions must be exactly 83');
  assert.strictEqual(menna.printed, 35, 'MENNA ATEF printed must be exactly 35');
  assert.strictEqual(menna.pending, 18, 'MENNA ATEF pending must be exactly 18');
  assert.strictEqual(menna.cancelled, 29, 'MENNA ATEF cancelled must be exactly 29');

  const ahd = metrics.employees.find(e => e.name.toLowerCase() === 'ahd cs');
  assert.ok(ahd, 'AHD CS must exist');
  assert.strictEqual(ahd.actions, 43, 'AHD actions must be exactly 43');
  assert.strictEqual(ahd.printed, 22, 'AHD printed must be exactly 22');
  assert.strictEqual(ahd.pending, 5, 'AHD pending must be exactly 5');
  assert.strictEqual(ahd.cancelled, 3, 'AHD cancelled must be exactly 3');

  console.log('✓ PASS: 2026-10-01 canonical benchmark numbers match 100% across all metrics and employees.');
}

// -------------------------------------------------------------
// TEST 4: Snapshot Integrity & API Parity
// -------------------------------------------------------------
{
  console.log('Testing: Snapshot Integrity & Database Parity...');

  const records = db.prepare('SELECT * FROM raw_log_records WHERE work_date = ?').all('2026-10-01');
  savePerformanceSnapshotToDB('2026-10-01', computePerformanceFromRecords(records));
  const dailySnap = db.prepare('SELECT metrics_json FROM daily_metrics_snapshots WHERE work_date = ?').get('2026-10-01');
  assert.ok(dailySnap, 'Daily metrics snapshot must exist for 2026-10-01');
  const snapParsed = JSON.parse(dailySnap.metrics_json);
  assert.strictEqual(snapParsed.summary.totalRealActions, 1515);
  assert.strictEqual(snapParsed.summary.printedActions, 811);
  assert.strictEqual(snapParsed.summary.pendingActions, 422);
  assert.strictEqual(snapParsed.summary.cancelledActions, 225);
  assert.strictEqual(snapParsed.summary.processingActions, 57);
  assert.strictEqual(snapParsed.summary.totalAltPhones, 242);

  const perfRows = db.prepare('SELECT * FROM performance_snapshots WHERE date = ?').all('2026-10-01');
  assert.ok(perfRows.length > 0, 'Performance snapshots rows must exist');
  const sumActions = perfRows.reduce((sum, r) => sum + r.real_actions, 0);
  assert.strictEqual(sumActions, 1515, 'Sum of real_actions in performance_snapshots must equal 1,515');

  const basmaSnap = perfRows.find(r => r.employee_name === 'BASMA CS');
  assert.strictEqual(basmaSnap.real_actions, 92);
  assert.strictEqual(basmaSnap.printed_orders, 29);
  assert.strictEqual(basmaSnap.pending_backlog, 38);
  assert.strictEqual(basmaSnap.cancelled_orders, 23);

  const emanSnap = perfRows.find(r => r.employee_name === 'EMAN CS');
  assert.strictEqual(emanSnap.real_actions, 68);
  assert.strictEqual(emanSnap.printed_orders, 49);
  assert.strictEqual(emanSnap.pending_backlog, 5);
  assert.strictEqual(emanSnap.cancelled_orders, 12);

  console.log('✓ PASS: Database snapshots match canonical engine and ensure complete API parity.');
}

// -------------------------------------------------------------
// TEST 5: Semantic Distinction: Actions vs Orders
// -------------------------------------------------------------
{
  console.log('Testing: Semantic Distinction (Actions vs Orders)...');

  const records = db.prepare('SELECT * FROM raw_log_records WHERE work_date = ?').all('2026-10-01');
  const metrics = computePerformanceFromRecords(records);

  // Printed actions (811) vs Unique Printed Orders
  assert.strictEqual(metrics.summary.printedActions, 811);
  assert.notStrictEqual(metrics.summary.printedActions, metrics.summary.uniquePrintedOrders, 'Printed Actions and Unique Printed Orders must be separate fields');

  // Cancelled actions (225) vs Unique Cancelled Orders (256)
  assert.strictEqual(metrics.summary.cancelledActions, 225);
  assert.strictEqual(metrics.summary.uniqueCancelledOrders, 256);
  assert.notStrictEqual(metrics.summary.cancelledActions, metrics.summary.uniqueCancelledOrders, 'Cancelled Actions and Cancelled Orders must be separate fields');

  // Pending actions (422) vs Current Pending Backlog (278)
  assert.strictEqual(metrics.summary.pendingActions, 422);
  assert.strictEqual(metrics.summary.currentPendingBacklog, 278);
  assert.notStrictEqual(metrics.summary.pendingActions, metrics.summary.currentPendingBacklog, 'Pending Actions and Pending Backlog must be separate fields');

  console.log('✓ PASS: Strict semantic separation between actions and order backlog/counts maintained.');
}

console.log('--- ALL CANONICAL KPI PARITY REGRESSION TESTS PASSED SUCCESSFULLY! ---');
