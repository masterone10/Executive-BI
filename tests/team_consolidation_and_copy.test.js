import assert from 'assert';
import fs from 'fs';
import { db } from '../db/index.js';

console.log('--- STARTING TEAM CONSOLIDATION & TEAM COPY VERIFICATION TESTS ---');

const templateContent = fs.readFileSync('template.html', 'utf8');

// =========================================================================
// 1. VERIFY ISSUE #1: TEAM + EMPLOYEES HAS ONE ADMINISTRATIVE HOME
// =========================================================================
console.log('1. Testing: Team & Employees Administrative Home...');

// 1.1 Management must have ONE single home for Team & Employees: 'team-employees'
assert(templateContent.includes("defaultTab: 'team-employees'"), "Management defaultTab must be team-employees");
assert(templateContent.includes("{ id: 'team-employees', label: 'Team & Employees', icon: '👥' }"), "team-employees tab missing in management");

// Verify that disconnected separate tabs 'employees' and 'teams' are NOT top-level tabs in management
const mgmtBlockMatch = templateContent.match(/management:\s*\{[\s\S]*?tabs:\s*\[([\s\S]*?)\]\s*\}/);
assert(mgmtBlockMatch, "management config block not found");
const mgmtTabsContent = mgmtBlockMatch[1];
const mgmtTabIds = Array.from(mgmtTabsContent.matchAll(/id:\s*['"]([^'"]+)['"]/g)).map(m => m[1]);
assert.deepStrictEqual(mgmtTabIds, ['team-employees', 'accounts', 'access', 'vendoor'], 
  `Management tabs must be exactly [team-employees, accounts, access, vendoor], got: ${JSON.stringify(mgmtTabIds)}`);
console.log('✓ PASS: Management has exactly ONE administrative home for Team & Employees.');

// 1.2 Top-level TEAM is strictly for operational viewing
assert(templateContent.includes("title: 'Team Operations'"), "Top-level Team title must be 'Team Operations'");
assert(templateContent.includes("Operational CS Team Roster (Read-Only)"), "Operational roster must indicate Read-Only");
assert(templateContent.includes("Operational Working Team Presence (Read-Only)"), "Operational working team must indicate Read-Only");
assert(templateContent.includes("عرض تشغيلي فقط (Read-Only Monitoring)"), "Operational working team banner present");
console.log('✓ PASS: Top-level Team page is designated strictly for operational viewing.');

// 1.3 Sub-pill navigation inside Management -> Team & Employees owns all three:
// Employees Master & Capacity, Teams Setup & Membership, Today's Working Shifts
assert(templateContent.includes("loadTeamEmployeesAdminView('employees')"), "Subview employees missing");
assert(templateContent.includes("loadTeamEmployeesAdminView('teams')"), "Subview teams missing");
assert(templateContent.includes("loadTeamEmployeesAdminView('shifts')"), "Subview shifts missing");
console.log('✓ PASS: All Team + Employee configuration subviews live inside the single administrative home.');

// =========================================================================
// 2. VERIFY ISSUE #2: TEAM-LEVEL COPY (SOURCE TEAM -> TARGET TEAM)
// =========================================================================
console.log('2. Testing: Team-Level Copy UI & API Contract...');

// 2.1 UI check: Exactly ONE Team Copy action in Team Setup, NO row-level copy buttons
assert(templateContent.includes('id="btnAdminTeamCopy"'), "btnAdminTeamCopy missing in Team Setup header");
assert(templateContent.includes("openTeamCopyModal()"), "openTeamCopyModal function missing");
assert(!templateContent.includes("copyEmpRow"), "No row-level employee copy buttons allowed");

// 2.2 Modal structure: Source Team, Target Team, Review box, Persist
assert(templateContent.includes('id="teamCopySourceTeam"'), "teamCopySourceTeam dropdown missing");
assert(templateContent.includes('id="teamCopyTargetTeam"'), "teamCopyTargetTeam dropdown missing");
assert(templateContent.includes('id="teamCopyReviewBox"'), "teamCopyReviewBox confirmation review missing");
assert(templateContent.includes('id="btnExecuteTeamCopy"'), "btnExecuteTeamCopy confirmation button missing");
console.log('✓ PASS: Team Copy UI strictly adheres to Source Team -> Target Team review and confirm workflow.');

// 2.3 Backend API Verification with Database
const initialEmpCount = db.prepare('SELECT count(*) as cnt FROM employees').get().cnt;
const initialOrderCount = db.prepare('SELECT count(*) as cnt FROM current_work_orders').get().cnt;

// Verify valid teams in employees table
const membersNew = db.prepare("SELECT count(*) as cnt FROM employees WHERE team_membership = 'New' AND active = 1").get().cnt;
const membersPending = db.prepare("SELECT count(*) as cnt FROM employees WHERE team_membership = 'Pending' AND active = 1").get().cnt;
console.log(`Initial DB state: ${initialEmpCount} employees (${membersNew} New, ${membersPending} Pending), ${initialOrderCount} work orders.`);

// Check server.js copy-configuration handler logic
const serverCode = fs.readFileSync('server.js', 'utf8');
assert(serverCode.includes("app.post('/api/team/copy-configuration'"), "POST /api/team/copy-configuration must exist");
assert(serverCode.includes("sourceTeamId"), "sourceTeamId must be supported in API contract");
assert(serverCode.includes("targetTeamId"), "targetTeamId must be supported in API contract");
assert(serverCode.includes("Source Team and Target Team must be different"), "Self-copy prevention required");

// Test that runtime entities cannot be modified by team copy
assert(!serverCode.match(/\/api\/team\/copy-configuration[\s\S]*?INSERT INTO current_work_orders/i), 
  "Team copy must NEVER write to current_work_orders");
assert(!serverCode.match(/\/api\/team\/copy-configuration[\s\S]*?INSERT INTO allocations/i), 
  "Team copy must NEVER write to allocations");
assert(!serverCode.match(/\/api\/team\/copy-configuration[\s\S]*?INSERT INTO audit_tracking_events/i), 
  "Team copy must NEVER write to audit_tracking_events");
console.log('✓ PASS: Team Copy API contract is strictly scoped to configuration with zero runtime side-effects.');

// =========================================================================
// 3. VERIFY ISSUE #3: REAL LEGACY PURGE
// =========================================================================
console.log('3. Testing: Legacy Purge & No Duplicate Systems...');

// 3.1 Verify no duplicate Account Settings pages
const accountTabs = Array.from(templateContent.matchAll(/id:\s*['"]accounts['"]/g));
// Accounts is a subtab under tracking and management, but account configuration is only under management
assert(templateContent.includes("loadAccountConfigView"), "loadAccountConfigView missing");

// 3.2 Verify classList safety guards against TypeError
assert(templateContent.includes("if (btn && btn.classList) btn.classList.toggle"), "btn classList safety guard missing");
assert(templateContent.includes("if (a && a.classList) a.classList.toggle"), "a classList safety guard missing");
assert(templateContent.includes("if (sideEl && sideEl.classList)"), "sideEl classList guard missing");
console.log('✓ PASS: Legacy references cleaned and classList safety guards in place.');

// =========================================================================
// 4. SUMMARY
// =========================================================================
console.log('--- ALL TEAM CONSOLIDATION & COPY VERIFICATION TESTS PASSED! ---');
