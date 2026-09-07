"""
CS Executive Dashboard — analysis engine.

Loads a raw operational log (.xlsx, Arabic action text), classifies each row,
DEDUPLICATES repeated status changes, and computes every metric the dashboard,
Excel and PDF outputs need. Emits a single JSON payload.

Usage:
    python engine/analyze.py path/to/log.xlsx  [path/to/hr_daily.xlsx]

Output:
    engine/data.json

Data contract and all business rules are documented in ../README.md.
"""
import sys, re, json
import pandas as pd
import numpy as np

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------
DEDUP_WINDOW_SEC = 120           # rows sharing a dedup key within this window = one action
MIN_ACTIONS_FOR_RATE = 50        # below this, an agent's rate% is flagged "Low Volume"

# Only these English status words count as CS status actions.
KNOWN_STATUSES = {"Printed", "Pending", "Canceled", "Cancelled", "Processing"}

# Regex for the target status after الى / إلى (optionally quoted).
STATUS_RE = re.compile(r"(?:الى|إلى)\s*'?([A-Za-z][A-Za-z ]*?)'?\s*$")
# "added a new order" — spelling of the verb varies.
ADDED_RE = re.compile(r"أضاف\s*ا?أ?وردر|اضاف\s*ا?أ?وردر")
# alternative / backup phone number edit.
ALT_RE = re.compile(r"التليفون البديل|رقم بديل|هاتف بديل")


# ----------------------------------------------------------------------------
# Classification helpers
# ----------------------------------------------------------------------------
def status_target(action_text: str):
    """Return the normalised target status of a status-change row, else None."""
    m = STATUS_RE.search(action_text)
    if not m:
        return None
    v = m.group(1).strip()
    if v == "Canceled":            # normalise the two spellings
        v = "Cancelled"
    return v if v in KNOWN_STATUSES else None


def is_cs_name(name) -> bool:
    """CS department = employee name ends with 'cs' (any case)."""
    return str(name).strip().lower().endswith("cs")


def pct(n, d) -> float:
    return round(100.0 * n / d, 1) if d else 0.0


# ----------------------------------------------------------------------------
# Loading
# ----------------------------------------------------------------------------
def load_logs(path: str) -> pd.DataFrame:
    df = pd.read_excel(path)
    df.columns = ["num", "order_code", "name", "action", "date"]
    df["name"] = df["name"].astype(str).str.strip()
    df["action"] = df["action"].astype(str)
    df["order_code"] = df["order_code"].astype(str)
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["status_to"] = df["action"].apply(status_target)
    df["is_added"] = df["action"].str.contains(ADDED_RE, na=False)
    df["is_alt"] = df["action"].str.contains(ALT_RE, na=False)
    df["is_cs"] = df["name"].apply(is_cs_name)
    return df


# ----------------------------------------------------------------------------
# Deduplication — the core rule (see README §2.4)
# ----------------------------------------------------------------------------
def dedup_status(df: pd.DataFrame) -> pd.DataFrame:
    """One row per real status change: collapse (order,name,status) repeats
    that occur within DEDUP_WINDOW_SEC of each other."""
    s = df[df["status_to"].notna()].copy()
    s = s.sort_values(["order_code", "name", "status_to", "date"])
    s["pk"] = s["order_code"] + "|" + s["name"] + "|" + s["status_to"]
    gap = s.groupby("pk")["date"].diff().dt.total_seconds()
    s["new_action"] = gap.isna() | (gap > DEDUP_WINDOW_SEC)
    return s[s["new_action"]].copy()


def dedup_alt(df: pd.DataFrame) -> pd.DataFrame:
    a = df[df["is_alt"]].copy().sort_values(["order_code", "name", "date"])
    a["pk"] = a["order_code"] + "|" + a["name"]
    gap = a.groupby("pk")["date"].diff().dt.total_seconds()
    a["new_action"] = gap.isna() | (gap > DEDUP_WINDOW_SEC)
    return a[a["new_action"]].copy()


def dedup_added(df: pd.DataFrame) -> pd.DataFrame:
    """Adding an order is a one-time event → one per (order, employee)."""
    ad = df[df["is_added"]].copy().sort_values(["order_code", "name", "date"])
    return ad.drop_duplicates(subset=["order_code", "name"], keep="first")


# ----------------------------------------------------------------------------
# Per-employee metrics
# ----------------------------------------------------------------------------
def build_employees(df: pd.DataFrame):
    sd = dedup_status(df)
    ad = dedup_alt(df)
    added = dedup_added(df)

    cs_sd = sd[sd["name"].apply(is_cs_name)]
    cs_ad = ad[ad["name"].apply(is_cs_name)]

    names = sorted(set(cs_sd["name"]) | set(cs_ad["name"]))
    piv = cs_sd.pivot_table(index="name", columns="status_to",
                            values="pk", aggfunc="count", fill_value=0)
    for col in ["Printed", "Pending", "Processing", "Cancelled"]:
        if col not in piv:
            piv[col] = 0
    alt_cnt = cs_ad.groupby("name").size()
    add_cnt = added[added["name"].apply(is_cs_name)].groupby("name").size()

    rows = []
    for n in names:
        printed = int(piv.loc[n, "Printed"]) if n in piv.index else 0
        pending = int(piv.loc[n, "Pending"]) if n in piv.index else 0
        proc = int(piv.loc[n, "Processing"]) if n in piv.index else 0
        canc = int(piv.loc[n, "Cancelled"]) if n in piv.index else 0
        rows.append(dict(
            name=n, printed=printed, pending=pending, processing=proc,
            cancelled=canc, alt=int(alt_cnt.get(n, 0)), added=int(add_cnt.get(n, 0)),
            actions=printed + pending + proc + canc,
        ))
    emp = pd.DataFrame(rows)
    emp = emp[emp["actions"] > 0].reset_index(drop=True)

    tot = dict(
        actions=int(emp["actions"].sum()), printed=int(emp["printed"].sum()),
        pending=int(emp["pending"].sum()), processing=int(emp["processing"].sum()),
        cancelled=int(emp["cancelled"].sum()), alt=int(emp["alt"].sum()),
    )

    # team-share %
    emp["contribution_pct"] = emp["actions"].apply(lambda x: pct(x, tot["actions"]))
    emp["printed_share_pct"] = emp["printed"].apply(lambda x: pct(x, tot["printed"]))
    emp["pending_share_pct"] = emp["pending"].apply(lambda x: pct(x, tot["pending"]))
    emp["canc_share_pct"] = emp["cancelled"].apply(lambda x: pct(x, tot["cancelled"]))
    emp["alt_share_pct"] = emp["alt"].apply(lambda x: pct(x, tot["alt"]))
    # own-mix rates (of each agent's own actions)
    emp["own_printed_rate"] = emp.apply(lambda r: pct(r["printed"], r["actions"]), axis=1)
    emp["own_pending_rate"] = emp.apply(lambda r: pct(r["pending"], r["actions"]), axis=1)
    emp["own_cancel_rate"] = emp.apply(lambda r: pct(r["cancelled"], r["actions"]), axis=1)
    emp["own_alt_rate"] = emp.apply(lambda r: pct(r["alt"], r["actions"]), axis=1)

    mx = emp["actions"].max() or 1
    emp["activity_score"] = (emp["actions"] / mx * 100).round(1)
    emp["efficiency_score"] = emp.apply(
        lambda r: pct(r["printed"] + r["processing"], r["actions"]), axis=1)
    maxc = emp["contribution_pct"].max() or 1
    emp["performance_score"] = (
        0.5 * emp["activity_score"] + 0.3 * emp["efficiency_score"]
        + 0.2 * emp["contribution_pct"] * (100 / maxc)).round(1)

    emp = emp.sort_values("actions", ascending=False).reset_index(drop=True)
    emp["rank"] = emp.index + 1
    emp["pctile"] = emp["performance_score"].rank(pct=True) * 100
    emp["grade"] = emp["pctile"].apply(_grade)
    emp["segment"] = emp["pctile"].apply(_segment)

    tcr = pct(tot["cancelled"], tot["actions"])
    emp["cancel_risk"] = emp.apply(lambda r: _risk(r, tcr), axis=1)

    raw_cs = int(df[df["is_cs"]]["status_to"].notna().sum())
    dedup_stats = dict(raw_cs_status=raw_cs, dedup_cs_status=tot["actions"],
                       removed=raw_cs - tot["actions"],
                       removed_pct=pct(raw_cs - tot["actions"], raw_cs))
    return emp, tot, tcr, dedup_stats


def _grade(p):
    return ("A+" if p >= 90 else "A" if p >= 80 else "B+" if p >= 70 else
            "B" if p >= 60 else "C+" if p >= 45 else "C" if p >= 30 else "D")


def _segment(p):
    return ("Top Performer" if p >= 80 else "Core Contributor" if p >= 50 else
            "Developing" if p >= 25 else "Needs Attention")


def _risk(r, tcr):
    if r["actions"] < MIN_ACTIONS_FOR_RATE:
        return "Low Volume"
    if r["own_cancel_rate"] >= tcr * 1.5:
        return "High"
    if r["own_cancel_rate"] >= tcr * 1.15:
        return "Elevated"
    return "Normal"


# ----------------------------------------------------------------------------
# Daily trend — rebuilt from the log timestamps (no HR file required)
# ----------------------------------------------------------------------------
def build_daily(df: pd.DataFrame):
    sd = dedup_status(df)
    added = dedup_added(df)
    # new orders per day (all departments)
    a = added.dropna(subset=["date"]).copy()
    a["d"] = a["date"].dt.date
    new_by_day = a.groupby("d").size()
    # printed / cancelled per day (CS status)
    s = sd[sd["name"].apply(is_cs_name)].dropna(subset=["date"]).copy()
    s["d"] = s["date"].dt.date
    pr_by_day = s[s["status_to"] == "Printed"].groupby("d").size()
    ca_by_day = s[s["status_to"] == "Cancelled"].groupby("d").size()

    days = sorted(set(new_by_day.index) | set(pr_by_day.index) | set(ca_by_day.index))
    daily = []
    for d in days:
        new = int(new_by_day.get(d, 0))
        printed = int(pr_by_day.get(d, 0))
        cancel = int(ca_by_day.get(d, 0))
        daily.append(dict(
            day=d.strftime("%b %d"), dow=d.strftime("%a"),
            new=new, printed=printed, cancel=cancel, add=new,
            printed_pct=pct(printed, new), cancel_pct=pct(cancel, new), add_pct=0.0,
        ))
    return daily


def hr_summary_from_daily(daily):
    if not daily:
        return {}
    df = pd.DataFrame(daily)
    return dict(
        days=len(df), tot_new=int(df["new"].sum()), tot_printed=int(df["printed"].sum()),
        tot_add=int(df["add"].sum()), tot_cancel=int(df["cancel"].sum()),
        avg_new=round(df["new"].mean()), avg_printed_pct=round(df["printed_pct"].mean(), 1),
        avg_cancel_pct=round(df["cancel_pct"].mean(), 1), avg_add_pct=0.0,
        best_print_day=df.loc[df["printed_pct"].idxmax(), "day"],
        best_print_pct=float(df["printed_pct"].max()),
        worst_cancel_day=df.loc[df["cancel_pct"].idxmax(), "day"],
        worst_cancel_pct=float(df["cancel_pct"].max()),
        peak_day=df.loc[df["new"].idxmax(), "day"], peak_new=int(df["new"].max()),
        low_day=df.loc[df["new"].idxmin(), "day"], low_new=int(df["new"].min()),
        date_min=df.iloc[0]["day"], date_max=df.iloc[-1]["day"],
    )


def added_all(df: pd.DataFrame) -> pd.DataFrame:
    ad = dedup_added(df)
    aa = ad.groupby("name").size().reset_index(name="added").sort_values("added", ascending=False)
    aa["is_cs"] = aa["name"].apply(is_cs_name)
    return aa


# ----------------------------------------------------------------------------
# Insights + observations (auto-generated text)
# ----------------------------------------------------------------------------
def build_insights(emp, tot, tcr, ded, hs, aa):
    team_pending = pct(tot["pending"], tot["actions"])
    top3 = pct(emp.head(3)["actions"].sum(), tot["actions"]) if len(emp) else 0
    high = emp[emp["cancel_risk"] == "High"]
    insights = [
        f"After removing duplicate log entries, each real status change counts once — "
        f"this cut {ded['removed']:,} repeated rows ({ded['removed_pct']}% of raw status logs).",
        f"Across {hs.get('days',0)} days, {hs.get('tot_new',0):,} new orders were logged "
        f"(avg {hs.get('avg_new',0):,.0f}/day).",
        f"At agent level (deduplicated), cancellations are {tcr}% of all "
        f"{tot['actions']:,} real actions; Pending is {team_pending}%.",
        f"{len(high)} agents carry a High cancellation-risk flag (rate ≥ 1.5× the {tcr}% team average).",
        f"{emp.iloc[0]['name']} leads with {emp.iloc[0]['contribution_pct']}% of all CS actions; "
        f"the top 3 hold {top3}%." if len(emp) else "",
        f"Printing is {pct(tot['printed'],tot['actions'])}% of real actions; "
        f"Pending is a {team_pending}% queue.",
        f"Daily cancellation averaged {hs.get('avg_cancel_pct',0)}%, worst on "
        f"{hs.get('worst_cancel_day','-')} at {hs.get('worst_cancel_pct',0)}%.",
        f"{int(aa['added'].sum()):,} unique orders were added across ALL departments "
        f"(deduplicated by order code).",
    ]
    obs = []
    if len(high):
        nm = ", ".join(high.head(3)["name"].tolist())
        obs.append(["Cancellation Hotspots",
            f"{len(high)} agents exceed 1.5× the team cancel rate — led by {nm}. "
            f"A review of their cancellation reasons is warranted."])
    w = emp[emp["actions"] >= MIN_ACTIONS_FOR_RATE].sort_values("own_cancel_rate", ascending=False)
    if len(w):
        w = w.iloc[0]
        obs.append(["Top Cancellation Rate",
            f"{w['name']} cancels {w['own_cancel_rate']}% of their {w['actions']:,} real actions "
            f"({w['cancelled']:,} orders) — the highest rate on the team."])
    obs.append(["Pending Backlog",
        f"{tot['pending']:,} orders sit in Pending ({pct(tot['pending'],tot['actions'])}% of actions)."])
    obs.append(["Deduplication Impact",
        f"Raw logs recorded each status change ~3×. Counting once per order+employee+status "
        f"removed {ded['removed_pct']}% of rows, giving a true action count of {tot['actions']:,}."])
    return [i for i in insights if i], obs


# ----------------------------------------------------------------------------
# Assemble the JSON payload the dashboard/reports consume
# ----------------------------------------------------------------------------
def _clean(v):
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return float(v)
    return v


def build_payload(log_path):
    df = load_logs(log_path)
    emp, tot, tcr, ded = build_employees(df)
    daily = build_daily(df)
    hs = hr_summary_from_daily(daily)
    aa = added_all(df)
    insights, obs = build_insights(emp, tot, tcr, ded, hs, aa)

    def top(col, n=10):
        d = emp.sort_values(col, ascending=False).head(n)
        return [{"name": r["name"], "value": _clean(r[col])} for _, r in d.iterrows()]

    payload = dict(
        hr=hs, daily=daily, log_totals=tot, dedup=ded,
        team_cancel_rate=tcr, team_pending_rate=pct(tot["pending"], tot["actions"]),
        employees=[{k: _clean(v) for k, v in row.items()} for row in emp.to_dict("records")],
        insights=insights, observations=obs,
        rankings=dict(
            most_active=top("actions"), printed=top("printed"), pending=top("pending"),
            cancelled=top("cancelled"), processing=top("processing"), alt=top("alt"),
            contribution=[{"name": r["name"], "value": float(r["contribution_pct"])}
                          for _, r in emp.sort_values("contribution_pct", ascending=False)
                          .head(10).iterrows()],
        ),
        cancel_rate_rank=[
            {"name": r["name"], "value": float(r["own_cancel_rate"]),
             "cancelled": int(r["cancelled"]), "actions": int(r["actions"]),
             "risk": r["cancel_risk"]}
            for _, r in emp[emp["actions"] >= MIN_ACTIONS_FOR_RATE]
            .sort_values("own_cancel_rate", ascending=False).head(15).iterrows()],
        added_all_top=[{"name": r["name"], "value": int(r["added"]), "is_cs": bool(r["is_cs"])}
                       for _, r in aa.head(15).iterrows()],
        added_cs=int(aa[aa["is_cs"]]["added"].sum()),
        added_noncs=int(aa[~aa["is_cs"]]["added"].sum()),
        status_totals=dict(Printed=tot["printed"], Pending=tot["pending"],
                           Processing=tot["processing"], Cancelled=tot["cancelled"]),
    )
    return payload


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python analyze.py path/to/log.xlsx", file=sys.stderr)
        sys.exit(1)
    payload = build_payload(sys.argv[1])
    with open("engine/data.json", "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    k = payload["log_totals"]
    print(f"OK — {len(payload['employees'])} agents, {k['actions']:,} real actions "
          f"(removed {payload['dedup']['removed_pct']}% duplicates). Wrote engine/data.json")
