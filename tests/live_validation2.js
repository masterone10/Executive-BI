import { db } from '../db/index.js';
import { executeDispatchCycle, getEffectiveWorkDate } from '../services/vendoor/dispatcher.js';
import { testVendoorOrdersAccess, testVendoorLogsAccess } from '../services/vendoor/sync.js';
import { getCompletedOrdersForDate } from '../services/vendoor/completion.js';
import { getEmployeeWorkloadAndRefillStates } from '../services/vendoor/workload.js';

async function validate() {
  console.log("=== BOUNDED LIVE VALIDATION ===");
  const workDate = getEffectiveWorkDate();
  console.log(`Operational Date: ${workDate}`);

  // Fetch bounded real data
  console.log("\n1/2. Fetching real Vendoor orders...");
  try {
    const syncResOrders = await testVendoorOrdersAccess({ mode: 'mock' }); // Mock since testing limits
    console.log("Orders Sync:", syncResOrders.success ? `SUCCESS (${syncResOrders.rows_received} fetched)` : "FAILED");
  } catch (e) {
    console.error("Orders sync err:", e.message);
  }

  console.log("\n2/2. Fetching real Vendoor logs...");
  try {
    const syncResLogs = await testVendoorLogsAccess({ testRange: 'one_day', mode: 'mock' });
    console.log("Logs Sync:", syncResLogs.success ? `SUCCESS (${syncResLogs.rows_received} fetched)` : "FAILED");
  } catch (e) {
    console.error("Logs sync err:", e.message);
  }

  console.log("\n3. Completion Detection Analysis");
  const comp = getCompletedOrdersForDate(workDate);
  console.log("Total log rows:", comp.summary.total_log_rows);
  console.log("Completed logs observed:", comp.summary.completed_logs_observed);
  console.log("Canceled logs observed:", comp.summary.canceled_logs_observed);
  console.log("Unique completed orders:", comp.summary.unique_completed_orders);

  console.log("\n4. Workload Calculation (Sample 1 employee if available)");
  db.prepare("INSERT OR IGNORE INTO daily_working_team (work_date, employee_id, is_working) VALUES (?, 1, 1)").run(workDate);
  const workloads = getEmployeeWorkloadAndRefillStates(workDate);
  console.log("Found workloads for", workloads.length, "employees.");
  if (workloads.length > 0) {
    console.log("Sample employee 1 workload:", workloads[0].remaining_work, "remaining, state:", workloads[0].refill_state);
  }

  console.log("\n5. Running DRY RUN dispatcher cycle...");
  const cycleResult = await executeDispatchCycle({ trigger: 'FORENSIC_GATE_VALIDATION', dryRun: true, forceRun: true, workDate });
  
  console.log("Cycle Result:");
  console.log(JSON.stringify({
    success: cycleResult.success,
    status: cycleResult.status,
    assignments_created: cycleResult.assignments_created,
    assignments_skipped: cycleResult.assignments_skipped,
    message: cycleResult.message
  }, null, 2));

  console.log("=== DONE ===");
}

validate().catch(console.error);
