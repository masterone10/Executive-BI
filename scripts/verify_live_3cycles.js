import { db } from '../db/index.js';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchStatus() {
  const res = await fetch('http://localhost:3000/api/integrations/vendoor/poller/status');
  return await res.json();
}

async function runProof() {
  console.log('=== STARTING LIVE PROOF MONITORED ACROSS 3 CONSECUTIVE CYCLES ===');
  
  const samples = [];
  const startTime = Date.now();
  
  // Monitor for ~95 seconds (3 x 30s cycles + buffer)
  while (Date.now() - startTime < 95000) {
    const status = await fetchStatus();
    const nowStr = new Date().toISOString();
    
    console.log(`[${nowStr}] Poller Running: ${status.isRunning} | Connection State: ${status.connection_state} | Orders RunCount: ${status.orders.run_count} (Status: ${status.orders.status}) | Logs RunCount: ${status.logs.run_count} (Status: ${status.logs.status})`);
    
    samples.push({
      timestamp: nowStr,
      status
    });
    
    await sleep(10000); // Sample every 10 seconds
  }

  console.log('\n=== RECENT VENDOOR SYNC RUNS FROM DATABASE ===');
  const runs = db.prepare(`
    SELECT sync_run_id, resource, status, records_fetched, records_accepted, duration_ms, created_at
    FROM vendoor_sync_runs
    ORDER BY id DESC
    LIMIT 10
  `).all();
  
  console.table(runs);

  console.log('\n=== RECENT WORK ORDERS IN POOL ===');
  const poolCounts = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM current_work_orders
    WHERE work_date = date('now')
    GROUP BY status
  `).all();
  
  console.table(poolCounts);

  console.log('\n=== RECENT RAW LOG RECORDS ===');
  const logCounts = db.prepare(`
    SELECT COUNT(*) as total_logs, COUNT(DISTINCT order_code) as unique_orders
    FROM raw_log_records
    WHERE work_date = date('now')
  `).get();
  
  console.log('Today Raw Logs:', logCounts);
}

runProof().catch(console.error);
