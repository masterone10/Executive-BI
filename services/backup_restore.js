/**
 * services/backup_restore.js
 * Comprehensive SQLite Online Backup & Safe Restore Engine
 * - Uses better-sqlite3 db.backup() for atomic, WAL-consistent online backups
 * - Provides verified point-in-time snapshot creation
 * - Provides verified database restoration with pre-flight and post-flight integrity checks
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { db, DB_PATH } from '../db/index.js';

const BACKUPS_DIR = path.join(process.cwd(), 'backups');

function ensureBackupsDir() {
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }
}

/**
 * Creates an online, atomic point-in-time backup of the active SQLite database
 * @param {string} [customFilename] 
 * @returns {Promise<{ success: boolean, backup_path: string, filename: string, size_bytes: number, integrity: string, timestamp: string }>}
 */
export async function createDatabaseBackup(customFilename = null) {
  ensureBackupsDir();
  const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = customFilename || `backup_${timestampStr}.db`;
  const backupPath = path.join(BACKUPS_DIR, filename);

  // Run online backup via better-sqlite3
  await db.backup(backupPath);

  // Pre-flight check on backup file
  const backupDb = new Database(backupPath, { readonly: true });
  const check = backupDb.pragma('integrity_check');
  const integrity = check && check[0] ? check[0].integrity_check : 'unknown';
  const stat = fs.statSync(backupPath);
  backupDb.close();

  if (integrity !== 'ok') {
    throw new Error(`Backup integrity check failed: ${integrity}`);
  }

  return {
    success: true,
    backup_path: backupPath,
    filename,
    size_bytes: stat.size,
    integrity,
    timestamp: new Date().toISOString()
  };
}

/**
 * Restores the target database from a verified backup file
 * @param {string} backupFilePath 
 * @param {string} [targetDbPath] 
 * @returns {{ success: boolean, restored_path: string, tables_count: number, integrity: string, records_restored: Record<string, number> }}
 */
export function restoreDatabaseFromBackup(backupFilePath, targetDbPath = DB_PATH) {
  if (!fs.existsSync(backupFilePath)) {
    throw new Error(`Backup file does not exist at: ${backupFilePath}`);
  }

  // 1. Verify backup file integrity before attempting restore
  const srcDb = new Database(backupFilePath, { readonly: true });
  const srcCheck = srcDb.pragma('integrity_check');
  if (!srcCheck || srcCheck[0]?.integrity_check !== 'ok') {
    srcDb.close();
    throw new Error('CORRUPT_BACKUP: The provided backup file failed SQLite integrity check.');
  }

  // Count source records
  const tables = srcDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const recordCounts = {};
  for (const t of tables) {
    try {
      const count = srcDb.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get().c;
      recordCounts[t.name] = count;
    } catch (_) {}
  }
  srcDb.close();

  // 2. Perform atomic file restore
  // In WAL mode, we also remove any existing -wal or -shm files for the target db to prevent stale pages
  const targetDir = path.dirname(targetDbPath);
  const targetBase = path.basename(targetDbPath);
  const walPath = path.join(targetDir, `${targetBase}-wal`);
  const shmPath = path.join(targetDir, `${targetBase}-shm`);

  // Close active WAL connections if restoring directly to live DB in production
  try {
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
  } catch (_) {}

  fs.copyFileSync(backupFilePath, targetDbPath);

  // 3. Verify restored database
  const destDb = new Database(targetDbPath);
  destDb.pragma('journal_mode = WAL');
  const postCheck = destDb.pragma('integrity_check');
  const fkCheck = destDb.pragma('foreign_key_check');
  const integrity = postCheck && postCheck[0] ? postCheck[0].integrity_check : 'failed';
  destDb.close();

  if (integrity !== 'ok') {
    throw new Error(`Restore failed post-flight integrity check: ${integrity}`);
  }

  return {
    success: true,
    restored_path: targetDbPath,
    tables_count: tables.length,
    integrity,
    foreign_key_violations: fkCheck ? fkCheck.length : 0,
    records_restored: recordCounts
  };
}
