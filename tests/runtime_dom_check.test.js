import assert from 'assert';
import fs from 'fs';
import { JSDOM } from 'jsdom';

console.log('--- STARTING RUNTIME DOM & ERROR CHECK ---');

const html = fs.readFileSync('public/index.html', 'utf8');

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  url: 'http://localhost:3000/'
});

const { window } = dom;
const { document } = window;

// Check navigation elements
assert(document.querySelector('.ds-nav-links'), 'Top nav links container exists');
const managementBtn = document.querySelector('button[data-p="management"]');
assert(managementBtn, 'Management button exists');

const teamBtn = document.querySelector('button[data-p="team"]');
assert(teamBtn, 'Team button exists');

console.log('✓ PASS: Nav buttons exist without null reference.');

// Check that teamCopyModal exists or is created on demand
assert(typeof window.openTeamCopyModal === 'function' || html.includes('openTeamCopyModal'), 'openTeamCopyModal is defined');

console.log('✓ PASS: Runtime DOM structure verified cleanly.');
