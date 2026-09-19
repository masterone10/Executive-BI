import { db, cleanupMockContamination } from '../db/index.js';
import { getVendoorConfig, getSafeVendoorStatus, testVendoorLiveLogin } from '../services/vendoor/auth.js';
import { getTwoCalendarMonthsRange, bootstrapHistoricalTwoMonths, getHistoricalBootstrapStatus } from '../services/vendoor/bootstrap.js';
import { getFullEmployeeProductivityProfiles } from '../services/vendoor/productivity.js';
import { generateOrderLevelAllocation, getOrderLevelAllocation, getCurrentWorkOverview } from '../services/allocation.js';
import { getAutonomousPollerStatus, syncVendoorOrders, syncVendoorLogs } from '../services/vendoor/orchestrator.js';
import { getOperationalDashboardData, getTrackingOverview } from '../services/tracking.js';
import { generateExecutiveSummaryReport } from '../services/reports.js';

async function main() {
  console.log('===============================================================');
  console.log('  REAL HISTORICAL BOOTSTRAP + SQL PROOF EXECUTION');
  console.log('===============================================================\n');

  // =========================================================================
  // 1) VERIFY ENVIRONMENT BEFORE RUN
  // =========================================================================
  console.log('--- 1) VERIFY ENVIRONMENT BEFORE RUN ---');
  const vCfg = getVendoorConfig();
  const vSafe = getSafeVendoorStatus();
  console.log('Environment & Runtime Settings:');
  console.log('  VENDOOR_MOCK_MODE:', vCfg.mockMode);
  console.log('  SEED_DEMO_DATA:', process.env.SEED_DEMO_DATA === 'true');
  console.log('  VENDOOR_INTEGRATION_ENABLED:', vCfg.enabled);
  console.log('  VENDOOR_BASE_URL:', vCfg.baseUrl);
  console.log('  Database in use (production vs test):', process.env.NODE_ENV === 'test' ? 'TEST (data.test.db)' : 'PRODUCTION (data.db)');
  console.log('  Has Auto-Login Credentials:', vSafe.has_auto_login_credentials);
  console.log('  Email Configured Preview:', vSafe.email_preview);
  console.log('  Connection State:', vSafe.connection_state);
  console.log('  Session State:', vSafe.session_state);

  // Authenticate live if needed
  if (vCfg.hasAutoLoginCredentials) {
    console.log('\n  Authenticating against Live Vendoor portal...');
    const loginTest = await testVendoorLiveLogin();
    console.log('  Live Login Result:', loginTest.success ? 'SUCCESS' : 'FAILED', loginTest.error ? `(${loginTest.error})` : '');
    console.log('  Session Live:', loginTest.session_live);
  }

  // =========================================================================
  // 2) VERIFY CURRENT DATABASE IS CLEAN
  // =========================================================================
  console.log('\n--- 2) VERIFY CURRENT DATABASE IS CLEAN ---');
  // Clean mock contamination if any was left
  cleanupMockContamination(db);

  const initialLogsCount = db.prepare('SELECT COUNT(*) as c FROM vendoor_logs').get().c;
  const initialRawLogsCount = db.prepare('SELECT COUNT(*) as c FROM raw_log_records').get().c;
  const initialOrdersCount = db.prepare('SELECT COUNT(*) as c FROM vendoor_orders').get().c;
  const initialCwoCount = db.prepare('SELECT COUNT(*) as c FROM current_work_orders').get().c;
  const initialSyncRuns = db.prepare('SELECT COUNT(*) as c FROM vendoor_sync_runs').get().c;
  const empMasterCount = db.prepare('SELECT COUNT(*) as c FROM employees').get().c;

  // Mock / Test audit
  const mockSyncRuns = db.prepare("SELECT COUNT(*) as c FROM vendoor_sync_runs WHERE sync_run_id LIKE '%mock%' OR sync_run_id LIKE '%test%'").get().c;
  const syntheticLogs = db.prepare("SELECT COUNT(*) as c FROM vendoor_logs WHERE employee_name IN ('Ahmed Hassan', 'Sara Mahmoud', 'Mohamed Ali', 'Nour Ibrahim', 'Khaled Omar')").get().c;

  console.log('Current Database Counts:');
  console.log('  vendoor_logs:', initialLogsCount);
  console.log('  raw_log_records:', initialRawLogsCount);
  console.log('  vendoor_orders:', initialOrdersCount);
  console.log('  current_work_orders:', initialCwoCount);
  console.log('  vendoor_sync_runs:', initialSyncRuns);
  console.log('  employees (Master):', empMasterCount);
  console.log('  mock/test sync_runs:', mockSyncRuns);
  console.log('  synthetic historical records:', syntheticLogs);

  // =========================================================================
  // 3) CALCULATE CANONICAL HISTORICAL RANGE
  // =========================================================================
  console.log('\n--- 3) CALCULATE CANONICAL HISTORICAL RANGE ---');
  const canonicalRange = getTwoCalendarMonthsRange();
  console.log('Canonical Range (2 Calendar Months):');
  console.log('  startDate:', canonicalRange.startDate);
  console.log('  endDate:  ', canonicalRange.endDate);

  // =========================================================================
  // 4) RUN REAL HISTORICAL BOOTSTRAP
  // =========================================================================
  console.log('\n--- 4) RUN REAL HISTORICAL BOOTSTRAP ---');
  console.log(`Executing real historical bootstrap for range ${canonicalRange.startDate} to ${canonicalRange.endDate}...`);
  
  const bootstrapResult = await bootstrapHistoricalTwoMonths({
    startDate: canonicalRange.startDate,
    endDate: canonicalRange.endDate,
    forceMode: 'live'
  });

  console.log('\nBootstrap Execution Result:');
  console.log('  Success:', bootstrapResult.success);
  console.log('  Job ID:', bootstrapResult.job_id);
  if (bootstrapResult.summary) {
    console.log('  Duration (ms):', bootstrapResult.summary.duration_ms);
    console.log('  Weekly Log Chunks:', bootstrapResult.summary.logs_chunks_count);
    console.log('  Logs Total Accepted:', bootstrapResult.summary.logs_total_accepted);
    console.log('  Orders Total Fetched:', bootstrapResult.summary.orders_total_fetched);
    console.log('  Days Snapshotted:', bootstrapResult.summary.days_snapshotted);
    console.log('  Profiles Generated:', bootstrapResult.summary.profiles_generated);
  } else if (bootstrapResult.error) {
    console.log('  Error:', bootstrapResult.error);
  }

  // =========================================================================
  // 5) BOOTSTRAP STATE MUST REFLECT REAL DB
  // =========================================================================
  console.log('\n--- 5) BOOTSTRAP STATE MUST REFLECT REAL DB ---');
  const bState = getHistoricalBootstrapStatus();
  console.log('Bootstrap State in SQL DB:');
  console.log('  Job ID:', bState.job_id);
  console.log('  Current Phase:', bState.current_phase);
  console.log('  State Status:', bState.state_status);
  console.log('  Percent Complete:', bState.percent_complete + '%');
  console.log('  Date Range:', bState.date_range);

  // =========================================================================
  // 6) SQL HISTORICAL PROOF
  // =========================================================================
  console.log('\n--- 6) SQL HISTORICAL PROOF ---');
  
  console.log('\nA) Logs by Business Date (raw_log_records):');
  const rawLogsByDate = db.prepare(`
    SELECT work_date, COUNT(*) as row_count
    FROM raw_log_records
    GROUP BY work_date
    ORDER BY work_date
  `).all();
  console.table(rawLogsByDate);

  console.log('\nB) Vendoor Logs by Business Date (vendoor_logs):');
  const vendoorLogsByDate = db.prepare(`
    SELECT work_date, COUNT(*) as row_count
    FROM vendoor_logs
    GROUP BY work_date
    ORDER BY work_date
  `).all();
  console.table(vendoorLogsByDate);

  console.log('\nC) Orders by Source Date (vendoor_orders):');
  const ordersByDate = db.prepare(`
    SELECT source_date,
           COUNT(*) AS rows,
           COUNT(DISTINCT order_code) AS distinct_orders,
           COUNT(DISTINCT merchant_code) AS distinct_merchants
    FROM vendoor_orders
    GROUP BY source_date
    ORDER BY source_date
  `).all();
  console.table(ordersByDate);

  console.log('\nD) Sync Runs History (vendoor_sync_runs):');
  const syncRunsList = db.prepare(`
    SELECT sync_run_id,
           resource,
           start_date,
           end_date,
           status,
           records_fetched,
           records_accepted,
           created_at
    FROM vendoor_sync_runs
    ORDER BY created_at ASC
  `).all();
  console.table(syncRunsList);

  console.log('\nE) Mock / Test Contamination Check:');
  const postMockRuns = db.prepare("SELECT COUNT(*) as c FROM vendoor_sync_runs WHERE sync_run_id LIKE '%mock%' OR sync_run_id LIKE '%test%'").get().c;
  const postSyntheticLogs = db.prepare("SELECT COUNT(*) as c FROM vendoor_logs WHERE employee_name IN ('Ahmed Hassan', 'Sara Mahmoud', 'Mohamed Ali', 'Nour Ibrahim', 'Khaled Omar')").get().c;
  const postSyntheticOrders = db.prepare("SELECT COUNT(*) as c FROM vendoor_orders WHERE account IN ('Vendoor Express', 'Alpha Merchant', 'Beta Logistics', 'Delta Direct', 'Gamma Trade')").get().c;
  console.log('  Mock Sync Runs Remaining:', postMockRuns);
  console.log('  Synthetic Logs Remaining:', postSyntheticLogs);
  console.log('  Synthetic Orders Remaining:', postSyntheticOrders);

  // =========================================================================
  // 7) COVERAGE CHECK
  // =========================================================================
  console.log('\n--- 7) COVERAGE CHECK ---');
  const startObj = new Date(canonicalRange.startDate + 'T00:00:00Z');
  const endObj = new Date(canonicalRange.endDate + 'T00:00:00Z');
  const allExpectedDates = [];
  let currD = new Date(startObj.getTime());
  while (currD <= endObj) {
    allExpectedDates.push(currD.toISOString().slice(0, 10));
    currD.setUTCDate(currD.getUTCDate() + 1);
  }

  const rawDatesSet = new Set(rawLogsByDate.map(r => r.work_date));
  const vendoorDatesSet = new Set(vendoorLogsByDate.map(r => r.work_date));
  const coveredDates = allExpectedDates.filter(d => rawDatesSet.has(d) || vendoorDatesSet.has(d));
  const missingDates = allExpectedDates.filter(d => !rawDatesSet.has(d) && !vendoorDatesSet.has(d));

  console.log(`Total Expected Calendar Dates (${canonicalRange.startDate} to ${canonicalRange.endDate}):`, allExpectedDates.length);
  console.log('Dates with Log Activity in Database:', coveredDates.length);
  console.log('Dates with Zero Activity / Inactive Days:', missingDates.length);
  if (missingDates.length > 0) {
    console.log('Inactive / Zero-Activity Dates:', missingDates.join(', '));
  }

  // =========================================================================
  // 8) PRODUCTIVITY DEPTH PROOF
  // =========================================================================
  console.log('\n--- 8) PRODUCTIVITY DEPTH PROOF ---');
  const profiles = getFullEmployeeProductivityProfiles(canonicalRange.endDate);
  
  const formattedProfiles = profiles.map(p => ({
    employee_id: p.employee_id,
    employee_name: p.employee_name,
    historical_active_days: p.historical_coverage,
    sample_size: p.sample_size,
    unique_worked_orders: p.unique_orders_worked,
    typical_10m: p.typical_orders_per_10m,
    typical_hour: p.typical_orders_per_hour,
    recent_rate: p.recent_rate,
    long_term_rate: p.long_term_rate,
    consistency: p.consistency,
    confidence: p.confidence,
    estimated_cap: p.estimated_capacity
  }));
  console.table(formattedProfiles);

  // Distribution
  let d0 = 0, d1 = 0, d2_7 = 0, d8_14 = 0, d15plus = 0;
  for (const p of profiles) {
    const days = parseInt(p.historical_coverage, 10) || 0;
    if (days === 0) d0++;
    else if (days === 1) d1++;
    else if (days >= 2 && days <= 7) d2_7++;
    else if (days >= 8 && days <= 14) d8_14++;
    else if (days >= 15) d15plus++;
  }

  console.log('\nProductivity Depth Distribution across Employee Master:');
  console.log('  0 active days:   ', d0);
  console.log('  1 active day:    ', d1);
  console.log('  2-7 active days: ', d2_7);
  console.log('  8-14 active days:', d8_14);
  console.log('  15+ active days: ', d15plus);
  console.log('  Total Employees: ', profiles.length);
  console.log('  Measured Employees (Sample > 0):', profiles.filter(p => p.sample_size > 0).length);
  console.log('  Unmeasured Employees (Baseline):', profiles.filter(p => p.sample_size === 0).length);

  // =========================================================================
  // 9) ALLOCATION PROOF
  // =========================================================================
  console.log('\n--- 9) ALLOCATION PROOF ---');
  const latestOrderDateRow = db.prepare('SELECT work_date, COUNT(*) as c FROM current_work_orders GROUP BY work_date ORDER BY c DESC LIMIT 1').get();
  const testAllocDate = latestOrderDateRow ? latestOrderDateRow.work_date : canonicalRange.endDate;
  console.log(`Running Auto Fair Allocation on controlled real business date: ${testAllocDate} (orders available: ${latestOrderDateRow?.c || 0})...`);

  // Ensure working team exists for test date
  const workingEmps = db.prepare('SELECT id FROM employees WHERE active = 1 LIMIT 8').all();
  const insTeam = db.prepare('INSERT OR REPLACE INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, ?, 1)');
  const txTeam = db.transaction(() => {
    for (const e of workingEmps) {
      insTeam.run(testAllocDate, e.id);
    }
  });
  txTeam();

  const allocGenResult = generateOrderLevelAllocation(testAllocDate, {
    method: 'fair_random',
    regenerate: true
  });

  console.log('Allocation Generation Summary:');
  console.log('  Success:', allocGenResult.success);
  console.log('  Date:', allocGenResult.date);
  console.log('  Total Orders Processed:', allocGenResult.total_orders);
  console.log('  Assigned Orders:', allocGenResult.assigned_orders_count);
  console.log('  Unassigned Orders:', allocGenResult.unassigned_orders_count);
  console.log('  Accounts Handled:', allocGenResult.accounts_count);
  console.log('  Working Employees Assigned:', allocGenResult.by_employee?.length || 0);

  // Verify Sticky Account Ownership & Non-split
  if (allocGenResult.account_owners && allocGenResult.account_owners.length > 0) {
    console.log('\nAccount Ownership Samples:');
    console.table(allocGenResult.account_owners.slice(0, 8));
  }

  // Check if any account with orders was assigned to multiple employees
  const orderAlloc = getOrderLevelAllocation(testAllocDate);
  const accountEmpMap = new Map();
  for (const ord of (orderAlloc.orders || [])) {
    if (!accountEmpMap.has(ord.account)) accountEmpMap.set(ord.account, new Set());
    if (ord.employee_id) accountEmpMap.get(ord.account).add(ord.employee_id);
  }
  let accountsWithMultipleEmployees = 0;
  for (const [acc, empSet] of accountEmpMap.entries()) {
    if (empSet.size > 1) {
      accountsWithMultipleEmployees++;
    }
  }
  console.log('Sticky Account Ownership Check:');
  console.log('  Total Accounts in Allocation:', accountEmpMap.size);
  console.log('  Accounts with single owner (No fragmentation):', accountEmpMap.size - accountsWithMultipleEmployees);
  console.log('  Accounts split across multiple employees:', accountsWithMultipleEmployees);

  // =========================================================================
  // 10) DAILY POLLER HANDOFF
  // =========================================================================
  console.log('\n--- 10) DAILY POLLER HANDOFF ---');
  const pollerStatus = getAutonomousPollerStatus();
  console.log('Autonomous Poller Status:');
  console.log('  Is Running:', pollerStatus.isRunning);
  console.log('  Is Cycle Active:', pollerStatus.isCycleActive);
  console.log('  Run Count:', pollerStatus.runCount);
  console.log('  Last Run At:', pollerStatus.lastRunAt);

  console.log('\nExecuting one live poll cycle for verification...');
  const pollOrders = await syncVendoorOrders({ fromDate: canonicalRange.endDate, toDate: canonicalRange.endDate, forceMode: 'live' });
  const pollLogs = await syncVendoorLogs({ startDate: canonicalRange.endDate, endDate: canonicalRange.endDate, forceMode: 'live' });
  console.log('  Poll Orders Result:', pollOrders.success ? 'SUCCESS' : 'FAILED', `(fetched: ${pollOrders.total_fetched || 0}, accepted: ${pollOrders.total_accepted || 0})`);
  console.log('  Poll Logs Result:', pollLogs.success ? 'SUCCESS' : 'FAILED', `(fetched: ${pollLogs.summary?.total_rows || 0}, accepted: ${pollLogs.summary?.total_accepted || 0})`);

  // =========================================================================
  // 11) APPLICATION RECONCILIATION
  // =========================================================================
  console.log('\n--- 11) APPLICATION RECONCILIATION ---');
  const reconDate = testAllocDate;
  const dbCwoTotal = db.prepare('SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ?').get(reconDate).c;
  const dbCwoNew = db.prepare("SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ? AND status = 'New'").get(reconDate).c;
  const dbCwoPending = db.prepare("SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ? AND (status = 'Pending' OR source_file_slot = 2)").get(reconDate).c;
  const dbAllocOrders = db.prepare('SELECT COUNT(*) as c FROM order_level_allocations WHERE allocation_date = ? AND employee_id IS NOT NULL').get(reconDate).c;
  const dbAccounts = db.prepare('SELECT COUNT(DISTINCT account) as c FROM current_work_orders WHERE work_date = ?').get(reconDate).c;

  const currentWorkOverview = getCurrentWorkOverview(reconDate);
  const operationalDash = getOperationalDashboardData(reconDate);
  const trackingOverview = getTrackingOverview(reconDate);
  const execReport = generateExecutiveSummaryReport({ startDate: reconDate, endDate: reconDate });

  console.log(`Reconciliation Table for Business Date: ${reconDate}`);
  console.table([
    { Metric: 'Total Orders', SQL_DB: dbCwoTotal, CurrentWorkOverview: currentWorkOverview.total_orders, OperationalDash: operationalDash.total_inventory, TrackingOverview: trackingOverview.total_orders },
    { Metric: 'New Orders', SQL_DB: dbCwoNew, CurrentWorkOverview: currentWorkOverview.new_count, OperationalDash: operationalDash.opening_new, TrackingOverview: trackingOverview.new_orders },
    { Metric: 'Pending Orders', SQL_DB: dbCwoPending, CurrentWorkOverview: currentWorkOverview.pending_count, OperationalDash: operationalDash.opening_pending, TrackingOverview: trackingOverview.pending_orders },
    { Metric: 'Allocated Orders', SQL_DB: dbAllocOrders, CurrentWorkOverview: currentWorkOverview.allocated_count, OperationalDash: operationalDash.allocated_orders, TrackingOverview: trackingOverview.allocated_count },
    { Metric: 'Accounts Count', SQL_DB: dbAccounts, CurrentWorkOverview: currentWorkOverview.accounts_count, OperationalDash: operationalDash.accounts_count, TrackingOverview: trackingOverview.accounts_count }
  ]);

  console.log('\n===============================================================');
  console.log('  VALIDATION EXECUTION COMPLETE');
  console.log('===============================================================');
}

main().catch(err => {
  console.error('Fatal error in proof execution:', err);
  process.exit(1);
});
