import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const ROOT_DIR = process.cwd();
const isExplicitProd = process.env.TARGET_DB === 'production' || process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production';
const isTestDetected = Boolean(
  process.env.NODE_ENV === 'test' ||
  process.env.VITEST ||
  process.env.JEST_WORKER_ID ||
  process.env.TEST_MODE === 'true' ||
  process.env.NODE_TEST_CONTEXT ||
  (process.argv && process.argv.some(arg => typeof arg === 'string' && (arg.includes('.test.') || arg.includes('/tests/'))))
);
const isTest = isTestDetected && !isExplicitProd;
export const DB_PATH = process.env.TEST_DB 
  ? path.resolve(ROOT_DIR, process.env.TEST_DB) 
  : (isTest ? path.join(ROOT_DIR, 'data.test.db') : (process.env.DATABASE_PATH ? path.resolve(ROOT_DIR, process.env.DATABASE_PATH) : path.join(ROOT_DIR, 'data.db')));
const SCHEMA_PATH = path.join(ROOT_DIR, 'db', 'schema.sql');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 30000');
db.pragma('foreign_keys = ON');

export function cleanupMockContamination(database = db) {
  try {
    database.prepare(`DELETE FROM vendoor_logs WHERE work_date = '2026-12-10' OR employee_name IN ('Ahmed Hassan', 'Sara Mahmoud', 'Mohamed Ali', 'Nour Ibrahim', 'Khaled Omar')`).run();
    database.prepare(`DELETE FROM raw_log_records WHERE work_date = '2026-12-10' OR employee_name IN ('Ahmed Hassan', 'Sara Mahmoud', 'Mohamed Ali', 'Nour Ibrahim', 'Khaled Omar')`).run();
    database.prepare(`DELETE FROM vendoor_orders WHERE account IN ('Vendoor Express', 'Alpha Merchant', 'Beta Logistics', 'Delta Direct', 'Gamma Trade')`).run();
    database.prepare(`DELETE FROM current_work_orders WHERE merchant_code LIKE 've%' AND account IN ('Vendoor Express', 'Alpha Merchant', 'Beta Logistics', 'Delta Direct', 'Gamma Trade')`).run();
    database.prepare(`DELETE FROM vendoor_sync_runs WHERE sync_run_id LIKE '%40n8%' OR sync_run_id LIKE '%z1gf%' OR sync_run_id LIKE '%mock%'`).run();
    database.prepare(`DELETE FROM vendoor_bootstrap_state WHERE job_id LIKE '%mock%'`).run();
    database.prepare(`DELETE FROM performance_snapshots WHERE date IN ('2026-10-10', '2026-10-11') OR employee_name LIKE 'Smart % CS'`).run();
  } catch (e) {
    console.warn('Cleanup mock contamination warning:', e.message);
  }
}

// Safe migrations function for existing and new databases
export function runMigrations(database = db) {
  cleanupMockContamination(database);
  // Safe table migration: Ensure team_membership, status & notes exist in employees
  try {
    const cols = database.prepare("PRAGMA table_info(employees)").all();
    if (cols.length > 0) {
      if (!cols.some(c => c.name === 'team_membership')) {
        database.exec("ALTER TABLE employees ADD COLUMN team_membership TEXT NOT NULL DEFAULT 'Both'");
        database.exec("UPDATE employees SET team_membership = 'Both' WHERE team_membership IS NULL");
        console.log('✓ Successfully migrated employees: added team_membership column');
      }
      if (!cols.some(c => c.name === 'notes')) {
        database.exec("ALTER TABLE employees ADD COLUMN notes TEXT");
      }
      if (!cols.some(c => c.name === 'status')) {
        database.exec("ALTER TABLE employees ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'");
        database.exec("UPDATE employees SET status = CASE WHEN active = 1 THEN 'ACTIVE' ELSE 'INACTIVE' END WHERE status IS NULL OR status = ''");
        console.log('✓ Successfully migrated employees: added status column');
      }
      if (!cols.some(c => c.name === 'effective_from')) {
        database.exec("ALTER TABLE employees ADD COLUMN effective_from TEXT");
      }
      if (!cols.some(c => c.name === 'effective_to')) {
        database.exec("ALTER TABLE employees ADD COLUMN effective_to TEXT");
      }
      if (!cols.some(c => c.name === 'departure_date')) {
        database.exec("ALTER TABLE employees ADD COLUMN departure_date TEXT");
      }
      if (!cols.some(c => c.name === 'departure_reason')) {
        database.exec("ALTER TABLE employees ADD COLUMN departure_reason TEXT");
      }
    }
  } catch (e) {
    console.warn('Migration check for employees team_membership & lifecycle columns:', e.message);
  }

  // Safe table migration: Ensure employee_lifecycle_audit and order_review_queue exist
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS employee_lifecycle_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id),
        employee_name TEXT NOT NULL,
        action_type TEXT NOT NULL,
        previous_status TEXT,
        new_status TEXT NOT NULL,
        effective_date TEXT NOT NULL,
        operator TEXT DEFAULT 'Supervisor',
        reason TEXT,
        impact_summary_json TEXT,
        affected_orders_count INTEGER DEFAULT 0,
        reassigned_orders_count INTEGER DEFAULT 0,
        uncertain_orders_count INTEGER DEFAULT 0,
        reassignments_json TEXT,
        review_items_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_lifecycle_emp ON employee_lifecycle_audit(employee_id);
      CREATE INDEX IF NOT EXISTS idx_lifecycle_date ON employee_lifecycle_audit(effective_date);

      CREATE TABLE IF NOT EXISTS order_review_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_date TEXT NOT NULL,
        order_code TEXT NOT NULL,
        account TEXT,
        merchant_code TEXT,
        current_status TEXT,
        previous_employee_id INTEGER,
        previous_employee_name TEXT,
        reason_code TEXT NOT NULL,
        reason_detail TEXT,
        suggested_employee_id INTEGER,
        suggested_employee_name TEXT,
        suggested_score REAL,
        review_status TEXT NOT NULL DEFAULT 'PENDING',
        resolved_employee_id INTEGER,
        resolved_employee_name TEXT,
        resolved_by TEXT,
        resolved_at TEXT,
        resolution_notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(work_date, order_code)
      );
      CREATE INDEX IF NOT EXISTS idx_review_queue_date ON order_review_queue(work_date);
      CREATE INDEX IF NOT EXISTS idx_review_queue_status ON order_review_queue(review_status);
      CREATE INDEX IF NOT EXISTS idx_review_queue_emp ON order_review_queue(previous_employee_id);
    `);
  } catch (e) {
    console.warn('Migration for employee_lifecycle_audit & order_review_queue:', e.message);
  }

  // Safe table migration: Ensure preparation_batches exists
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS preparation_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id TEXT NOT NULL UNIQUE,
        work_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN',
        total_files INTEGER DEFAULT 0,
        files_json TEXT,
        parsed_summary_json TEXT,
        allocation_version INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (e) {
    console.warn('Migration for preparation_batches:', e.message);
  }

  // Safe table migration: Ensure account_rules exists
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS account_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_name TEXT NOT NULL UNIQUE,
        new_eligible_json TEXT,
        pending_eligible_json TEXT,
        blocked_json TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (e) {
    console.warn('Migration for account_rules:', e.message);
  }

  // Safe table migration: Ensure account_exceptions exists
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS account_exceptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_name TEXT NOT NULL,
        work_date TEXT,
        status_type TEXT DEFAULT 'Both',
        exception_type TEXT NOT NULL,
        employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
        employee_name TEXT,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (e) {
    console.warn('Migration for account_exceptions:', e.message);
  }

  // Safe table migration: Ensure order_level_allocations exists
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS order_level_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        allocation_date TEXT NOT NULL,
        allocation_version INTEGER NOT NULL DEFAULT 1,
        order_code TEXT NOT NULL,
        account TEXT NOT NULL,
        status TEXT NOT NULL,
        employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        employee_name TEXT NOT NULL,
        method TEXT DEFAULT 'Fair Random',
        rule_note TEXT,
        is_override INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(allocation_date, allocation_version, order_code)
      )
    `);
    database.exec("CREATE INDEX IF NOT EXISTS idx_ord_alloc_date ON order_level_allocations(allocation_date, allocation_version)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_ord_alloc_emp ON order_level_allocations(allocation_date, employee_id)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_ord_alloc_code ON order_level_allocations(order_code)");

    // Safe table migration: Ensure account_owners exists for Account-Level Ownership (One Account = One Employee)
    database.exec(`
      CREATE TABLE IF NOT EXISTS account_owners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_date TEXT NOT NULL,
        account TEXT NOT NULL,
        owner_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        owner_employee_name TEXT NOT NULL,
        allocation_version INTEGER NOT NULL DEFAULT 1,
        allocation_method TEXT DEFAULT 'Account Fair Balance',
        is_override INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(work_date, account)
      )
    `);
    database.exec("CREATE INDEX IF NOT EXISTS idx_account_owners_date ON account_owners(work_date)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_account_owners_emp ON account_owners(work_date, owner_employee_id)");

    // Safe table migration: Ensure account_reassignment_logs exists
    database.exec(`
      CREATE TABLE IF NOT EXISTS account_reassignment_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_date TEXT NOT NULL,
        account TEXT NOT NULL,
        previous_employee_id INTEGER,
        previous_employee_name TEXT,
        new_employee_id INTEGER NOT NULL,
        new_employee_name TEXT NOT NULL,
        reassigned_by TEXT DEFAULT 'Supervisor',
        reason TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    database.exec("CREATE INDEX IF NOT EXISTS idx_acc_reassign_date ON account_reassignment_logs(work_date)");
  } catch (e) {
    console.warn('Migration for order_level_allocations:', e.message);
  }

  // Safe table migration: Ensure business_date exists in uploaded_files
  try {
    const cols = database.prepare("PRAGMA table_info(uploaded_files)").all();
    if (cols.length > 0 && !cols.some(c => c.name === 'business_date')) {
      database.exec("ALTER TABLE uploaded_files ADD COLUMN business_date TEXT");
    }
    if (cols.length > 0 && !cols.some(c => c.name === 'detection_json')) {
      database.exec("ALTER TABLE uploaded_files ADD COLUMN detection_json TEXT");
    }
  } catch (e) {
    console.warn('Migration for uploaded_files columns:', e.message);
  }

  // Safe table migration: Ensure allocation_versions exists
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS allocation_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        allocation_date TEXT NOT NULL,
        version_number INTEGER NOT NULL DEFAULT 1,
        generated_at TEXT DEFAULT (datetime('now')),
        generated_by TEXT DEFAULT 'Supervisor',
        method TEXT DEFAULT 'Fair Random',
        rule_summary TEXT,
        total_orders INTEGER DEFAULT 0,
        assigned_orders INTEGER DEFAULT 0,
        unassigned_orders INTEGER DEFAULT 0,
        allocation_json TEXT,
        is_final INTEGER NOT NULL DEFAULT 1,
        UNIQUE(allocation_date, version_number)
      )
    `);
  } catch (e) {
    console.warn('Migration for allocation_versions:', e.message);
  }
  try {
    const cols = database.prepare("PRAGMA table_info(daily_working_team)").all();
    if (cols.length > 0) {
      if (!cols.some(c => c.name === 'is_working')) {
        database.exec("ALTER TABLE daily_working_team ADD COLUMN is_working INTEGER NOT NULL DEFAULT 1");
        // Explicitly guarantee all pre-existing rows have is_working = 1
        database.exec("UPDATE daily_working_team SET is_working = 1 WHERE is_working IS NULL");
        console.log('✓ Successfully migrated daily_working_team: added is_working column');
      }
      if (!cols.some(c => c.name === 'source')) {
        database.exec("ALTER TABLE daily_working_team ADD COLUMN source TEXT NOT NULL DEFAULT 'MANUAL'");
        console.log('✓ Successfully migrated daily_working_team: added source column');
      }
      if (!cols.some(c => c.name === 'observed_at')) {
        database.exec("ALTER TABLE daily_working_team ADD COLUMN observed_at TEXT");
      }
      if (!cols.some(c => c.name === 'last_activity_at')) {
        database.exec("ALTER TABLE daily_working_team ADD COLUMN last_activity_at TEXT");
      }
      if (!cols.some(c => c.name === 'updated_at')) {
        database.exec("ALTER TABLE daily_working_team ADD COLUMN updated_at TEXT");
      }
    }
  } catch (e) {
    console.warn('Migration check for daily_working_team columns:', e.message);
  }

  // Safe table migration: Ensure source_file_slot, source_type, merchant_code, file_name exist in current_work_orders
  try {
    const cols = database.prepare("PRAGMA table_info(current_work_orders)").all();
    if (cols.length > 0) {
      if (!cols.some(c => c.name === 'source_file_slot')) {
        database.exec("ALTER TABLE current_work_orders ADD COLUMN source_file_slot INTEGER DEFAULT 1");
      }
      if (!cols.some(c => c.name === 'source_type')) {
        database.exec("ALTER TABLE current_work_orders ADD COLUMN source_type TEXT DEFAULT 'NEW'");
      }
      if (!cols.some(c => c.name === 'merchant_code')) {
        database.exec("ALTER TABLE current_work_orders ADD COLUMN merchant_code TEXT");
      }
      if (!cols.some(c => c.name === 'file_name')) {
        database.exec("ALTER TABLE current_work_orders ADD COLUMN file_name TEXT");
      }
      if (!cols.some(c => c.name === 'batch_id')) {
        database.exec("ALTER TABLE current_work_orders ADD COLUMN batch_id TEXT");
      }
      if (!cols.some(c => c.name === 'tracking_id')) {
        database.exec("ALTER TABLE current_work_orders ADD COLUMN tracking_id TEXT");
      }
      if (!cols.some(c => c.name === 'priority')) {
        database.exec("ALTER TABLE current_work_orders ADD COLUMN priority TEXT DEFAULT 'REGULAR'");
      }
      if (!cols.some(c => c.name === 'work_state')) {
        database.exec("ALTER TABLE current_work_orders ADD COLUMN work_state TEXT DEFAULT 'UNASSIGNED'");
      }
      if (!cols.some(c => c.name === 'round_number')) {
        database.exec("ALTER TABLE current_work_orders ADD COLUMN round_number INTEGER DEFAULT 1");
      }
      if (!cols.some(c => c.name === 'assigned_employee_id')) {
        database.exec("ALTER TABLE current_work_orders ADD COLUMN assigned_employee_id INTEGER");
      }
      if (!cols.some(c => c.name === 'assigned_employee_name')) {
        database.exec("ALTER TABLE current_work_orders ADD COLUMN assigned_employee_name TEXT");
      }
      if (!cols.some(c => c.name === 'claimed_at')) {
        database.exec("ALTER TABLE current_work_orders ADD COLUMN claimed_at TEXT");
      }
      if (!cols.some(c => c.name === 'completed_at')) {
        database.exec("ALTER TABLE current_work_orders ADD COLUMN completed_at TEXT");
      }
    }
  } catch (e) {
    // Ignored if table not created yet or column exists
  }

  // Safe table migration: Ensure tracking columns exist in order_level_allocations
  try {
    const cols = database.prepare("PRAGMA table_info(order_level_allocations)").all();
    if (cols.length > 0) {
      if (!cols.some(c => c.name === 'tracking_id')) {
        database.exec("ALTER TABLE order_level_allocations ADD COLUMN tracking_id TEXT");
      }
      if (!cols.some(c => c.name === 'work_state')) {
        database.exec("ALTER TABLE order_level_allocations ADD COLUMN work_state TEXT DEFAULT 'ASSIGNED'");
      }
      if (!cols.some(c => c.name === 'priority')) {
        database.exec("ALTER TABLE order_level_allocations ADD COLUMN priority TEXT DEFAULT 'REGULAR'");
      }
      if (!cols.some(c => c.name === 'round_number')) {
        database.exec("ALTER TABLE order_level_allocations ADD COLUMN round_number INTEGER DEFAULT 1");
      }
    }
  } catch (e) {
    // Ignored
  }

  // Safe table migration: Ensure tracking columns exist in order_tracking
  try {
    const cols = database.prepare("PRAGMA table_info(order_tracking)").all();
    if (cols.length > 0) {
      if (!cols.some(c => c.name === 'tracking_id')) {
        database.exec("ALTER TABLE order_tracking ADD COLUMN tracking_id TEXT");
      }
      if (!cols.some(c => c.name === 'work_state')) {
        database.exec("ALTER TABLE order_tracking ADD COLUMN work_state TEXT DEFAULT 'UNASSIGNED'");
      }
      if (!cols.some(c => c.name === 'priority')) {
        database.exec("ALTER TABLE order_tracking ADD COLUMN priority TEXT DEFAULT 'REGULAR'");
      }
    }
  } catch (e) {
    // Ignored
  }

  // Safe table migration: Ensure order_tracking_events and employee_activity_log exist
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS order_tracking_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tracking_id TEXT NOT NULL,
        order_code TEXT NOT NULL,
        work_date TEXT NOT NULL,
        stage TEXT NOT NULL,
        work_state TEXT DEFAULT 'UNASSIGNED',
        employee_id INTEGER,
        employee_name TEXT,
        previous_employee_id INTEGER,
        previous_employee_name TEXT,
        action TEXT,
        timestamp TEXT NOT NULL,
        reason TEXT,
        source TEXT DEFAULT 'SYSTEM',
        details TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ote_tracking ON order_tracking_events(tracking_id);
      CREATE INDEX IF NOT EXISTS idx_ote_order ON order_tracking_events(order_code);
      CREATE INDEX IF NOT EXISTS idx_ote_date ON order_tracking_events(work_date);

      CREATE TABLE IF NOT EXISTS employee_activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_date TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        employee_id INTEGER NOT NULL REFERENCES employees(id),
        employee_name_snapshot TEXT NOT NULL,
        action TEXT NOT NULL,
        tracking_code TEXT,
        order_code TEXT,
        account TEXT,
        source TEXT DEFAULT 'UI',
        details TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_emp_act_date ON employee_activity_log(work_date);
      CREATE INDEX IF NOT EXISTS idx_emp_act_emp ON employee_activity_log(employee_id, work_date);
      CREATE INDEX IF NOT EXISTS idx_emp_act_order ON employee_activity_log(order_code);
      CREATE INDEX IF NOT EXISTS idx_emp_act_action ON employee_activity_log(action);
    `);
  } catch (e) {
    console.warn('Migration for order_tracking_events & employee_activity_log:', e.message);
  }

  // Safe table migration: Ensure files_count and files_json exist in current_work_pool_summary
  try {
    const cols = database.prepare("PRAGMA table_info(current_work_pool_summary)").all();
    if (cols.length > 0) {
      if (!cols.some(c => c.name === 'files_count')) {
        database.exec("ALTER TABLE current_work_pool_summary ADD COLUMN files_count INTEGER DEFAULT 0");
      }
      if (!cols.some(c => c.name === 'files_json')) {
        database.exec("ALTER TABLE current_work_pool_summary ADD COLUMN files_json TEXT");
      }
    }
  } catch (e) {
    // Ignored
  }

  // Safe table migration: Ensure specific_orders_uploads has source_type
  try {
    const cols = database.prepare("PRAGMA table_info(specific_orders_uploads)").all();
    if (cols.length > 0) {
      if (!cols.some(c => c.name === 'source_type')) {
        database.exec("ALTER TABLE specific_orders_uploads ADD COLUMN source_type TEXT DEFAULT 'NEW'");
      }
    }
  } catch (e) {
    // Ignored
  }

  // Safe compatibility view/table for order_tracking if queried directly
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS order_tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_code TEXT NOT NULL,
        work_date TEXT NOT NULL,
        account TEXT,
        status TEXT,
        assigned_to TEXT,
        actions_count INTEGER DEFAULT 0,
        timeline_json TEXT,
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(order_code, work_date)
      )
    `);
  } catch (e) {
    // Ignored
  }

  // Safe index migration: Ensure UNIQUE index on (date, employee_name) for performance_snapshots
  try {
    database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_perf_snapshots_date_emp ON performance_snapshots(date, employee_name)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_dwt_workdate ON daily_working_team(work_date)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_dwt_date_emp ON daily_working_team(work_date, employee_id)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_employees_active_dept ON employees(active, department)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_daily_metrics_workdate ON daily_metrics_snapshots(work_date)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_vendoor_orders_srcdate ON vendoor_orders(source_date, account)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_cwo_date_acc ON current_work_orders(work_date, account)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_ord_alloc_date_ver ON order_level_allocations(allocation_date, allocation_version, employee_id)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_raw_logs_date_emp_dt ON raw_log_records(work_date, employee_name, event_datetime)");
  } catch (e) {
    // Ignored if index exists
  }

  // Safe table migration: Ensure daily_metrics_snapshots exists
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS daily_metrics_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_date TEXT NOT NULL UNIQUE,
        source_file_id INTEGER REFERENCES uploaded_files(id) ON DELETE SET NULL,
        metrics_json TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (e) {
    console.warn('Migration for daily_metrics_snapshots:', e.message);
  }

  // Safe table migration: Ensure raw_log_records has work_date, is_cs, is_deduped
  try {
    const cols = database.prepare("PRAGMA table_info(raw_log_records)").all();
    if (cols.length > 0) {
      if (!cols.some(c => c.name === 'work_date')) {
        database.exec("ALTER TABLE raw_log_records ADD COLUMN work_date TEXT");
      }
      if (!cols.some(c => c.name === 'is_cs')) {
        database.exec("ALTER TABLE raw_log_records ADD COLUMN is_cs INTEGER DEFAULT 1");
      }
      if (!cols.some(c => c.name === 'is_deduped')) {
        database.exec("ALTER TABLE raw_log_records ADD COLUMN is_deduped INTEGER DEFAULT 1");
      }
      database.exec("CREATE INDEX IF NOT EXISTS idx_raw_log_work_date ON raw_log_records(work_date)");
      database.exec("CREATE INDEX IF NOT EXISTS idx_raw_log_date_order ON raw_log_records(work_date, order_code)");
      database.exec("CREATE INDEX IF NOT EXISTS idx_raw_log_date_emp ON raw_log_records(work_date, employee_name)");
      database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_logs_dedup ON raw_log_records(work_date, order_code, employee_name, event_datetime, action)");
    }
  } catch (e) {
    console.warn('Migration for raw_log_records:', e.message);
  }

  // Safe table migration: Ensure vendoor_connection_tests exists
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS vendoor_connection_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        resource TEXT NOT NULL,
        test_type TEXT NOT NULL,
        start_date TEXT,
        end_date TEXT,
        status TEXT NOT NULL,
        http_status INTEGER,
        content_type TEXT,
        rows_received INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        summary_json TEXT,
        error_safe TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (e) {
    console.warn('Migration for vendoor_connection_tests:', e.message);
  }

  // Safe table migrations for Phase 2: Vendoor Sync, Identity, and Audit
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS vendoor_sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_run_id TEXT UNIQUE NOT NULL,
        resource TEXT NOT NULL,
        start_date TEXT,
        end_date TEXT,
        status TEXT NOT NULL,
        records_fetched INTEGER DEFAULT 0,
        records_accepted INTEGER DEFAULT 0,
        records_duplicated INTEGER DEFAULT 0,
        records_rejected INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        summary_json TEXT,
        error_safe TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS vendoor_reconciliation_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_timestamp TEXT NOT NULL,
        business_date TEXT NOT NULL,
        sync_run_id TEXT,
        vendoor_new_count INTEGER DEFAULT 0,
        vendoor_pending_count INTEGER DEFAULT 0,
        vendoor_total_count INTEGER DEFAULT 0,
        local_new_count INTEGER DEFAULT 0,
        local_pending_count INTEGER DEFAULT 0,
        local_total_count INTEGER DEFAULT 0,
        delta INTEGER DEFAULT 0,
        missing_order_codes TEXT,
        extra_order_codes TEXT,
        reconciliation_status TEXT DEFAULT 'PASS',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS vendoor_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_code TEXT UNIQUE NOT NULL,
        status TEXT,
        account TEXT,
        merchant_code TEXT,
        source_date TEXT,
        city TEXT,
        total_price REAL DEFAULT 0,
        raw_payload_json TEXT,
        sync_run_id TEXT,
        imported_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS vendoor_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_name TEXT NOT NULL,
        order_code TEXT NOT NULL,
        action TEXT NOT NULL,
        action_classification TEXT,
        is_productive INTEGER DEFAULT 1,
        timestamp_str TEXT NOT NULL,
        work_date TEXT,
        matched_employee_id INTEGER,
        sync_run_id TEXT,
        imported_at TEXT DEFAULT (datetime('now')),
        UNIQUE(order_code, employee_name, timestamp_str, action)
      );

      CREATE TABLE IF NOT EXISTS vendoor_identity_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vendoor_name TEXT UNIQUE NOT NULL,
        normalized_name TEXT NOT NULL,
        employee_id INTEGER,
        status TEXT NOT NULL DEFAULT 'UNMATCHED',
        match_method TEXT DEFAULT 'NONE',
        confidence REAL DEFAULT 0.0,
        notes TEXT,
        first_seen TEXT DEFAULT (datetime('now')),
        last_seen TEXT DEFAULT (datetime('now')),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_vendoor_orders_acc ON vendoor_orders(account);
      CREATE INDEX IF NOT EXISTS idx_vendoor_orders_date ON vendoor_orders(source_date);
      CREATE INDEX IF NOT EXISTS idx_vendoor_logs_date ON vendoor_logs(work_date);
      CREATE INDEX IF NOT EXISTS idx_vendoor_logs_emp ON vendoor_logs(employee_name);
      CREATE INDEX IF NOT EXISTS idx_vendoor_logs_match ON vendoor_logs(matched_employee_id);
      CREATE INDEX IF NOT EXISTS idx_vendoor_ident_norm ON vendoor_identity_mappings(normalized_name);
      CREATE INDEX IF NOT EXISTS idx_vendoor_ident_status ON vendoor_identity_mappings(status);

      -- Phase 3 Continuous Auto Dispatcher & Smart Refill Audit Tables
      CREATE TABLE IF NOT EXISTS auto_dispatch_cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_id TEXT UNIQUE NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        work_date TEXT NOT NULL,
        mode TEXT NOT NULL,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        working_employees_count INTEGER DEFAULT 0,
        unallocated_orders_count INTEGER DEFAULT 0,
        eligible_employees_count INTEGER DEFAULT 0,
        employees_needing_refill_count INTEGER DEFAULT 0,
        assignments_attempted INTEGER DEFAULT 0,
        assignments_created INTEGER DEFAULT 0,
        assignments_skipped INTEGER DEFAULT 0,
        assignments_failed INTEGER DEFAULT 0,
        completed_orders_observed INTEGER DEFAULT 0,
        summary_json TEXT,
        error_safe TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS auto_dispatch_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_id TEXT NOT NULL REFERENCES auto_dispatch_cycles(cycle_id),
        work_date TEXT NOT NULL,
        order_code TEXT NOT NULL,
        account TEXT NOT NULL,
        employee_id INTEGER NOT NULL REFERENCES employees(id),
        employee_name TEXT NOT NULL,
        is_dry_run INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'AUTO_DISPATCH',
        reason TEXT NOT NULL,
        capacity_before INTEGER,
        capacity_after INTEGER,
        remaining_workload_before INTEGER,
        remaining_workload_after INTEGER,
        smart_score REAL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_auto_dispatch_cycles_date ON auto_dispatch_cycles(work_date);
      CREATE INDEX IF NOT EXISTS idx_auto_dispatch_cycles_status ON auto_dispatch_cycles(status);
      CREATE INDEX IF NOT EXISTS idx_auto_dispatch_assign_cycle ON auto_dispatch_assignments(cycle_id);
      CREATE INDEX IF NOT EXISTS idx_auto_dispatch_assign_order ON auto_dispatch_assignments(order_code, work_date);
      CREATE INDEX IF NOT EXISTS idx_auto_dispatch_assign_emp ON auto_dispatch_assignments(employee_id, work_date);
    `);
  } catch (e) {
    console.warn('Migration for Vendoor Phase 2/3 tables:', e.message);
  }

  // Safe table migration: Ensure vendoor_orders has merchant_code, business_date, active_status, is_active, last_synced_at, created_at_original
  try {
    const vCols = database.prepare("PRAGMA table_info(vendoor_orders)").all();
    if (vCols.length > 0) {
      if (!vCols.some(c => c.name === 'merchant_code')) {
        database.exec("ALTER TABLE vendoor_orders ADD COLUMN merchant_code TEXT");
      }
      if (!vCols.some(c => c.name === 'business_date')) {
        database.exec("ALTER TABLE vendoor_orders ADD COLUMN business_date TEXT");
      }
      if (!vCols.some(c => c.name === 'active_status')) {
        database.exec("ALTER TABLE vendoor_orders ADD COLUMN active_status TEXT");
      }
      if (!vCols.some(c => c.name === 'is_active')) {
        database.exec("ALTER TABLE vendoor_orders ADD COLUMN is_active INTEGER DEFAULT 1");
      }
      if (!vCols.some(c => c.name === 'last_synced_at')) {
        database.exec("ALTER TABLE vendoor_orders ADD COLUMN last_synced_at TEXT");
      }
      if (!vCols.some(c => c.name === 'created_at_original')) {
        database.exec("ALTER TABLE vendoor_orders ADD COLUMN created_at_original TEXT");
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_vendoor_orders_bdate ON vendoor_orders(business_date);
        CREATE INDEX IF NOT EXISTS idx_vendoor_orders_active ON vendoor_orders(is_active);
      `);
    }
  } catch (e) {
    // Ignored
  }

  // Seed centralized operational day cutoff if not present
  try {
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('operational_day_cutoff', '20:00', 'Centralized operational day cutoff time (HH:mm) after which events roll over to next business date')
    `).run();

    // Phase 3 Continuous Auto Dispatcher & Smart Refill Configuration Parameters
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('vendoor_auto_dispatch_enabled', 'false', 'Master kill-switch for continuous auto dispatcher (default false)')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('dry_run_mode', 'true', 'Dry-run simulation mode for auto dispatcher (default true, zero allocation writes)')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('refill_threshold', '20', 'Remaining workload threshold under which an employee becomes eligible for smart refill')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('dispatcher_interval_ms', '60000', 'Interval in milliseconds between continuous dispatcher cycles (default 60s)')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('max_orders_per_cycle', '50', 'Maximum unallocated orders processed in a single auto-dispatch cycle')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('max_assignments_per_cycle', '100', 'Maximum assignments created in a single auto-dispatch cycle')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('dispatcher_time_budget_ms', '15000', 'Execution timeout budget in ms for a single auto-dispatch cycle')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('safety_margin', '0.85', 'Safety capacity buffer for refill allocation')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('stale_orders_limit_ms', '3600000', 'Maximum age in milliseconds for orders data before considered stale (default 3600000ms = 60m)')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('stale_logs_limit_ms', '3600000', 'Maximum age in milliseconds for logs data before considered stale (default 3600000ms = 60m)')
    `).run();

    // Smart Allocation Configuration Parameters
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('target_orders_per_account', '30', 'Workload guideline target orders per account (not a forced split limit)')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('max_single_employee_capacity', '80', 'Standard maximum daily capacity threshold for a single employee before considering split')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('weight_performance', '0.40', 'Weight for historical performance and completion rate in smart allocation scoring')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('weight_capacity', '0.35', 'Weight for available remaining capacity in smart allocation scoring')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('weight_workload_balance', '0.25', 'Weight for account fairness and workload balance in smart allocation scoring')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('expected_working_minutes', '360', 'Expected active working minutes per day used for dynamic capacity derivation')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('capacity_safety_factor', '0.85', 'Safety buffer factor applied to observed throughput rate (e.g. 0.85 for 15% buffer)')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('min_capacity_floor', '30', 'Minimum daily capacity floor for an active employee')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('max_capacity_ceiling', '150', 'Maximum daily capacity ceiling for an active employee')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('recency_weight', '0.40', 'Weight given to recent active window rate vs long-term typical rate')
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO system_configs (key, value, description)
      VALUES ('productivity_weight', '0.40', 'Weight for real-log forensic productivity throughput in performance scoring')
    `).run();
  } catch (e) {
    // ignore
  }

  // Safe table migration: Ensure report_history exists
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS report_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_type TEXT NOT NULL,
        date_mode TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        filters_json TEXT,
        summary_metadata_json TEXT,
        generated_by TEXT DEFAULT 'Supervisor',
        status TEXT DEFAULT 'COMPLETED',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_report_history_type ON report_history(report_type);
      CREATE INDEX IF NOT EXISTS idx_report_history_date ON report_history(created_at);
    `);
  } catch (e) {
    console.warn('Migration for report_history:', e.message);
  }
}

export function checkDatabaseIntegrity(database = db) {
  try {
    const integrity = database.pragma('integrity_check');
    const quick = database.pragma('quick_check');
    const journalMode = database.pragma('journal_mode')[0]?.journal_mode || 'unknown';
    const isOk = Array.isArray(integrity) && integrity.length === 1 && integrity[0].integrity_check === 'ok';
    const isQuickOk = Array.isArray(quick) && quick.length === 1 && quick[0].quick_check === 'ok';
    return {
      healthy: isOk && isQuickOk,
      integrity_check: integrity,
      quick_check: quick,
      journal_mode: journalMode
    };
  } catch (err) {
    return {
      healthy: false,
      error: err.message
    };
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

  // Seed baseline snapshot if 2026-09-08 is missing from daily_metrics_snapshots
  const baselineDate = '2026-09-08';
  const existing = db.prepare('SELECT id FROM daily_metrics_snapshots WHERE work_date = ?').get(baselineDate);
  if (!existing) {
    seedBaselineSnapshot();
  }
}

function seedBaselineSnapshot() {
  const dataJsonPath = path.join(ROOT_DIR, 'data.json');
  if (!fs.existsSync(dataJsonPath)) return;

  try {
    const baselineDate = '2026-09-08';
    const existing = db.prepare('SELECT id FROM daily_metrics_snapshots WHERE work_date = ?').get(baselineDate);
    if (!existing) {
      const dataStr = fs.readFileSync(dataJsonPath, 'utf-8');
      db.prepare(`
        INSERT OR IGNORE INTO daily_metrics_snapshots (work_date, metrics_json)
        VALUES (?, ?)
      `).run(baselineDate, dataStr);

      // Also ensure performance_snapshots has baseline rows for 2026-09-08
      const parsed = JSON.parse(dataStr);
      if (parsed.employees && Array.isArray(parsed.employees)) {
        const checkRows = db.prepare('SELECT COUNT(*) as count FROM performance_snapshots WHERE date = ?').get(baselineDate);
        if (checkRows.count === 0) {
          const insertSnap = db.prepare(`
            INSERT OR IGNORE INTO performance_snapshots (
              date, employee_name, real_actions, printed_orders, pending_backlog,
              cancelled_orders, processing_orders, alt_phones, added_orders,
              own_printed_rate, own_pending_rate, own_cancel_rate, own_proc_rate, own_alt_rate,
              performance_score, contribution_pct, grade, segment, cancel_risk
            ) VALUES (
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?
            )
          `);
          const tx = db.transaction(() => {
            for (const emp of parsed.employees) {
              insertSnap.run(
                baselineDate,
                emp.name,
                emp.actions || 0,
                emp.printed || 0,
                emp.pending || 0,
                emp.cancelled || 0,
                emp.processing || 0,
                emp.alt || 0,
                emp.added || 0,
                emp.own_printed_rate || 0,
                emp.own_pending_rate || 0,
                emp.own_cancel_rate || 0,
                emp.own_proc_rate || 0,
                emp.own_alt_rate || 0,
                emp.performance_score || 0,
                emp.contribution_pct || 0,
                emp.grade || 'B',
                emp.segment || 'Core Contributor',
                emp.cancel_risk || 'Normal'
              );
            }
          });
          tx();
        }
      }
    }
  } catch (err) {
    console.warn('Error seeding baseline snapshot:', err.message);
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
