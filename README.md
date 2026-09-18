# Executive-BI: Vendoor-First Customer Service Operational BI & Work Allocation

An enterprise-grade executive BI platform and autonomous operational dispatching system for Customer Service operations, featuring live integration with the internal **Vendoor Employee Portal** (`/dashboard/login`), unified SQLite persistence, deterministic Fair Work Allocation, live activity tracking, and executive performance intelligence.

---

## 1. System Setup & Environment

### 1.1 Requirements
- **Node.js**: `v20+` or `v22+` (ES Modules)
- **Database**: SQLite3 (`better-sqlite3` with WAL mode and foreign key constraints enabled)

### 1.2 Installation & Build
```bash
# Install dependencies
npm install

# Run build & static asset generator
npm run build

# Run comprehensive test suite
npm test

# Run linter
npm run lint

# Start server
npm start
```

### 1.3 Environment Variables
Configure your environment variables in `.env` or manage them via the **Management** page:

```env
PORT=3000
VENDOOR_BASE_URL=https://aff.ven-door.com
VENDOOR_EMPLOYEE_EMAIL=supervisor@aff.ven-door.com
VENDOOR_EMPLOYEE_PASSWORD=YourSecurePasswordHere
VENDOOR_AUTO_DISPATCH_ENABLED=false
```

---

## 2. Autonomous Vendoor Integration

### 2.1 Direct Session-Aware Authentication
- **Endpoint**: `${VENDOOR_BASE_URL}/dashboard/login`
- **Mechanism**: The system fetches the login page dynamically, parses the session CSRF token, and performs a secure `POST` login with employee credentials.
- **Session Management**: Authenticated Laravel session cookies are maintained strictly in memory and automatically refreshed upon expiry.
- **Security Invariant**: Passwords, session cookies, raw tokens, and CSRF headers are **never** stored in the database or exposed via UI/API responses.

### 2.2 Automated Data Sync Orchestration
1. **Orders Ingestion** (`/dashboard/orders`): Autonomous multi-page retrieval iterating through all paginated DataTables records, deduplicating by unique `order_code` while preserving source Business Dates, merchant codes, and statuses.
2. **Logs Ingestion** (`/dashboard/log/xls/all`): Authenticated retrieval of EOD activity logs, parsed and normalized directly into real deduplicated action streams.
3. **Multi-Day Batching**: Safe window extraction ensuring full date coverage without truncation.

---

## 3. Daily Operational Workflow

The standard operational lifecycle is fully automated:

```
[ Management ] → Enter Vendoor Email + Password (auto-login & token management)
       ↓
[ Employee Master ] → Define employees & permanent capabilities (NEW / PENDING / BOTH / NEITHER)
       ↓
[ Business Date ] → Select global operating date (synchronized across all views)
       ↓
[ Today's Working Team ] → Designate on-duty agents for the selected date
       ↓
[ Operations ] → Review live orders pool, account eligibility, and unallocated volume
       ↓
[ ⚡ Auto Fair Allocation ] → Single-click deterministic allocation (account-centric, sticky ownership)
       ↓
[ Tracking ] → Live reconciliation of assigned orders vs actual Vendoor activity
       ↓
[ Performance & Reports ] → Empirical productivity, median throughput, and executive reports
```

### Key Business Invariants:
1. **Today's Working Team Gate**: An empty working team on a business date strictly blocks allocation (`SETUP REQUIRED`). Inactive or off-duty employees never receive work.
2. **Account-Centric Distribution**: 1 Account = 1 Employee by default. Accounts with 40, 100, or 120 orders remain unified with a single agent if capacity allows. 120 is **never** an arbitrary split trigger.
3. **Sticky Ownership**: Existing valid account owners retain their accounts across operating days unless reallocated via audited supervisor override.
4. **Action Deduplication**: Identical status changes within a 120-second rolling window are collapsed into 1 real action. Alt-phone edits are deduplicated within 120 seconds.
5. **Exclusion of Canceled Orders**: Canceled orders are excluded from speed, throughput, capacity, and score calculations.
6. **Auto Dispatcher OFF Invariant**: When `VENDOOR_AUTO_DISPATCH_ENABLED=false`, zero live dispatcher executions or database mutations occur.

---

## 4. Architecture & Domain Services

```
┌────────────────────────────────────────────────────────┐
│                   Vendoor Portal                       │
│    (/dashboard/login, /dashboard/orders, /log/xls/all) │
└───────────────────────────┬────────────────────────────┘
                            │ (Authenticated Session)
                            ▼
┌────────────────────────────────────────────────────────┐
│               Vendoor Ingestion Layer                  │
│       services/vendoor/{auth, orders, logs, client}    │
└───────────────────────────┬────────────────────────────┘
                            │ (Normalized Objects)
                            ▼
┌────────────────────────────────────────────────────────┐
│             Authoritative SQLite Database              │
│       employees, daily_working_team, specific_orders,  │
│       order_level_allocations, raw_log_records         │
└───────────────────────────┬────────────────────────────┘
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
┌───────────────────────┐       ┌───────────────────────┐
│ Domain Core Services  │       │ Real-Time Dispatcher  │
│ • services/allocation │       │ • services/vendoor/   │
│ • services/tracking   │       │   dispatcher          │
│ • services/productivity       │ • services/vendoor/   │
│ • services/reports    │       │   workload            │
└───────────┬───────────┘       └───────────┬───────────┘
            │                               │
            └───────────────┬───────────────┘
                            ▼
┌────────────────────────────────────────────────────────┐
│              Unified REST API & UI                     │
│  Top-Level Pages: Dashboard, Operations, Tracking,     │
│  Management, Performance + Global Context Bar          │
└────────────────────────────────────────────────────────┘
```

---

## 5. Troubleshooting & Health Diagnostics

- **Vendoor Status Disconnected**: Verify credentials on the **Management > Vendoor** tab. Test live connection using the Test Connection action.
- **Empty Allocation or Setup Required**: Verify that **Today's Working Team** has at least one active employee checked for the selected Business Date.
- **Stale Data Warning**: Check that orders and logs sync timestamps are within the active operation window. Trigger a manual sync from the Vendoor tab if necessary.
- **Database Health**: The database runs integrity checks on startup (`PRAGMA integrity_check`). Schema migrations are idempotent and preserve all historical records.
