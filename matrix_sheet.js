/**
 * F&O MATRIX  —  Google Sheet
 *
 * HOW IT FITS TOGETHER
 *   GitHub publishes a fresh ranking and matrix every 10 minutes (verified:
 *   40 snapshots on 29-Sep, one every ~10 min). This script copies them in.
 *
 *   Sheet1       FORMULAS ONLY. It reads TOP15_DATA and recalculates by
 *                itself. Its status line uses NOW(), so the data's age keeps
 *                counting even when this script is NOT running -- a stopped
 *                trigger now shows up in red instead of looking like a quiet
 *                market.
 *   TOP15_DATA   the raw ranking, overwritten each refresh. Don't edit it.
 *   MATRIX       the full 10-minute matrix, all stocks.
 *
 * SETUP (once)
 *  1. SHEET_ID below = your Sheet URL, the part between /d/ and /edit.  Ctrl+S
 *  2. Run  setupSheet1     -> builds the formulas and colours on Sheet1
 *  3. Run  installTrigger  -> refreshNow every 10 minutes (approve the prompt)
 *  4. Run  testTop         -> confirms the trigger exists and data is fresh
 *
 * No GitHub token is needed any more: the GitHub workflow now collects on its
 * own schedule, so this script only reads public files.
 *
 * Past days:  loadDay('2026-09-04')
 */

const SHEET_ID = 'PASTE_YOUR_SHEET_ID_HERE';

const REPO = 'kumarshivuppcl-svg/morning-signal-bot';
const RAW  = 'https://raw.githubusercontent.com/' + REPO + '/master/data/';
const DATA_TAB = 'TOP15_DATA';
/* Raw numbers for the CALC page, one row per (stock, metric, time). The
   MATRIX tab shows text like "1,234 ▲" that formulas cannot use. */
const LONG_TAB = 'DATA_LONG';
const REF_TAB  = 'DATA_REF';
const CALC_TAB = 'CALC';
const CALC_HDR_ROW = 13;                    /* CALC: times on row 13, one indicator per row below */
const UP = ' ▲', DOWN = ' ▼', FLAT = '';

/* Sheet1 layout: title, live status, legend, header, then 15 data rows. */
const TOP_HDR_ROW = 4, TOP_FIRST = 5, TOP_ROWS = 15;
/* Where the refresh writes its bookkeeping on TOP15_DATA (clear of the CSV). */
const META = { day: 'AB1', snap: 'AB2', fetched: 'AB3' };

/* Display column -> ranking CSV header. Looked up BY NAME, so a change in
   rank_top.py's column order cannot put values under the wrong heading. */
const TOP_COLS = [
  ['#', 'Rank'], ['SYMBOL', 'Symbol'], ['SCORE', 'SCORE'], ['VOL x', 'VOL'],
  ['OPT x', 'OPT'], ['OI x', 'OIC'], ['GAP %', 'GAP'], ['OPEN %', 'OPN'],
  ['CHG %', 'CHG'], ['sOI', 'SOI'], ['vs VWAP', 'VWP'], ['CPR w%', 'DCW'],
  ['PCR', 'PCR'], ['LEV', 'LEV'], ['DELIV Δ', 'DLV'], ['dCPR', 'DCPR'],
  ['wCPR', 'WCPR'], ['BUILD (day)', 'BUILD'], ['SESSION', 'SESS']
];


/* ============================================================ refresh ===== */

/* The 10-minute job. Copies data in; Sheet1's formulas do the rest. */
function refreshNow() {
  const day = istToday();
  /* Ranking first: it is the tab you read, and it must not be skipped if the
     much larger matrix render is slow. */
  pullTop_(day);
  ensureSheet1_();
  const res = fetchCsv_(day);
  if (res) {
    pullLong_(day, res);           /* raw numbers first: the CALC page reads them */
    ensureCalc_();
    render_(res, day, 'MATRIX');
    return;
  }
  /* No snapshot yet today (before 9:20, or a holiday): blank MATRIX so an
     old day is never mistaken for today. Sheet1 keeps the last ranking, and
     its title shows which day that was. */
  clearStale_(day);
}

/* Redraw without waiting for the trigger. */
function pullOnly() { refreshNow(); }
function topOnly()  { pullTop_(istToday()); ensureSheet1_(); }

/* Copy today's ranking CSV into TOP15_DATA. On any failure the previous data
   is left in place -- and Sheet1's status line shows how old it is. */
function pullTop_(day) {
  const r = UrlFetchApp.fetch(RAW + 'top15_' + day + '.csv?cb=' + Date.now(),
                              { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) {
    console.log('no ranking for ' + day + ' (HTTP ' + r.getResponseCode() + ')');
    return false;
  }
  const rows = Utilities.parseCsv(r.getContentText());
  if (!rows || rows.length < 2) return false;

  /* Numbers as numbers, so the formulas and colour rules can compare them. */
  const w = Math.max.apply(null, rows.map(function (x) { return x.length; }));
  const vals = rows.map(function (row, i) {
    const out = [];
    for (let c = 0; c < w; c++) {
      const v = (row[c] === undefined ? '' : String(row[c]).trim());
      const n = Number(v);
      out.push(i > 0 && v !== '' && !isNaN(n) ? n : v);
    }
    return out;
  });

  const h = {}; rows[0].forEach(function (n, i) { h[String(n).trim()] = i; });
  const at = (h.AT !== undefined) ? String(rows[1][h.AT] || '').trim() : '';

  const ss = book_();
  const d = ss.getSheetByName(DATA_TAB) || ss.insertSheet(DATA_TAB);
  d.getRange('A1:Z60').clearContent();
  d.getRange(1, 1, vals.length, w).setValues(vals);
  d.getRange('AA1:AB3').setValues([
    ['Ranking day', Utilities.parseDate(day, 'Asia/Kolkata', 'yyyy-MM-dd')],
    ['Snapshot', at ? Utilities.parseDate(day + ' ' + at, 'Asia/Kolkata',
                                          'yyyy-MM-dd HH:mm') : ''],
    ['Fetched at', new Date()]
  ]);
  d.getRange('AB1').setNumberFormat('dd-mmm-yyyy');
  d.getRange('AB2:AB3').setNumberFormat('dd-mmm-yyyy hh:mm');
  console.log('ranking ' + day + ' snapshot ' + at + ' -> ' + DATA_TAB);
  return true;
}


/* ========================================================= raw numbers ===== */

/* Flatten the matrix CSV (and today's futures CSV, when the PC collector has
   published one) into DATA_LONG -- Symbol | Metric | Time | Value | Key --
   and the reference columns (PrevDay, Open, pivots, ...) into DATA_REF.
   Key = "SYMBOL|METRIC|TIME", so any formula can fetch one number with a
   single MATCH. Times are stored as TEXT ("09:20"): left as values, Sheets
   would turn them into time serials and every key lookup would miss. */
function pullLong_(day, matrixRows) {
  const longRows = [], refRows = [];
  const add = function (rows) {
    if (!rows || rows.length < 2) return;
    const head = rows[0].map(function (h) { return String(h).trim(); });
    for (let r = 1; r < rows.length; r++) {
      const sym = String(rows[r][0] || '').trim(), met = String(rows[r][1] || '').trim();
      if (!sym || !met) continue;
      for (let c = 2; c < head.length; c++) {
        const s = String(rows[r][c] === undefined ? '' : rows[r][c]).trim();
        if (s === '') continue;
        const n = Number(s), v = isNaN(n) ? s : n;
        const key = sym + '|' + met + '|' + head[c];
        (head[c].indexOf(':') > 0 ? longRows : refRows).push([sym, met, head[c], v, key]);
      }
    }
  };
  add(matrixRows);
  const fr = UrlFetchApp.fetch(RAW + 'fut_' + day + '.csv?cb=' + Date.now(),
                               { muteHttpExceptions: true });
  if (fr.getResponseCode() === 200) add(Utilities.parseCsv(fr.getContentText()));

  const ss = book_();
  [[LONG_TAB, longRows], [REF_TAB, refRows]].forEach(function (t) {
    const sh = ss.getSheetByName(t[0]) || ss.insertSheet(t[0]);
    sh.clearContents();
    const rows = [['Symbol', 'Metric', t[0] === LONG_TAB ? 'Time' : 'Field', 'Value', 'Key']]
                   .concat(t[1]);
    sh.getRange(1, 1, rows.length, 5).setNumberFormats(
      rows.map(function () { return ['@', '@', '@', 'General', '@']; }));
    sh.getRange(1, 1, rows.length, 5).setValues(rows);
    if (!sh.isSheetHidden()) sh.hideSheet();
  });
  console.log(LONG_TAB + ': ' + longRows.length + ' values,  ' + REF_TAB + ': '
              + refRows.length + ' reference values');
}


/* ================================================================ CALC ===== */

/* One page showing every step for ONE stock. B2 holds the stock; everything
   else is a formula reading DATA_LONG / DATA_REF and the yellow parameter
   cells, so changing a parameter recalculates the whole page.
   Safe to re-run; it rebuilds the page but keeps the chosen stock and any
   parameter values already typed in. */
function setupCalc() {
  const ss = book_();
  let sh = ss.getSheetByName(CALC_TAB);
  const keep = {};
  if (sh) {                                 /* preserve user choices */
    keep.sym = sh.getRange('B2').getValue();
    keep.params = sh.getRange('A5:C11').getValues();
  } else {
    sh = ss.insertSheet(CALC_TAB);
  }
  sh.clear();
  sh.clearConditionalFormatRules();
  sh.getRange('A:Z').setFontFamily('Arial').setFontSize(10);

  const top = top1Sheet_(ss);
  const L = "'" + LONG_TAB + "'!";
  const yellow = '#FFF2CC', head = '#1F3864';

  /* --- title, stock, back link ------------------------------------------ */
  sh.getRange('A1').setFormula('="STEP-BY-STEP CALCULATIONS    "&IF($B$2="","(pick a stock)",$B$2)')
    .setFontSize(13).setFontWeight('bold');
  sh.getRange('A2').setValue('Stock').setFontWeight('bold');
  sh.getRange('B2').setValue(keep.sym || '').setBackground(yellow).setFontWeight('bold')
    .setBorder(true, true, true, true, false, false);
  sh.getRange('C2').setValue('click a stock name on TOP 15 or MATRIX, or pick from the list')
    .setFontColor('#5F6368').setFontSize(9);
  sh.getRange('H2').setFormula('=HYPERLINK("#gid=' + top.getSheetId() + '","<- back to TOP 15")');

  /* --- parameters --------------------------------------------------------- */
  sh.getRange('A4').setValue('PARAMETERS  -  edit the yellow cells; every formula below reads them')
    .setFontWeight('bold');
  const params = keep.params || [['RSI period', 14, 'number of 10-minute bars, Wilder smoothing  (name: RSI_PERIOD)']];
  if (!keep.params) {
    for (let i = 1; i < 7; i++) params.push(['', '', '']);
  }
  sh.getRange('A5:C11').setValues(params);
  sh.getRange('B5:B11').setBackground(yellow).setHorizontalAlignment('center');
  sh.getRange('C5:C11').setFontColor('#5F6368').setFontSize(9);
  ss.setNamedRange('RSI_PERIOD', sh.getRange('B5'));

  /* --- one row per indicator, snapshot times across (like MATRIX) -------- */
  /* (cond)*(cond) FILTER form: same result in Sheets and in Excel if downloaded */
  const pick = function (col) {
    return 'FILTER(' + L + '$' + col + ':$' + col + ',(' + L + '$A:$A=$B$2)*('
           + L + '$B:$B="PRICE"))';
  };
  const h = CALC_HDR_ROW;
  sh.getRange(h, 1).setValue('Time');
  sh.getRange(h, 2).setFormula('=IFERROR(TRANSPOSE(' + pick('C') + '),"")');
  sh.getRange(h + 1, 1).setFormula('="RSI ("&RSI_PERIOD&")"');
  /* Wilder RSI on the 10-minute PRICE, N = RSI_PERIOD:
     first average = simple mean of the first N moves, then
     avg = (previous avg x (N-1) + this move) / N;  RSI = 100 - 100/(1+avgGain/avgLoss). */
  sh.getRange(h + 1, 2).setFormula('=IFERROR(LET(px,' + pick('D') + ',per,RSI_PERIOD,'
    + 'idx,SEQUENCE(ROWS(px)),'
    + 'gain,MAP(idx,LAMBDA(k,IF(k=1,0,MAX(INDEX(px,k)-INDEX(px,k-1),0)))),'
    + 'loss,MAP(idx,LAMBDA(k,IF(k=1,0,MAX(INDEX(px,k-1)-INDEX(px,k),0)))),'
    + 'avgG,SCAN(0,idx,LAMBDA(a,k,IF(k<=per,0,IF(k=per+1,SUMPRODUCT((idx<=per+1)*gain)/per,'
    + '(a*(per-1)+INDEX(gain,k))/per)))),'
    + 'avgL,SCAN(0,idx,LAMBDA(a,k,IF(k<=per,0,IF(k=per+1,SUMPRODUCT((idx<=per+1)*loss)/per,'
    + '(a*(per-1)+INDEX(loss,k))/per)))),'
    + 'TRANSPOSE(MAP(idx,avgG,avgL,LAMBDA(k,g,l,IF(k<=per,"",IF(l=0,100,100-100/(1+g/l))))))),"")');

  /* --- look -------------------------------------------------------------- */
  sh.getRange(h, 1, 1, 60).setFontWeight('bold').setBackground(head).setFontColor('#FFFFFF')
    .setHorizontalAlignment('center');
  sh.getRange(h + 1, 1).setFontWeight('bold');
  sh.getRange(h + 1, 2, 1, 59).setNumberFormat('0.00').setHorizontalAlignment('center');
  sh.setColumnWidth(1, 150);
  for (let c = 2; c <= 60; c++) sh.setColumnWidth(c, 56);
  sh.setFrozenRows(2);
  sh.setFrozenColumns(1);

  setCalcSymbols_(sh);
  console.log('CALC built: RSI row (period in B5)');
}

/* Dropdown of every stock, so the page works even without the click script. */
function setCalcSymbols_(sh) {
  const ref = book_().getSheetByName(REF_TAB);
  if (!ref || ref.getLastRow() < 2) return;
  const seen = {}, list = [];
  ref.getRange(2, 1, ref.getLastRow() - 1, 1).getValues().forEach(function (r) {
    const s = String(r[0]).trim();
    if (s && !seen[s]) { seen[s] = 1; list.push(s); }
  });
  list.sort();
  sh.getRange('B2').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(list.slice(0, 500), true).setAllowInvalid(true).build());
}

function ensureCalc_() {
  const sh = book_().getSheetByName(CALC_TAB);
  if (!sh || sh.getRange(CALC_HDR_ROW + 1, 2).getFormula().indexOf('SCAN') < 0) setupCalc();
}


/* ============================================================== Sheet1 ===== */

function top1Sheet_(ss) {
  let sh = ss.getSheetByName('Sheet1');
  if (!sh) {
    const first = ss.getSheets()[0];
    sh = (first && first.getName() !== 'MATRIX' && first.getName() !== DATA_TAB)
           ? first : ss.insertSheet('TOP 15', 0);
  }
  return sh;
}

/* Build Sheet1 once. Everything on it is a formula or a colour RULE, so it
   updates on its own whenever TOP15_DATA changes. Safe to re-run. */
function setupSheet1() {
  const ss = book_();
  /* NOW() must count in IST, and recalculate every minute so the age of the
     data keeps moving even when no refresh happens. */
  ss.setSpreadsheetTimeZone('Asia/Kolkata');
  ss.setRecalculationInterval(SpreadsheetApp.RecalculationInterval.ON_CHANGE_AND_MINUTE);
  if (!ss.getSheetByName(DATA_TAB)) ss.insertSheet(DATA_TAB);

  const sh = top1Sheet_(ss);
  sh.clear();
  sh.clearConditionalFormatRules();

  const D = "'" + DATA_TAB + "'!";
  const day = D + '$' + META.day.replace(/(\d)/, '$$$1');
  const snap = D + '$' + META.snap.replace(/(\d)/, '$$$1');
  const got = D + '$' + META.fetched.replace(/(\d)/, '$$$1');
  const open = 'AND(WEEKDAY(NOW(),2)<=5,MOD(NOW(),1)>=TIME(9,20,0),'
             + 'MOD(NOW(),1)<=TIME(15,40,0))';

  sh.getRange('A1').setFormula(
    '="TOP 15 OPPORTUNITIES   "&IF(' + day + '="","",TEXT(' + day + ',"dd-mmm-yyyy"))'
    + '&"      ranked 0.4 volume + 0.3 options + 0.3 OI, vs a 2-session baseline"')
    .setFontWeight('bold').setFontSize(11);

  /* Two clocks. "data" = how old GitHub's snapshot is (the collector).
     "sheet refreshed" = when THIS script last ran (the trigger). If the second
     one climbs while the market is open, the trigger has stopped. */
  sh.getRange('A2').setFormula(
    '=IF(' + snap + '="","no ranking loaded yet - run topOnly",'
    + '"snapshot "&TEXT(' + snap + ',"hh:mm")'
    + '&"   ·   data "&TEXT(ROUND((NOW()-' + snap + ')*1440,0),"0")&" min old"'
    + '&"   ·   sheet refreshed "&TEXT(ROUND((NOW()-' + got + ')*1440,0),"0")&" min ago"'
    + '&IF(AND(' + open + ',(NOW()-' + got + ')*1440>25),'
    + '"      ***  SHEET NOT REFRESHING - run testTop  ***",'
    + 'IF(AND(' + open + ',(NOW()-' + snap + ')*1440>25),'
    + '"      ***  DATA STALE - collector is behind  ***","")))')
    .setFontSize(10);

  sh.getRange('A3').setValue(
    'Click a stock name to open its step-by-step calculations (CALC tab)   |   '
    + 'GAP% open vs prev close · OPEN% now vs today\'s open · CHG% now vs prev close'
    + '   |   BUILD = whole day, SESSION = since the open, bold where they disagree'
    + '   |   vs VWAP +above / -below   |   dCPR/wCPR price vs daily/weekly pivot range,'
    + ' CPR w% its width (bold = narrow, trending-day setup)')
    .setFontSize(9).setFontColor('#5F6368');

  /* Header + one spilling formula per column. */
  const hdr = TOP_COLS.map(function (c) { return c[0]; });
  sh.getRange(TOP_HDR_ROW, 1, 1, hdr.length).setValues([hdr])
    .setFontWeight('bold').setBackground('#1F3864').setFontColor('#FFFFFF')
    .setHorizontalAlignment('center');
  const block = D + '$A$2:$Z$' + (TOP_ROWS + 1);
  const heads = D + '$A$1:$Z$1';
  TOP_COLS.forEach(function (c, i) {
    sh.getRange(TOP_FIRST, i + 1).setFormula(
      '=ARRAYFORMULA(IFERROR(INDEX(' + block + ',0,MATCH("' + c[1] + '",'
      + heads + ',0)),""))');
  });

  const n = TOP_ROWS, R = function (col) { return sh.getRange(TOP_FIRST, col, n, 1); };
  const fmt = { 3: '0.000', 4: '0.00', 5: '0.00', 6: '0.000', 7: '0.00', 8: '0.00',
                9: '0.00', 10: '0.000', 11: '0.00', 12: '0.000', 13: '0.00',
                14: '0.00', 15: '0.0' };
  Object.keys(fmt).forEach(function (c) { R(Number(c)).setNumberFormat(fmt[c]); });
  sh.getRange(TOP_FIRST, 1, n, hdr.length).setFontFamily('Roboto Mono').setFontSize(10);
  /* Looks like a link: clicking it opens that stock's CALC page (needs the
     small click script attached to the sheet -- calc_click.gs). */
  R(2).setFontWeight('bold').setFontColor('#1155CC').setFontLine('underline');
  /* Zebra shading is plain formatting, not a rule: in Sheets only the first
     matching rule applies to a cell, so a shading rule would block the colours. */
  for (let i = 0; i < n; i += 2) {
    sh.getRange(TOP_FIRST + i + 1, 1, 1, hdr.length).setBackground('#F1F3F4');
  }

  /* Colour RULES -- these re-evaluate on every data change, no script needed. */
  const rules = [];
  const add = function (rng, f, font, bold) {
    let b = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(f).setRanges([rng]);
    if (font) b = b.setFontColor(font);
    if (bold) b = b.setBold(true);
    rules.push(b.build());
  };
  const L = function (col) {           /* column letter of the first data row */
    return '$' + String.fromCharCode(64 + col) + TOP_FIRST;
  };
  /* sign colours: GAP, OPEN, CHG, vs VWAP */
  [7, 8, 9, 11].forEach(function (c) {
    add(R(c), '=AND(ISNUMBER(' + L(c) + '),' + L(c) + '>0)', '#137333');
    add(R(c), '=AND(ISNUMBER(' + L(c) + '),' + L(c) + '<0)', '#B3261E');
  });
  /* 2x and above is worth seeing at a glance: VOL, OPT, LEV */
  [4, 5, 14].forEach(function (c) {
    add(R(c), '=AND(ISNUMBER(' + L(c) + '),' + L(c) + '>=2)', null, true);
  });
  /* narrow central pivot range */
  add(R(12), '=AND(ISNUMBER(' + L(12) + '),' + L(12) + '<0.3)', '#B06000', true);
  /* pivot zones */
  [16, 17].forEach(function (c) {
    add(R(c), '=' + L(c) + '="ABOVE"', '#137333');
    add(R(c), '=' + L(c) + '="BELOW"', '#B3261E');
  });
  /* build states -- the disagreeing version first, so it wins and goes bold */
  const states = [['LONG BUILD', '#137333'], ['SHORT BUILD', '#B3261E'],
                  ['SHORT COVER', '#1A73E8'], ['LONG UNWIND', '#B06000']];
  const dis = 'AND(' + L(18) + '<>"",' + L(19) + '<>"",' + L(18) + '<>' + L(19) + ')';
  [18, 19].forEach(function (c) {
    states.forEach(function (s) {
      add(R(c), '=AND(' + L(c) + '="' + s[0] + '",' + dis + ')', s[1], true);
    });
    states.forEach(function (s) { add(R(c), '=' + L(c) + '="' + s[0] + '"', s[1]); });
  });
  /* status line goes red when something has stopped */
  add(sh.getRange('A2'), '=ISNUMBER(FIND("***",$A$2))', '#B3261E', true);
  sh.setConditionalFormatRules(rules);

  sh.setFrozenRows(TOP_HDR_ROW);
  sh.setFrozenColumns(2);
  sh.setColumnWidth(1, 34);
  sh.setColumnWidth(2, 106);
  for (let c = 3; c <= 15; c++) sh.setColumnWidth(c, 58);
  sh.setColumnWidth(16, 62);
  sh.setColumnWidth(17, 62);
  sh.setColumnWidth(18, 104);
  sh.setColumnWidth(19, 104);
  ss.setActiveSheet(sh);
  ss.moveActiveSheet(1);
  console.log('Sheet1 built: ' + TOP_COLS.length + ' formula columns, '
              + rules.length + ' colour rules');
}

/* Rebuild Sheet1 only if its formulas are missing (first run, or overwritten). */
function ensureSheet1_() {
  const ss = book_();
  const f = top1Sheet_(ss).getRange(TOP_FIRST, 3).getFormula();
  if (f.indexOf(DATA_TAB) < 0) {
    console.log('Sheet1 has no formulas yet - building it');
    setupSheet1();
  }
}


/* ============================================================= trigger ===== */

/* Creates the 10-minute trigger in code, replacing any earlier ones -- so it
   cannot silently be missing, duplicated, or pointed at the wrong function. */
function installTrigger() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshNow') { ScriptApp.deleteTrigger(t); removed++; }
  });
  ScriptApp.newTrigger('refreshNow').timeBased().everyMinutes(10).create();
  console.log('removed ' + removed + ' old refreshNow trigger(s); installed one new '
              + 'every-10-minutes trigger');
  listTriggers_();
}

function listTriggers_() {
  const t = ScriptApp.getProjectTriggers();
  if (!t.length) { console.log('   NO TRIGGERS in this project'); return 0; }
  t.forEach(function (x) {
    console.log('   trigger -> ' + x.getHandlerFunction() + '  (' + x.getEventType() + ')');
  });
  return t.filter(function (x) { return x.getHandlerFunction() === 'refreshNow'; }).length;
}


/* ========================================================= diagnostics ===== */

/* Run if Sheet1 stops changing. Each step reports separately, so the broken
   one is obvious. */
function testTop() {
  const day = istToday();
  console.log('1. IST date: ' + day);
  if (!SHEET_ID || SHEET_ID.indexOf('PASTE') === 0) {
    console.log('2. STOP - SHEET_ID is still the placeholder'); return;
  }
  let ss;
  try { ss = book_(); } catch (e) { console.log('2. STOP - ' + e.message); return; }
  console.log('2. book: "' + ss.getName() + '"  timezone ' + ss.getSpreadsheetTimeZone());

  console.log('3. triggers in this project:');
  const n = listTriggers_();
  console.log(n === 1 ? '   OK - one refreshNow trigger'
            : n === 0 ? '   PROBLEM - no refreshNow trigger: run installTrigger'
            : '   PROBLEM - ' + n + ' refreshNow triggers: run installTrigger to reset');

  const r = UrlFetchApp.fetch(RAW + 'top15_' + day + '.csv?cb=' + Date.now(),
                              { muteHttpExceptions: true });
  console.log('4. ranking on GitHub: HTTP ' + r.getResponseCode()
            + (r.getResponseCode() === 200 ? '' : '  (none yet today - before 9:20 or a holiday)'));

  const d = ss.getSheetByName(DATA_TAB);
  if (!d) { console.log('5. no ' + DATA_TAB + ' tab yet - run refreshNow'); return; }
  const got = d.getRange(META.fetched).getValue(), snap = d.getRange(META.snap).getValue();
  const now = new Date();
  console.log('5. last refresh ' + (got ? Math.round((now - got) / 60000) + ' min ago' : 'never')
            + ';  data snapshot ' + (snap ? Math.round((now - snap) / 60000) + ' min old' : 'none'));

  const f = top1Sheet_(ss).getRange(TOP_FIRST, 3).getFormula();
  console.log('6. Sheet1 formulas: ' + (f.indexOf(DATA_TAB) >= 0 ? 'present'
            : 'MISSING - run setupSheet1'));
}

function loadDay(d) {
  const res = fetchCsv_(d);
  if (res) render_(res, d, 'MATRIX ' + d);
  else console.log('no archived data for ' + d);
}

function testConnection() {
  const ss = book_();
  console.log('Sheet OK: "' + ss.getName() + '"');
  const r = UrlFetchApp.fetch(RAW + 'matrix_' + istToday() + '.csv?cb=' + Date.now(),
                              { muteHttpExceptions: true });
  console.log('matrix HTTP ' + r.getResponseCode() +
              (r.getResponseCode() === 200
                 ? ' — ' + r.getContentText().length + ' bytes'
                 : ' — no snapshot recorded yet today'));
}


/* ============================================================== MATRIX ===== */

function book_() {
  if (!SHEET_ID || SHEET_ID.indexOf('PASTE') === 0) {
    throw new Error('Set SHEET_ID at the top — copy it from your Sheet URL ' +
                    'between /d/ and /edit');
  }
  return SpreadsheetApp.openById(SHEET_ID);
}

function fetchCsv_(day) {
  const res = UrlFetchApp.fetch(RAW + 'matrix_' + day + '.csv?cb=' + Date.now(),
                                { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  const rows = Utilities.parseCsv(res.getContentText());
  return (rows && rows.length >= 2) ? rows : null;
}

/* Blank the MATRIX tab when there is no data for `day` yet. */
function clearStale_(day) {
  const ss = book_();
  const sh = ss.getSheetByName('MATRIX');
  if (!sh) { console.log('nothing to clear'); return; }
  const stamp = sh.getRange(1, 1).getValue();
  if (String(stamp).indexOf(day) === 0) { console.log('already cleared for ' + day); return; }
  sh.clear();
  sh.getRange(1, 1).setValue(day + '  —  waiting for first snapshot (9:20 IST)')
    .setFontWeight('bold');
  console.log('cleared stale data, ready for ' + day);
}

function render_(rows, day, tabName) {
  const nCol = rows[0].length;
  /* Reference columns are every header WITHOUT a time in it. Derived from the
     file, because a hardcoded count went stale each time a column was added
     (it was still 7 when there were 12, so arrows ran across Open and the
     pivot levels as if they were snapshots). */
  let FIXED = 0;
  while (FIXED < nCol && String(rows[0][FIXED]).indexOf(':') < 0) FIXED++;
  /* Rows per stock, counted from the data for the same reason. */
  let BLOCK = 0;
  while (1 + BLOCK < rows.length && rows[1 + BLOCK][0] === rows[1][0]) BLOCK++;
  BLOCK = Math.max(BLOCK, 1);

  const out = [], colors = [];
  out.push(rows[0].slice());
  colors.push(rows[0].map(function () { return '#000000'; }));

  let lastSym = '';
  for (let r = 1; r < rows.length; r++) {
    const src = rows[r], line = [], col = [];
    for (let c = 0; c < nCol; c++) {
      const raw = (src[c] || '').trim();
      if (c === 0) {                         /* symbol shown once per block */
        line.push(raw === lastSym ? '' : raw);
        lastSym = raw;
        col.push('#111111');
        continue;
      }
      if (c < FIXED) { line.push(raw); col.push('#111111'); continue; }
      if (raw === '') { line.push(''); col.push('#000000'); continue; }
      const v = parseFloat(raw);
      if (isNaN(v)) { line.push(raw); col.push('#111111'); continue; }
      let prev = NaN;                         /* vs previous non-empty snapshot */
      for (let k = c - 1; k >= FIXED; k--) {
        const p = parseFloat((src[k] || '').trim());
        if (!isNaN(p)) { prev = p; break; }
      }
      let arrow = FLAT;
      if (!isNaN(prev)) arrow = v > prev ? UP : (v < prev ? DOWN : FLAT);
      line.push(fmt_(v) + arrow);
      col.push(arrow === UP ? '#137333' : arrow === DOWN ? '#B3261E' : '#111111');
    }
    out.push(line);
    colors.push(col);
  }

  const ss = book_();
  const sh = ss.getSheetByName(tabName) || ss.insertSheet(tabName);
  sh.clear();
  const rng = sh.getRange(1, 1, out.length, nCol);
  rng.setValues(out);
  rng.setFontColors(colors);
  rng.setFontFamily('Roboto Mono');
  rng.setFontSize(9);
  sh.getRange(1, 1, 1, nCol).setFontWeight('bold').setBackground('#1F3864')
    .setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(2);
  sh.setColumnWidth(1, 110);
  sh.setColumnWidth(2, 80);
  for (let r = 1; r < out.length; r += BLOCK) {
    if (((r - 1) / BLOCK) % 2 === 1) {
      sh.getRange(r + 1, 1, Math.min(BLOCK, out.length - r), nCol)
        .setBackground('#F1F3F4');
    }
  }
  console.log(tabName + ': ' + out.length + ' rows x ' + nCol + ' cols, '
              + FIXED + ' reference cols, ' + BLOCK + ' rows per stock');
}

/** ratios read best at 2dp; large raw counts get thousands separators. */
function fmt_(v) {
  if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString('en-IN');
  return v.toFixed(2);
}

function istToday() {
  const n = new Date();
  const i = new Date(n.getTime() + n.getTimezoneOffset() * 60000 + 5.5 * 3600000);
  const p = function (x) { return (x < 10 ? '0' : '') + x; };
  return i.getFullYear() + '-' + p(i.getMonth() + 1) + '-' + p(i.getDate());
}
