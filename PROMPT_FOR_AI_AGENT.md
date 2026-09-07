# One-shot prompt to rebuild this dashboard with an AI agent

Paste the block below to any capable coding agent (Claude, GPT, etc.), then attach a
sample log file. It contains every rule needed to regenerate the whole system. It is
deliberately explicit about the two things that are easy to get wrong: **the Arabic
action parsing** and **deduplication**.

---

```
Build me an enterprise "Customer Service Executive Performance Dashboard" from an
Excel operational log. Deliver: (1) a Python analysis engine, (2) a single self-contained
interactive HTML dashboard with an "Import/Replace" button that re-parses a new log
entirely in the browser, and (3) Excel + PDF report generators. Use pandas/numpy/
openpyxl/matplotlib on the Python side and hand-built SVG/CSS charts + SheetJS on the
front end (no chart library for rendering).

DATA — the log is an .xlsx with 5 columns (Arabic headers):
  A "#" row number | B "كود الطلب" order code | C "الاسم" employee name
  | D "الاكشن" action text (Arabic) | E "التاريخ" timestamp.

ACTION PARSING (Arabic text with English status words embedded):
- Status change: the target status is the English word after "الى" or "إلى"
  (it may be quoted), e.g. "...حالة الطلب من 'Pending' إلى 'Canceled'" -> Canceled.
  Count only these statuses: Printed, Pending, Processing, Canceled/Cancelled.
  Treat "Canceled" and "Cancelled" as the SAME status (normalise to Cancelled).
- Added order: action contains "أضاف اوردر" or "اضاف اوردر".
- Alt-phone change: action contains "التليفون البديل" or "رقم بديل" or "هاتف بديل".

DEPARTMENT FILTER:
- An employee is Customer Service iff their name ends with "cs" (case-insensitive).
- All status analysis is CS-only.
- EXCEPTION: "Added order" is counted for EVERY employee (all departments), not just CS.

DEDUPLICATION (most important — do not skip):
- Every real status change is logged ~3 times with different wording but identical
  meaning and near-identical timestamps. Count each real change ONCE.
- Dedup key = (order code + employee + status). Rows sharing that key within a
  2-MINUTE window collapse into one action. Keep the 2-minute window so that a genuine
  Cancel -> Pending -> Cancel on the same order minutes apart stays as two actions.
- Alt-phone dedup key = (order + employee), same 2-min window.
- Added-order dedup = one per (order + employee).
- On real data this removes ~66% of raw status rows. Show the removed % in the UI.

METRICS per employee (actions = printed+pending+processing+cancelled):
- Team-share %: contribution% = actions/Σactions; and cancelled/Σcancelled, etc.
- OWN-MIX rates (of the employee's own actions), these are required and shown per page:
  own_printed_rate, own_pending_rate, own_cancel_rate, own_alt_rate.
- activity = actions/max*100; efficiency = (printed+processing)/actions*100;
  performance = 0.5*activity + 0.3*efficiency + 0.2*(contribution% normalised to max).
- Grade by performance percentile: >=90 A+, >=80 A, >=70 B+, >=60 B, >=45 C+, >=30 C else D.
- Segment: >=80 Top Performer, >=50 Core Contributor, >=25 Developing, else Needs Attention.
- Cancellation risk (needs >=50 actions): High if own_cancel_rate>=1.5*team_rate,
  Elevated if >=1.15*, else Normal; Low Volume if <50 actions.

DAILY TREND: rebuild it from the log timestamps themselves (new orders/day from added
orders; printed & cancelled per day from CS status) — do NOT require a separate file.

DASHBOARD PAGES: Executive Overview (KPI cards + status donut incl. Pending + top-10 +
Pareto + daily line), Daily Trend, Cancellation Analysis (per-agent rate bars + risk
table), Pending Analysis (per-agent own-rate), Printed Analysis (per-agent own-rate),
Alt Phone Analysis, Employee Profiles (card each: stacked mix + own rates), Added Orders
(all departments), Executive Insights + Observations (auto-generated text), Scorecard
(graded table), Detailed Data (searchable/sortable/filterable table with Print%, Pend%,
Cancel%, Alt% columns).

IMPORT/REPLACE BUTTON — critical correctness rule: when a new file is uploaded, the JS
must recompute AND overwrite EVERY field the pages read: employees, log_totals,
status_totals, rankings, cancel_rate_rank, added_*, the rebuilt hr/daily arrays, AND the
generated insights + observations text. If any field is left stale, that part of the UI
will keep showing the previous file's numbers. After recompute, re-render the current page.
Show a confirmation toast with: file name, raw rows -> real actions, agent count, date range.
Also guard the line chart against a single-day dataset (avoid divide-by-zero on (points-1)).

DESIGN: navy #1E3A8A, blue #2563EB, green #16A34A, amber #F59E0B, red #DC2626,
purple #7C3AED (purple = Pending). Dark sidebar, light content, rounded cards, soft
shadows, minimal Power-BI look. English UI, LTR.

SHARE: the dashboard must be a single self-contained .html (inline the data and inline
SheetJS as base64 so it works offline). Add a "Share" dialog explaining: send the file
directly, or drag it onto a free static host (Netlify Drop / tiiny.host / GitHub Pages),
with a note that a published link is public and the data has employee names.

EXCEL (openpyxl): sheets = Executive Summary, Daily Trend (+line chart), Agent Scorecard
(all counts + own% as live =D/C formulas), Cancellation Analysis, Status Distribution
(+pie). PDF (matplotlib): cover+KPIs, daily trend, cancellation, printed/pending rates,
status pie + top agents, observations.

Validate: after building, re-uploading the SAME file must give identical numbers, and
uploading a DIFFERENT file must change ALL pages (including HR/daily cards and insights).
```

---

## Notes for whoever runs this

- If your agent has a sandbox, also give it `engine/analyze.py` from this repo as a
  reference implementation — it encodes all the rules above and is known-correct on the
  sample data (45 agents, 29,671 real actions, 66.5% duplicates removed).
- The trickiest bug in practice is the Import/Replace path leaving `hr`/`daily`/`insights`
  stale. The reference dashboard rebuilds those inside the upload handler — see
  `docs/CHANGELOG.md`.
