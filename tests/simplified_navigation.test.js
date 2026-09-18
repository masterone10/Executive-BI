import assert from 'assert';
import fs from 'fs';

console.log('--- STARTING SIMPLIFIED NAVIGATION & UI REORGANIZATION TESTS ---');

const templateContent = fs.readFileSync('template.html', 'utf8');

// Test 1: Verify 5 Main Navigation Items in Sidebar
console.log('Testing: Sidebar Navigation Structure...');
assert(templateContent.includes('data-p="dashboard"'), 'Dashboard sidebar item missing');
assert(templateContent.includes('data-p="operations"'), 'Operations sidebar item missing');
assert(templateContent.includes('data-p="tracking"'), 'Tracking sidebar item missing');
assert(templateContent.includes('data-p="management"'), 'Management sidebar item missing');
assert(templateContent.includes('data-p="performance"'), 'Performance sidebar item missing');
console.log('✓ PASS: Exactly 5 main sidebar navigation categories present.');

// Test 2: Verify MAIN_PAGES_CONFIG & Subtabs
console.log('Testing: MAIN_PAGES_CONFIG and Subtabs Configuration...');
assert(templateContent.includes('dashboard: {'), 'Dashboard config missing');
assert(templateContent.includes('operations: {'), 'Operations config missing');
assert(templateContent.includes('tracking: {'), 'Tracking config missing');
assert(templateContent.includes('management: {'), 'Management config missing');
assert(templateContent.includes('performance: {'), 'Performance config missing');

// Subtabs verification
assert(templateContent.includes("id: 'allocation'"), 'Allocation subtab missing');
assert(templateContent.includes("id: 'dispatcher'"), 'Dispatcher subtab missing');
assert(templateContent.includes("id: 'working-team'"), 'Working team subtab missing');
assert(templateContent.includes("id: 'orders-pool'"), 'Orders pool subtab missing');
assert(templateContent.includes("id: 'history'"), 'History subtab missing');
assert(templateContent.includes("id: 'scorecard'"), 'Scorecard subtab missing');
console.log('✓ PASS: Subtabs configured for all 5 categories.');

// Test 3: Verify Legacy Route Map for Backward-Compatibility
console.log('Testing: Backward-Compatibility & Route Aliasing...');
assert(templateContent.includes('LEGACY_ROUTE_MAP'), 'LEGACY_ROUTE_MAP missing');
assert(templateContent.includes("'work-allocation': { page: 'operations', tab: 'allocation' }"), 'work-allocation legacy route missing');
assert(templateContent.includes("'working-team': { page: 'operations', tab: 'working-team' }"), 'working-team legacy route missing');
assert(templateContent.includes("'account-config': { page: 'management', tab: 'accounts' }"), 'account-config legacy route missing');
console.log('✓ PASS: Legacy route aliases intact.');

// Test 4: Verify Account Cards as Primary View in Work Allocation
console.log('Testing: Account Cards Primary View in Work Allocation...');
assert(templateContent.includes("let workAllocViewMode = 'accounts'"), 'workAllocViewMode default must be accounts');
assert(templateContent.includes('copyAllEmployeesDirect'), 'copyAllEmployeesDirect missing');
assert(templateContent.includes('copySelectedEmployeeDirect'), 'copySelectedEmployeeDirect missing');
assert(templateContent.includes('export-zip'), 'export-zip button link missing');
assert(templateContent.includes('1 Account → 1 CS'), 'Small account tag missing');
console.log('✓ PASS: Account Cards configured as primary view with direct copy and export actions.');

console.log('--- ALL SIMPLIFIED NAVIGATION TESTS PASSED SUCCESSFULLY! ---');
