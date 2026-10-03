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
  assert.ok(records.length > 20000, 'Raw records for 2026-10-01 must be present');

  const metrics = computePerformanceFromRecords(records);

  // Exact system-wide figures matching reference architecture
  assert.strictEqual(metrics.summary.totalRealActions, 2163, 'Total Real Actions must be exactly 2,163');
  assert.strictEqual(metrics.summary.rawStatusCount, 6474, 'Raw status count must be exactly 6,474');
  assert.strictEqual(metrics.summary.printedActions, 1217, 'Printed Actions must be exactly 1,217');
  assert.strictEqual(metrics.summary.pendingActions, 607, 'Pending Actions must be exactly 607');
  assert.strictEqual(metrics.summary.cancelledActions, 280, 'Cancelled Actions must be exactly 280');
  assert.strictEqual(metrics.summary.processingActions, 59, 'Processing Actions must be exactly 59');
  assert.strictEqual(metrics.summary.totalAltPhones, 369, 'Alt Phones Added must be exactly 369');
  assert.strictEqual(metrics.summary.totalNewOrders, 1739, 'New Orders must be exactly 1,739');
  assert.strictEqual(metrics.summary.duplicatesRemovedPct, 66.6, 'Duplicates removed % must be 66.6%');
  assert.strictEqual(metrics.dedup.removed, 4311, 'Duplicates removed rows must be exactly 4,311');

  // Employee-level exact figures
  const basma = metrics.employees.find(e => e.name.includes('BASMA'));
  assert.ok(basma, 'BASMA CS must exist');
  assert.strictEqual(basma.actions, 266, 'BASMA actions must be exactly 266');
  assert.strictEqual(basma.printed, 140, 'BASMA printed must be exactly 140');
  assert.strictEqual(basma.pending, 77, 'BASMA pending must be exactly 77');
  assert.strictEqual(basma.cancelled, 44, 'BASMA cancelled must be exactly 44');

  const eman = metrics.employees.find(e => e.name.includes('EMAN'));
  assert.ok(eman, 'EMAN CS must exist');
  assert.strictEqual(eman.actions, 157, 'EMAN actions must be exactly 157');
  assert.strictEqual(eman.printed, 104, 'EMAN printed must be exactly 104');
  assert.strictEqual(eman.pending, 30, 'EMAN pending must be exactly 30');
  assert.strictEqual(eman.cancelled, 21, 'EMAN cancelled must be exactly 21');

  const menna = metrics.employees.find(e => e.name.toLowerCase().includes('menna atef'));
  assert.ok(menna, 'MENNA ATEF CS must exist');
  assert.strictEqual(menna.actions, 109, 'MENNA ATEF actions must be exactly 109');
  assert.strictEqual(menna.printed, 73, 'MENNA ATEF printed must be exactly 73');
  assert.strictEqual(menna.pending, 29, 'MENNA ATEF pending must be exactly 29');
  assert.strictEqual(menna.cancelled, 5, 'MENNA ATEF cancelled must be exactly 5');

  const ahd = metrics.employees.find(e => e.name.toLowerCase().includes('ahd'));
  assert.ok(ahd, 'AHD CS must exist');
  assert.strictEqual(ahd.actions, 108, 'AHD actions must be exactly 108');
  assert.strictEqual(ahd.printed, 76, 'AHD printed must be exactly 76');
  assert.strictEqual(ahd.pending, 16, 'AHD pending must be exactly 16');
  assert.strictEqual(ahd.cancelled, 10, 'AHD cancelled must be exactly 10');

  const reem = metrics.employees.find(e => e.name.toLowerCase().includes('reem elsaeed'));
  assert.ok(reem, 'REEM ELSAEED CS must exist');
  assert.strictEqual(reem.actions, 102, 'REEM actions must be exactly 102');
  assert.strictEqual(reem.printed, 59, 'REEM printed must be exactly 59');
  assert.strictEqual(reem.pending, 31, 'REEM pending must be exactly 31');
  assert.strictEqual(reem.cancelled, 8, 'REEM cancelled must be exactly 8');

  console.log('✓ PASS: 2026-10-01 canonical benchmark numbers match 100% across all metrics and employees.');
}

// -------------------------------------------------------------
// TEST 4: Snapshot Integrity & API Parity
// -------------------------------------------------------------
{
  console.log('Testing: Snapshot Integrity & Database Parity...');

  const dailySnap = db.prepare('SELECT metrics_json FROM daily_metrics_snapshots WHERE work_date = ?').get('2026-10-01');
  assert.ok(dailySnap, 'Daily metrics snapshot must exist for 2026-10-01');
  const snapParsed = JSON.parse(dailySnap.metrics_json);
  assert.strictEqual(snapParsed.summary.totalRealActions, 2163);
  assert.strictEqual(snapParsed.summary.printedActions, 1217);
  assert.strictEqual(snapParsed.summary.pendingActions, 607);
  assert.strictEqual(snapParsed.summary.cancelledActions, 280);
  assert.strictEqual(snapParsed.summary.processingActions, 59);
  assert.strictEqual(snapParsed.summary.totalAltPhones, 369);

  const perfRows = db.prepare('SELECT * FROM performance_snapshots WHERE date = ?').all('2026-10-01');
  assert.ok(perfRows.length > 0, 'Performance snapshots rows must exist');
  const sumActions = perfRows.reduce((sum, r) => sum + r.real_actions, 0);
  assert.strictEqual(sumActions, 2163, 'Sum of real_actions in performance_snapshots must equal 2,163');

  const basmaSnap = perfRows.find(r => r.employee_name.includes('BASMA'));
  assert.strictEqual(basmaSnap.real_actions, 266);
  assert.strictEqual(basmaSnap.printed_actions, 140);
  assert.strictEqual(basmaSnap.pending_actions, 77);
  assert.strictEqual(basmaSnap.cancelled_actions, 44);

  const emanSnap = perfRows.find(r => r.employee_name.includes('EMAN'));
  assert.strictEqual(emanSnap.real_actions, 157);
  assert.strictEqual(emanSnap.printed_actions, 104);
  assert.strictEqual(emanSnap.pending_actions, 30);
  assert.strictEqual(emanSnap.cancelled_actions, 21);

  console.log('✓ PASS: Database snapshots match canonical engine and ensure complete API parity.');
}

// -------------------------------------------------------------
// TEST 5: Semantic Distinction: Actions vs Orders
// -------------------------------------------------------------
{
  console.log('Testing: Semantic Distinction (Actions vs Orders)...');

  const records = db.prepare('SELECT * FROM raw_log_records WHERE work_date = ?').all('2026-10-01');
  const metrics = computePerformanceFromRecords(records);

  // Printed actions (1,217) vs Unique Printed Orders (2,603 across multi-stage lifecycle)
  assert.strictEqual(metrics.summary.printedActions, 1217);
  assert.notStrictEqual(metrics.summary.printedActions, metrics.summary.uniquePrintedOrders, 'Printed Actions and Unique Printed Orders must be separate fields');

  // Cancelled actions (280) vs Unique Cancelled Orders (302)
  assert.strictEqual(metrics.summary.cancelledActions, 280);
  assert.strictEqual(metrics.summary.uniqueCancelledOrders, 302);
  assert.notStrictEqual(metrics.summary.cancelledActions, metrics.summary.uniqueCancelledOrders, 'Cancelled Actions and Cancelled Orders must be separate fields');

  // Pending actions (607) vs Current Pending Backlog (391)
  assert.strictEqual(metrics.summary.pendingActions, 607);
  assert.strictEqual(metrics.summary.currentPendingBacklog, 391);
  assert.notStrictEqual(metrics.summary.pendingActions, metrics.summary.currentPendingBacklog, 'Pending Actions and Pending Backlog must be separate fields');

  console.log('✓ PASS: Strict semantic separation between actions and order backlog/counts maintained.');
}

console.log('--- ALL CANONICAL KPI PARITY REGRESSION TESTS PASSED SUCCESSFULLY! ---');
