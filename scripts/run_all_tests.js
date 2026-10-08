import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const testsDir = path.resolve('tests');
const files = fs.readdirSync(testsDir)
  .filter(f => f.endsWith('.test.js'))
  .sort();

console.log('====================================================');
console.log(`DISCOVERED TEST FILES: ${files.length}`);
console.log('====================================================');

let totalFiles = files.length;
let passedFiles = 0;
let failedFiles = 0;
const failures = [];

const startTime = Date.now();

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const fullPath = path.join(testsDir, file);
  process.stdout.write(`[${i + 1}/${totalFiles}] Running ${file}... `);

  const res = spawnSync(process.execPath, [fullPath], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test' },
    encoding: 'utf-8',
    timeout: 90000
  });

  if (res.status === 0) {
    passedFiles++;
    console.log('PASSED');
  } else {
    failedFiles++;
    console.log('FAILED (Exit Code:', res.status, ')');
    failures.push({ file, output: res.stderr || res.stdout });
  }
}

const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
console.log('\n====================================================');
console.log('TEST SUITE EXECUTION SUMMARY');
console.log('====================================================');
console.log(`Discovered Files: ${totalFiles}`);
console.log(`Executed Files:   ${totalFiles}`);
console.log(`Passed Files:     ${passedFiles}`);
console.log(`Failed Files:     ${failedFiles}`);
console.log(`Duration:         ${durationSec}s`);

if (failedFiles > 0) {
  console.log('\nFAILURES DETAILS:');
  for (const f of failures) {
    console.log(`\n====================================================`);
    console.log(`FAILING TEST: ${f.file}`);
    console.log(`====================================================`);
    console.log(f.output || '(No output recorded)');
  }
  process.exit(1);
} else {
  console.log(`\nALL ${passedFiles} TEST FILES PASSED SUCCESSFULLY!`);
  process.exit(0);
}
