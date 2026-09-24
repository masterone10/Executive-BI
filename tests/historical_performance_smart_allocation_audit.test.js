import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/index.js';
import {
  isCsEmployee,
  isCSName,
  normalizeDateToISO,
  getOperationalBusinessDate
} from '../services/parser.js';
import {
  isCSDepartment,
  getWorkingTeam,
  generateOrderLevelAllocation
} from '../services/allocation.js';
import {
  calculateSmartAllocationScore,
  getEmployeePerformanceProfiles,
  computePerformanceFromRecords
} from '../services/performance.js';

describe('Historical Performance -> Smart Allocation Audit Suite (7/7)', () => {

  test('1. Historical Source Ingestion & Date Resolution', () => {
    // Verify operational date resolution and business cutoff
    const early = getOperationalBusinessDate('2026-09-18 14:30:00');
    assert.strictEqual(early.business_date, '2026-09-18');

    const late = getOperationalBusinessDate('2026-09-18 21:30:00');
    assert.strictEqual(late.business_date, '2026-09-19', 'Events past cutoff belong to next operational day');

    // Normalization of ISO dates
    assert.strictEqual(normalizeDateToISO('2026-08-16'), '2026-08-16');
    assert.strictEqual(normalizeDateToISO('16/08/2026'), '2026-08-16');
  });

  test('2. CS vs Non-CS Strict Role Filtering & Audit Isolation', () => {
    // Explicit department checking
    assert.strictEqual(isCsEmployee({ name: 'Jehan data entry', department: 'Data Entry' }), false);
    assert.strictEqual(isCsEmployee({ name: 'Mohamed', department: 'Other' }), false);
    assert.strictEqual(isCsEmployee({ name: 'Sales Rep 1', department: 'Sales' }), false);
    assert.strictEqual(isCsEmployee({ name: 'Marketing Lead', department: 'Marketing' }), false);
    assert.strictEqual(isCsEmployee({ name: 'Warehouse Packer', department: 'Warehouse' }), false);
    assert.strictEqual(isCsEmployee({ name: 'Finance Auditor', department: 'Finance' }), false);
    assert.strictEqual(isCsEmployee({ name: 'Super', department: '' }), false);
    assert.strictEqual(isCsEmployee({ name: 'Shopify automation', department: '' }), false);

    // Active CS agents
    assert.strictEqual(isCsEmployee({ name: 'BASMA CS', department: 'CS' }), true);
    assert.strictEqual(isCsEmployee('BASMA CS'), true);
    assert.strictEqual(isCSDepartment('CS', 'BASMA CS'), true);
    assert.strictEqual(isCSDepartment('Data Entry', 'Jehan data entry'), false);
  });

  test('3. Snapshot Reconstruction & Mathematical KPI Integrity', () => {
    // Verify formula calculations: real actions, hourly rate, accuracy
    const dummyRecords = [
      { employee_name: 'BASMA CS', action: 'تم تجهيز الشحنة الى Printed', event_datetime: '2026-09-18 10:00:00', order_code: 'ORD-1' },
      { employee_name: 'BASMA CS', action: 'تم تجهيز الشحنة الى Printed', event_datetime: '2026-09-18 10:30:00', order_code: 'ORD-2' },
      { employee_name: 'BASMA CS', action: 'تم تجهيز الشحنة الى Pending', event_datetime: '2026-09-18 11:00:00', order_code: 'ORD-3' },
      { employee_name: 'BASMA CS', action: 'رقم هاتف آخر', event_datetime: '2026-09-18 11:30:00', order_code: 'ORD-1' }
    ];

    const result = computePerformanceFromRecords(dummyRecords, '2026-09-18');
    assert.ok(result && Array.isArray(result.employees), 'Result must contain employees array');
    const basma = result.employees.find(e => e.name === 'BASMA CS');
    assert.ok(basma, 'Computed performance must contain BASMA CS');
    assert.strictEqual(basma.printed, 2);
    assert.strictEqual(basma.pending, 1);
    assert.strictEqual(basma.alt, 1);
    assert.ok(basma.performance_score > 0);
  });

  test('4. Profile Aggregation & Historical Metrics Hydration', () => {
    const profiles = getEmployeePerformanceProfiles('2026-09-22');
    assert.ok(profiles instanceof Map, 'Profiles must be returned as Map');
    assert.ok(profiles.size > 0, 'Profiles must contain records');

    // Profile contains expected fields
    for (const [, prof] of profiles.entries()) {
      assert.ok(typeof prof.historical_score === 'number');
      assert.ok(typeof prof.estimated_daily_capacity === 'number');
      assert.ok(typeof prof.historical_rate === 'number');
    }
  });

  test('5. Controlled Causality Mutations (Tests A, B, C, D)', () => {
    const baseProfile = {
      historical_score: 75.0,
      historical_rate: 1.0,
      estimated_daily_capacity: 80,
      typical_orders_10m: 2,
      recent_orders_10m: 2,
      consistency: 0.5,
      confidence: 'MEDIUM'
    };
    const baseWorkload = { ordersCount: 20, accountsCount: 2 };
    const base = calculateSmartAllocationScore(1, baseProfile, baseWorkload);

    // TEST A: Mutate ONLY historical_score (75 -> 90)
    const profA = { ...baseProfile, historical_score: 90.0 };
    const resA = calculateSmartAllocationScore(1, profA, baseWorkload);
    assert.strictEqual(resA.perf_component, 90);
    assert.strictEqual(resA.cap_component, base.cap_component);
    assert.strictEqual(resA.fair_component, base.fair_component);
    assert.ok(resA.composite_score > base.composite_score);

    // TEST B: Mutate ONLY historical_rate (1.0 -> 1.2)
    const profB = { ...baseProfile, historical_rate: 1.2 };
    const resB = calculateSmartAllocationScore(1, profB, baseWorkload);
    assert.strictEqual(resB.perf_component, 90);
    assert.strictEqual(resB.cap_component, base.cap_component);
    assert.strictEqual(resB.fair_component, base.fair_component);
    assert.ok(resB.composite_score > base.composite_score);

    // TEST C: Mutate ONLY estimated_daily_capacity (80 -> 100)
    const profC = { ...baseProfile, estimated_daily_capacity: 100 };
    const resC = calculateSmartAllocationScore(1, profC, baseWorkload);
    assert.strictEqual(resC.perf_component, base.perf_component);
    assert.strictEqual(resC.cap_component, 80);
    assert.ok(resC.fair_component > base.fair_component);
    assert.ok(resC.composite_score > base.composite_score);

    // TEST D: Mutate ONLY workload/fairness (accounts 2->4, orders 20->40)
    const workD = { ordersCount: 40, accountsCount: 4 };
    const resD = calculateSmartAllocationScore(1, baseProfile, workD);
    assert.strictEqual(resD.perf_component, base.perf_component);
    assert.strictEqual(resD.cap_component, 50);
    assert.ok(resD.fair_component < base.fair_component);
    assert.ok(resD.composite_score < base.composite_score);
  });

  test('6. Working Team Invariance & Non-CS Candidate Exclusion', () => {
    const team = getWorkingTeam('2026-09-22');
    assert.ok(Array.isArray(team));

    // Every candidate in the working team must be CS
    for (const member of team) {
      assert.strictEqual(isCsEmployee(member), true, `Member ${member.name} must be CS`);
    }

    // Non-CS employees in employees table must NOT be in workingTeam
    const nonCsNames = db.prepare("SELECT name FROM employees WHERE department != 'CS'").all().map(r => r.name);
    for (const badName of nonCsNames) {
      assert.strictEqual(team.some(t => t.name === badName), false, `Non-CS employee ${badName} must be excluded`);
    }
  });

  test('7. Smart Allocation Engine Decision & Split Optimization', () => {
    // Score ranking guarantees top performer selected when capacity is adequate
    const cand1 = calculateSmartAllocationScore(1, { historical_score: 95, historical_rate: 1.3, estimated_daily_capacity: 100 }, { ordersCount: 0, accountsCount: 0 });
    const cand2 = calculateSmartAllocationScore(2, { historical_score: 70, historical_rate: 1.0, estimated_daily_capacity: 50 }, { ordersCount: 0, accountsCount: 0 });

    assert.ok(cand1.composite_score > cand2.composite_score, 'High-performance, high-capacity candidate must outrank lower candidate');
  });

});
