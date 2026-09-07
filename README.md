# CS Executive Performance Dashboard — Full Source

An enterprise-grade executive BI dashboard for Customer-Service operational logs
(Arabic action text), with a Python analysis engine, a self-contained interactive
HTML dashboard, and Excel/PDF report generators.

This document is written so that **you or an AI agent can rebuild the entire system
from scratch**. Every rule, formula, and gotcha we discovered is captured here.

---

## 1. What the system does

Given a raw operational **log file** (one row per logged action, Arabic text) it produces:

- KPI cards (total actions, printed, pending, processing, cancelled, alt-phones, added orders…)
- Per-employee profiles with **own-mix rates**: Printed %, Pending %, Cancel %, Alt-phone %
- Cancellation analysis (per-agent rate + risk tiers), Pending analysis, Printed analysis
- Daily trend (rebuilt from the log timestamps)
- Executive insights + observations (auto-generated text)
- Scorecard with grades (A+…D) and segments
- A searchable/sortable/filterable detailed table
- Downloadable **Excel** (.xlsx) and **PDF** reports
- An **Import / Replace** button: re-parse a new log entirely in-browser and refresh every page
- A **Share** flow (send the single file, or publish to a free static host)

Optionally it also ingests a pre-aggregated **daily HR report** (one row per day) — but the
dashboard can rebuild the daily trend from the logs alone, so the HR file is not required.

---

## 2. The data (critical — read before coding)

### 2.1 Log file columns

The log is an `.xlsx` with these 5 columns (Arabic headers):

| Index | Header (Arabic) | Meaning        | Example |
|-------|-----------------|----------------|---------|
| A (0) | `#`             | row number     | `1` |
| B (1) | `كود الطلب`      | **order code** | `rr1402` |
| C (2) | `الاسم`          | employee name  | `MARWA AHMED CS` |
| D (3) | `الاكشن`         | action text    | see below |
| E (4) | `التاريخ`        | timestamp      | `2026-07-04 14:04:29` |

### 2.2 Action text patterns (all Arabic)

The action column mixes Arabic verbs with **English status names embedded inside**:

- **Status change** → `... حالة الطلب من 'X' إلى 'Printed'` or `عدل حالة الاوردر الى Canceled`
  - The target status is the English word after `الى` / `إلى` (optionally quoted).
  - Known statuses: `Printed`, `Pending`, `Processing`, `Canceled`/`Cancelled`.
    (Also seen but not counted as CS actions: Shipped, Collected, Delivered, Refunded, etc.)
  - **`Canceled` and `Cancelled` are the same thing — normalise to `Cancelled`.**
- **Added order** → contains `أضاف اوردر` / `اضاف اوردر` (spelling varies).
- **Alt-phone change** → contains `التليفون البديل` / `رقم بديل` / `هاتف بديل`.

### 2.3 The CS department filter

An employee belongs to Customer Service **iff their name ends with `cs`** (case-insensitive:
`CS`, `Cs`, `cs` all count). All status analysis is CS-only.

**Exception:** "Added order" is counted for **every** employee regardless of department
(data-entry staff add orders too). So added-orders analysis is all-departments; everything
else is CS-only.

### 2.4 ⚠️ Deduplication (the most important rule)

Each real status change is logged **~3 times** with different wording but the same meaning:

```
rr1402  عدل MARWA AHMED CS حالة الطلب من 'Pending' إلى 'Canceled'   14:04:29
rr1402  عدل حالة الاوردر الى Canceled                                14:04:29
rr1402  عدل MARWA AHMED CS حالة الطلب من Pending إلى Canceled        14:04:20
```

These three rows are **one** real cancellation and must be counted **once**.

**Dedup key = (order code + employee + status).** Rows sharing that key within a
**2-minute window** collapse to one action.

The 2-minute window matters: the *same* order can be genuinely cancelled, set back to
Pending, then cancelled again minutes later — those are **two** real cancellations and
must stay separate. Collapsing purely by key (ignoring time) would wrongly merge them.
On the sample data, dedup removes ~66.5% of raw status rows (88,583 → 29,671).

- **Alt-phone** dedup key = (order code + employee), same 2-minute window.
- **Added order** dedup = one per (order code + employee) — adding is a one-time event.

---

## 3. Metrics & formulas

Let an employee's real (deduplicated) counts be `printed, pending, processing, cancelled`,
and `actions = printed + pending + processing + cancelled`.

**Team-share percentages** (of the whole CS team):
- `contribution% = actions / Σactions`
- `cancel_share% = cancelled / Σcancelled`   (and similarly pending_share, printed_share, alt_share)

**Own-mix rates** (of that employee's own actions — these are what the user asked for):
- `own_printed_rate = printed / actions`
- `own_pending_rate = pending / actions`
- `own_cancel_rate  = cancelled / actions`
- `own_alt_rate     = alt / actions`

**Scores:**
- `activity_score   = actions / max(actions) * 100`
- `efficiency_score = (printed + processing) / actions * 100`
- `performance_score = 0.5*activity + 0.3*efficiency + 0.2*(contribution% normalised to its max)`

**Grade** by performance percentile: ≥90 A+, ≥80 A, ≥70 B+, ≥60 B, ≥45 C+, ≥30 C, else D.
**Segment**: ≥80 Top Performer, ≥50 Core Contributor, ≥25 Developing, else Needs Attention.

**Cancellation risk** (needs ≥50 actions to be meaningful):
- `High`      if own_cancel_rate ≥ 1.5 × team_cancel_rate
- `Elevated`  if ≥ 1.15 ×
- `Normal`    otherwise
- `Low Volume` if actions < 50

---

## 4. Architecture

```
raw log (.xlsx)
      │
      ▼
engine/analyze.py   ── loads, classifies, DEDUPLICATES, computes all metrics
      │  produces a JSON payload (data.json)
      ├────────────► build_dashboard.py ─► dashboard/index.html (self-contained)
      ├────────────► build_excel.py     ─► Executive_Report.xlsx
      └────────────► build_pdf.py       ─► Executive_Report.pdf
```

The **dashboard** embeds the JSON inline and also carries a JS re-implementation of the
same dedup+metrics logic, so the **Import / Replace** button can recompute everything
client-side from a freshly uploaded file — no server needed.

### The one rule that keeps Import/Replace correct

> The JS recompute must update **every** field the pages read: not just `employees`
> and `log_totals`, but also `hr`/`daily` (rebuilt from the log timestamps),
> `rankings`, `cancel_rate_rank`, `added_*`, `status_totals`, **and the generated
> `insights` + `observations` text**. If any field is left untouched, that part of
> the dashboard will keep showing the previous file's numbers.

(That was a real bug: originally only the numeric fields updated, so HR cards and the
insights text stayed stale. See `docs/CHANGELOG.md`.)

---

## 5. How to run / rebuild

```bash
pip install pandas numpy openpyxl matplotlib
# 1) analyse + emit JSON
python engine/analyze.py path/to/log.xlsx            # writes engine/data.json
# 2) build the outputs
python engine/build_dashboard.py                     # dashboard/index.html
python engine/build_excel.py                         # Executive_Report.xlsx
python engine/build_pdf.py                            # Executive_Report.pdf
```

For a fully self-contained dashboard (works offline, shareable as one file), inline the
SheetJS library — see `docs/BUILD_STANDALONE.md`.

---

## 6. Design system

- Colours: navy `#1E3A8A`, blue `#2563EB`, green `#16A34A`, amber `#F59E0B`,
  red `#DC2626`, purple `#7C3AED` (purple = Pending).
- Dark sidebar, light content, rounded cards, soft shadows. Power-BI-like, minimal.
- Charts are hand-built SVG/CSS (donut = conic-gradient, bars = flex, line = inline SVG,
  Pareto = SVG). No chart library needed for rendering; SheetJS is only for reading uploads.

See `docs/PROMPT_FOR_AI_AGENT.md` for a single prompt that regenerates this whole project.
