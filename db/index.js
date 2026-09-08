import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const ROOT_DIR = process.cwd();
const DB_PATH = path.join(ROOT_DIR, 'data.db');
const SCHEMA_PATH = path.join(ROOT_DIR, 'db', 'schema.sql');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Safe migrations function for existing and new databases
export function runMigrations(database = db) {
  // Safe table migration: Ensure is_working exists in daily_working_team
  try {
    const cols = database.prepare("PRAGMA table_info(daily_working_team)").all();
    if (cols.length > 0 && !cols.some(c => c.name === 'is_working')) {
      database.exec("ALTER TABLE daily_working_team ADD COLUMN is_working INTEGER NOT NULL DEFAULT 1");
      // Explicitly guarantee all pre-existing rows have is_working = 1
      database.exec("UPDATE daily_working_team SET is_working = 1 WHERE is_working IS NULL");
      console.log('✓ Successfully migrated daily_working_team: added is_working column');
    }
  } catch (e) {
    console.warn('Migration check for daily_working_team is_working:', e.message);
  }

  // Safe table migration: Ensure source_file_slot exists in current_work_orders
  try {
    const cols = database.prepare("PRAGMA table_info(current_work_orders)").all();
    if (cols.length > 0 && !cols.some(c => c.name === 'source_file_slot')) {
      database.exec("ALTER TABLE current_work_orders ADD COLUMN source_file_slot INTEGER DEFAULT 1");
    }
  } catch (e) {
    // Ignored if table not created yet or column exists
  }

  // Safe index migration: Ensure UNIQUE index on (date, employee_name) for performance_snapshots
  try {
    database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_perf_snapshots_date_emp ON performance_snapshots(date, employee_name)");
  } catch (e) {
    // Ignored if index exists
  }
}

// Initialize schema
export function initDB() {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schema);

  // Run all safe migrations
  runMigrations(db);

  // Seed default system configs if empty
  const configCount = db.prepare('SELECT COUNT(*) as count FROM system_configs').get().count;
  if (configCount === 0) {
    const insertConfig = db.prepare('INSERT INTO system_configs (key, value, description) VALUES (?, ?, ?)');
    insertConfig.run('weight_productivity', '0.30', 'Weight for activity/productivity score');
    insertConfig.run('weight_printed', '0.25', 'Weight for printed efficiency score');
    insertConfig.run('weight_pending_control', '0.15', 'Weight for pending control score');
    insertConfig.run('weight_cancel_control', '0.20', 'Weight for cancellation control score');
    insertConfig.run('weight_processing', '0.10', 'Weight for processing efficiency score');
    insertConfig.run('min_actions_threshold', '50', 'Minimum actions needed for high confidence score');
  }

  // Seed employees from data.json if employees table is empty
  const empCount = db.prepare('SELECT COUNT(*) as count FROM employees').get().count;
  if (empCount === 0) {
    seedInitialEmployees();
  }
}

function seedInitialEmployees() {
  const dataJsonPath = path.join(ROOT_DIR, 'data.json');
  if (!fs.existsSync(dataJsonPath)) return;

  try {
    const d = JSON.parse(fs.readFileSync(dataJsonPath, 'utf-8'));
    const insertEmp = db.prepare(`
      INSERT OR IGNORE INTO employees (name, department, active)
      VALUES (?, ?, 1)
    `);

    const tx = db.transaction(() => {
      // 1. Insert CS employees
      if (d.employees && Array.isArray(d.employees)) {
        for (const e of d.employees) {
          if (e.name) {
            insertEmp.run(e.name.trim(), 'CS');
          }
        }
      }

      // 2. Insert Non-CS / Data Entry from added_all_top
      if (d.added_all_top && Array.isArray(d.added_all_top)) {
        for (const a of d.added_all_top) {
          if (a.name) {
            const isCS = a.is_cs || a.name.trim().toLowerCase().endsWith('cs');
            const dept = isCS ? 'CS' : (/data\s*entry/i.test(a.name) ? 'Data Entry' : 'Other');
            insertEmp.run(a.name.trim(), dept);
          }
        }
      }
    });

    tx();
    console.log('Seeded employees into SQLite database successfully.');
  } catch (err) {
    console.error('Error seeding initial employees:', err);
  }
}

// Ensure database is initialized on module load
initDB();

export default db;
