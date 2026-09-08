import XLSX from 'xlsx';
import fs from 'fs';

export function createExcelWorkbook(data) {
  const wb = XLSX.utils.book_new();
  const tot = data.log_totals;
  const hs = data.hr || {};
  const ded = data.dedup || {};
  const emp = data.employees || [];
  const tcr = data.team_cancel_rate || 0;

  // 1. Executive Summary
  const summaryRows = [
    ['CUSTOMER SERVICE — EXECUTIVE REPORT (DEDUPLICATED)'],
    [`Each status change counted once per order+employee+status. Removed ${(ded.removed || 0).toLocaleString()} duplicate rows (${ded.removed_pct || 0}% of raw).`],
    [],
    ['KEY PERFORMANCE INDICATORS', 'VALUE'],
    ['Total Real Actions', (tot.actions || 0).toLocaleString()],
    ['Raw Rows (before dedup)', (ded.raw_cs_status || 0).toLocaleString()],
    ['New Orders', (hs.tot_new || 0).toLocaleString()],
    ['Printed', (tot.printed || 0).toLocaleString()],
    ['Team Print Rate', `${tot.actions ? (tot.printed / tot.actions * 100).toFixed(1) : 0}%`],
    ['Pending', (tot.pending || 0).toLocaleString()],
    ['Team Pending Rate', `${data.team_pending_rate || 0}%`],
    ['Cancelled', (tot.cancelled || 0).toLocaleString()],
    ['Team Cancel Rate', `${tcr}%`],
    ['Alt Phones Added', (tot.alt || 0).toLocaleString()],
    ['Top Performer', emp[0]?.name || '-'],
    [],
    ['EXECUTIVE INSIGHTS'],
  ];

  if (data.insights) {
    data.insights.forEach(ins => summaryRows.push([`• ${ins}`]));
  }

  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary['!cols'] = [{ wch: 45 }, { wch: 25 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Executive Summary');

  // 2. Daily Trend
  const dailyHeaders = ['Date', 'Day', 'New Orders', 'Printed', 'Printed %', 'Cancelled', 'Cancel %'];
  const dailyRows = [dailyHeaders];
  (data.daily || []).forEach(d => {
    dailyRows.push([
      d.day,
      d.dow,
      d.new,
      d.printed,
      `${d.printed_pct}%`,
      d.cancel,
      `${d.cancel_pct}%`,
    ]);
  });
  const wsDaily = XLSX.utils.aoa_to_sheet(dailyRows);
  wsDaily['!cols'] = [{ wch: 14 }, { wch: 8 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, wsDaily, 'Daily Trend');

  // 3. Agent Scorecard
  const scoreHeaders = [
    'Rank', 'Employee', 'Total Actions', 'Printed', 'Print %', 'Pending', 'Pend %',
    'Processing', 'Cancelled', 'Cancel %', 'Alt Phone', 'Alt %', 'Added Orders',
    'Contribution %', 'Grade', 'Segment', 'Cancel Risk'
  ];
  const scoreRows = [scoreHeaders];
  emp.forEach(e => {
    scoreRows.push([
      e.rank,
      e.name,
      e.actions,
      e.printed,
      `${e.own_printed_rate}%`,
      e.pending,
      `${e.own_pending_rate}%`,
      e.processing,
      e.cancelled,
      `${e.own_cancel_rate}%`,
      e.alt,
      `${e.own_alt_rate}%`,
      e.added,
      `${e.contribution_pct}%`,
      e.grade,
      e.segment,
      e.cancel_risk,
    ]);
  });
  const wsScore = XLSX.utils.aoa_to_sheet(scoreRows);
  wsScore['!cols'] = [
    { wch: 8 }, { wch: 28 }, { wch: 14 }, { wch: 10 }, { wch: 10 },
    { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
    { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 8 },
    { wch: 18 }, { wch: 14 }
  ];
  XLSX.utils.book_append_sheet(wb, wsScore, 'Agent Scorecard');

  // 4. Cancellation Analysis
  const cancelHeaders = ['Rank', 'Employee', 'Total Actions', 'Cancelled', 'Own Cancel Rate %', '% of Team Cancels', 'Risk'];
  const cancelRows = [cancelHeaders];
  const cdf = [...emp].filter(e => e.cancelled > 0).sort((a, b) => b.own_cancel_rate - a.own_cancel_rate);
  cdf.forEach((e, idx) => {
    cancelRows.push([
      idx + 1,
      e.name,
      e.actions,
      e.cancelled,
      `${e.own_cancel_rate}%`,
      `${e.canc_share_pct}%`,
      e.cancel_risk,
    ]);
  });
  const wsCancel = XLSX.utils.aoa_to_sheet(cancelRows);
  wsCancel['!cols'] = [{ wch: 8 }, { wch: 28 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, wsCancel, 'Cancellation Analysis');

  // 5. Status Distribution
  const st = data.status_totals || {};
  const distRows = [
    ['Status', 'Count', 'Share %'],
    ['Printed', st.Printed || 0, `${tot.actions ? ((st.Printed || 0) / tot.actions * 100).toFixed(1) : 0}%`],
    ['Pending', st.Pending || 0, `${tot.actions ? ((st.Pending || 0) / tot.actions * 100).toFixed(1) : 0}%`],
    ['Processing', st.Processing || 0, `${tot.actions ? ((st.Processing || 0) / tot.actions * 100).toFixed(1) : 0}%`],
    ['Cancelled', st.Cancelled || 0, `${tot.actions ? ((st.Cancelled || 0) / tot.actions * 100).toFixed(1) : 0}%`],
  ];
  const wsDist = XLSX.utils.aoa_to_sheet(distRows);
  wsDist['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, wsDist, 'Status Distribution');

  return wb;
}

export function saveExcelFile(data, outputPath) {
  const wb = createExcelWorkbook(data);
  XLSX.writeFile(wb, outputPath);
}
