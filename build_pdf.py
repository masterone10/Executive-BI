"""
Build the executive PDF report (Executive_Report.pdf) from data.json.

Pages:
  1. Cover + KPI grid + insights
  2. Daily trend (volume + rates)
  3. Cancellation analysis (per-agent rate + volume)
  4. Per-agent Printed & Pending rates
  5. Status mix pie + top-active agents
  6. Observations & recommendations
"""
import json, pathlib, textwrap as tw
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages

ROOT = pathlib.Path(__file__).resolve().parent.parent
D = json.loads((ROOT / "engine" / "data.json").read_text(encoding="utf-8"))

CN, CB, CG, CA, CR, CP = "#1E3A8A", "#2563EB", "#16A34A", "#F59E0B", "#DC2626", "#7C3AED"
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9})


def wrap(t, n=24):
    return t if len(t) <= n else t[:n - 1] + "…"


def build():
    emp = D["employees"]; tot = D["log_totals"]; hs = D["hr"]; ded = D["dedup"]
    tcr = D["team_cancel_rate"]
    daily = D["daily"]
    out = ROOT / "Executive_Report.pdf"

    with PdfPages(out) as pdf:
        # Page 1 — cover
        fig = plt.figure(figsize=(11.7, 8.27)); fig.patch.set_facecolor("white")
        fig.text(0.5, 0.93, "CUSTOMER SERVICE", ha="center", fontsize=25, fontweight="bold", color=CN)
        fig.text(0.5, 0.887, "Executive Report — Deduplicated", ha="center", fontsize=13, color="#475569")
        fig.text(0.5, 0.852, f"{ded['removed']:,} duplicate rows removed ({ded['removed_pct']}%) · "
                 f"{tot['actions']:,} real actions", ha="center", fontsize=8.5, color="#94A3B8", style="italic")
        cards = [("Real Actions", f"{tot['actions']:,}", CN),
                 ("New Orders", f"{hs.get('tot_new',0):,}", CB),
                 ("Printed", f"{tot['printed']:,}", CG),
                 ("Print Rate", f"{round(100*tot['printed']/tot['actions'],1)}%", CG),
                 ("Pending", f"{tot['pending']:,}", CP),
                 ("Pending Rate", f"{D['team_pending_rate']}%", CP),
                 ("Cancelled", f"{tot['cancelled']:,}", CR),
                 ("Cancel Rate", f"{tcr}%", CR),
                 ("Top Agent", wrap(emp[0]["name"], 15), CG)]
        x0, y0, w, h, gx, gy = 0.06, 0.55, 0.28, 0.10, 0.02, 0.03
        for i, (lab, val, col) in enumerate(cards):
            rr, cc = divmod(i, 3); x = x0 + cc * (w + gx); y = y0 - rr * (h + gy)
            ax = fig.add_axes([x, y, w, h]); ax.axis("off")
            ax.add_patch(plt.Rectangle((0, 0), 1, 1, color=col, alpha=0.10, transform=ax.transAxes))
            ax.add_patch(plt.Rectangle((0, 0), 0.03, 1, color=col, transform=ax.transAxes))
            ax.text(0.10, 0.62, val, fontsize=15, fontweight="bold", color=col, transform=ax.transAxes, va="center")
            ax.text(0.10, 0.24, lab.upper(), fontsize=7.5, color="#64748B", transform=ax.transAxes, va="center")
        fig.text(0.06, 0.16, "EXECUTIVE INSIGHTS", fontsize=11, fontweight="bold", color="#0F172A")
        for i, t in enumerate(D["insights"][:5]):
            for j, line in enumerate(tw.wrap(t, 120)):
                fig.text(0.07, 0.13 - i * 0.026 - j * 0.016, ("• " if j == 0 else "  ") + line,
                         fontsize=8.3, color="#334155")
        pdf.savefig(fig); plt.close()

        # Page 2 — daily
        if daily:
            fig, axes = plt.subplots(2, 1, figsize=(11.7, 8.27)); fig.patch.set_facecolor("white")
            fig.suptitle("Daily Operational Trend", fontsize=16, fontweight="bold", color=CN, y=0.97)
            x = range(len(daily)); days = [d["day"].replace("Jul ", "") for d in daily]
            ax = axes[0]
            ax.plot(x, [d["new"] for d in daily], color=CB, marker="o", ms=3, label="New")
            ax.plot(x, [d["printed"] for d in daily], color=CG, marker="o", ms=3, label="Printed")
            ax.plot(x, [d["cancel"] for d in daily], color=CR, marker="o", ms=3, label="Cancelled")
            ax.set_xticks(list(x)); ax.set_xticklabels(days, fontsize=7); ax.legend(fontsize=9, ncol=3)
            ax.set_title("Order Volume", fontsize=11); ax.spines[["top", "right"]].set_visible(False); ax.grid(axis="y", alpha=.3)
            ax = axes[1]
            ax.plot(x, [d["printed_pct"] for d in daily], color=CG, marker="o", ms=3, label="Printed %")
            ax.plot(x, [d["cancel_pct"] for d in daily], color=CR, marker="o", ms=3, label="Cancel %")
            ax.set_xticks(list(x)); ax.set_xticklabels(days, fontsize=7); ax.legend(fontsize=9, ncol=2)
            ax.set_title("Daily Rates (%)", fontsize=11); ax.spines[["top", "right"]].set_visible(False); ax.grid(axis="y", alpha=.3)
            plt.tight_layout(rect=[0, 0, 1, 0.94]); pdf.savefig(fig); plt.close()

        # Page 3 — cancellation
        fig, axes = plt.subplots(1, 2, figsize=(11.7, 8.27)); fig.patch.set_facecolor("white")
        fig.suptitle("Cancellation Analysis by Agent", fontsize=15, fontweight="bold", color=CN, y=0.96)
        cr = sorted([e for e in emp if e["actions"] >= 50], key=lambda e: -e["own_cancel_rate"])[:12]
        ax = axes[0]
        cols = [CR if e["own_cancel_rate"] >= tcr * 1.5 else CA if e["own_cancel_rate"] >= tcr * 1.15 else CG for e in cr]
        ax.barh([wrap(e["name"]) for e in cr][::-1], [e["own_cancel_rate"] for e in cr][::-1], color=cols[::-1])
        ax.axvline(tcr, color="#64748B", ls="--", lw=1)
        ax.set_title("Own Cancellation Rate %", fontsize=11); ax.set_xlabel("% of agent actions")
        ax.spines[["top", "right"]].set_visible(False)
        cc = sorted(emp, key=lambda e: -e["cancelled"])[:12]
        ax = axes[1]
        ax.barh([wrap(e["name"]) for e in cc][::-1], [e["cancelled"] for e in cc][::-1], color=CR, alpha=.8)
        ax.set_title("Cancelled Volume (count)", fontsize=11); ax.set_xlabel("orders")
        ax.spines[["top", "right"]].set_visible(False)
        plt.tight_layout(rect=[0, 0, 1, 0.93]); pdf.savefig(fig); plt.close()

        # Page 4 — printed & pending rates
        fig, axes = plt.subplots(1, 2, figsize=(11.7, 8.27)); fig.patch.set_facecolor("white")
        fig.suptitle("Per-Agent Printed & Pending Rates", fontsize=15, fontweight="bold", color=CN, y=0.96)
        pr = sorted([e for e in emp if e["actions"] >= 50], key=lambda e: -e["own_printed_rate"])[:12]
        ax = axes[0]
        ax.barh([wrap(e["name"]) for e in pr][::-1], [e["own_printed_rate"] for e in pr][::-1], color=CG)
        ax.set_title("Printing Rate % (own actions)", fontsize=11); ax.set_xlabel("%")
        ax.spines[["top", "right"]].set_visible(False)
        pe = sorted([e for e in emp if e["actions"] >= 50], key=lambda e: -e["own_pending_rate"])[:12]
        ax = axes[1]
        ax.barh([wrap(e["name"]) for e in pe][::-1], [e["own_pending_rate"] for e in pe][::-1], color=CP)
        ax.set_title("Pending Rate % (own actions)", fontsize=11); ax.set_xlabel("%")
        ax.spines[["top", "right"]].set_visible(False)
        plt.tight_layout(rect=[0, 0, 1, 0.93]); pdf.savefig(fig); plt.close()

        # Page 5 — status pie + top active
        fig, axes = plt.subplots(1, 2, figsize=(11.7, 8.27)); fig.patch.set_facecolor("white")
        fig.suptitle("Status Mix & Agent Activity", fontsize=15, fontweight="bold", color=CN, y=0.96)
        st = D["status_totals"]
        axes[0].pie([st["Printed"], st["Pending"], st["Processing"], st["Cancelled"]],
                    labels=["Printed", "Pending", "Processing", "Cancelled"],
                    colors=[CG, CP, CA, CR], autopct="%1.1f%%", startangle=90,
                    wedgeprops=dict(width=0.42, edgecolor="white"))
        axes[0].set_title("CS Status Distribution (incl. Pending)", fontsize=11)
        t10 = emp[:10]; ax = axes[1]
        ax.barh([wrap(e["name"]) for e in t10][::-1], [e["actions"] for e in t10][::-1], color=CN)
        ax.set_title("Top 10 Most Active (real actions)", fontsize=11); ax.set_xlabel("actions")
        ax.spines[["top", "right"]].set_visible(False)
        plt.tight_layout(rect=[0, 0, 1, 0.93]); pdf.savefig(fig); plt.close()

        # Page 6 — observations
        fig = plt.figure(figsize=(11.7, 8.27)); fig.patch.set_facecolor("white")
        fig.text(0.5, 0.94, "Executive Observations & Recommendations", ha="center",
                 fontsize=16, fontweight="bold", color=CN)
        y = 0.84
        for title, body in D["observations"]:
            fig.text(0.08, y, "▸ " + title, fontsize=11.5, fontweight="bold", color="#0F172A")
            for line in tw.wrap(body, 108):
                y -= 0.033; fig.text(0.10, y, line, fontsize=9.5, color="#334155")
            y -= 0.05
        pdf.savefig(fig); plt.close()

    print(f"Wrote {out}")


if __name__ == "__main__":
    build()
