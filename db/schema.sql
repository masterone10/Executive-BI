-- Executive BI Unified Database Schema (SQLite / better-sqlite3)
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
  team_membership TEXT NOT NULL DEFAULT 'Both', -- 'New', 'Pending', 'Both'
  active INTEGER NOT NULL DEFAULT 1,     -- 1 for active, 0 for inactive
  status TEXT NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'INACTIVE', 'DEPARTED'
  effective_from TEXT,
  effective_to TEXT,
  departure_date TEXT,
  departure_reason TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_working_team (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date TEXT NOT NULL, -- YYYY-MM-DD
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  is_working INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'MANUAL', -- 'MANUAL', 'VENDOOR_OBSERVED'
  observed_at TEXT,
  last_activity_at TEXT,
  last_productive_activity_at TEXT,
  last_action TEXT,
  last_productive_action TEXT,
  last_order_code TEXT,
  last_account TEXT,
  live_status TEXT,
  idle_seconds INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(work_date, employee_id)
);

CREATE TABLE IF NOT EXISTS preparation_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL UNIQUE,
  work_date TEXT NOT NULL, -- Primary business date
  status TEXT NOT NULL DEFAULT 'OPEN', -- 'OPEN', 'FINALIZED', 'CANCELLED'
  total_files INTEGER DEFAULT 0,
  files_json TEXT,
  parsed_summary_json TEXT,
  allocation_version INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS uploaded_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL, -- 'daily_log', 'specific_orders'
  source_type TEXT,        -- 'NEW', 'PENDING', 'EOD_DAILY_LOG', 'SPECIFIC_ORDERS'
  file_hash TEXT,          -- SHA-256 hash for deterministic deduplication
  batch_id TEXT,           -- Linked preparation batch ID
  business_date TEXT,      -- Authoritative business date
  detection_json TEXT,     -- Raw detection metadata
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
  work_date TEXT,          -- YYYY-MM-DD
  order_code TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  action TEXT,
  status TEXT,
  event_datetime TEXT,
  is_cs INTEGER DEFAULT 1,
  is_deduped INTEGER DEFAULT 1,
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

CREATE TABLE IF NOT EXISTS daily_metrics_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date TEXT NOT NULL UNIQUE,
  source_file_id INTEGER REFERENCES uploaded_files(id) ON DELETE SET NULL,
  metrics_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS specific_orders_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date TEXT NOT NULL,
  file_slot INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER DEFAULT 0,
  row_count INTEGER DEFAULT 0,
  valid_orders_count INTEGER DEFAULT 0,
  raw_orders_json TEXT,
  source_type TEXT DEFAULT 'NEW',
  upload_date TEXT DEFAULT (datetime('now')),
  UNIQUE(work_date, file_slot)
);

CREATE TABLE IF NOT EXISTS current_work_pool_summary (
  work_date TEXT PRIMARY KEY,
  file1_name TEXT,
  file1_rows INTEGER DEFAULT 0,
  file1_orders INTEGER DEFAULT 0,
  file2_name TEXT,
  file2_rows INTEGER DEFAULT 0,
  file2_orders INTEGER DEFAULT 0,
  files_count INTEGER DEFAULT 0,
  files_json TEXT,
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
  source_type TEXT DEFAULT 'NEW',
  merchant_code TEXT,
  file_name TEXT,
  batch_id TEXT,
  tracking_id TEXT,      -- Internal unique lifecycle/audit identity
  priority TEXT DEFAULT 'REGULAR', -- 'REGULAR', 'FAST_TRACK'
  work_state TEXT DEFAULT 'UNASSIGNED', -- 'UNASSIGNED', 'ASSIGNED', 'CLAIMED', 'IN_PROGRESS', 'COMPLETED'
  round_number INTEGER DEFAULT 1,
  assigned_employee_id INTEGER,
  assigned_employee_name TEXT,
  claimed_at TEXT,
  completed_at TEXT,
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

CREATE TABLE IF NOT EXISTS account_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_name TEXT NOT NULL UNIQUE,
  new_eligible_json TEXT,      -- Array of employee IDs/names allowed for New orders
  pending_eligible_json TEXT,  -- Array of employee IDs/names allowed for Pending orders
  blocked_json TEXT,           -- Array of employee IDs/names explicitly blocked
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS account_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_name TEXT NOT NULL,
  work_date TEXT, -- NULL for persistent, or YYYY-MM-DD for date-specific
  status_type TEXT DEFAULT 'Both', -- 'New', 'Pending', 'Both'
  exception_type TEXT NOT NULL,    -- 'allow_only', 'block', 'force_assign'
  employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  employee_name TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

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
);

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
);

CREATE TABLE IF NOT EXISTS order_level_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  allocation_date TEXT NOT NULL, -- YYYY-MM-DD
  allocation_version INTEGER NOT NULL DEFAULT 1,
  order_code TEXT NOT NULL,
  account TEXT NOT NULL,
  status TEXT NOT NULL, -- 'New', 'Pending', etc.
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  employee_name TEXT NOT NULL, -- e.g. 'Ahmed CS' or 'UNASSIGNED'
  method TEXT DEFAULT 'Fair Random', -- 'Random', 'Fair Random', 'Manual Override'
  rule_note TEXT,
  is_override INTEGER NOT NULL DEFAULT 0,
  tracking_id TEXT,
  work_state TEXT DEFAULT 'ASSIGNED', -- 'ASSIGNED', 'CLAIMED', 'IN_PROGRESS', 'COMPLETED'
  priority TEXT DEFAULT 'REGULAR',     -- 'REGULAR', 'FAST_TRACK'
  round_number INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(allocation_date, allocation_version, order_code)
);

CREATE TABLE IF NOT EXISTS allocation_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  allocation_date TEXT NOT NULL, -- YYYY-MM-DD
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
);

CREATE TABLE IF NOT EXISTS order_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_code TEXT NOT NULL,
  work_date TEXT NOT NULL,
  account TEXT,
  status TEXT,
  assigned_to TEXT,
  actions_count INTEGER DEFAULT 0,
  timeline_json TEXT,
  tracking_id TEXT,
  work_state TEXT DEFAULT 'UNASSIGNED', -- 'UNASSIGNED', 'ASSIGNED', 'CLAIMED', 'IN_PROGRESS', 'COMPLETED'
  priority TEXT DEFAULT 'REGULAR',
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(order_code, work_date)
);

-- Individual Tracking Events (Audit & Chronological Lifecycle History)
CREATE TABLE IF NOT EXISTS order_tracking_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracking_id TEXT NOT NULL,
  order_code TEXT NOT NULL,
  work_date TEXT NOT NULL,
  stage TEXT NOT NULL, -- 'New', 'Printed', 'Sealed', 'Dispatched', 'Delivered', 'Completed', 'Cancelled', 'Refunded', 'Returned'
  work_state TEXT DEFAULT 'UNASSIGNED', -- 'UNASSIGNED', 'ASSIGNED', 'CLAIMED', 'IN_PROGRESS', 'COMPLETED'
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

-- Live Employee Activity Monitoring
CREATE TABLE IF NOT EXISTS employee_activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  employee_name_snapshot TEXT NOT NULL,
  action TEXT NOT NULL, -- 'ASSIGNED', 'CLAIMED', 'VIEWED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'HANDOFF'
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

CREATE TABLE IF NOT EXISTS vendoor_connection_tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource TEXT NOT NULL, -- 'orders', 'logs'
  test_type TEXT NOT NULL, -- 'one_day', 'two_day', 'small_page', 'ping'
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL, -- 'SUCCESS', 'FAILED', 'AUTH_EXPIRED', 'ACCESS_FORBIDDEN', 'RATE_LIMITED', 'TIMEOUT', etc.
  http_status INTEGER,
  content_type TEXT,
  rows_received INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  summary_json TEXT,
  error_safe TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

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

-- Phase 3 Continuous Auto Dispatcher & Smart Refill Audit Tables
CREATE TABLE IF NOT EXISTS auto_dispatch_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id TEXT UNIQUE NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  work_date TEXT NOT NULL,
  mode TEXT NOT NULL, -- 'DRY_RUN', 'LIVE_DISPATCH'
  trigger TEXT NOT NULL, -- 'MANUAL_CYCLE', 'POLLING_INTERVAL', 'SIMULATION'
  status TEXT NOT NULL, -- 'SUCCESS', 'NO_UNALLOCATED_WORK', 'NO_ELIGIBLE_EMPLOYEES', 'FAILED', 'SETUP_REQUIRED', 'PAUSED'
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

CREATE TABLE IF NOT EXISTS vendoor_bootstrap_state (
  job_id TEXT PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  current_phase TEXT NOT NULL,
  state_status TEXT NOT NULL,
  progress_json TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- High-performance lookup & analytics indexes
CREATE INDEX IF NOT EXISTS idx_raw_logs_lookup ON raw_log_records(work_date, order_code, employee_name, event_datetime);
CREATE INDEX IF NOT EXISTS idx_raw_logs_workdate ON raw_log_records(work_date);
CREATE INDEX IF NOT EXISTS idx_raw_logs_emp_date ON raw_log_records(employee_name, work_date);
CREATE INDEX IF NOT EXISTS idx_vendoor_logs_lookup ON vendoor_logs(order_code, employee_name, timestamp_str, action);
CREATE INDEX IF NOT EXISTS idx_vendoor_logs_workdate ON vendoor_logs(work_date);
CREATE INDEX IF NOT EXISTS idx_vendoor_orders_date ON vendoor_orders(source_date);
CREATE INDEX IF NOT EXISTS idx_cwo_date_code ON current_work_orders(work_date, order_code);
CREATE INDEX IF NOT EXISTS idx_sync_runs_res_date ON vendoor_sync_runs(resource, start_date, end_date, status);

CREATE TABLE IF NOT EXISTS report_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_type TEXT NOT NULL,
  date_mode TEXT NOT NULL, -- 'day', 'week', 'month', 'custom'
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  filters_json TEXT,
  summary_metadata_json TEXT,
  generated_by TEXT DEFAULT 'Supervisor',
  status TEXT DEFAULT 'COMPLETED',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Operational Lifecycle & Reassignment Audit Tables
CREATE TABLE IF NOT EXISTS employee_lifecycle_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  employee_name TEXT NOT NULL,
  action_type TEXT NOT NULL, -- 'STATUS_CHANGE', 'DEPARTURE', 'REACTIVATION', 'REASSIGNMENT'
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

CREATE TABLE IF NOT EXISTS order_review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date TEXT NOT NULL,
  order_code TEXT NOT NULL,
  account TEXT,
  merchant_code TEXT,
  current_status TEXT,
  previous_employee_id INTEGER,
  previous_employee_name TEXT,
  reason_code TEXT NOT NULL, -- 'DEPARTED_EMPLOYEE_UNCERTAIN', 'UNRESOLVED_IDENTITY', 'STREAM_MISMATCH', 'STATUS_UNCERTAINTY', 'CAPACITY_EXHAUSTED'
  reason_detail TEXT,
  suggested_employee_id INTEGER,
  suggested_employee_name TEXT,
  suggested_score REAL,
  review_status TEXT NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'RESOLVED', 'DISMISSED'
  resolved_employee_id INTEGER,
  resolved_employee_name TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  resolution_notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(work_date, order_code)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_emp ON employee_lifecycle_audit(employee_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_date ON employee_lifecycle_audit(effective_date);
CREATE INDEX IF NOT EXISTS idx_review_queue_date ON order_review_queue(work_date);
CREATE INDEX IF NOT EXISTS idx_review_queue_status ON order_review_queue(review_status);
CREATE INDEX IF NOT EXISTS idx_review_queue_emp ON order_review_queue(previous_employee_id);

-- Optimized Indexes for Performance & Joins
CREATE INDEX IF NOT EXISTS idx_report_history_type ON report_history(report_type);
CREATE INDEX IF NOT EXISTS idx_report_history_date ON report_history(created_at);
CREATE INDEX IF NOT EXISTS idx_auto_dispatch_cycles_date ON auto_dispatch_cycles(work_date);
CREATE INDEX IF NOT EXISTS idx_auto_dispatch_cycles_status ON auto_dispatch_cycles(status);
CREATE INDEX IF NOT EXISTS idx_auto_dispatch_assign_cycle ON auto_dispatch_assignments(cycle_id);
CREATE INDEX IF NOT EXISTS idx_auto_dispatch_assign_order ON auto_dispatch_assignments(order_code, work_date);
CREATE INDEX IF NOT EXISTS idx_auto_dispatch_assign_emp ON auto_dispatch_assignments(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_vendoor_orders_acc ON vendoor_orders(account);
CREATE INDEX IF NOT EXISTS idx_vendoor_orders_date ON vendoor_orders(source_date);
CREATE INDEX IF NOT EXISTS idx_vendoor_logs_date ON vendoor_logs(work_date);
CREATE INDEX IF NOT EXISTS idx_vendoor_logs_emp ON vendoor_logs(employee_name);
CREATE INDEX IF NOT EXISTS idx_vendoor_logs_match ON vendoor_logs(matched_employee_id);
CREATE INDEX IF NOT EXISTS idx_vendoor_ident_norm ON vendoor_identity_mappings(normalized_name);
CREATE INDEX IF NOT EXISTS idx_vendoor_ident_status ON vendoor_identity_mappings(status);
CREATE INDEX IF NOT EXISTS idx_log_order ON raw_log_records(order_code);
CREATE INDEX IF NOT EXISTS idx_log_emp ON raw_log_records(employee_name);
CREATE INDEX IF NOT EXISTS idx_raw_log_work_date ON raw_log_records(work_date);
CREATE INDEX IF NOT EXISTS idx_raw_log_date_order ON raw_log_records(work_date, order_code);
CREATE INDEX IF NOT EXISTS idx_raw_log_date_emp ON raw_log_records(work_date, employee_name);
CREATE INDEX IF NOT EXISTS idx_perf_date ON performance_snapshots(date);
CREATE INDEX IF NOT EXISTS idx_perf_emp ON performance_snapshots(employee_id);
CREATE INDEX IF NOT EXISTS idx_work_date ON current_work_orders(work_date);
CREATE INDEX IF NOT EXISTS idx_work_account ON current_work_orders(account);
CREATE INDEX IF NOT EXISTS idx_alloc_date ON allocation_headers(allocation_date);
CREATE INDEX IF NOT EXISTS idx_ord_alloc_date ON order_level_allocations(allocation_date, allocation_version);
CREATE INDEX IF NOT EXISTS idx_ord_alloc_emp ON order_level_allocations(allocation_date, employee_id);
CREATE INDEX IF NOT EXISTS idx_ord_alloc_code ON order_level_allocations(order_code);
CREATE INDEX IF NOT EXISTS idx_acc_rules_name ON account_rules(account_name);
CREATE INDEX IF NOT EXISTS idx_account_owners_date ON account_owners(work_date);
CREATE INDEX IF NOT EXISTS idx_account_owners_emp ON account_owners(work_date, owner_employee_id);
CREATE INDEX IF NOT EXISTS idx_acc_reassign_date ON account_reassignment_logs(work_date);
CREATE INDEX IF NOT EXISTS idx_dwt_workdate ON daily_working_team(work_date);
CREATE INDEX IF NOT EXISTS idx_dwt_date_emp ON daily_working_team(work_date, employee_id);
CREATE INDEX IF NOT EXISTS idx_employees_active_dept ON employees(active, department);
CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status);
CREATE INDEX IF NOT EXISTS idx_daily_metrics_workdate ON daily_metrics_snapshots(work_date);
CREATE INDEX IF NOT EXISTS idx_vendoor_orders_srcdate ON vendoor_orders(source_date, account);
CREATE INDEX IF NOT EXISTS idx_cwo_date_acc ON current_work_orders(work_date, account);
CREATE INDEX IF NOT EXISTS idx_ord_alloc_date_ver ON order_level_allocations(allocation_date, allocation_version, employee_id);
CREATE INDEX IF NOT EXISTS idx_raw_logs_date_emp_dt ON raw_log_records(work_date, employee_name, event_datetime);

-- ============================================================
-- ENTERPRISE ALLOCATION ENGINE SCHEMA (Sections 125-133A)
-- ============================================================

CREATE TABLE IF NOT EXISTS allocation_configuration_versions (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_by TEXT NOT NULL DEFAULT 'Supervisor',
  config_json TEXT NOT NULL,
  diff_summary_json TEXT,
  accounts_changed INTEGER DEFAULT 0,
  employees_changed INTEGER DEFAULT 0,
  settings_changed INTEGER DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS account_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL UNIQUE,
  new_start_time TEXT,
  new_end_time TEXT,
  pending_start_time TEXT,
  pending_end_time TEXT,
  config_version INTEGER DEFAULT 1,
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by TEXT DEFAULT 'Supervisor'
);
CREATE INDEX IF NOT EXISTS idx_acc_sched_acc ON account_schedules(account);

CREATE TABLE IF NOT EXISTS employee_capacities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  max_orders INTEGER NOT NULL DEFAULT 40,
  config_version INTEGER DEFAULT 1,
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by TEXT DEFAULT 'Supervisor'
);
CREATE INDEX IF NOT EXISTS idx_emp_cap_emp ON employee_capacities(employee_id);

CREATE TABLE IF NOT EXISTS allocation_global_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  config_version INTEGER DEFAULT 1,
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by TEXT DEFAULT 'Supervisor'
);

CREATE TABLE IF NOT EXISTS employee_daily_allocation_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date TEXT NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  pending_sequence INTEGER NOT NULL DEFAULT 0,
  new_event_consumed INTEGER NOT NULL DEFAULT 0,
  daily_mode TEXT NOT NULL DEFAULT 'NORMAL', -- 'NORMAL', 'PENDING_RESCUE'
  rescue_state TEXT NOT NULL DEFAULT 'NONE',   -- 'NONE', 'ACTIVE'
  last_allocation_run_id TEXT,
  last_allocation_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(work_date, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_emp_daily_state_date ON employee_daily_allocation_states(work_date);
CREATE INDEX IF NOT EXISTS idx_emp_daily_state_emp ON employee_daily_allocation_states(employee_id);

CREATE TABLE IF NOT EXISTS enterprise_allocation_runs (
  run_id TEXT PRIMARY KEY,
  work_date TEXT NOT NULL,
  trigger TEXT NOT NULL, -- 'MANUAL', 'AUTOMATIC', 'LOW_REMAINING_EVALUATION', 'RESCUE_EVALUATION', 'PREVIEW', 'SHADOW'
  mode TEXT NOT NULL,    -- 'OFF', 'SHADOW', 'PREVIEW', 'ACTIVE'
  allocation_type TEXT NOT NULL, -- 'PENDING_EVENT', 'NEW_EVENT', 'PENDING_RESCUE_SUPPORT', 'MIXED_BATCH'
  status TEXT NOT NULL,  -- 'COMMITTED', 'PREVIEW_GENERATED', 'BLOCKED', 'ROLLED_BACK'
  block_type TEXT,       -- 'BUSINESS_RULE', 'SYSTEM_SAFETY', NULL
  block_reason TEXT,
  rescue_state TEXT DEFAULT 'NONE',
  configuration_version INTEGER,
  context_hash TEXT NOT NULL,
  fingerprint TEXT,
  total_orders_input INTEGER DEFAULT 0,
  assigned_count INTEGER DEFAULT 0,
  unassigned_count INTEGER DEFAULT 0,
  eligible_candidates_json TEXT,
  excluded_candidates_json TEXT,
  proposal_json TEXT,
  decision_trace_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ent_alloc_date ON enterprise_allocation_runs(work_date);
CREATE INDEX IF NOT EXISTS idx_ent_alloc_status ON enterprise_allocation_runs(status);

CREATE TABLE IF NOT EXISTS distribution_fingerprints (
  fingerprint TEXT PRIMARY KEY,
  work_date TEXT NOT NULL,
  run_id TEXT NOT NULL,
  allocation_type TEXT,
  distribution_metadata_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dist_fp_date ON distribution_fingerprints(work_date);

CREATE TABLE IF NOT EXISTS allocation_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  work_date TEXT NOT NULL,
  configuration_version INTEGER,
  context_hash TEXT NOT NULL,
  snapshot_data_json TEXT NOT NULL,
  captured_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alloc_snap_run ON allocation_snapshots(run_id);
CREATE INDEX IF NOT EXISTS idx_alloc_snap_date ON allocation_snapshots(work_date);

CREATE TABLE IF NOT EXISTS allocation_decision_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  work_date TEXT NOT NULL,
  configuration_version INTEGER,
  entity_type TEXT NOT NULL, -- 'EMPLOYEE', 'ACCOUNT', 'ORDER', 'RESCUE', 'RUN'
  entity_id TEXT NOT NULL,
  decision TEXT NOT NULL,    -- 'ELIGIBLE', 'EXCLUDED', 'ASSIGNED', 'BLOCKED', 'WAITING'
  reason_code TEXT NOT NULL,
  reason_details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alloc_audit_run ON allocation_decision_audits(run_id);
CREATE INDEX IF NOT EXISTS idx_alloc_audit_date ON allocation_decision_audits(work_date);

CREATE TABLE IF NOT EXISTS allocation_operational_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date TEXT NOT NULL,
  alert_type TEXT NOT NULL, -- 'LOW_REMAINING', 'ACCOUNT_OPENING_SOON', 'RESCUE_PRESSURE', 'BLOCK_ALERT'
  entity_id TEXT NOT NULL,
  details_json TEXT,
  status TEXT DEFAULT 'ACTIVE',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(work_date, alert_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_alloc_alerts_date ON allocation_operational_alerts(work_date);
