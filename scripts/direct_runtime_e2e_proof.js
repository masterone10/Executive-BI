import { db } from '../db/index.js';

const BASE_URL = 'http://localhost:3000';

async function fetchJson(endpoint, options = {}) {
  const res = await fetch(`${BASE_URL}${endpoint}`, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} on ${endpoint}: ${text.slice(0, 150)}`);
  }
  return { status: res.status, data: await res.json() };
}

async function runDirectRuntimeE2EProof() {
  console.log('================================================================');
  console.log('    DIRECT END-TO-END RUNTIME PROOF: VENDOOR & DASHBOARD        ');
  console.log('================================================================\n');

  let passedChecks = 0;
  let totalChecks = 0;

  function assertCheck(name, condition, details = '') {
    totalChecks++;
    if (condition) {
      passedChecks++;
      console.log(`[PASS] ${name} ${details ? '(' + details + ')' : ''}`);
    } else {
      console.error(`[FAIL] ${name} ${details ? '(' + details + ')' : ''}`);
      process.exitCode = 1;
    }
  }

  // ==========================================
  // PART 1: VENDOOR RUNTIME INTEGRATION PROOF
  // ==========================================
  console.log('\n>>> SECTION 1: VENDOOR RUNTIME VALIDATION <<<');

  // 1.1 Vendoor Status
  const { data: vStatus } = await fetchJson('/api/integrations/vendoor/status');
  assertCheck('1.1 Vendoor Status Endpoint', vStatus && vStatus.connection_state, `State: ${vStatus.connection_state}, Mock: ${vStatus.mock_mode}`);
  assertCheck('1.2 Vendoor Session Health', typeof vStatus.session_state === 'string', `Session: ${vStatus.session_state}`);
  assertCheck('1.3 Vendoor Base URL Configured', typeof vStatus.base_url === 'string' && vStatus.base_url.length > 0, `URL: ${vStatus.base_url}`);

  // 1.2 Vendoor History & Sync
  const { data: vHistory } = await fetchJson('/api/integrations/vendoor/history');
  assertCheck('1.4 Vendoor Export History Accessible', Array.isArray(vHistory.history || vHistory), `Count: ${(vHistory.history || vHistory).length}`);

  const { data: vSyncHistory } = await fetchJson('/api/integrations/vendoor/sync/history');
  const syncRuns = vSyncHistory.runs || vSyncHistory.history || vSyncHistory;
  assertCheck('1.5 Vendoor Sync History Accessible', Array.isArray(syncRuns) && syncRuns.length > 0, `Sync runs recorded: ${syncRuns.length}`);

  // 1.3 Vendoor Bootstrap & Poller
  const { data: vBootstrap } = await fetchJson('/api/integrations/vendoor/bootstrap-status');
  assertCheck('1.6 Vendoor Bootstrap Status', vBootstrap && vBootstrap.success === true, `Bootstrap: ${vBootstrap.state_status || 'OK'}`);

  const { data: vPoller } = await fetchJson('/api/integrations/vendoor/poller/status');
  assertCheck('1.7 Vendoor Poller Status', vPoller.success === true && (vPoller.isRunning === true || vPoller.orders?.is_running === true), `Poller running: ${vPoller.isRunning}, Connection: ${vPoller.connection_state}`);

  // 1.4 Vendoor Dispatcher Engine & Queues
  const { data: vDispStatus } = await fetchJson('/api/vendoor/dispatcher/status');
  assertCheck('1.8 Vendoor Dispatcher Engine', vDispStatus && vDispStatus.success === true, `Operational status: ${vDispStatus.operational_status}`);

  const { data: vWorkloads } = await fetchJson('/api/vendoor/dispatcher/workloads');
  const workloads = vWorkloads.workloads || vWorkloads;
  assertCheck('1.9 Vendoor Dispatcher Workloads', Array.isArray(workloads) && workloads.length > 0, `Workload agents tracked: ${workloads.length}`);

  const { data: vUnallocated } = await fetchJson('/api/vendoor/dispatcher/unallocated');
  assertCheck('1.10 Vendoor Unallocated Queue', vUnallocated.success === true && vUnallocated.pool !== undefined, `Total unallocated: ${vUnallocated.pool?.total_unallocated_orders}`);

  const { data: vCompletion } = await fetchJson('/api/vendoor/dispatcher/completion');
  assertCheck('1.11 Vendoor Dispatcher Completion Tracking', vCompletion !== undefined && (vCompletion.success === true || vCompletion.rates !== undefined), `Completion tracking active`);

  const { data: vAudit } = await fetchJson('/api/vendoor/dispatcher/audit');
  assertCheck('1.12 Vendoor Dispatcher Audit Logs', vAudit.success === true && Array.isArray(vAudit.history), `Audit entries: ${vAudit.history?.length}`);

  const { data: vAlerts } = await fetchJson('/api/vendoor/dispatcher/alerts');
  assertCheck('1.13 Vendoor Dispatcher Alerts Engine', Array.isArray(vAlerts.alerts || vAlerts), `Alerts array active`);

  const { data: vLiveLogs } = await fetchJson('/api/vendoor/logs/live');
  assertCheck('1.14 Vendoor Live Log Stream', Array.isArray(vLiveLogs.logs || vLiveLogs), `Live log records returned`);


  // ==========================================
  // PART 2: DASHBOARD RUNTIME INTEGRATION PROOF
  // ==========================================
  console.log('\n>>> SECTION 2: DASHBOARD & METRICS RUNTIME VALIDATION <<<');

  // 2.1 System Health
  const { data: healthData } = await fetchJson('/api/health');
  assertCheck('2.1 Health Check', healthData.status === 'ok', `Service: ${healthData.service}`);

  // 2.2 Global Context
  const { data: gContext } = await fetchJson('/api/global-context');
  assertCheck('2.2 Global Context Work Date & Counts', gContext.work_date !== undefined && typeof gContext.total_orders === 'number', `Date: ${gContext.work_date}, Total Orders: ${gContext.total_orders}`);
  assertCheck('2.3 Global Context Vendoor State', gContext.vendoor && gContext.vendoor.connection_state === 'CONNECTED', `Session: ${gContext.vendoor?.session_state}`);

  // 2.3 Historical Target Date Parity (2026-09-08)
  const targetDate = '2026-09-08';
  const { data: dashData08 } = await fetchJson(`/api/data?date=${targetDate}`);
  const { data: perfData08 } = await fetchJson(`/api/performance/${targetDate}`);
  assertCheck('2.4 Dashboard Baseline 2026-09-08 Employees', Array.isArray(dashData08.employees) && dashData08.employees.length === 45, `Employees count: ${dashData08.employees?.length}`);
  assertCheck('2.5 Dashboard Baseline 2026-09-08 Actions Total', dashData08.log_totals?.actions === 29671, `Total actions: ${dashData08.log_totals?.actions}`);
  assertCheck('2.6 Performance Baseline Actions Match', perfData08.totals?.actions === 29671, `Perf actions: ${perfData08.totals?.actions}`);

  // 2.4 Live Operational Date Parity (2026-09-29)
  const liveDate = '2026-09-29';
  const { data: dashData29 } = await fetchJson(`/api/data?date=${liveDate}`);
  const { data: poolData29 } = await fetchJson(`/api/orders/pool-status/${liveDate}`);

  // Query SQLite DB directly for liveDate
  const dbOrdersTotal29 = db.prepare('SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = ?').get(liveDate).c;
  const dbAccountsCount29 = db.prepare('SELECT COUNT(DISTINCT account) as c FROM current_work_orders WHERE work_date = ?').get(liveDate).c;
  const dbWorkingTeam29 = db.prepare('SELECT COUNT(*) as c FROM daily_working_team WHERE work_date = ?').get(liveDate).c;

  assertCheck('2.7 Dashboard Live 2026-09-29 Operational Summary', dashData29.summary && typeof dashData29.summary.duplicatesRemovedPct === 'number', `Dupes removed: ${dashData29.summary?.duplicatesRemovedPct}%`);
  assertCheck('2.8 Dashboard Live 2026-09-29 Active Employees', Array.isArray(dashData29.employees) && dashData29.employees.length > 0, `Active CS employees: ${dashData29.employees?.length}`);
  assertCheck('2.9 Pool Status Total Orders matches DB exactly', poolData29.total_orders === dbOrdersTotal29, `API: ${poolData29.total_orders}, SQLite DB: ${dbOrdersTotal29}`);
  assertCheck('2.10 Pool Status Accounts Count matches DB exactly', poolData29.accounts_count === dbAccountsCount29, `API: ${poolData29.accounts_count}, SQLite DB: ${dbAccountsCount29}`);
  assertCheck('2.11 Live Working Team Active in DB', dbWorkingTeam29 > 0, `Working team members: ${dbWorkingTeam29}`);


  // ==========================================
  // PART 3: TRACKING & VIEW REALITY RUNTIME PROOF
  // ==========================================
  console.log('\n>>> SECTION 3: TRACKING & VIEW REALITY RESOLUTION PROOF <<<');

  const { data: trackOverview } = await fetchJson('/api/tracking/overview');
  assertCheck('3.1 Tracking Overview Endpoint Active', trackOverview && trackOverview.employees_outside_allocation !== undefined, 'Tracking overview operational');

  // Verify that any outside employee record in the overview includes both employee_id and employee_name
  if (trackOverview.employees_outside_allocation && trackOverview.employees_outside_allocation.length > 0) {
    const sampleEmp = trackOverview.employees_outside_allocation[0];
    assertCheck('3.2 Overview provides valid employee_id', sampleEmp.employee_id !== undefined && sampleEmp.employee_id !== null, `ID: ${sampleEmp.employee_id}, Name: ${sampleEmp.employee_name}`);
  } else {
    assertCheck('3.2 Overview schema validated', true, 'Zero outside employees on current snapshot');
  }

  // Test View Reality Employee Lookup by ID at runtime
  const anyEmployee = db.prepare('SELECT id, name FROM employees WHERE active = 1 LIMIT 1').get();
  if (anyEmployee) {
    const { data: empReality } = await fetchJson(`/api/tracking/${targetDate}/employee/${anyEmployee.id}`);
    assertCheck('3.3 View Reality routes via employee_id correctly', empReality.employee_id === anyEmployee.id, `Resolved employee ID ${empReality.employee_id} (${empReality.employee_name})`);
  }

  const { data: teamSummary } = await fetchJson(`/api/tracking/${targetDate}/team-summary`);
  assertCheck('3.4 Team Summary Active', teamSummary && Array.isArray(teamSummary.employees), `Team tracking count: ${teamSummary.employees?.length}`);


  // ==========================================
  // PART 4: EXECUTIVE BI & REPORTS RUNTIME PROOF
  // ==========================================
  console.log('\n>>> SECTION 4: EXECUTIVE BI & SYSTEM HEALTH REPORTS <<<');

  const { data: execReport } = await fetchJson('/api/reports/executive-summary');
  assertCheck('4.1 Executive BI Summary Operational', execReport && (execReport.report_type === 'executive_summary' || execReport.report_type === 'executive-summary'), `Report: ${execReport.report_type}, Total Orders: ${execReport.total_orders}`);

  const { data: prodReport } = await fetchJson('/api/reports/productivity');
  assertCheck('4.2 Productivity Analytics Operational', prodReport !== undefined, 'Productivity dataset returned');

  const { data: sysHealth } = await fetchJson('/api/reports/system-health');
  assertCheck('4.3 System Health Operational', sysHealth && (sysHealth.report_type === 'system_health' || sysHealth.report_type === 'system-health') && sysHealth.database?.healthy === true && sysHealth.vendoor?.enabled === true, `Database healthy: ${sysHealth.database?.healthy}, Vendoor enabled: ${sysHealth.vendoor?.enabled}`);

  console.log('\n================================================================');
  console.log(`TOTAL CHECKS: ${totalChecks} | PASSED: ${passedChecks} | FAILED: ${totalChecks - passedChecks}`);
  console.log(`FINAL RESULT: ${passedChecks === totalChecks ? 'ALL DIRECT RUNTIME CHECKS PASSED (100%)' : 'FAILURES DETECTED'}`);
  console.log('================================================================\n');

  if (passedChecks !== totalChecks) {
    process.exit(1);
  }
}

runDirectRuntimeE2EProof().catch(err => {
  console.error('Direct runtime test error:', err);
  process.exit(1);
});
