# Changelog / lessons learned

The order these were built in, and the real bugs we hit — useful so you don't repeat them.

## v1 — English assumption (wrong)
First pass assumed English action text. The real data is **Arabic** with English status
words embedded. Fixed the parser to extract the status after `الى/إلى` and to detect
`أضاف اوردر` / `التليفون البديل`.

## v2 — HR file + logs combined
Added the daily HR report (`JUL_HR1.xlsx`, one row per day). Later made redundant: the
daily trend is now rebuilt from the log timestamps, so no separate HR file is required.

## v3 — Deduplication + per-person rates + English UI
- Discovered each status change is logged ~3× (different wording, same meaning, near-same
  timestamp). Added dedup by (order+employee+status) within a **2-minute window** →
  removed ~66.5% of rows (88,583 → 29,671 real actions). MARWA AHMED CS: 657 raw cancels
  → 219 real (52.6% own cancel rate).
- Added per-agent **own-mix rates**: Printed %, Pending %, Cancel %, Alt-phone %, each as
  its own page + a column in the detailed table.
- Switched the whole UI to English (LTR).

## v4 — Standalone + Share + Import/Replace fixes
Two real bugs in the client-side Import/Replace path:

1. **Stack overflow on large files.** Computing the date range with
   `Math.min.apply(null, dates)` blows the call stack on ~170k timestamps and threw
   *after* the numbers had updated, so the UI showed "could not parse" and looked stale.
   → Fixed by computing min/max with a plain loop.

2. **Stale HR / insights.** The upload handler updated the numeric fields but not the
   rebuilt `hr`/`daily` arrays nor the generated `insights`/`observations` text, so those
   parts kept showing the previous file's numbers ("some numbers change, some don't").
   → Fixed by rebuilding the daily trend from the uploaded log and regenerating all
   insight/observation strings inside the handler, then re-rendering.

3. **Single-day line chart.** A one-day file made the line chart divide by `(points-1)=0`
   → `NaN` SVG coordinates. → Guarded `x(i)` to centre a single point.

Also inlined SheetJS as base64 for a true offline single-file build, and added a Share
dialog + an import confirmation toast (file name, rows→actions, agents, date range) so
it's always obvious whether a replace actually took effect.

## Invariants to preserve (tests)
- Re-uploading the **same** file → identical numbers.
- Uploading a **different** file → **every** page changes, including HR/daily cards and
  the insights text.
- Excel recalculates with **0 formula errors**.
- Dashboard renders all 11 pages with no JS errors, online or offline.
