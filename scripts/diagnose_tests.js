import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const testsDir = path.resolve('tests');
const files = fs.readdirSync(testsDir)
  .filter(f => f.endsWith('.test.js'))
  .sort();

console.log(`Running diagnostics on ${files.length} test files...`);

const summary = {
  timestamp: new Date().toISOString(),
  total: files.length,
  passed: 0,
  failed: 0,
  failures: [],
  passedFiles: []
};

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const fullPath = path.join(testsDir, file);

  const res = spawnSync(process.execPath, [fullPath], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test' },
    encoding: 'utf-8',
    timeout: 60000
  });

  if (res.status === 0) {
    summary.passed++;
    summary.passedFiles.push(file);
    console.log(`[${i + 1}/${files.length}] PASS: ${file}`);
  } else {
    summary.failed++;
    const errMsg = (res.stderr || res.stdout || 'Unknown error').trim().split('\n').slice(-15).join('\n');
    summary.failures.push({ file, exitCode: res.status, error: errMsg });
    console.log(`[${i + 1}/${files.length}] FAIL: ${file} (code ${res.status})`);
  }
  // Write progress checkpoint
  fs.writeFileSync('test_run_summary.json', JSON.stringify(summary, null, 2));
}

console.log(`Finished: ${summary.passed} PASSED, ${summary.failed} FAILED`);
