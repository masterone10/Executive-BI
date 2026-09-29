/**
 * tests/backup_restore_drill.test.js
 * Comprehensive Forensic Live Drill for SQLite Backup and Restore
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createDatabaseBackup, restoreDatabaseFromBackup } from '../services/backup_restore.js';

test('BACKUP & RESTORE FORENSIC LIVE DRILL', async (t) => {
  const testDbDir = path.join(process.cwd(), 'temp_drill');
  if (!fs.existsSync(testDbDir)) fs.mkdirSync(testDbDir, { recursive: true });

  const testDbPath = path.join(testDbDir, 'drill_original.db');
  const restoredDbPath = path.join(testDbDir, 'drill_restored.db');
  const backupFilePath = path.join(testDbDir, 'drill_snapshot.db');

  // Clean prior drill artifacts
  [testDbPath, restoredDbPath, backupFilePath].forEach(f => {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  });

  // 1. Initialize a rich sample database
  const originalDb = new Database(testDbPath);
  originalDb.pragma('journal_mode = WAL');
  originalDb.pragma('foreign_keys = ON');

  originalDb.exec(`
    CREATE TABLE employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      department TEXT NOT NULL,
      team_membership TEXT NOT NULL DEFAULT 'Both',
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE current_work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_date TEXT NOT NULL,
      order_code TEXT NOT NULL UNIQUE,
      account TEXT NOT NULL,
      status TEXT NOT NULL,
      work_state TEXT NOT NULL DEFAULT 'UNASSIGNED',
      assigned_employee_id INTEGER REFERENCES employees(id)
    );

    CREATE TABLE raw_log_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_date TEXT NOT NULL,
      order_code TEXT NOT NULL,
      employee_name TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      event_datetime TEXT NOT NULL,
      is_cs INTEGER NOT NULL DEFAULT 1
    );
  `);

  // Insert test records
  const insertEmp = originalDb.prepare('INSERT INTO employees (name, department, team_membership, active) VALUES (?, ?, ?, 1)');
  const emp1 = insertEmp.run('Sara CS Agent', 'CS', 'Both');
  const emp2 = insertEmp.run('Ahmed CS Agent', 'CS', 'New');

  const insertOrder = originalDb.prepare('INSERT INTO current_work_orders (work_date, order_code, account, status, work_state, assigned_employee_id) VALUES (?, ?, ?, ?, ?, ?)');
  insertOrder.run('2026-09-27', 'ORD-1001', 'Store Alpha', 'New', 'ASSIGNED', emp1.lastInsertRowid);
  insertOrder.run('2026-09-27', 'ORD-1002', 'Store Beta', 'Pending', 'ASSIGNED', emp2.lastInsertRowid);
  insertOrder.run('2026-09-27', 'ORD-1003', 'Store Gamma', 'New', 'UNASSIGNED', null);

  const insertLog = originalDb.prepare('INSERT INTO raw_log_records (work_date, order_code, employee_name, action, status, event_datetime, is_cs) VALUES (?, ?, ?, ?, ?, ?, 1)');
  insertLog.run('2026-09-27', 'ORD-1001', 'Sara CS Agent', 'Order Confirmed', 'Printed', '2026-09-27 10:15:00');
  insertLog.run('2026-09-27', 'ORD-1002', 'Ahmed CS Agent', 'Phone Call Customer', 'Pending', '2026-09-27 10:20:00');

  const originalEmpCount = originalDb.prepare('SELECT COUNT(*) as c FROM employees').get().c;
  const originalOrderCount = originalDb.prepare('SELECT COUNT(*) as c FROM current_work_orders').get().c;
  const originalLogCount = originalDb.prepare('SELECT COUNT(*) as c FROM raw_log_records').get().c;

  assert.equal(originalEmpCount, 2);
  assert.equal(originalOrderCount, 3);
  assert.equal(originalLogCount, 2);

  // 2. Perform Point-In-Time Backup
  await t.test('Step 1: Create Point-In-Time Backup file using SQLite Backup API', async () => {
    await originalDb.backup(backupFilePath);
    assert.ok(fs.existsSync(backupFilePath), 'Backup file must exist on disk');
    const stat = fs.statSync(backupFilePath);
    assert.ok(stat.size > 0, 'Backup file size must be > 0 bytes');

    // Verify backup integrity
    const chkDb = new Database(backupFilePath, { readonly: true });
    const integ = chkDb.pragma('integrity_check');
    assert.equal(integ[0].integrity_check, 'ok');
    chkDb.close();
  });

  // 3. Simulate Data Corruption / Accidental Deletion on Original DB
  await t.test('Step 2: Simulate Disaster / Accidental Deletion on Live Database', () => {
    originalDb.prepare('DELETE FROM current_work_orders WHERE order_code = ?').run('ORD-1001');
    originalDb.prepare('DELETE FROM current_work_orders WHERE order_code = ?').run('ORD-1002');
    originalDb.prepare('DELETE FROM employees WHERE name = ?').run('Ahmed CS Agent');
    originalDb.prepare('INSERT INTO current_work_orders (work_date, order_code, account, status) VALUES (?, ?, ?, ?)').run('2026-09-27', 'CORRUPT-999', 'Fake Store', 'Broken');

    const degradedEmpCount = originalDb.prepare('SELECT COUNT(*) as c FROM employees').get().c;
    const degradedOrderCount = originalDb.prepare('SELECT COUNT(*) as c FROM current_work_orders').get().c;

    assert.equal(degradedEmpCount, 1, 'Employees should be degraded to 1');
    assert.equal(degradedOrderCount, 2, 'Orders degraded to 2 (ORD-1003 and CORRUPT-999)');
  });

  // 4. Perform Full Restoration from the Backup file
  await t.test('Step 3: Execute Full Database Restoration from Backup file', () => {
    const restoreResult = restoreDatabaseFromBackup(backupFilePath, restoredDbPath);
    assert.equal(restoreResult.success, true);
    assert.equal(restoreResult.integrity, 'ok');
    assert.equal(restoreResult.foreign_key_violations, 0);

    // Verify restored database contents
    const rDb = new Database(restoredDbPath);
    const restoredEmpCount = rDb.prepare('SELECT COUNT(*) as c FROM employees').get().c;
    const restoredOrderCount = rDb.prepare('SELECT COUNT(*) as c FROM current_work_orders').get().c;
    const restoredLogCount = rDb.prepare('SELECT COUNT(*) as c FROM raw_log_records').get().c;

    assert.equal(restoredEmpCount, 2, 'Employees restored to exact count of 2');
    assert.equal(restoredOrderCount, 3, 'Orders restored to exact count of 3');
    assert.equal(restoredLogCount, 2, 'Logs restored to exact count of 2');

    // Verify deleted row ORD-1001 is back intact
    const ord1001 = rDb.prepare('SELECT * FROM current_work_orders WHERE order_code = ?').get('ORD-1001');
    assert.ok(ord1001, 'ORD-1001 must be completely restored');
    assert.equal(ord1001.account, 'Store Alpha');
    assert.equal(ord1001.status, 'New');

    // Verify deleted employee Ahmed is back intact
    const ahmed = rDb.prepare('SELECT * FROM employees WHERE name = ?').get('Ahmed CS Agent');
    assert.ok(ahmed, 'Ahmed CS Agent must be completely restored');

    // Verify corrupt row does not exist in restored database
    const corruptRow = rDb.prepare('SELECT * FROM current_work_orders WHERE order_code = ?').get('CORRUPT-999');
    assert.equal(corruptRow, undefined, 'Corrupt row must not exist in restored snapshot');

    rDb.close();
  });

  // Cleanup test resources
  originalDb.close();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});
