"""
Build the executive Excel report (Executive_Report.xlsx) from data.json.

Sheets:
  1. Executive Summary    — KPIs + dedup note
  2. Daily Trend          — per-day figures + a line chart
  3. Agent Scorecard      — every agent, all counts + own-mix % (live formulas)
  4. Cancellation Analysis— per-agent cancel rate + risk (the requested focus)
  5. Status Distribution  — Printed/Pending/Processing/Cancelled + pie

Percentages are written as live Excel formulas (=D/C) so they recompute if edited.
"""
import json, pathlib
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.chart import LineChart, PieChart, Reference

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = json.loads((ROOT / "engine" / "data.json").read_text(encoding="utf-8"))

NAVY, BLUE, GREEN = "1E3A8A", "2563EB", "16A34A"
AMBER, RED, PURPLE = "F59E0B", "DC2626", "7C3AED"
WHITE, LIGHT = "FFFFFF", "F1F5F9"
thin = Side(style="thin", color="D1D5DB")
BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)


def header(ws, row, n, fill=NAVY):
    for c in range(1, n + 1):
        cell = ws.cell(row=row, column=c)
        cell.font = Font(name="Arial", bold=True, color=WHITE, size=11)
        cell.fill = PatternFill("solid", fgColor=fill)
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = BORDER


def build():
    d = DATA
    tot, hs, ded = d["log_totals"], d["hr"], d["dedup"]
    emp = d["employees"]
    tcr = d["team_cancel_rate"]
    wb = Workbook()

    # ---- Sheet 1: Executive Summary ----
    ws = wb.active; ws.title = "Executive Summary"; ws.sheet_view.showGridLines = False
    ws["A1"] = "CUSTOMER SERVICE — EXECUTIVE REPORT (DEDUPLICATED)"
    ws["A1"].font = Font(name="Arial", bold=True, size=15, color=NAVY); ws.merge_cells("A1:E1")
    ws["A2"] = (f"Each status change counted once per order+employee+status. "
                f"Removed {ded['removed']:,} duplicate rows ({ded['removed_pct']}% of raw).")
    ws["A2"].font = Font(name="Arial", italic=True, size=10, color="64748B"); ws.merge_cells("A2:F2")
    kpis = [
        ("Total Real Actions", f"{tot['actions']:,}", NAVY),
        ("Raw Rows (before dedup)", f"{ded['raw_cs_status']:,}", "64748B"),
        ("New Orders", f"{hs.get('tot_new',0):,}", BLUE),
        ("Printed", f"{tot['printed']:,}", GREEN),
        ("Team Print Rate", f"{round(100*tot['printed']/tot['actions'],1)}%", GREEN),
        ("Pending", f"{tot['pending']:,}", PURPLE),
        ("Team Pending Rate", f"{d['team_pending_rate']}%", PURPLE),
        ("Cancelled", f"{tot['cancelled']:,}", RED),
        ("Team Cancel Rate", f"{tcr}%", RED),
        ("Alt Phones Added", f"{tot['alt']:,}", BLUE),
        ("Top Performer", emp[0]["name"], GREEN),
    ]
    r = 4; ws.cell(r, 1, "KEY PERFORMANCE INDICATORS").font = Font(bold=True, size=12); r += 1
    for lab, val, col in kpis:
        ws.cell(r, 1, lab).font = Font(name="Arial", size=11, color="334155")
        ws.cell(r, 1).fill = PatternFill("solid", fgColor=LIGHT); ws.cell(r, 1).border = BORDER
        vc = ws.cell(r, 2, val); vc.font = Font(name="Arial", bold=True, size=12, color=col)
        vc.alignment = Alignment(horizontal="right"); vc.border = BORDER; r += 1
    r += 1; ws.cell(r, 1, "EXECUTIVE INSIGHTS").font = Font(bold=True, size=12); r += 1
    for ins in d["insights"]:
        c = ws.cell(r, 1, "• " + ins); c.font = Font(name="Arial", size=10, color="334155")
        c.alignment = Alignment(wrap_text=True, vertical="top")
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=6)
        ws.row_dimensions[r].height = 28; r += 1
    ws.column_dimensions["A"].width = 42; ws.column_dimensions["B"].width = 22
    for c in "CDEF": ws.column_dimensions[c].width = 13

    # ---- Sheet 2: Daily Trend ----
    ws2 = wb.create_sheet("Daily Trend"); ws2.sheet_view.showGridLines = False
    cols = ["Date", "New", "Printed", "Printed %", "Cancelled", "Cancel %"]
    for c, h in enumerate(cols, 1): ws2.cell(1, c, h)
    header(ws2, 1, len(cols))
    for i, row in enumerate(d["daily"], start=2):
        ws2.cell(i, 1, row["day"]); ws2.cell(i, 2, row["new"]); ws2.cell(i, 3, row["printed"])
        ws2.cell(i, 4, f"=C{i}/B{i}" if row["new"] else 0)
        ws2.cell(i, 5, row["cancel"]); ws2.cell(i, 6, f"=E{i}/B{i}" if row["new"] else 0)
        for c in range(1, 7): ws2.cell(i, c).border = BORDER
        ws2.cell(i, 4).number_format = "0.0%"; ws2.cell(i, 6).number_format = "0.0%"
    lr = 1 + len(d["daily"])
    for c, w in enumerate([12, 10, 10, 11, 11, 10], 1):
        ws2.column_dimensions[get_column_letter(c)].width = w
    ws2.freeze_panes = "A2"
    if lr > 2:
        ch = LineChart(); ch.title = "Daily New vs Printed vs Cancelled"; ch.height = 9; ch.width = 20
        for cc in (2, 3, 5):
            ch.add_data(Reference(ws2, min_col=cc, max_col=cc, min_row=1, max_row=lr), titles_from_data=True)
        ch.set_categories(Reference(ws2, min_col=1, min_row=2, max_row=lr)); ws2.add_chart(ch, "H2")

    # ---- Sheet 3: Agent Scorecard ----
    ws3 = wb.create_sheet("Agent Scorecard"); ws3.sheet_view.showGridLines = False
    cols = ["Rank", "Employee", "Actions", "Printed", "Print %", "Pending", "Pend %",
            "Processing", "Cancelled", "Cancel %", "Alt", "Alt %", "Added",
            "Contrib %", "Grade", "Segment"]
    for c, h in enumerate(cols, 1): ws3.cell(1, c, h)
    header(ws3, 1, len(cols))
    for i, row in enumerate(emp, start=2):
        vals = [row["rank"], row["name"], row["actions"], row["printed"], None, row["pending"],
                None, row["processing"], row["cancelled"], None, row["alt"], None, row["added"],
                row["contribution_pct"] / 100, row["grade"], row["segment"]]
        for c, v in enumerate(vals, 1):
            if v is not None: ws3.cell(i, c, v)
            ws3.cell(i, c).border = BORDER; ws3.cell(i, c).font = Font(name="Arial", size=10)
        ws3.cell(i, 5, f"=D{i}/C{i}"); ws3.cell(i, 7, f"=F{i}/C{i}")
        ws3.cell(i, 10, f"=I{i}/C{i}"); ws3.cell(i, 12, f"=K{i}/C{i}")
        for c in (5, 7, 10, 12, 14): ws3.cell(i, c).number_format = "0.0%"
        g = row["grade"]; gcol = GREEN if g.startswith("A") else BLUE if g.startswith("B") else AMBER if g.startswith("C") else RED
        ws3.cell(i, 15).font = Font(bold=True, color=gcol)
        if row["own_cancel_rate"] >= tcr * 1.5:
            ws3.cell(i, 10).font = Font(bold=True, color=RED)
    for c, w in enumerate([6, 26, 9, 8, 9, 8, 9, 10, 10, 9, 6, 8, 7, 10, 7, 15], 1):
        ws3.column_dimensions[get_column_letter(c)].width = w
    ws3.freeze_panes = "C2"

    # ---- Sheet 4: Cancellation Analysis ----
    ws4 = wb.create_sheet("Cancellation Analysis"); ws4.sheet_view.showGridLines = False
    cols = ["Rank", "Employee", "Total Actions", "Cancelled", "Own Cancel Rate %",
            "% of Team Cancels", "Risk"]
    for c, h in enumerate(cols, 1): ws4.cell(1, c, h)
    header(ws4, 1, len(cols), RED)
    cdf = sorted([e for e in emp if e["cancelled"] > 0],
                 key=lambda e: -e["own_cancel_rate"])
    tcan = tot["cancelled"]
    for i, row in enumerate(cdf, start=2):
        ws4.cell(i, 1, i - 1); ws4.cell(i, 2, row["name"]); ws4.cell(i, 3, row["actions"])
        ws4.cell(i, 4, row["cancelled"]); ws4.cell(i, 5, f"=D{i}/C{i}")
        ws4.cell(i, 6, f"=D{i}/{tcan}"); ws4.cell(i, 7, row["cancel_risk"])
        for c in range(1, 8): ws4.cell(i, c).border = BORDER
        ws4.cell(i, 5).number_format = "0.0%"; ws4.cell(i, 6).number_format = "0.0%"
        rk = row["cancel_risk"]
        rcol = RED if rk == "High" else AMBER if rk == "Elevated" else GREEN if rk == "Normal" else "64748B"
        ws4.cell(i, 7).font = Font(bold=True, color=rcol)
    for c, w in enumerate([6, 28, 13, 11, 16, 16, 12], 1):
        ws4.column_dimensions[get_column_letter(c)].width = w
    ws4.freeze_panes = "A2"

    # ---- Sheet 5: Status Distribution ----
    ws5 = wb.create_sheet("Status Distribution"); ws5.sheet_view.showGridLines = False
    ws5.cell(1, 1, "Status"); ws5.cell(1, 2, "Count"); ws5.cell(1, 3, "Share %"); header(ws5, 1, 3)
    st = d["status_totals"]
    for i, (k, v) in enumerate([("Printed", st["Printed"]), ("Pending", st["Pending"]),
                                ("Processing", st["Processing"]), ("Cancelled", st["Cancelled"])], start=2):
        ws5.cell(i, 1, k).border = BORDER; ws5.cell(i, 2, v).border = BORDER
        ws5.cell(i, 3, f"=B{i}/SUM($B$2:$B$5)").border = BORDER; ws5.cell(i, 3).number_format = "0.0%"
    ws5.column_dimensions["A"].width = 16; ws5.column_dimensions["B"].width = 12; ws5.column_dimensions["C"].width = 12
    pie = PieChart(); pie.title = "CS Status Distribution"
    pie.add_data(Reference(ws5, min_col=2, min_row=1, max_row=5), titles_from_data=True)
    pie.set_categories(Reference(ws5, min_col=1, min_row=2, max_row=5))
    pie.height = 8; pie.width = 12; ws5.add_chart(pie, "E2")

    out = ROOT / "Executive_Report.xlsx"
    wb.save(out)
    print(f"Wrote {out}")


if __name__ == "__main__":
    build()
