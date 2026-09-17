import { db } from '../db/index.js';
import { executeDispatchCycle, getEffectiveWorkDate } from '../services/vendoor/dispatcher.js';

async function validate() {
  console.log("=== BOUNDED LIVE VALIDATION ===");
  const workDate = getEffectiveWorkDate();
  console.log(`Operational Date: ${workDate}`);

  console.log("\nRunning DRY RUN dispatcher cycle...");
  const cycleResult = await executeDispatchCycle({ trigger: 'FORENSIC_GATE_VALIDATION', dryRun: true, forceRun: true, workDate });

  console.log("Cycle Result:");
  console.log(JSON.stringify(cycleResult, null, 2));

  console.log("=== DONE ===");
}

validate().catch(console.error);
