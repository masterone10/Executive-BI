import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

const DEDUP_WINDOW_SEC = 120;
const DEDUP_WINDOW_MS = DEDUP_WINDOW_SEC * 1000;
const MIN_ACTIONS_FOR_RATE = 50;
const KNOWN_STATUSES = new Set(['Printed', 'Pending', 'Canceled', 'Cancelled', 'Processing']);
const STATUS_RE = /(?:الى|إلى)\s*'?([A-Za-z][A-Za-z ]*?)'?\s*$/;
const ADDED_RE = /أضاف\s*ا?أ?وردر|اضاف\s*ا?أ?وردر/;
const ALT_RE = /التليفون البديل|رقم بديل|هاتف بديل/;

function isCSName(name) {
  return String(name || '').trim().toLowerCase().endsWith('cs');
}

function pct(n, d) {
  return d ? +(n / d * 100).toFixed(1) : 0;
}

function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val.getTime();
  if (typeof val === 'number') {
    // Excel serial date to JS timestamp
    return Math.round((val - 25569) * 86400 * 1000);
  }
  const parsed = Date.parse(val);
  return isNaN(parsed) ? null : parsed;
}

export function buildPayload(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });

  if (rows.length === 0) {
    throw new Error('Empty spreadsheet');
  }

  const hdr = rows[0].map(h => String(h || '').trim());
  let oi = 1, ci = 2, ai = 3, di = 4;
  hdr.forEach((h, i) => {
    if (/كود|order|code/i.test(h)) oi = i;
    if (/الاسم|name/i.test(h)) ci = i;
    if (/الاكشن|action/i.test(h)) ai = i;
    if (/التاريخ|date/i.test(h)) di = i;
  });

  const dataRows = rows.slice(1).filter(r => r && r.length);

  const recs = [];
  for (const r of dataRows) {
    const act = String(r[ai] || '').trim();
    const name = String(r[ci] || '').trim();
    if (!name) continue;
    const order = String(r[oi] || '').trim();
    let st = null;
    const m = STATUS_RE.exec(act);
    if (m) {
      st = m[1].trim();
      if (st === 'Canceled') st = 'Cancelled';
      if (!KNOWN_STATUSES.has(st)) st = null;
    }
    const dt = parseDate(r[di]);
    recs.push({
      order,
      name,
      act,
      st,
      dt,
      alt: ALT_RE.test(act),
      added: ADDED_RE.test(act),
      isCS: isCSName(name),
    });
  }

  // 1. Status deduplication
  const statusRecs = recs.filter(r => r.st);
  const statusGroups = {};
  for (const r of statusRecs) {
    const k = `${r.order}|${r.name}|${r.st}`;
    if (!statusGroups[k]) statusGroups[k] = [];
    statusGroups[k].push(r);
  }

  const emap = {};
  const dedupedStatusEvents = [];

  for (const group of Object.values(statusGroups)) {
    group.sort((a, b) => (a.dt || 0) - (b.dt || 0));
    let lastDt = null;
    for (const r of group) {
      if (lastDt === null || (r.dt && lastDt && r.dt - lastDt > DEDUP_WINDOW_MS)) {
        if (!emap[r.name]) {
          emap[r.name] = { name: r.name, printed: 0, pending: 0, processing: 0, cancelled: 0, alt: 0, added: 0 };
        }
        if (r.st === 'Printed') emap[r.name].printed++;
        else if (r.st === 'Pending') emap[r.name].pending++;
        else if (r.st === 'Processing') emap[r.name].processing++;
        else if (r.st === 'Cancelled') emap[r.name].cancelled++;

        dedupedStatusEvents.push(r);
        lastDt = r.dt;
      }
    }
  }

  // 2. Alt phone deduplication
  const altRecs = recs.filter(r => r.alt);
  const altGroups = {};
  for (const r of altRecs) {
    const k = `${r.order}|${r.name}`;
    if (!altGroups[k]) altGroups[k] = [];
    altGroups[k].push(r);
  }

  for (const group of Object.values(altGroups)) {
    group.sort((a, b) => (a.dt || 0) - (b.dt || 0));
    let lastDt = null;
    for (const r of group) {
      if (lastDt === null || (r.dt && lastDt && r.dt - lastDt > DEDUP_WINDOW_MS)) {
        if (!emap[r.name]) {
          emap[r.name] = { name: r.name, printed: 0, pending: 0, processing: 0, cancelled: 0, alt: 0, added: 0 };
        }
        emap[r.name].alt++;
        lastDt = r.dt;
      }
    }
  }

  // 3. Added orders deduplication (one per order + employee)
  const addSeen = {};
  const addedAll = {};
  let addedCS = 0;
  let addedNon = 0;

  for (const r of recs) {
    if (!r.added) continue;
    const k = `${r.order}|${r.name}`;
    if (addSeen[k]) continue;
    addSeen[k] = 1;
    addedAll[r.name] = (addedAll[r.name] || 0) + 1;
    if (r.isCS) addedCS++;
    else addedNon++;
    if (emap[r.name]) emap[r.name].added++;
  }

  // CS employees
  let emps = Object.values(emap)
    .filter(x => isCSName(x.name))
    .map(x => ({
      ...x,
      actions: x.printed + x.pending + x.processing + x.cancelled,
    }))
    .filter(x => x.actions > 0);

  const T = { actions: 0, printed: 0, pending: 0, processing: 0, cancelled: 0, alt: 0 };
  for (const x of emps) {
    T.actions += x.actions;
    T.printed += x.printed;
    T.pending += x.pending;
    T.processing += x.processing;
    T.cancelled += x.cancelled;
    T.alt += x.alt;
  }

  const mx = Math.max(...emps.map(x => x.actions), 1);
  for (const x of emps) {
    x.contribution_pct = pct(x.actions, T.actions);
    x.canc_share_pct = pct(x.cancelled, T.cancelled);
    x.pending_share_pct = pct(x.pending, T.pending);
    x.printed_share_pct = pct(x.printed, T.printed);
    x.alt_share_pct = pct(x.alt, T.alt);
    x.own_printed_rate = pct(x.printed, x.actions);
    x.own_pending_rate = pct(x.pending, x.actions);
    x.own_cancel_rate = pct(x.cancelled, x.actions);
    x.own_proc_rate = pct(x.processing, x.actions);
    x.own_alt_rate = pct(x.alt, x.actions);
    x.activity_score = +(x.actions / mx * 100).toFixed(1);
    x.efficiency_score = pct(x.printed + x.processing, x.actions);
  }

  emps.sort((a, b) => b.actions - a.actions);
  const maxC = emps[0]?.contribution_pct || 1;
  const totalEmps = emps.length;

  for (let i = 0; i < emps.length; i++) {
    const x = emps[i];
    x.performance_score = +(0.5 * x.activity_score + 0.3 * x.efficiency_score + 0.2 * x.contribution_pct * (100 / maxC)).toFixed(1);
    x.rank = i + 1;
    const p = (1 - i / totalEmps) * 100;
    x.pctile = +p.toFixed(1);
    x.grade = p >= 90 ? 'A+' : p >= 80 ? 'A' : p >= 70 ? 'B+' : p >= 60 ? 'B' : p >= 45 ? 'C+' : p >= 30 ? 'C' : 'D';
    x.segment = p >= 80 ? 'Top Performer' : p >= 50 ? 'Core Contributor' : p >= 25 ? 'Developing' : 'Needs Attention';
  }

  const tcr = pct(T.cancelled, T.actions);
  for (const x of emps) {
    x.cancel_risk = x.actions < MIN_ACTIONS_FOR_RATE ? 'Low Volume' : x.own_cancel_rate >= tcr * 1.5 ? 'High' : x.own_cancel_rate >= tcr * 1.15 ? 'Elevated' : 'Normal';
  }

  const rawCS = statusRecs.filter(r => r.isCS).length;
  const ded = {
    raw_cs_status: rawCS,
    dedup_cs_status: T.actions,
    removed: rawCS - T.actions,
    removed_pct: pct(rawCS - T.actions, rawCS),
  };
  const dedup = ded;

  const rt = k => emps.slice().sort((a, b) => b[k] - a[k]).slice(0, 10).map(x => ({ name: x.name, value: x[k] }));

  const rankings = {
    most_active: emps.slice(0, 10).map(x => ({ name: x.name, value: x.actions })),
    printed: rt('printed'),
    pending: rt('pending'),
    cancelled: rt('cancelled'),
    processing: rt('processing'),
    alt: rt('alt'),
    contribution: emps.slice(0, 10).map(x => ({ name: x.name, value: x.contribution_pct })),
  };

  const cancel_rate_rank = emps
    .filter(x => x.actions >= MIN_ACTIONS_FOR_RATE)
    .sort((a, b) => b.own_cancel_rate - a.own_cancel_rate)
    .slice(0, 15)
    .map(x => ({
      name: x.name,
      value: x.own_cancel_rate,
      cancelled: x.cancelled,
      actions: x.actions,
      risk: x.cancel_risk,
    }));

  const aa = Object.entries(addedAll)
    .map(([name, v]) => ({ name, value: v, is_cs: isCSName(name) }))
    .sort((a, b) => b.value - a.value);

  // Daily trend
  const byday = {};
  function dkey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const addSeen2 = {};
  for (const r of recs) {
    if (!r.added || !r.dt) continue;
    const k = `${r.order}|${r.name}`;
    if (addSeen2[k]) continue;
    addSeen2[k] = 1;
    const dk = dkey(r.dt);
    if (!byday[dk]) byday[dk] = { new: 0, printed: 0, cancel: 0 };
    byday[dk].new++;
  }

  for (const r of dedupedStatusEvents) {
    if (!r.dt || !r.isCS) continue;
    const dk = dkey(r.dt);
    if (!byday[dk]) byday[dk] = { new: 0, printed: 0, cancel: 0 };
    if (r.st === 'Printed') byday[dk].printed++;
    else if (r.st === 'Cancelled') byday[dk].cancel++;
  }

  const days = Object.keys(byday).sort();
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let daily = [];
  let hr = {};

  if (days.length) {
    daily = days.map(dk => {
      const p = dk.split('-');
      const dt = new Date(+p[0], +p[1] - 1, +p[2]);
      const o = byday[dk];
      const pp = o.new ? +(o.printed / o.new * 100).toFixed(1) : 0;
      const cp = o.new ? +(o.cancel / o.new * 100).toFixed(1) : 0;
      return {
        day: `${mon[+p[1] - 1]} ${String(+p[2]).padStart(2, '0')}`,
        dow: dow[dt.getDay()],
        new: o.new,
        printed: o.printed,
        cancel: o.cancel,
        add: o.new,
        printed_pct: pp,
        cancel_pct: cp,
        add_pct: 0,
      };
    });

    const tN = daily.reduce((s, x) => s + x.new, 0);
    const tP = daily.reduce((s, x) => s + x.printed, 0);
    const tC = daily.reduce((s, x) => s + x.cancel, 0);
    const vals = daily.map(x => x.new);
    const pcts = daily.map(x => x.printed_pct);
    const cpcts = daily.map(x => x.cancel_pct);
    const avg = a => (a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(1) : 0);

    const maxNewI = vals.indexOf(Math.max(...vals));
    const minNewI = vals.indexOf(Math.min(...vals));
    const bestP = pcts.indexOf(Math.max(...pcts));
    const worstC = cpcts.indexOf(Math.max(...cpcts));

    hr = {
      days: daily.length,
      tot_new: tN,
      tot_printed: tP,
      tot_add: tN,
      tot_cancel: tC,
      avg_new: Math.round(tN / daily.length),
      avg_printed_pct: avg(pcts),
      avg_cancel_pct: avg(cpcts),
      avg_add_pct: 0,
      best_print_day: daily[bestP]?.day || '-',
      best_print_pct: pcts[bestP] || 0,
      worst_cancel_day: daily[worstC]?.day || '-',
      worst_cancel_pct: cpcts[worstC] || 0,
      peak_day: daily[maxNewI]?.day || '-',
      peak_new: vals[maxNewI] || 0,
      low_day: daily[minNewI]?.day || '-',
      low_new: vals[minNewI] || 0,
      date_min: daily[0]?.day || '-',
      date_max: daily[daily.length - 1]?.day || '-',
    };
  }

  // Insights and observations
  const teamPending = pct(T.pending, T.actions);
  const top3 = emps.length ? +(emps.slice(0, 3).reduce((s, e) => s + e.actions, 0) / T.actions * 100).toFixed(1) : 0;
  const highRiskEmps = emps.filter(e => e.cancel_risk === 'High');

  const insights = [
    `After removing duplicate log entries, each real status change counts once — this cut ${ded.removed.toLocaleString()} repeated rows (${ded.removed_pct}% of raw status logs).`,
    `Across ${hr.days || 0} days, ${(hr.tot_new || 0).toLocaleString()} new orders were logged (avg ${(hr.avg_new || 0).toLocaleString()}/day).`,
    `At agent level (deduplicated), cancellations are ${tcr}% of all ${T.actions.toLocaleString()} real actions; Pending is ${teamPending}%.`,
    `${highRiskEmps.length} agents carry a High cancellation-risk flag (rate ≥ 1.5× the ${tcr}% team average).`,
    emps[0] ? `${emps[0].name} leads with ${emps[0].contribution_pct}% of all CS actions; the top 3 hold ${top3}%.` : '',
    `Printing is ${T.actions ? +(T.printed / T.actions * 100).toFixed(1) : 0}% of real actions; Pending is a ${teamPending}% queue.`,
    `Daily cancellation averaged ${hr.avg_cancel_pct || 0}%, worst on ${hr.worst_cancel_day || '-'} at ${hr.worst_cancel_pct || 0}%.`,
    `${(addedCS + addedNon).toLocaleString()} unique orders were added across ALL departments (deduplicated by order code).`,
  ].filter(Boolean);

  const obs = [];
  if (highRiskEmps.length) {
    const nm = highRiskEmps.slice(0, 3).map(e => e.name).join(', ');
    obs.push([
      'Cancellation Hotspots',
      `${highRiskEmps.length} agents exceed 1.5× the team cancel rate — led by ${nm}. A review of their cancellation reasons is warranted.`,
    ]);
  }
  const topCanceler = emps.filter(e => e.actions >= MIN_ACTIONS_FOR_RATE).sort((a, b) => b.own_cancel_rate - a.own_cancel_rate)[0] || emps[0];
  if (topCanceler) {
    obs.push([
      'Top Cancellation Rate',
      `${topCanceler.name} cancels ${topCanceler.own_cancel_rate}% of their ${topCanceler.actions.toLocaleString()} real actions (${topCanceler.cancelled.toLocaleString()} orders) — the highest rate on the team.`,
    ]);
  }
  obs.push([
    'Pending Backlog',
    `${T.pending.toLocaleString()} orders sit in Pending (${teamPending}% of actions) — a queue that was absent from the HR summary.`,
  ]);

  const half = Math.floor(daily.length / 2) || 1;
  const fh = daily.slice(0, half).reduce((s, x) => s + x.cancel_pct, 0) / half;
  const sh = daily.slice(-half).reduce((s, x) => s + x.cancel_pct, 0) / half;
  obs.push([
    'Cancellation Trend',
    `Daily cancellation rate is ${sh > fh ? 'rising' : 'easing'}: ${fh.toFixed(1)}% in the first half vs ${sh.toFixed(1)}% in the second.`,
  ]);
  obs.push([
    'Deduplication Impact',
    `Raw logs recorded each status change ~3×. Counting once per order+employee+status removed ${ded.removed_pct}% of rows, giving a true action count of ${T.actions.toLocaleString()}.`,
  ]);

  return {
    hr,
    daily,
    log_totals: T,
    dedup,
    team_cancel_rate: tcr,
    team_pending_rate: teamPending,
    employees: emps,
    insights,
    observations: obs,
    rankings,
    cancel_rate_rank,
    added_all_top: aa.slice(0, 15),
    added_cs: addedCS,
    added_noncs: addedNon,
    status_totals: {
      Printed: T.printed,
      Pending: T.pending,
      Processing: T.processing,
      Cancelled: T.cancelled,
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith('analyze.js')) {
  const logFile = process.argv[2] || 'sample_log.xlsx';
  const payload = buildPayload(logFile);
  fs.writeFileSync('data.json', JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`OK — ${payload.employees.length} agents, ${payload.log_totals.actions.toLocaleString()} real actions (removed ${payload.dedup.removed_pct}% duplicates). Wrote data.json`);
}
