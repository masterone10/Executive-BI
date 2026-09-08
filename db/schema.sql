-- Executive BI Database Schema (SQLite / better-sqlite3)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS system_configs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  department TEXT NOT NULL DEFAULT 'CS', -- 'CS', 'Data Entry', 'Other'
  active INTEGER NOT NULL DEFAULT 1,     -- 1 for active, 0 for inactive
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_working_team (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date TEXT NOT NULL, -- YYYY-MM-DD
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  is_working INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(work_date, employee_id)
);

CREATE TABLE IF NOT EXISTS uploaded_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL, -- 'daily_log', 'specific_orders'
  source_type TEXT,
  upload_date TEXT DEFAULT (datetime('now')),
  period_start TEXT,
  period_end TEXT,
  row_count INTEGER DEFAULT 0,
  valid_rows INTEGER DEFAULT 0,
  skipped_rows INTEGER DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS raw_log_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file_id INTEGER REFERENCES uploaded_files(id) ON DELETE CASCADE,
  order_code TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  action TEXT,
  status TEXT,
  event_datetime TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS performance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL, -- YYYY-MM-DD
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  employee_name TEXT NOT NULL,
  real_actions INTEGER DEFAULT 0,
  new_orders INTEGER DEFAULT 0,
  printed_orders INTEGER DEFAULT 0,
  pending_backlog INTEGER DEFAULT 0,
  cancelled_orders INTEGER DEFAULT 0,
  processing_orders INTEGER DEFAULT 0,
  alt_phones INTEGER DEFAULT 0,
  added_orders INTEGER DEFAULT 0,
  printed_actions INTEGER DEFAULT 0,
  pending_actions INTEGER DEFAULT 0,
  processing_actions INTEGER DEFAULT 0,
  cancelled_actions INTEGER DEFAULT 0,
  own_printed_rate REAL DEFAULT 0,
  own_pending_rate REAL DEFAULT 0,
  own_cancel_rate REAL DEFAULT 0,
  own_proc_rate REAL DEFAULT 0,
  own_alt_rate REAL DEFAULT 0,
  activity_score REAL DEFAULT 0,
  efficiency_score REAL DEFAULT 0,
  performance_score REAL DEFAULT 0,
  contribution_pct REAL DEFAULT 0,
  rate REAL DEFAULT 0,
  grade TEXT,
  segment TEXT,
  cancel_risk TEXT,
  source_file_id INTEGER REFERENCES uploaded_files(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(date, employee_name)
);

CREATE TABLE IF NOT EXISTS performance_kpis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  performance_snapshot_id INTEGER NOT NULL REFERENCES performance_snapshots(id) ON DELETE CASCADE,
  kpi_name TEXT NOT NULL,
  raw_value REAL,
  normalized_score REAL,
  weight REAL,
  weighted_score REAL
);

-- Staged uploads for Specific Orders (File 1 and File 2 per day)
CREATE TABLE IF NOT EXISTS specific_orders_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date TEXT NOT NULL,
  file_slot INTEGER NOT NULL, -- 1 for File 1, 2 for File 2
  file_name TEXT NOT NULL,
  file_size INTEGER DEFAULT 0,
  row_count INTEGER DEFAULT 0,
  valid_orders_count INTEGER DEFAULT 0,
  raw_orders_json TEXT,
  upload_date TEXT DEFAULT (datetime('now')),
  UNIQUE(work_date, file_slot)
);

-- Summary of merged Current Orders Pool
CREATE TABLE IF NOT EXISTS current_work_pool_summary (
  work_date TEXT PRIMARY KEY,
  file1_name TEXT,
  file1_rows INTEGER DEFAULT 0,
  file1_orders INTEGER DEFAULT 0,
  file2_name TEXT,
  file2_rows INTEGER DEFAULT 0,
  file2_orders INTEGER DEFAULT 0,
  merged_orders_count INTEGER DEFAULT 0,
  unique_orders_count INTEGER DEFAULT 0,
  duplicate_orders_count INTEGER DEFAULT 0,
  duplicate_details_json TEXT,
  duplicates_explanation TEXT,
  merged_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS current_work_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  file_slot INTEGER DEFAULT 1,
  upload_date TEXT DEFAULT (datetime('now')),
  work_date TEXT NOT NULL,
  order_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS current_work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file_id INTEGER REFERENCES current_work_files(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL, -- YYYY-MM-DD
  order_code TEXT NOT NULL,
  account TEXT NOT NULL, -- Merchant Name displayed as Account
  status TEXT NOT NULL,  -- 'New', 'Pending', etc.
  order_date TEXT,
  source_file_slot INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(work_date, order_code)
);

CREATE TABLE IF NOT EXISTS allocation_headers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  allocation_date TEXT NOT NULL UNIQUE, -- YYYY-MM-DD
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS allocation_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  allocation_header_id INTEGER NOT NULL REFERENCES allocation_headers(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  account TEXT NOT NULL,
  status TEXT NOT NULL, -- 'New', 'Pending', 'New + Pending'
  available_orders_at_assignment INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(allocation_header_id, employee_id, account, status)
);

CREATE INDEX IF NOT EXISTS idx_log_order ON raw_log_records(order_code);
CREATE INDEX IF NOT EXISTS idx_log_emp ON raw_log_records(employee_name);
CREATE INDEX IF NOT EXISTS idx_perf_date ON performance_snapshots(date);
CREATE INDEX IF NOT EXISTS idx_perf_emp ON performance_snapshots(employee_id);
CREATE INDEX IF NOT EXISTS idx_work_date ON current_work_orders(work_date);
CREATE INDEX IF NOT EXISTS idx_work_account ON current_work_orders(account);
CREATE INDEX IF NOT EXISTS idx_alloc_date ON allocation_headers(allocation_date);
