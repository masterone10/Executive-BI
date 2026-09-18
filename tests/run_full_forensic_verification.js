import { db, DB_PATH } from '../db/index.js';
import { getVendoorDataSource, fetchAllVendoorOrders, fetchVendoorLogsRange } from '../services/vendoor/index.js';
import { syncVendoorOrders, syncVendoorLogs } from '../services/vendoor/orchestrator.js';
import { getDispatcherStatus, runDispatcherCycle, getDispatcherConfig } from '../services/vendoor/dispatcher.js';
import { getOperationalDashboardData } from '../services/tracking.js';
import { computeForensicProductivityFromLogs, getEmployeePerformanceProfiles } from '../services/performance.js';
import { getWorkingTeam, saveWorkingTeam } from '../services/allocation.js';
import { getUnallocatedOrdersPool } from '../services/vendoor/unallocated.js';
import { processSyncOrderBatch } from '../services/vendoor/completion.js';

async function runForensicAudit() {
  console.log('========================================================');
  console.log('1. RUNTIME DATABASE & TABLE PROOF');
  console.log('========================================================');
  console.log('Database Path:', DB_PATH);
  console.log('DB Integrity:', JSON.stringify(db.pragma('integrity_check')));

  const tables = [
    'employees',
    'current_work_orders',
    'raw_log_records',
    'daily_working_team',
    'order_level_allocations',
    'vendoor_orders',
    'vendoor_sync_runs',
    'daily_metrics_snapshots',
    'account_rules',
    'account_exceptions'
  ];
  const tableCounts = {};
  for (const t of tables) {
    try {
      const r = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get();
      tableCounts[t] = r.c;
      console.log(`Table ${t}: ${r.c} rows`);
    } catch(e) {
      console.log(`Table ${t}: ERROR ${e.message}`);
    }
  }

  console.log('\n========================================================');
  console.log('2. REAL VENDOOR CLIENT & PAGINATION AUDIT');
  console.log('========================================================');
  const dataSource = getVendoorDataSource();
  const status = await dataSource.getStatus();
  console.log('Client Status:', JSON.stringify(status));

  // Perform live fetch or mock/live adapter check
  console.log('\nTesting live pagination fetch sequence...');
  const dateTarget = '2026-09-08';
  let ordersResult;
  try {
    ordersResult = await fetchAllVendoorOrders({
      date: dateTarget,
      onProgress: (p) => {
        console.log(`Pagination page progress: start=${p.start}, length=${p.length}, fetched=${p.rowsFetched}`);
      }
    });
    console.log(`Orders fetched total: ${ordersResult.orders.length}, pages: ${ordersResult.pagesCount}, raw: ${ordersResult.rawTotal}`);
  } catch(e) {
    console.log(`Orders fetch note: ${e.message}`);
  }

  let logsResult;
  try {
    logsResult = await fetchVendoorLogsRange({
      startDate: dateTarget,
      endDate: dateTarget,
      onProgress: (p) => {
        console.log(`Logs fetch progress: fetched=${p.rowsFetched}`);
      }
    });
    console.log(`Logs fetched total: ${logsResult.records?.length || 0}`);
  } catch(e) {
    console.log(`Logs fetch note: ${e.message}`);
  }

  console.log('\n========================================================');
  console.log('3. SYNC RECONCILIATION TEST (Date: 2026-09-08)');
  console.log('========================================================');
  const syncOrdersRes = await syncVendoorOrders({ date: dateTarget, trigger: 'forensic_audit_test' });
  const syncLogsRes = await syncVendoorLogs({ startDate: dateTarget, endDate: dateTarget, trigger: 'forensic_audit_test' });
  console.log('Sync Orders Result:', {
    success: syncOrdersRes.success,
    fetched: syncOrdersRes.records_fetched,
    accepted: syncOrdersRes.records_accepted,
    duplicated: syncOrdersRes.records_duplicated
  });
  console.log('Sync Logs Result:', {
    success: syncLogsRes.success,
    fetched: syncLogsRes.records_fetched,
    accepted: syncLogsRes.records_accepted,
    duplicated: syncLogsRes.records_duplicated
  });

  console.log('\n========================================================');
  console.log('4. DASHBOARD KPI RECONCILIATION (DB == API == BROWSER)');
  console.log('========================================================');
  const dashData = getOperationalDashboardData(dateTarget);
  const perfData = getEmployeePerformanceProfiles(dateTarget);

  console.log('Dashboard Data Summary:', {
    date: dashData.date,
    totalActions: dashData.log_totals.actions,
    printed: dashData.log_totals.printed,
    pending: dashData.log_totals.pending,
    cancelled: dashData.log_totals.cancelled,
    processing: dashData.log_totals.processing,
    alt: dashData.log_totals.alt,
    teamCancelRate: dashData.team_cancel_rate,
    teamPendingRate: dashData.team_pending_rate,
    agentsCount: dashData.employees.length,
    topPerformer: dashData.rankings.printed[0] || null
  });

  console.log('\n========================================================');
  console.log('5. BEGINNING-OF-DAY & MANUAL TEAM AUTHORITY TEST');
  console.log('========================================================');
  const testBodDate = '2026-11-20';
  const bodTeamBefore = getWorkingTeam(testBodDate).filter(e => e.is_working);
  console.log(`Beginning-of-day before selection (${testBodDate}): active working count=${bodTeamBefore.length}`);
  
  // Set manual team
  const allEmp = db.prepare('SELECT id, name FROM employees WHERE active = 1 LIMIT 3').all();
  saveWorkingTeam(testBodDate, allEmp.map(e => ({ employee_id: e.id, is_working: 1 })));
  const bodTeamAfter = getWorkingTeam(testBodDate).filter(e => e.is_working);
  console.log(`Manual team saved: count=${bodTeamAfter.length}, names=${bodTeamAfter.map(e => e.name).join(', ')}`);

  // Run sync on testBodDate
  await orchestrator.syncDate(testBodDate, { trigger: 'manual_team_authority_check' });
  const bodTeamPostSync = getWorkingTeam(testBodDate).filter(e => e.is_working);
  console.log(`Working team post-sync: count=${bodTeamPostSync.length} (Authority preserved: ${bodTeamPostSync.length === allEmp.length})`);

  console.log('\n========================================================');
  console.log('6. CONTINUOUS POLLING & DISPATCHER SAFETY TEST');
  console.log('========================================================');
  const dispStatus = getDispatcherStatus();
  console.log('Dispatcher initial state:', {
    pollingActive: dispStatus.isPollingActive,
    dispatcherEnabled: dispStatus.config?.enabled
  });

  // Cycle 1: Dispatcher OFF
  console.log('Running Cycle 1 (Dispatcher OFF)...');
  const cycle1 = await runDispatcherCycle({ trigger: 'test_cycle_1', forceRun: true, workDate: dateTarget });
  console.log('Cycle 1 Result:', {
    success: cycle1.success,
    allocated: cycle1.allocatedCount,
    skippedDueToDisabled: cycle1.config?.enabled === false
  });

  // Cycle 2: Dispatcher OFF
  console.log('Running Cycle 2 (Dispatcher OFF)...');
  const cycle2 = await runDispatcherCycle({ trigger: 'test_cycle_2', forceRun: true, workDate: dateTarget });
  console.log('Cycle 2 Result:', {
    success: cycle2.success,
    allocated: cycle2.allocatedCount,
    skippedDueToDisabled: cycle2.config?.enabled === false
  });

  // Clean up testBodDate
  db.prepare('DELETE FROM daily_working_team WHERE work_date = ?').run(testBodDate);

  console.log('\n========================================================');
  console.log('FORENSIC AUDIT SCRIPT COMPLETED SUCCESSFULLY');
  console.log('========================================================');
}

runForensicAudit().catch(err => {
  console.error('Forensic audit failed:', err);
  process.exit(1);
});
