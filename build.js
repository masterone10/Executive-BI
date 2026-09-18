import fs from 'fs';
import path from 'path';
import { buildPayload } from './analyze.js';
import { saveExcelFile, createExcelWorkbook } from './export_excel.js';

const ROOT_DIR = process.cwd();
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

if (!fs.existsSync(PUBLIC_DIR)) {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

// 1. Copy xlsx.full.min.js from node_modules if present
const xlsxSrc = path.join(ROOT_DIR, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js');
const xlsxDst = path.join(PUBLIC_DIR, 'xlsx.full.min.js');
if (fs.existsSync(xlsxSrc)) {
  fs.copyFileSync(xlsxSrc, xlsxDst);
  console.log('Copied xlsx.full.min.js to public/');
}

// 2. Load or generate data.json
let payload;
const sampleLogPath = path.join(ROOT_DIR, 'sample_log.xlsx');
const dataJsonPath = path.join(ROOT_DIR, 'data.json');

if (fs.existsSync(dataJsonPath)) {
  console.log('Loading existing data.json ...');
  payload = JSON.parse(fs.readFileSync(dataJsonPath, 'utf-8'));
} else if (fs.existsSync(sampleLogPath)) {
  console.log('Parsing sample_log.xlsx ...');
  payload = buildPayload(sampleLogPath);
  fs.writeFileSync(dataJsonPath, JSON.stringify(payload, null, 2), 'utf-8');
} else {
  throw new Error('Neither sample_log.xlsx nor data.json found');
}

// 3. Generate Executive_Report_v3.xlsx in public
const excelReportPath = path.join(PUBLIC_DIR, 'Executive_Report_v3.xlsx');
saveExcelFile(payload, excelReportPath);
console.log('Generated public/Executive_Report_v3.xlsx');

// 4. Read template.html and inject payload & SheetJS
const templatePath = path.join(ROOT_DIR, 'template.html');
let html = fs.readFileSync(templatePath, 'utf-8');

// Replace XLSX lib placeholder
html = html.replace(
  '<!--XLSX_LIB_PLACEHOLDER-->',
  '<script src="/xlsx.full.min.js"></script>'
);

// Enhance buttons for Excel & PDF in top bar
html = html.replace(
  '<a class="btn" href="Executive_Report_v3.xlsx" download>⭳ Excel</a>',
  '<button class="btn" id="exportExcelBtn" onclick="exportCurrentExcel()">⭳ Excel</button>'
);
html = html.replace(
  '<a class="btn primary" href="Executive_Report_v3.pdf" download>⭳ PDF</a>',
  '<button class="btn primary" id="exportPdfBtn" onclick="window.print()">⭳ PDF / Print</button>'
);

// Add print stylesheet
const printStyles = `
<style media="print">
  @page { size: landscape; margin: 12mm; }
  .side, .top .actions, #importToast, #shareModal { display: none !important; }
  .main { margin-left: 0 !important; width: 100% !important; }
  .top { position: static !important; box-shadow: none !important; border: none !important; padding: 0 0 16px 0 !important; }
  .wrap { padding: 0 !important; }
  body { background: #fff !important; color: #000 !important; }
  .panel, .kpi, .prof { box-shadow: none !important; border: 1px solid #ccc !important; break-inside: avoid; }
</style>
`;
html = html.replace('</head>', `${printStyles}\n</head>`);

// Add exportCurrentExcel function
const exportScript = `
<script>
window.exportCurrentExcel = function() {
  if (typeof XLSX === 'undefined') {
    window.location.href = '/Executive_Report_v3.xlsx';
    return;
  }
  try {
    var wb = XLSX.utils.book_new();
    var tot = D.log_totals, hs = D.hr || {}, ded = D.dedup || {}, emp = D.employees || [];
    
    // Executive Summary
    var sRows = [
      ['CUSTOMER SERVICE — EXECUTIVE REPORT (DEDUPLICATED)'],
      ['Each status change counted once per order+employee+status. Removed ' + (ded.removed||0).toLocaleString() + ' duplicate rows (' + (ded.removed_pct||0) + '% of raw).'],
      [],
      ['KEY PERFORMANCE INDICATORS', 'VALUE'],
      ['Total Real Actions', (tot.actions||0).toLocaleString()],
      ['Raw Rows (before dedup)', (ded.raw_cs_status||0).toLocaleString()],
      ['New Orders', (hs.tot_new||0).toLocaleString()],
      ['Printed', (tot.printed||0).toLocaleString()],
      ['Team Print Rate', (tot.actions ? (tot.printed/tot.actions*100).toFixed(1) : 0) + '%'],
      ['Pending', (tot.pending||0).toLocaleString()],
      ['Team Pending Rate', (D.team_pending_rate||0) + '%'],
      ['Cancelled', (tot.cancelled||0).toLocaleString()],
      ['Team Cancel Rate', (D.team_cancel_rate||0) + '%'],
      ['Alt Phones Added', (tot.alt||0).toLocaleString()],
      ['Top Performer', emp[0] ? emp[0].name : '-'],
      [],
      ['EXECUTIVE INSIGHTS']
    ];
    if (D.insights) {
      D.insights.forEach(function(ins) { sRows.push(['• ' + ins]); });
    }
    var wsS = XLSX.utils.aoa_to_sheet(sRows);
    wsS['!cols'] = [{ wch: 45 }, { wch: 25 }];
    XLSX.utils.book_append_sheet(wb, wsS, 'Executive Summary');

    // Daily Trend
    var dRows = [['Date', 'Day', 'New Orders', 'Printed', 'Printed %', 'Cancelled', 'Cancel %']];
    (D.daily || []).forEach(function(d) {
      dRows.push([d.day, d.dow, d.new, d.printed, d.printed_pct + '%', d.cancel, d.cancel_pct + '%']);
    });
    var wsD = XLSX.utils.aoa_to_sheet(dRows);
    wsD['!cols'] = [{ wch: 14 }, { wch: 8 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, wsD, 'Daily Trend');

    // Scorecard
    var scRows = [['Rank', 'Employee', 'Total Actions', 'Printed', 'Print %', 'Pending', 'Pend %', 'Processing', 'Cancelled', 'Cancel %', 'Alt Phone', 'Alt %', 'Added Orders', 'Contribution %', 'Grade', 'Segment', 'Cancel Risk']];
    emp.forEach(function(e) {
      scRows.push([e.rank, e.name, e.actions, e.printed, e.own_printed_rate + '%', e.pending, e.own_pending_rate + '%', e.processing, e.cancelled, e.own_cancel_rate + '%', e.alt, e.own_alt_rate + '%', e.added, e.contribution_pct + '%', e.grade, e.segment, e.cancel_risk]);
    });
    var wsSc = XLSX.utils.aoa_to_sheet(scRows);
    wsSc['!cols'] = [{ wch: 8 }, { wch: 28 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 8 }, { wch: 18 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, wsSc, 'Agent Scorecard');

    // Cancellation
    var cRows = [['Rank', 'Employee', 'Total Actions', 'Cancelled', 'Own Cancel Rate %', '% of Team Cancels', 'Risk']];
    var cdf = emp.slice().filter(function(e) { return e.cancelled > 0; }).sort(function(a, b) { return b.own_cancel_rate - a.own_cancel_rate; });
    cdf.forEach(function(e, idx) {
      cRows.push([idx + 1, e.name, e.actions, e.cancelled, e.own_cancel_rate + '%', e.canc_share_pct + '%', e.cancel_risk]);
    });
    var wsC = XLSX.utils.aoa_to_sheet(cRows);
    wsC['!cols'] = [{ wch: 8 }, { wch: 28 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, wsC, 'Cancellation Analysis');

    // Status Distribution
    var st = D.status_totals || {};
    var distRows = [
      ['Status', 'Count', 'Share %'],
      ['Printed', st.Printed || 0, (tot.actions ? ((st.Printed || 0) / tot.actions * 100).toFixed(1) : 0) + '%'],
      ['Pending', st.Pending || 0, (tot.actions ? ((st.Pending || 0) / tot.actions * 100).toFixed(1) : 0) + '%'],
      ['Processing', st.Processing || 0, (tot.actions ? ((st.Processing || 0) / tot.actions * 100).toFixed(1) : 0) + '%'],
      ['Cancelled', st.Cancelled || 0, (tot.actions ? ((st.Cancelled || 0) / tot.actions * 100).toFixed(1) : 0) + '%'],
    ];
    var wsDist = XLSX.utils.aoa_to_sheet(distRows);
    wsDist['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, wsDist, 'Status Distribution');

    XLSX.writeFile(wb, 'Executive_Report.xlsx');
  } catch(err) {
    console.error('Export failed, falling back to static download:', err);
    window.location.href = '/Executive_Report_v3.xlsx';
  }
};
</script>
`;
html = html.replace('</body>', `${exportScript}\n</body>`);

// Replace __DATA_PLACEHOLDER__ with clean dynamic default state
const defaultInitialData = {
  exists: false,
  date: null,
  work_date: null,
  employees: [],
  log_totals: { actions: 0, printed: 0, pending: 0, processing: 0, cancelled: 0, alt: 0 },
  status_totals: { Printed: 0, Pending: 0, Processing: 0, Cancelled: 0 },
  hr: { days: 0, tot_new: 0, tot_printed: 0, tot_cancel: 0, tot_add: 0 },
  daily: [],
  rankings: { printed: [], pending: [], cancelled: [] },
  cancel_rate_rank: [],
  team_cancel_rate: 0,
  team_pending_rate: 0,
  addedOrders: { totalAdded: 0, totalAddedCS: 0, totalAddedNonCS: 0, fromCS: 0, fromOtherDepartments: 0, topCSContributors: [], allCSContributors: [] }
};
html = html.replace('__DATA_PLACEHOLDER__', JSON.stringify(defaultInitialData));

// Write public/index.html
fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), html, 'utf-8');
console.log('Successfully generated public/index.html');
