import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import {
  isEventInTimeWindow,
  normalizeTimeToSeconds,
  extractCairoDateTimeComponents
} from '../services/time_utils.js';
import {
  getHourlyTimeWindowEventData,
  getCanonicalOrderMetadata,
  getOperationalDashboardData
} from '../services/tracking.js';

test('1. Time Window Boundary Test (User Request 14)', () => {
  const workDate = '2026-09-24';
  const fromTime = '17:00';
  const toTime = '18:00';

  // Test events
  const eventA = '2026-09-24 16:59:59';
  const eventB = '2026-09-24 17:00:00';
  const eventC = '2026-09-24 17:15:00';
  const eventD = '2026-09-24 17:59:59';
  const eventE = '2026-09-24 18:00:00';
  const eventF = '2026-09-24 18:00:01';

  // Expected: B, C, D INCLUDED; A, E, F EXCLUDED
  assert.equal(isEventInTimeWindow(eventA, workDate, fromTime, toTime), false, 'Event A (16:59:59) should be EXCLUDED');
  assert.equal(isEventInTimeWindow(eventB, workDate, fromTime, toTime), true, 'Event B (17:00:00) should be INCLUDED');
  assert.equal(isEventInTimeWindow(eventC, workDate, fromTime, toTime), true, 'Event C (17:15:00) should be INCLUDED');
  assert.equal(isEventInTimeWindow(eventD, workDate, fromTime, toTime), true, 'Event D (17:59:59) should be INCLUDED');
  assert.equal(isEventInTimeWindow(eventE, workDate, fromTime, toTime), false, 'Event E (18:00:00) should be EXCLUDED');
  assert.equal(isEventInTimeWindow(eventF, workDate, fromTime, toTime), false, 'Event F (18:00:01) should be EXCLUDED');
});

test('2. Time Window Normalization & Cross-Day Isolation', () => {
  assert.equal(normalizeTimeToSeconds('17:00'), 17 * 3600);
  assert.equal(normalizeTimeToSeconds('18:00:00'), 18 * 3600);
  assert.equal(normalizeTimeToSeconds('09:30'), 9 * 3600 + 30 * 60);

  // Different date must never be included even if time matches
  const diffDateEvent = '2026-09-25 17:30:00';
  assert.equal(isEventInTimeWindow(diffDateEvent, '2026-09-24', '17:00', '18:00'), false, 'Different date must be EXCLUDED');
});

test('3. End-to-End Time Window Dataset & Operational Re-calculation', () => {
  const testDate = '2026-09-24';

  // Seed test employee in master if not present
  const empStmt = db.prepare('INSERT OR IGNORE INTO employees (name, department, active, status) VALUES (?, ?, ?, ?)');
  empStmt.run('Agent TimeTester A', 'CS', 1, 'ACTIVE');
  empStmt.run('Agent TimeTester B', 'CS', 1, 'ACTIVE');

  // Seed sample canonical Vendoor orders with customer phone numbers
  const insertOrder = db.prepare(`
    INSERT OR REPLACE INTO vendoor_orders (
      order_code, account, status, source_date, raw_payload_json
    ) VALUES (?, ?, ?, ?, ?)
  `);

  insertOrder.run('ORD-TW-001', 'TechZone', 'Printed', testDate, JSON.stringify({ phone: '01012345678', customer_name: 'Mohamed Ali' }));
  insertOrder.run('ORD-TW-002', 'TechZone', 'Printed', testDate, JSON.stringify({ phone: '01198765432', customer_name: 'Ahmed Hassan' }));
  insertOrder.run('ORD-TW-003', 'FashionHub', 'Pending', testDate, JSON.stringify({ phone: '01234567890', customer_name: 'Sara Ibrahim' }));
  insertOrder.run('ORD-TW-004', 'FashionHub', 'Cancelled', testDate, JSON.stringify({ phone: '01511223344', customer_name: 'Khaled Tarek' }));
  insertOrder.run('ORD-TW-OUT', 'TechZone', 'Printed', testDate, JSON.stringify({ phone: '01099999999', customer_name: 'Outside User' }));

  // Seed logs with precise timestamps
  // 17:00 -> 18:00 window:
  // ORD-TW-001 at 17:05 (Agent A, Printed / Confirmed)
  // ORD-TW-002 at 17:20 (Agent A, Printed / Confirmed)
  // ORD-TW-003 at 17:35 (Agent B, Pending / Unconfirmed)
  // ORD-TW-004 at 17:50 (Agent B, Cancelled)
  // ORD-TW-OUT at 16:30 (Outside window)
  const insertLog = db.prepare(`
    INSERT OR REPLACE INTO vendoor_logs (
      work_date, order_code, employee_name, action, action_classification, timestamp_str, is_productive
    ) VALUES (?, ?, ?, ?, ?, ?, 1)
  `);

  insertLog.run(testDate, 'ORD-TW-001', 'Agent TimeTester A', 'Print Order', 'Printed', '2026-09-24 17:05:00');
  insertLog.run(testDate, 'ORD-TW-002', 'Agent TimeTester A', 'Print Order', 'Printed', '2026-09-24 17:20:00');
  insertLog.run(testDate, 'ORD-TW-003', 'Agent TimeTester B', 'Move to Pending', 'Pending', '2026-09-24 17:35:00');
  insertLog.run(testDate, 'ORD-TW-004', 'Agent TimeTester B', 'Cancel Order', 'Cancelled', '2026-09-24 17:50:00');
  insertLog.run(testDate, 'ORD-TW-OUT', 'Agent TimeTester A', 'Print Order', 'Printed', '2026-09-24 16:30:00');

  // Verify Phone Extraction
  const meta1 = getCanonicalOrderMetadata('ORD-TW-001');
  assert.equal(meta1.phone, '01012345678', 'Canonical customer phone must be retrieved correctly');

  // Execute Time Window Filter Query
  const windowData = getHourlyTimeWindowEventData(testDate, '17:00', '18:00');

  assert.equal(windowData.success, true);
  assert.equal(windowData.time_window.is_active, true);
  assert.equal(windowData.time_window.from, '17:00');
  assert.equal(windowData.time_window.to, '18:00');

  // Check KPI calculations in window
  // 4 orders worked in window: ORD-TW-001, 002, 003, 004 (ORD-TW-OUT is excluded)
  assert.equal(windowData.kpis.total_orders_worked, 4, 'Total orders worked in window must be 4');
  assert.equal(windowData.kpis.confirmed_orders, 2, 'Confirmed orders in window must be 2 (ORD-001, ORD-002)');
  assert.equal(windowData.kpis.unconfirmed_orders, 2, 'Unconfirmed orders in window must be 2 (ORD-003, ORD-004)');
  assert.equal(windowData.kpis.confirmation_rate, 50, 'Confirmation rate must be 2/4 * 100 = 50% (denominator strictly window orders)');
  assert.equal(windowData.kpis.real_actions, 4, 'Real actions in window must be 4');

  // Check employee performance ranking in window
  // Agent A has 2 confirmed, Agent B has 0 confirmed
  const topEmp = windowData.kpis.top_confirmed_employees[0];
  assert.equal(topEmp.name, 'Agent TimeTester A');
  assert.equal(topEmp.confirmed_orders, 2);
  assert.equal(topEmp.confirmation_rate, 100);

  // Check order events list contains phone numbers and correct columns
  const order1Event = windowData.order_events.find(e => e.order_code === 'ORD-TW-001');
  assert.ok(order1Event, 'ORD-TW-001 event must exist in window');
  assert.equal(order1Event.phone, '01012345678');
  assert.equal(order1Event.is_confirmed, true);
  assert.equal(order1Event.confirmation_status, 'CONFIRMED');

  const order3Event = windowData.order_events.find(e => e.order_code === 'ORD-TW-003');
  assert.ok(order3Event, 'ORD-TW-003 event must exist in window');
  assert.equal(order3Event.phone, '01234567890');
  assert.equal(order3Event.is_confirmed, false);
  assert.equal(order3Event.confirmation_status, 'UNCONFIRMED');

  // Excluded outside event must NOT be in window
  const outEvent = windowData.order_events.find(e => e.order_code === 'ORD-TW-OUT');
  assert.equal(outEvent, undefined, 'ORD-TW-OUT (16:30:00) must NOT appear in 17:00-18:00 window');
});

test('4. Operational Dashboard All-Day vs Time-Window', () => {
  const testDate = '2026-09-24';

  // All Day Query
  const allDay = getOperationalDashboardData(testDate);
  assert.equal(allDay.time_window.is_active, false);

  // Filtered Query
  const windowed = getOperationalDashboardData(testDate, { fromTime: '17:00', toTime: '18:00' });
  assert.equal(windowed.time_window.is_active, true);
  assert.equal(windowed.kpis.total_orders_worked, 4);
  assert.equal(windowed.kpis.confirmed_orders, 2);
});
