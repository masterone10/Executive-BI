import Database from 'better-sqlite3';
import path from 'path';

const ROOT_DIR = process.cwd();
const dbPath = process.env.DATABASE_PATH ? path.resolve(ROOT_DIR, process.env.DATABASE_PATH) : path.join(ROOT_DIR, 'data.db');
const db = new Database(dbPath);

async function runVerification() {
  console.log('=== RUNTIME VERIFICATION AUDIT ===\n');

  // 1. DB Path and Row Counts
  console.log('--- 1. DATABASE ROW COUNTS ---');
  console.log('Database Path:', dbPath);
  const tables = [
    'current_work_orders',
    'raw_log_records',
    'daily_working_team',
    'order_level_allocations',
    'employees',
    'vendoor_orders',
    'vendoor_sync_runs',
    'vendoor_logs'
  ];
  const dbCounts = {};
  for (const t of tables) {
    const row = db.prepare(`SELECT COUNT(*) as count FROM ${t}`).get();
    dbCounts[t] = row.count;
    console.log(`  ${t}: ${row.count}`);
  }

  // 2. Vendoor Connection Status
  console.log('\n--- 2. VENDOOR LIVE CONNECTION STATUS ---');
  const statusRes = await fetch('http://localhost:3000/api/integrations/vendoor/status');
  const statusData = await statusRes.json();
  console.log('Status HTTP:', statusRes.status);
  console.log('Connection State:', statusData.connection_state);
  console.log('Session State:', statusData.session_state);
  console.log('Base URL:', statusData.base_url);
  console.log('Mock Mode:', statusData.mock_mode);

  // 3. Test Date 2026-09-08 KPI Reconciliation
  console.log('\n--- 3. DATE 2026-09-08 KPI RECONCILIATION ---');
  // DB query for 2026-09-08
  const dbOrdersTotal = db.prepare("SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = '2026-09-08'").get().c;
  const dbOrdersNew = db.prepare("SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = '2026-09-08' AND status = 'New'").get().c;
  const dbOrdersPending = db.prepare("SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = '2026-09-08' AND (status = 'Pending' OR source_file_slot = 2)").get().c;
  const dbTeamCount = db.prepare("SELECT COUNT(*) as c FROM daily_working_team WHERE work_date = '2026-09-08'").get().c;
  const dbAllocated = db.prepare("SELECT COUNT(*) as c FROM order_level_allocations WHERE allocation_date = '2026-09-08'").get().c;
  const dbUnallocated = Math.max(0, dbOrdersTotal - dbAllocated);
  const dbLogsCount = db.prepare("SELECT COUNT(*) as c FROM raw_log_records WHERE work_date = '2026-09-08'").get().c;
  const dbUniqueOrdersWorked = db.prepare("SELECT COUNT(DISTINCT order_code) as c FROM raw_log_records WHERE work_date = '2026-09-08' AND order_code != 'UNKNOWN'").get().c;

  console.log('DB Counts for 2026-09-08:');
  console.log('  Total Orders in current_work_orders:', dbOrdersTotal);
  console.log('  New Orders:', dbOrdersNew);
  console.log('  Pending Orders:', dbOrdersPending);
  console.log('  Working Team:', dbTeamCount);
  console.log('  Allocated Orders:', dbAllocated);
  console.log('  Unallocated Orders:', dbUnallocated);
  console.log('  Raw Log Records:', dbLogsCount);
  console.log('  Unique Orders Worked in Logs:', dbUniqueOrdersWorked);

  // API query for 2026-09-08
  const apiDataRes = await fetch('http://localhost:3000/api/data?date=2026-09-08');
  const apiData = await apiDataRes.json();
  const apiPerfRes = await fetch('http://localhost:3000/api/performance/2026-09-08');
  const apiPerf = await apiPerfRes.json();
  const apiPoolRes = await fetch('http://localhost:3000/api/orders/pool-status/2026-09-08');
  const apiPool = await apiPoolRes.json();

  console.log('\nAPI Counts for 2026-09-08:');
  console.log('  apiData.work_date:', apiData.work_date);
  console.log('  apiData.team count:', apiData.team?.length || 0);
  console.log('  apiData.orders count:', apiData.orders?.length || 0);
  console.log('  apiPerf.totals.actions:', apiPerf.totals?.actions);
  console.log('  apiPool.total_orders:', apiPool.total_orders);
  console.log('  apiPool.unallocated_count:', apiPool.unallocated_count);

  // 4. Test Date 2026-09-18 (Today / Live Date)
  console.log('\n--- 4. DATE 2026-09-18 (LIVE DATE) KPI RECONCILIATION ---');
  const dbOrdersTotalLive = db.prepare("SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = '2026-09-18'").get().c;
  const dbOrdersNewLive = db.prepare("SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = '2026-09-18' AND status = 'New'").get().c;
  const dbOrdersPendingLive = db.prepare("SELECT COUNT(*) as c FROM current_work_orders WHERE work_date = '2026-09-18' AND (status = 'Pending' OR source_file_slot = 2)").get().c;
  const dbTeamCountLive = db.prepare("SELECT COUNT(*) as c FROM daily_working_team WHERE work_date = '2026-09-18'").get().c;
  const dbAllocatedLive = db.prepare("SELECT COUNT(*) as c FROM order_level_allocations WHERE allocation_date = '2026-09-18'").get().c;
  const dbUnallocatedLive = Math.max(0, dbOrdersTotalLive - dbAllocatedLive);
  const dbLogsCountLive = db.prepare("SELECT COUNT(*) as c FROM raw_log_records WHERE work_date = '2026-09-18'").get().c;
  const dbUniqueOrdersWorkedLive = db.prepare("SELECT COUNT(DISTINCT order_code) as c FROM raw_log_records WHERE work_date = '2026-09-18' AND order_code != 'UNKNOWN'").get().c;

  console.log('DB Counts for 2026-09-18:');
  console.log('  Total Orders in current_work_orders:', dbOrdersTotalLive);
  console.log('  New Orders:', dbOrdersNewLive);
  console.log('  Pending Orders:', dbOrdersPendingLive);
  console.log('  Working Team:', dbTeamCountLive);
  console.log('  Allocated Orders:', dbAllocatedLive);
  console.log('  Unallocated Orders:', dbUnallocatedLive);
  console.log('  Raw Log Records:', dbLogsCountLive);
  console.log('  Unique Orders Worked in Logs:', dbUniqueOrdersWorkedLive);

  // API query for 2026-09-18
  const livePoolRes = await fetch('http://localhost:3000/api/orders/pool-status/2026-09-18');
  const livePool = await livePoolRes.json();
  console.log('\nAPI Pool for 2026-09-18:');
  console.log('  total_orders:', livePool.total_orders);
  console.log('  new_orders:', livePool.new_orders);
  console.log('  pending_orders:', livePool.pending_orders);
  console.log('  allocated_count:', livePool.allocated_count);
  console.log('  unallocated_count:', livePool.unallocated_count);

  console.log('\n=== AUDIT COMPLETE ===');
}

runVerification().catch(err => console.error('Verification failed:', err));
