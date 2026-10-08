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

// Replace XLSX lib placeholder with empty string (lazy loaded on demand)
html = html.replace(
  '<!--XLSX_LIB_PLACEHOLDER-->',
  ''
);

// Print stylesheet injection
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
