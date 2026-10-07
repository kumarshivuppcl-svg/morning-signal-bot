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
const CALC_FIRST = 16, CALC_ROWS = 60;      /* data rows on CALC: 16..75 */
const CALC_METRICS = ['PRICE', 'VWAP', 'CASH VOL', 'F&O VOL', 'F&O OI', 'CALL VOL',
                      'CALL OI', 'PUT VOL', 'PUT OI', 'FUT VOL', 'FUT OI', 'FUT PRICE'];
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
    try { ruleTab_(day, res); } catch (e) { console.log('RULE tab failed: ' + e.message); }
    try { ensureBlocks_(); } catch (e) { console.log('BLOCKS tab failed: ' + e.message); }
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

/* Weekends and holidays: load the most recent trading day that has data into
   TOP 15, MATRIX and CALC (refreshNow deliberately loads only TODAY). Run it
   by hand; the 10-minute trigger keeps calling refreshNow. */
function showLastDay() {
  const t = new Date();
  for (let i = 0; i < 10; i++) {
    const d = Utilities.formatDate(new Date(t.getTime() - i * 86400000), 'Asia/Kolkata', 'yyyy-MM-dd');
    const res = fetchCsv_(d);
    if (!res) continue;
    pullTop_(d);
    ensureSheet1_();
    pullLong_(d, res);
    ensureCalc_();
    try { ruleTab_(d, res); } catch (e) { console.log('RULE tab failed: ' + e.message); }
    try { ensureBlocks_(); } catch (e) { console.log('BLOCKS tab failed: ' + e.message); }
    render_(res, d, 'MATRIX');
    console.log('showing ' + d);
    return;
  }
  console.log('no data in the last 10 days');
}
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
  /* The data's own date, so CALC counts days to expiry from the snapshot
     day rather than from whenever the sheet is opened. */
  refRows.push(['_ALL', 'DAY', 'Date', day, '_ALL|DAY|Date']);
  /* NSE F&O holidays (saved by the collector), as real dates so NETWORKDAYS
     can skip them when counting trading days to expiry. */
  const hr = UrlFetchApp.fetch(RAW + 'holidays.csv?cb=' + Date.now(), { muteHttpExceptions: true });
  if (hr.getResponseCode() === 200) {
    Utilities.parseCsv(hr.getContentText()).slice(1).forEach(function (h) {
      const iso = String(h[0] || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
        refRows.push(['_ALL', 'HOLIDAY', iso,
                      Utilities.parseDate(iso, 'Asia/Kolkata', 'yyyy-MM-dd'), '_ALL|HOLIDAY|' + iso]);
      }
    });
  }
  /* Last ~30 completed sessions' high/low/close (collector, once a day) for
     True Range and ATR on CALC. SESSION rows list the dates, oldest first. */
  const dr = UrlFetchApp.fetch(RAW + 'daily.csv?cb=' + Date.now(), { muteHttpExceptions: true });
  if (dr.getResponseCode() === 200) {
    const dv = Utilities.parseCsv(dr.getContentText());
    const dh = dv[0].map(function (x) { return String(x).trim(); });
    const iS = dh.indexOf('Symbol'), iD = dh.indexOf('Date'), iH = dh.indexOf('High'),
          iL = dh.indexOf('Low'), iC = dh.indexOf('Close');
    const dates = {};
    dv.slice(1).forEach(function (x) {
      const sy = String(x[iS] || '').trim(), dt = String(x[iD] || '').trim();
      if (!sy || !dt) return;
      dates[dt] = 1;
      [['DAILY H', iH], ['DAILY L', iL], ['DAILY C', iC]].forEach(function (m) {
        const v = Number(x[m[1]]);
        if (!isNaN(v)) refRows.push([sy, m[0], dt, v, sy + '|' + m[0] + '|' + dt]);
      });
    });
    Object.keys(dates).sort().forEach(function (dt) {
      refRows.push(['_ALL', 'SESSION', dt, dt, '_ALL|SESSION|' + dt]);
    });
  }
  const fr = UrlFetchApp.fetch(RAW + 'fut_' + day + '.csv?cb=' + Date.now(),
                               { muteHttpExceptions: true });
  if (fr.getResponseCode() === 200) add(Utilities.parseCsv(fr.getContentText()));

  const ss = book_();
  [[LONG_TAB, longRows], [REF_TAB, refRows]].forEach(function (t) {
    const sh = ss.getSheetByName(t[0]) || ss.insertSheet(t[0]);
    sh.clearContents();
    const rows = [['Symbol', 'Metric', t[0] === LONG_TAB ? 'Time' : 'Field', 'Value', 'Key']]
                   .concat(t[1]);
    /* Room for every row, then text format by WHOLE COLUMN (one call each):
       a per-cell format array for ~66,000 rows timed out ("Service
       Spreadsheets timed out"). Text keeps 09:20 and the keys as typed. */
    if (sh.getMaxRows() < rows.length) sh.insertRowsAfter(sh.getMaxRows(), rows.length - sh.getMaxRows());
    sh.getRange('A:C').setNumberFormat('@');
    sh.getRange('E:E').setNumberFormat('@');
    /* Written in blocks, each its own call, so no single call is too large. */
    const BLOCK_ROWS = 10000;
    for (let i = 0; i < rows.length; i += BLOCK_ROWS) {
      const part = rows.slice(i, i + BLOCK_ROWS);
      sh.getRange(i + 1, 1, part.length, 5).setValues(part);
      SpreadsheetApp.flush();
    }
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
    keep.params = sh.getRange('A5:C13').getValues();
  } else {
    sh = ss.insertSheet(CALC_TAB);
  }
  sh.clear();
  sh.clearConditionalFormatRules();
  sh.getRange('A:Z').setFontFamily('Arial').setFontSize(10);

  const top = top1Sheet_(ss);
  const L = "'" + LONG_TAB + "'!", R = "'" + REF_TAB + "'!";
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
  /* One slot per parameter, each with a range name the formulas use. A value
     already typed in a slot is kept on rebuild; an empty slot gets the default. */
  /* [range name, label, default, note, earlier label]. The earlier label lets
     a rebuild recognise a slot saved under the old short name and keep its value. */
  const PARAMS = [
    ['RSI_PERIOD', 'Relative Strength Index period', 14,
     'number of 10-minute bars, Wilder smoothing  (name: RSI_PERIOD)', 'RSI period'],
    ['OI_EMA', 'Open Interest moving average period', 9,
     'exponential moving average of the Net / Call / Put change in open interest, 10-minute bars  (name: OI_EMA)',
     'OI EMA period'],
    ['PX_EMA', 'Price moving average period', 20,
     'exponential moving average of the 10-minute price  (name: PX_EMA)', 'Price EMA period'],
    ['FLAT_BAND', 'Flat band %', 0.1,
     'price within this % of its moving average = consolidating  (name: FLAT_BAND)', 'Flat band %'],
    ['PIN_BAND', 'Pin band %', 1,
     'price within this % of the Pin Strike = at the pin  (name: PIN_BAND)', 'Pin band %'],
    ['GEX_MIN', 'Gamma exposure minimum %', 3,
     'gamma exposure below this % of the previous day cash volume = too small to matter  (name: GEX_MIN)',
     'GEX minimum %'],
    ['ATR_PERIOD', 'Average True Range period', 14,
     'daily sessions, Wilder smoothing, at most 30  (name: ATR_PERIOD)', 'ATR period'],
    ['CPR_NARROW', 'Central Pivot Range narrow %', 0.25,
     'daily Central Pivot Range width at or below this % of the pivot = NARROW (trend day)  (name: CPR_NARROW)',
     'CPR narrow %'],
    ['CPR_WIDE', 'Central Pivot Range wide %', 0.75,
     'daily Central Pivot Range width at or above this % of the pivot = WIDE (range day)  (name: CPR_WIDE)',
     'CPR wide %']
  ];
  const params = [];
  for (let i = 0; i < 9; i++) {
    const old = keep.params ? keep.params[i] : ['', '', ''];
    const def = PARAMS[i];
    if (def && (old[0] === '' || old[0] === def[1] || old[0] === def[4])) {
      params.push([def[1], old[1] === '' ? def[2] : old[1], def[3]]);
    } else {
      params.push(old);
    }
  }
  sh.getRange('A5:C13').setValues(params);
  sh.getRange('B5:B13').setBackground(yellow).setHorizontalAlignment('center');
  sh.getRange('C5:C13').setFontColor('#5F6368').setFontSize(9);
  PARAMS.forEach(function (p, i) { ss.setNamedRange(p[0], sh.getRange('B' + (5 + i))); });

  /* --- reference values --------------------------------------------------- */
  const ref = function (metric, field) {
    return '=IFERROR(INDEX(' + R + '$D:$D,MATCH($B$2&"|' + metric + '|' + field + '",'
           + R + '$E:$E,0)),"")';
  };
  sh.getRange('E4').setValue('REFERENCE  (yesterday and today\'s open)').setFontWeight('bold');
  const refs = [
    ['Previous Close',                                ref('PRICE', 'PrevDay'),     ''],
    ['Close of the Day Before',                       ref('PRICE', 'PrevDay2'),    ''],
    ['Today Open',                                    ref('PRICE', 'Open'),        ''],
    ['Daily Central Pivot Range  Top / Bottom',       ref('PRICE', 'dTC'),         ref('PRICE', 'dBC')],
    ['Weekly Central Pivot Range  Top / Bottom',      ref('PRICE', 'wTC'),         ref('PRICE', 'wBC')],
    ['Cash Volume  Previous Day / Day Before',        ref('CASH VOL', 'PrevDay'),  ref('CASH VOL', 'PrevDay2')],
    ['Delivery %  Previous Day / Day Before',         ref('CASH VOL', 'DelivPct'), ref('CASH VOL', 'DelivPctPrev')],
    ['Futures Volume / Open Interest  Previous Day',  ref('FUT VOL', 'PrevDay'),   ref('FUT OI', 'PrevDay')]
  ];
  refs.forEach(function (row, i) {
    sh.getRange(5 + i, 5).setValue(row[0]);
    sh.getRange(5 + i, 6).setFormula(row[1]);
    if (row[2]) sh.getRange(5 + i, 7).setFormula(row[2]);
  });
  sh.getRange('F5:G12').setNumberFormat('#,##0.00').setHorizontalAlignment('right');

  /* --- STEP 1: raw inputs, one row per 10-minute snapshot ----------------- */
  const f = CALC_FIRST, last = CALC_FIRST + CALC_ROWS - 1;
  sh.getRange(f - 2, 1).setValue('STEP 1  -  Raw inputs for this stock, every 10 minutes '
                                 + '(absolute numbers from NSE / Breeze)').setFontWeight('bold');
  const hdr1 = ['Time'].concat(CALC_METRICS);
  /* Full names in the header; the formulas carry the data keys themselves. */
  sh.getRange(f - 1, 1, 1, hdr1.length).setValues([['Time (10-minute snapshot)', 'Price',
    'Volume Weighted Average Price', 'Cash Volume (shares)', 'Futures + Options Volume (contracts)',
    'Futures + Options Open Interest (contracts)', 'Call Volume (ATM +/-5 strikes)',
    'Call Open Interest (ATM +/-5 strikes)', 'Put Volume (ATM +/-5 strikes)',
    'Put Open Interest (ATM +/-5 strikes)', 'Futures Volume (shares)',
    'Futures Open Interest (shares)', 'Futures Price']]);
  /* (cond)*(cond) form: same result in Sheets and in Excel if downloaded */
  sh.getRange(f, 1).setFormula('=IFERROR(FILTER(' + L + '$C:$C,(' + L + '$A:$A=$B$2)*('
                               + L + '$B:$B="PRICE")),"")');
  const raw = [];
  for (let r = f; r <= last; r++) {
    const line = [];
    for (let c = 2; c <= hdr1.length; c++) {
      const col = String.fromCharCode(64 + c);
      line.push('=IF($A' + r + '="","",IFERROR(INDEX(' + L + '$D:$D,MATCH($B$2&"|'
                + CALC_METRICS[c - 2] + '|"&$A' + r + ',' + L + '$E:$E,0)),""))');
    }
    raw.push(line);
  }
  sh.getRange(f, 2, CALC_ROWS, hdr1.length - 1).setFormulas(raw).setNumberFormat('#,##0.##');

  /* --- STEP 2: worked example, RSI on the 10-minute price ----------------- */
  /* Columns O..U. Wilder: first average = simple mean of the first N moves,
     then avg = (previous avg x (N-1) + this move) / N. N is RSI_PERIOD. */
  sh.getRange(f - 2, 15).setValue('STEP 2  -  Example: RSI(RSI_PERIOD) on the 10-minute PRICE '
                                  + '(change B5 and watch it recalculate)').setFontWeight('bold');
  sh.getRange(f - 1, 15, 1, 7).setValues([['Price Change', 'Gain', 'Loss', 'Average Gain',
    'Average Loss', 'Relative Strength (Average Gain / Average Loss)',
    'Relative Strength Index (RSI)']]);
  const rsi = [];
  for (let r = f; r <= last; r++) {
    const n = 'ROW()-' + f;                  /* moves seen so far at this row */
    if (r === f) { rsi.push(['', '', '', '', '', '', '']); continue; }
    const avg = function (src, me) {
      return '=IF($A' + r + '="","",IF(' + n + '<RSI_PERIOD,"",IF(' + n + '=RSI_PERIOD,'
        + 'AVERAGE(OFFSET($' + src + '$' + (f + 1) + ',0,0,RSI_PERIOD,1)),'
        + 'IF(' + src + r + '="",' + me + (r - 1) + ',(' + me + (r - 1)
        + '*(RSI_PERIOD-1)+' + src + r + ')/RSI_PERIOD))))';
    };
    rsi.push([
      '=IF(OR($B' + r + '="",$B' + (r - 1) + '=""),"",$B' + r + '-$B' + (r - 1) + ')',
      '=IF(O' + r + '="","",MAX(O' + r + ',0))',
      '=IF(O' + r + '="","",MAX(-O' + r + ',0))',
      avg('P', 'R'),
      avg('Q', 'S'),
      '=IF(OR(R' + r + '="",S' + r + '=""),"",IF(S' + r + '=0,"",R' + r + '/S' + r + '))',
      '=IF(OR(R' + r + '="",S' + r + '=""),"",IF(S' + r + '=0,100,100-100/(1+R' + r + '/S' + r + ')))'
    ]);
  }
  sh.getRange(f, 15, CALC_ROWS, 7).setFormulas(rsi).setNumberFormat('0.00');

  /* --- STEP 3: OI change, its EMAs, price EMA, setups -------------------- */
  /* Columns W..AK. OI comes from the FIXED-band rows (strikes around
     yesterday's close, same contracts all day): the ATM band in STEP 1 moves
     with spot, so its 10-minute change mixes band shifts with real writing.
     Price/VWAP come from the STEP 1 grid (B, C).
     EMA = alpha x value + (1 - alpha) x previous EMA, alpha = 2/(N+1),
     seeded with the simple average of the first N values (blank before). */
  const S3 = 23, S3N = 15;
  const cl = function (n) {                  /* 1 -> A, 27 -> AA */
    let s = '';
    for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
    return s;
  };
  const FC = cl(S3), FP = cl(S3 + 1),       /* fixed-band CALL / PUT OI */
        W = cl(S3 + 2), X = cl(S3 + 3), Y = cl(S3 + 4), Z = cl(S3 + 5), AA = cl(S3 + 6),
        AB = cl(S3 + 7), AC = cl(S3 + 8);
  const fixed = function (metric, r) {
    return '=IF($A' + r + '="","",IFERROR(INDEX(' + L + '$D:$D,MATCH($B$2&"|' + metric
           + '|"&$A' + r + ',' + L + '$E:$E,0)),""))';
  };
  sh.getRange(f - 2, S3).setValue('STEP 3  -  Change in OI, its EMA (OI_EMA), price EMA (PX_EMA) '
                                  + 'and the setups they define').setFontWeight('bold');
  sh.getRange(f - 1, S3, 1, S3N).setValues([['Call Open Interest (fixed band)',
    'Put Open Interest (fixed band)', 'Call Open Interest Change', 'Put Open Interest Change',
    'Net Open Interest Change (Put - Call)', 'Exponential Moving Average of Net Change',
    'Exponential Moving Average of Call Change', 'Exponential Moving Average of Put Change',
    'Exponential Moving Average of Price', 'Price Distance from VWAP %',
    'Price Distance from its Moving Average %', 'Net Change Crossing its Moving Average',
    'Alignment (Net Change vs Average, Price vs VWAP)', 'Setup', 'Hold Signal']]);
  /* EMA of column `src` whose values start on row `s0`, period named `p`. */
  const ema = function (src, me, s0, p, r) {
    const k = '(ROW()-' + (s0 - 1) + ')';          /* values seen so far */
    if (r < s0) return '';
    return '=IF($A' + r + '="","",IF(' + k + '<' + p + ',"",IF(' + k + '=' + p + ','
      + 'IFERROR(AVERAGE(OFFSET($' + src + '$' + s0 + ',0,0,' + p + ',1)),""),'
      + 'IF(' + src + r + '="",' + me + (r - 1) + ',IF(' + me + (r - 1) + '="","",'
      + src + r + '*2/(' + p + '+1)+' + me + (r - 1) + '*(1-2/(' + p + '+1)))))))';
  };
  const s3 = [];
  for (let r = f; r <= last; r++) {
    const q = r - 1, first = r === f;
    s3.push([
      fixed('CALL OI FIX', r),
      fixed('PUT OI FIX', r),
      first ? '' : '=IF(OR(' + FC + r + '="",' + FC + q + '=""),"",' + FC + r + '-' + FC + q + ')',
      first ? '' : '=IF(OR(' + FP + r + '="",' + FP + q + '=""),"",' + FP + r + '-' + FP + q + ')',
      first ? '' : '=IF(OR(' + W + r + '="",' + X + r + '=""),"",' + X + r + '-' + W + r + ')',
      ema(Y, Z, f + 1, 'OI_EMA', r),
      ema(W, AA, f + 1, 'OI_EMA', r),
      ema(X, AB, f + 1, 'OI_EMA', r),
      ema('B', AC, f, 'PX_EMA', r),
      '=IF(OR($B' + r + '="",$C' + r + '=""),"",($B' + r + '/$C' + r + '-1)*100)',
      '=IF(OR($B' + r + '="",' + AC + r + '=""),"",($B' + r + '/' + AC + r + '-1)*100)',
      /* Net OI change crossing its EMA (rule 1 trigger) */
      first ? '' : '=IF(OR(' + Y + r + '="",' + Z + r + '="",' + Y + q + '="",' + Z + q + '=""),"",'
        + 'IF(AND(' + Y + r + '>' + Z + r + ',' + Y + q + '<=' + Z + q + '),"CROSS UP",'
        + 'IF(AND(' + Y + r + '<' + Z + r + ',' + Y + q + '>=' + Z + q + '),"CROSS DOWN","")))',
      /* rule 1: Net OI chg vs its EMA, with price vs VWAP */
      '=IF(OR(' + Y + r + '="",' + Z + r + '="",$C' + r + '=""),"",'
        + 'IF(AND(' + Y + r + '>' + Z + r + ',$B' + r + '>$C' + r + '),"BULL",'
        + 'IF(AND(' + Y + r + '<' + Z + r + ',$B' + r + '<$C' + r + '),"BEAR","")))',
      /* table: price direction, price vs EMA, CE chg vs EMA, PE chg vs EMA */
      first ? '' : '=IF(OR(' + AC + r + '="",' + W + r + '="",' + AA + r + '="",' + X + r + '="",'
        + AB + r + '=""),"",IF(ABS($B' + r + '/' + AC + r + '-1)*100<=FLAT_BAND,"RANGE",'
        + 'IF(AND($B' + r + '>$B' + q + ',$B' + r + '>' + AC + r + ',' + W + r + '<' + AA + r + ','
        + X + r + '>' + AB + r + '),"LONG",'
        + 'IF(AND($B' + r + '<$B' + q + ',$B' + r + '<' + AC + r + ',' + W + r + '>' + AA + r + ','
        + X + r + '<' + AB + r + '),"SHORT",'
        + 'IF(AND($B' + r + '>$B' + q + ',$B' + r + '>' + AC + r + ',' + W + r + '>' + AA + r + ','
        + X + r + '<=' + AB + r + '),"TRAP",'
        + 'IF(AND($B' + r + '>$B' + q + ',' + X + r + '<' + AB + r + '),"NO BACKING",""))))))',
      /* rule 3: hold while price stays on its side of the EMA and writers defend */
      '=IF(OR(' + AC + r + '="",' + AA + r + '="",' + AB + r + '=""),"",'
        + 'IF(AND($B' + r + '>' + AC + r + ',' + X + r + '>' + AB + r + '),"HOLD LONG",'
        + 'IF(AND($B' + r + '<' + AC + r + ',' + W + r + '>' + AA + r + '),"HOLD SHORT","")))'
    ]);
  }
  sh.getRange(f, S3, CALC_ROWS, S3N).setFormulas(s3);
  sh.getRange(f, S3, CALC_ROWS, 8).setNumberFormat('#,##0;-#,##0');
  sh.getRange(f, S3 + 8, CALC_ROWS, 1).setNumberFormat('#,##0.00');
  sh.getRange(f, S3 + 9, CALC_ROWS, 2).setNumberFormat('0.00');
  sh.getRange(f, S3 + 11, CALC_ROWS, 4).setHorizontalAlignment('center').setFontWeight('bold');
  const tag = cl(S3 + 11) + f + ':' + cl(S3 + 14) + last;
  const cf = sh.getConditionalFormatRules();
  [['CROSS UP', '#137333'], ['BULL', '#137333'], ['LONG', '#137333'], ['HOLD LONG', '#137333'],
   ['CROSS DOWN', '#C5221F'], ['BEAR', '#C5221F'], ['SHORT', '#C5221F'], ['HOLD SHORT', '#C5221F'],
   ['TRAP', '#B06000'], ['NO BACKING', '#B06000'], ['RANGE', '#5F6368']].forEach(function (c) {
    cf.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(c[0]).setFontColor(c[1])
      .setRanges([sh.getRange(tag)]).build());
  });

  /* --- STEP 4: delta-weighted OI and gamma exposure ---------------------- */
  /* Collector rows, ATM +/-5 of the nearest expiry, all in SHARES:
     DOI = OI x delta (buyers' side); GEX = OI x gamma x price x 1% = shares a
     fully hedged writer trades per 1% move. Net GEX here is CALL - PUT (the
     US convention); which side NSE writers are on is not in the data. */
  const S4 = S3 + S3N + 1, S4N = 15;
  const C4 = function (i) { return cl(S4 + i); };
  sh.getRange(f - 2, S4).setValue('STEP 4  -  Delta-weighted OI (DOI) and gamma exposure (GEX), '
                                  + 'shares;  pin = GEX STRIKE').setFontWeight('bold');
  sh.getRange(f - 1, S4, 1, S4N).setValues([['Call Delta-Weighted Open Interest (shares)',
    'Put Delta-Weighted Open Interest (shares)', 'Net Delta-Weighted Open Interest (shares)',
    'Net Delta-Weighted Open Interest as % of Futures Open Interest',
    'Call Gamma Exposure (shares per 1% move)', 'Put Gamma Exposure (shares per 1% move)',
    'Total Gamma Exposure (shares per 1% move)', 'Net Gamma Exposure (Call - Put)',
    'Total Gamma Exposure as % of Previous Day Cash Volume', 'Pin Strike (most gamma)',
    'Price Distance from Pin Strike %', 'Gamma Reading', 'Expiry Date',
    'Calendar Days to Expiry', 'Trading Days to Expiry (excluding holidays)']]);
  /* A date may arrive as text (Excel) or already converted (Sheets). */
  const asDate = function (x) { return 'IF(ISNUMBER(' + x + '),' + x + ',DATEVALUE(' + x + '))'; };
  const dataDay = 'IFERROR(INDEX(' + "'" + REF_TAB + "'!" + '$D:$D,MATCH("_ALL|DAY|Date",'
                 + "'" + REF_TAB + "'!" + '$E:$E,0)),"")';
  const prevCash = 'IFERROR(INDEX(' + "'" + REF_TAB + "'!" + '$D:$D,MATCH($B$2&"|CASH VOL|PrevDay",'
                   + "'" + REF_TAB + "'!" + '$E:$E,0)),"")';
  const s4 = [];
  for (let r = f; r <= last; r++) {
    const c = function (i) { return C4(i) + r; };
    s4.push([
      fixed('CALL DOI', r),
      fixed('PUT DOI', r),
      '=IF(OR(' + c(0) + '="",' + c(1) + '=""),"",' + c(0) + '+' + c(1) + ')',
      '=IF(OR(' + c(2) + '="",N($L' + r + ')=0),"",' + c(2) + '/$L' + r + '*100)',
      fixed('CALL GEX', r),
      fixed('PUT GEX', r),
      '=IF(OR(' + c(4) + '="",' + c(5) + '=""),"",' + c(4) + '+' + c(5) + ')',
      '=IF(OR(' + c(4) + '="",' + c(5) + '=""),"",' + c(4) + '-' + c(5) + ')',
      '=IF(OR(' + c(6) + '="",N(' + prevCash + ')=0),"",' + c(6) + '/' + prevCash + '*100)',
      fixed('GEX STRIKE', r),
      '=IF(OR($B' + r + '="",N(' + c(9) + ')=0),"",($B' + r + '/' + c(9) + '-1)*100)',
      '=IF(' + c(8) + '="","",IF(' + c(8) + '<GEX_MIN,"GEX SMALL",'
        + 'IF(AND(' + c(10) + '<>"",ABS(N(' + c(10) + '))<=PIN_BAND),"AT PIN","")))',
      fixed('EXPIRY', r),
      /* calendar days from the snapshot day; 0 on expiry day */
      '=IF(OR(' + c(12) + '="",' + dataDay + '=""),"",IFERROR(' + asDate(c(12)) + '-'
        + asDate(dataDay) + ',""))',
      /* sessions after today up to and including expiry: weekends and NSE
         F&O holidays excluded (falls back to weekends only if no list) */
      '=IF(' + c(13) + '="","",IFERROR(NETWORKDAYS(' + asDate(dataDay) + ',' + asDate(c(12))
        + ',FILTER(' + "'" + REF_TAB + "'!" + '$D:$D,' + "'" + REF_TAB + "'!" + '$B:$B="HOLIDAY"))-1,'
        + 'IFERROR(NETWORKDAYS(' + asDate(dataDay) + ',' + asDate(c(12)) + ')-1,"")))'
    ]);
  }
  sh.getRange(f, S4, CALC_ROWS, S4N).setFormulas(s4);
  sh.getRange(f, S4, CALC_ROWS, 3).setNumberFormat('#,##0;-#,##0');
  sh.getRange(f, S4 + 3, CALC_ROWS, 1).setNumberFormat('0.0');
  sh.getRange(f, S4 + 4, CALC_ROWS, 4).setNumberFormat('#,##0;-#,##0');
  sh.getRange(f, S4 + 8, CALC_ROWS, 1).setNumberFormat('0.0');
  sh.getRange(f, S4 + 9, CALC_ROWS, 1).setNumberFormat('#,##0.##');
  sh.getRange(f, S4 + 10, CALC_ROWS, 1).setNumberFormat('0.00');
  sh.getRange(f, S4 + 11, CALC_ROWS, 1).setHorizontalAlignment('center').setFontWeight('bold');
  sh.getRange(f, S4 + 12, CALC_ROWS, 1).setNumberFormat('dd-mmm-yyyy').setHorizontalAlignment('center');
  sh.getRange(f, S4 + 13, CALC_ROWS, 2).setNumberFormat('0').setHorizontalAlignment('center');
  const tag4 = sh.getRange(C4(11) + f + ':' + C4(11) + last);
  cf.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('AT PIN').setFontColor('#B06000')
    .setRanges([tag4]).build());
  cf.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('GEX SMALL').setFontColor('#5F6368')
    .setRanges([tag4]).build());
  sh.setConditionalFormatRules(cf);

  /* --- STEP 5: range boundaries (price levels) -------------------------- */
  /* IV is NSE's ATM figure, annualised on CALENDAR days (that is how NSE's
     IV is computed), so moves scale with sqrt(days/365).
     Day high/low here come from the 10-minute snapshots, so they can miss a
     spike between snapshots. ATR is the latest value from STEP 6. */
  const S5 = S4 + S4N + 1, S5N = 17;
  const C5 = function (i) { return cl(S5 + i); };
  const DTE = cl(S4 + 13);                  /* STEP 4: days to expiry */
  const RF = "'" + REF_TAB + "'!";
  const refv = function (metric, field) {
    return 'IFERROR(INDEX(' + RF + '$D:$D,MATCH($B$2&"|' + metric + '|' + field + '",' + RF + '$E:$E,0)),"")';
  };
  const S6 = S5 + S5N + 1, S6N = 7, S6ROWS = 40;
  const C6 = function (i) { return cl(S6 + i); };
  const atrRng = '$' + C6(5) + '$' + f + ':$' + C6(5) + '$' + (f + S6ROWS - 1);
  const lastAtr = 'INDEX(' + atrRng + ',MAX(FILTER(ROW(' + atrRng + '),ISNUMBER(' + atrRng + ')))-'
                  + (f - 1) + ')';
  sh.getRange(f - 2, S5).setValue('STEP 5  -  Range boundaries: implied volatility, Average True Range, '
                                  + 'Central Pivot Range').setFontWeight('bold');
  sh.getRange(f - 1, S5, 1, S5N).setValues([[
    'ATM Implied Volatility (% a year)',
    'Expected One-Day Move (points)',
    'Implied Volatility Day Range - Upper (previous close + one-day move)',
    'Implied Volatility Day Range - Lower (previous close - one-day move)',
    'Expected Move to Expiry (points)',
    'Implied Volatility Expiry Range - Upper (price + move to expiry)',
    'Implied Volatility Expiry Range - Lower (price - move to expiry)',
    'Day High So Far (10-minute snapshots)',
    'Day Low So Far (10-minute snapshots)',
    'Average True Range (points, from STEP 6)',
    'Average True Range Day Range - Upper (day low + Average True Range)',
    'Average True Range Day Range - Lower (day high - Average True Range)',
    'Daily Central Pivot Range - Top',
    'Daily Central Pivot Range - Bottom',
    'Daily Central Pivot Range Type (Narrow / Normal / Wide)',
    'Weekly Central Pivot Range - Top',
    'Weekly Central Pivot Range - Bottom']]);
  const prevClose = refv('PRICE', 'PrevDay');
  const s5 = [];
  for (let r = f; r <= last; r++) {
    const c = function (i) { return C5(i) + r; };
    s5.push([
      fixed('ATM IV', r),
      '=IF(OR($B' + r + '="",' + c(0) + '=""),"",$B' + r + '*' + c(0) + '/100*SQRT(1/365))',
      '=IF(OR(' + c(1) + '="",N(' + prevClose + ')=0),"",' + prevClose + '+' + c(1) + ')',
      '=IF(OR(' + c(1) + '="",N(' + prevClose + ')=0),"",' + prevClose + '-' + c(1) + ')',
      '=IF(OR(' + c(1) + '="",' + DTE + r + '=""),"",$B' + r + '*' + c(0) + '/100*SQRT(MAX('
        + DTE + r + ',1)/365))',
      '=IF(' + c(4) + '="","",$B' + r + '+' + c(4) + ')',
      '=IF(' + c(4) + '="","",$B' + r + '-' + c(4) + ')',
      '=IF($B' + r + '="","",MAX($B$' + f + ':$B' + r + '))',
      '=IF($B' + r + '="","",MIN($B$' + f + ':$B' + r + '))',
      '=IF($B' + r + '="","",IFERROR(' + lastAtr + ',""))',
      '=IF(OR(' + c(8) + '="",N(' + c(9) + ')=0),"",' + c(8) + '+' + c(9) + ')',
      '=IF(OR(' + c(7) + '="",N(' + c(9) + ')=0),"",' + c(7) + '-' + c(9) + ')',
      '=IF($B' + r + '="","",' + refv('PRICE', 'dTC') + ')',
      '=IF($B' + r + '="","",' + refv('PRICE', 'dBC') + ')',
      /* width as % of the pivot decides the type; the thresholds are parameters */
      '=IF(OR(N(' + c(12) + ')=0,N(' + c(13) + ')=0),"",IF(ABS(' + c(12) + '-' + c(13) + ')/(('
        + c(12) + '+' + c(13) + ')/2)*100<=CPR_NARROW,"NARROW",IF(ABS(' + c(12) + '-' + c(13)
        + ')/((' + c(12) + '+' + c(13) + ')/2)*100>=CPR_WIDE,"WIDE","NORMAL")))',
      '=IF($B' + r + '="","",' + refv('PRICE', 'wTC') + ')',
      '=IF($B' + r + '="","",' + refv('PRICE', 'wBC') + ')'
    ]);
  }
  sh.getRange(f, S5, CALC_ROWS, S5N).setFormulas(s5);
  sh.getRange(f, S5, CALC_ROWS, 1).setNumberFormat('0.00');
  sh.getRange(f, S5 + 1, CALC_ROWS, 13).setNumberFormat('#,##0.00');
  sh.getRange(f, S5 + 14, CALC_ROWS, 1).setHorizontalAlignment('center').setFontWeight('bold');
  sh.getRange(f, S5 + 15, CALC_ROWS, 2).setNumberFormat('#,##0.00');
  const tag5 = sh.getRange(C5(14) + f + ':' + C5(14) + last);
  cf.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('WIDE').setFontColor('#137333')
    .setRanges([tag5]).build());
  cf.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('NARROW').setFontColor('#1A73E8')
    .setRanges([tag5]).build());

  /* --- STEP 6: daily True Range and ATR (last completed sessions) -------- */
  /* TR = max(High - Low, |High - prev Close|, |Low - prev Close|); the first
     session has no previous close, so TR = High - Low.
     ATR (Wilder): first value = simple average of the first ATR_PERIOD TRs,
     then ATR = (previous ATR x (N-1) + TR) / N. Rows run oldest -> newest. */
  sh.getRange(f - 2, S6).setValue('STEP 6  -  Daily True Range and ATR(ATR_PERIOD), oldest -> newest')
    .setFontWeight('bold');
  sh.getRange(f - 1, S6, 1, S6N).setValues([['Session Date', 'Day High', 'Day Low', 'Day Close',
    'True Range', 'Average True Range (Wilder)', 'Average True Range as % of Close']]);
  const s6 = [];
  for (let r = f; r < f + S6ROWS; r++) {
    const c = function (i) { return C6(i) + r; };
    const p = function (i) { return C6(i) + (r - 1); };
    const daily = function (m) {
      return '=IF(' + c(0) + '="","",IFERROR(INDEX(' + RF + '$D:$D,MATCH($B$2&"|' + m + '|"&'
        + c(0) + ',' + RF + '$E:$E,0)),""))';
    };
    const k = '(ROW()-' + (f - 1) + ')';
    s6.push([
      r === f ? '=IFERROR(FILTER(' + RF + '$C:$C,(' + RF + '$A:$A="_ALL")*(' + RF
        + '$B:$B="SESSION")),"")' : '',
      daily('DAILY H'), daily('DAILY L'), daily('DAILY C'),
      r === f
        ? '=IF(OR(' + c(1) + '="",' + c(2) + '=""),"",' + c(1) + '-' + c(2) + ')'
        : '=IF(OR(' + c(1) + '="",' + c(2) + '=""),"",IF(' + p(3) + '="",' + c(1) + '-' + c(2)
          + ',MAX(' + c(1) + '-' + c(2) + ',ABS(' + c(1) + '-' + p(3) + '),ABS(' + c(2) + '-'
          + p(3) + '))))',
      '=IF(' + c(0) + '="","",IF(' + k + '<ATR_PERIOD,"",IF(' + k + '=ATR_PERIOD,'
        + 'IFERROR(AVERAGE(OFFSET($' + C6(4) + '$' + f + ',0,0,ATR_PERIOD,1)),""),'
        + (r === f ? '""' : 'IF(' + c(4) + '="",' + p(5) + ',IF(' + p(5) + '="","",(' + p(5)
          + '*(ATR_PERIOD-1)+' + c(4) + ')/ATR_PERIOD))') + ')))',
      '=IF(OR(' + c(5) + '="",N(' + c(3) + ')=0),"",' + c(5) + '/' + c(3) + '*100)'
    ]);
  }
  sh.getRange(f, S6, S6ROWS, S6N).setFormulas(s6);
  sh.getRange(f, S6 + 1, S6ROWS, 5).setNumberFormat('#,##0.00');
  sh.getRange(f, S6 + 6, S6ROWS, 1).setNumberFormat('0.00');
  sh.getRange(f, S6 + 5, S6ROWS, 1).setFontWeight('bold');
  sh.setConditionalFormatRules(cf);
  const END = S6 + S6N - 1;

  /* --- look -------------------------------------------------------------- */
  [[f - 1, 1, hdr1.length], [f - 1, 15, 7], [f - 1, S3, S3N], [f - 1, S4, S4N],
   [f - 1, S5, S5N], [f - 1, S6, S6N]].forEach(function (h) {
    sh.getRange(h[0], h[1], 1, h[2]).setFontWeight('bold').setBackground(head)
      .setFontColor('#FFFFFF').setHorizontalAlignment('center').setWrap(true);
  });
  sh.getRange(f, 1, CALC_ROWS, 1).setFontWeight('bold');
  for (let i = 1; i < CALC_ROWS; i += 2) {
    sh.getRange(f + i, 1, 1, END).setBackground('#F1F3F4');
  }
  sh.getRange(f, 21, CALC_ROWS, 1).setFontWeight('bold');
  sh.setColumnWidth(1, 220);
  for (let c = 2; c <= END; c++) sh.setColumnWidth(c, 110);
  [S4 - 1, S5 - 1, S6 - 1].forEach(function (c) { sh.setColumnWidth(c, 18); });
  sh.setColumnWidth(14, 18);                /* gaps between the steps */
  sh.setColumnWidth(22, 18);
  for (let c = S3 + 11; c <= S3 + S3N - 1; c++) sh.setColumnWidth(c, 96);
  sh.setColumnWidth(5, 250);                /* reference labels sit in column E */
  sh.setFrozenRows(2);

  setCalcSymbols_(sh);
  console.log('CALC built: ' + PARAMS.length + ' parameters, ' + refs.length
              + ' reference values, ' + CALC_METRICS.length + ' raw columns, RSI, STEP 3');
}

/* Dropdown of every stock, so the page works even without the click script. */
function setCalcSymbols_(sh) {
  const ref = book_().getSheetByName(REF_TAB);
  if (!ref || ref.getLastRow() < 2) return;
  const seen = {}, list = [];
  ref.getRange(2, 1, ref.getLastRow() - 1, 1).getValues().forEach(function (r) {
    const s = String(r[0]).trim();
    if (s && s !== '_ALL' && !seen[s]) { seen[s] = 1; list.push(s); }
  });
  list.sort();
  sh.getRange('B2').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(list.slice(0, 500), true).setAllowInvalid(true).build());
}

function ensureCalc_() {
  const sh = book_().getSheetByName(CALC_TAB);
  if (!sh || sh.getRange(CALC_FIRST, 1).getFormula().indexOf(LONG_TAB) < 0) setupCalc();
}


/* ========================================================= YOUR RULE ===== */

/* The user's own decision rule, every stock, from the 10-minute matrix.
   Google has no futures-only OI, no single-strike OI and no 1-minute data, so
   (user's choice, 8 Oct) F&O OI stands in for futures OI, the fixed strike band
   (CALL / PUT OI FIX) for single strikes, and "price down + cash pace" for
   "cash selling dominates". BULL / BEAR CASE only when all 4 hold DEC_N bars
   in a row. Recomputed by refreshNow; settings are the yellow cells. */
const RULE_TAB = 'RULE';
const RULE_FIRST = 6;
const RULE_NAMES = ['Bull1 F&O OI down+price up', 'Bull2 above pivot top', 'Bull3 call OI (band) down+price up',
                    'Bull4 put OI (band) up', 'Bear1 F&O OI up+price down', 'Bear2 below prev low',
                    'Bear3 call OI (band) up', 'Bear4 price down+cash pace'];

function ruleTab_(day, rows) {
  const ss = book_();
  let sh = ss.getSheetByName(RULE_TAB);
  const fresh = !sh;
  if (fresh) sh = ss.insertSheet(RULE_TAB);
  /* settings: keep what the user typed */
  let decN = Number(sh.getRange('B2').getValue()), pace = sh.getRange('B3').getValue();
  if (!(decN >= 1)) decN = 3;
  pace = (pace === '' || isNaN(Number(pace))) ? 1.5 : Number(pace);

  /* previous session's low per stock (collector's daily.csv) */
  const low = {};
  const dr = UrlFetchApp.fetch(RAW + 'daily.csv?cb=' + Date.now(), { muteHttpExceptions: true });
  if (dr.getResponseCode() === 200) {
    const dv = Utilities.parseCsv(dr.getContentText());
    const h = dv[0].map(function (x) { return String(x).trim(); });
    const iS = h.indexOf('Symbol'), iD = h.indexOf('Date'), iL = h.indexOf('Low');
    dv.slice(1).forEach(function (x) {
      const s = String(x[iS] || '').trim(), d = String(x[iD] || '').trim(), v = Number(x[iL]);
      if (s && d < day && !isNaN(v) && (!low[s] || d > low[s].d)) low[s] = { d: d, v: v };
    });
  }

  const head = rows[0].map(function (x) { return String(x).trim(); });
  const T = [], col = {};
  head.forEach(function (x, i) { col[x] = i; if (x.indexOf(':') > 0) T.push(i); });
  const num = function (r, i) {
    if (!r) return NaN;
    const s = String(r[i] === undefined ? '' : r[i]).trim();
    return s === '' ? NaN : Number(s);
  };
  const by = {};
  rows.slice(1).forEach(function (r) {
    const s = String(r[0] || '').trim(), m = String(r[1] || '').trim();
    if (s) (by[s] = by[s] || {})[m] = r;
  });

  const out = [];
  let lastT = '';
  Object.keys(by).sort().forEach(function (s) {
    const M = by[s], P = M['PRICE'];
    const idx = T.filter(function (i) { return !isNaN(num(P, i)); });   /* snapshots with a price */
    if (idx.length < 2) return;
    const top = Math.max(num(P, col['dTC']), num(P, col['dBC']));
    const pl = low[s] ? low[s].v : NaN;
    const cash10 = [];
    const bars = [];
    for (let k = 1; k < idx.length; k++) {
      const j = idx[k], p = idx[k - 1];
      const d = function (m) { return num(M[m], j) - num(M[m], p); };
      const dP = d('PRICE'), dFO = d('F&O OI'), dC = d('CALL OI FIX'), dPt = d('PUT OI FIX');
      const c10 = d('CASH VOL');
      const earlier = cash10.filter(function (x) { return !isNaN(x); });
      const avg = earlier.length ? earlier.reduce(function (a, b) { return a + b; }, 0) / earlier.length : NaN;
      const pc = (avg > 0 && !isNaN(c10)) ? c10 / avg : NaN;
      cash10.push(c10);
      const px = num(P, j);
      const c = [dFO < 0 && dP > 0, px > top, dC < 0 && dP > 0, dPt > 0,
                 dFO > 0 && dP < 0, px < pl, dC > 0,
                 dP < 0 && (pace > 0 ? pc >= pace : c10 > 0)];
      bars.push({ t: head[j], px: px, c: c, bull: c[0] && c[1] && c[2] && c[3], bear: c[4] && c[5] && c[6] && c[7] });
    }
    const b = bars[bars.length - 1];
    const lastN = bars.slice(-decN);
    let dec = 'NONE';
    if (lastN.length >= decN && lastN.every(function (x) { return x.bull; })) dec = 'BULL CASE';
    else if (lastN.length >= decN && lastN.every(function (x) { return x.bear; })) dec = 'BEAR CASE';
    const yes = function (v) { return v ? 'YES' : ''; };
    const met = RULE_NAMES.filter(function (n, i) { return b.c[i]; }).join(' | ');
    out.push([s, b.t, b.px].concat(b.c.slice(0, 4).map(yes), [b.bull ? 'BULL' : ''],
                                     b.c.slice(4).map(yes), [b.bear ? 'BEAR' : '', dec, met]));
    if (b.t > lastT) lastT = b.t;
  });

  const H = ['Stock', 'Time', 'Price', 'Bull 1: F&O OI falls + price up', 'Bull 2: Price above daily pivot range top',
             'Bull 3: Call OI (fixed band) falls + price up', 'Bull 4: Put OI (fixed band) rises', 'BULL - this bar (all 4)',
             'Bear 1: F&O OI rises + price down', 'Bear 2: Price below previous day low',
             'Bear 3: Call OI (fixed band) rises', 'Bear 4: Price down + cash pace >= CASH_PACE', 'BEAR - this bar (all 4)',
             'DECISION (all 4 for DEC_N bars)', 'Conditions met this bar'];
  sh.getRange('A1').setValue('YOUR DECISION RULE  -  all F&O stocks  -  ' + day + '  ' + lastT
                             + '   (filter or sort the columns as you like)').setFontWeight('bold').setFontSize(12);
  sh.getRange('A2:C4').setValues([
    ['DEC_N', decN, 'BULL / BEAR CASE when all 4 conditions hold this many 10-minute bars in a row'],
    ['CASH_PACE', pace, 'Bear 4: this 10-min cash volume / average of today\'s earlier 10-min volumes (0 = any volume)'],
    ['', '', 'Google data: F&O OI (futures + options) in place of futures OI; fixed strike band (11 strikes around '
             + 'previous close) in place of single strikes; changes are vs the previous 10-minute snapshot. '
             + 'Settings apply at the next refresh.']]);
  sh.getRange('B2:B3').setBackground('#FFF2CC').setFontWeight('bold').setHorizontalAlignment('center');
  sh.getRange('C2:C4').setFontColor('#5F6368').setFontSize(9);
  sh.getRange(RULE_FIRST - 1, 1, 1, H.length).setValues([H]).setFontWeight('bold').setBackground('#7F6000')
    .setFontColor('#FFFFFF').setWrap(true).setVerticalAlignment('middle').setHorizontalAlignment('center');
  const last = Math.max(sh.getLastRow(), RULE_FIRST);
  sh.getRange(RULE_FIRST, 1, last - RULE_FIRST + 1, H.length).clearContent();
  if (out.length) {
    sh.getRange(RULE_FIRST, 1, out.length, H.length).setValues(out);
    sh.getRange(RULE_FIRST, 2, out.length, 1).setNumberFormat('@');
    sh.getRange(RULE_FIRST, 3, out.length, 1).setNumberFormat('#,##0.00');
  }
  if (fresh || sh.getConditionalFormatRules().length === 0) {
    const all = sh.getRange(RULE_FIRST, 4, 400, H.length - 3);
    const rule = function (txt, bg, font) {
      return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(txt).setBackground(bg)
        .setFontColor(font).setBold(true).setRanges([all]).build();
    };
    sh.setConditionalFormatRules([rule('BULL CASE', '#B7E1CD', '#137333'), rule('BEAR CASE', '#F4C7C3', '#B3261E'),
                                  rule('BULL', '#FFFFFF', '#137333'), rule('BEAR', '#FFFFFF', '#B3261E'),
                                  rule('YES', '#CEEFD9', '#000000')]);
    sh.setFrozenRows(RULE_FIRST - 1);
    sh.setFrozenColumns(1);
    sh.setRowHeight(RULE_FIRST - 1, 60);
    sh.setColumnWidth(1, 110);
    for (let c = 4; c <= 14; c++) sh.setColumnWidth(c, 86);
    sh.setColumnWidth(15, 420);
    sh.getRange(RULE_FIRST - 1, 1, 400, H.length).setFontFamily('Arial').setFontSize(9);
  }
  console.log('RULE: ' + out.length + ' stocks at ' + lastT + ' (DEC_N ' + decN + ', CASH_PACE ' + pace + ')');
}


/* ============================================================ BLOCKS ===== */

/* Blocks of N minutes (B3, multiple of 10) for one stock (B2; follows CALC's
   stock unless you type one). All formulas over DATA_LONG / DATA_REF. The first
   block starts from the previous day's close and OI. */
const BLOCKS_TAB = 'BLOCKS';
const BLK_FIRST = 7, BLK_ROWS = 40;

function setupBlocks() {
  const ss = book_();
  let sh = ss.getSheetByName(BLOCKS_TAB);
  let keepSym = '', keepSize = 30;
  if (sh) {
    keepSym = sh.getRange('B2').getFormula() || sh.getRange('B2').getValue();
    const z = Number(sh.getRange('B3').getValue());
    if (z >= 10) keepSize = z;
  } else {
    sh = ss.insertSheet(BLOCKS_TAB);
  }
  sh.clear();
  sh.clearConditionalFormatRules();
  sh.getRange('A:P').setFontFamily('Arial').setFontSize(10);
  const L = "'" + LONG_TAB + "'!", R = "'" + REF_TAB + "'!";
  const v = function (metric, tcell) {
    return 'IFERROR(INDEX(' + L + '$D:$D,MATCH($B$2&"|' + metric + '|"&' + tcell + ',' + L + '$E:$E,0)),"")';
  };
  const ref = function (metric) {
    return 'IFERROR(INDEX(' + R + '$D:$D,MATCH($B$2&"|' + metric + '|PrevDay",' + R + '$E:$E,0)),"")';
  };
  sh.getRange('A1').setFormula('="BLOCKS  -  "&$B$2&"  -  "&$B$3&"-minute blocks"').setFontWeight('bold').setFontSize(13);
  sh.getRange('A2').setValue('Stock');
  if (keepSym && String(keepSym).charAt(0) !== '=') sh.getRange('B2').setValue(keepSym);   /* a typed symbol stays */
  else sh.getRange('B2').setFormula("='" + CALC_TAB + "'!B2");
  sh.getRange('C2').setValue('follows the CALC stock; type a symbol here to pick another (delete it to follow CALC again: ='
                             + CALC_TAB + '!B2)');
  sh.getRange('A3').setValue('Block size (minutes)');
  sh.getRange('B3').setValue(keepSize);
  sh.getRange('C3').setValue('10, 20, 30, 60 ... (snapshots are every 10 minutes)');
  sh.getRange('B2:B3').setBackground('#FFF2CC').setFontWeight('bold');
  sh.getRange('C2:C3').setFontColor('#5F6368').setFontSize(9);
  sh.getRange('A4').setValue('Cash volume in shares; OI in contracts. F&O OI = futures + options. Call / Put OI = fixed band '
                             + 'of strikes around the previous close. A block is blank if its snapshot is missing.')
    .setFontColor('#5F6368').setFontSize(9);
  const H = ['From', 'To', 'Start price', 'End price', 'Price move %', 'Cash volume in block', 'Cash volume (day so far)',
             'F&O OI (end)', 'F&O OI change', 'F&O participants', 'Call OI band (end)', 'Call OI change',
             'Put OI band (end)', 'Put OI change', 'end minute'];
  sh.getRange(5, 1, 1, H.length).setValues([H]).setFontWeight('bold').setBackground('#1F3864')
    .setFontColor('#FFFFFF').setWrap(true).setHorizontalAlignment('center').setVerticalAlignment('middle');
  const f = [];
  const label = function (r) {
    return '=IF(OR($E' + r + '="",$I' + r + '=""),"",IF(AND($E' + r + '>0,$I' + r + '>0),"FRESH LONGS",IF(AND($E' + r
           + '>0,$I' + r + '<0),"SHORT COVERING",IF(AND($E' + r + '<0,$I' + r + '>0),"FRESH SHORTS",IF(AND($E' + r
           + '<0,$I' + r + '<0),"LONG UNWINDING","-")))))';
  };
  for (let n = 0; n < BLK_ROWS; n++) {
    const r = BLK_FIRST + n, p = r - 1, first = n === 0;
    const has = '$D' + r + '=""';
    const m = first ? '=CEILING(560,$B$3)' : '=IF($O' + p + '="","",IF($O' + p + '+$B$3>930,"",$O' + p + '+$B$3))';
    f.push([
      first ? '="09:15"' : '=IF($B' + r + '="","",$B' + p + ')',
      '=IF($O' + r + '="","",TEXT(INT($O' + r + '/60),"00")&":"&TEXT(MOD($O' + r + ',60),"00"))',
      '=IF(' + has + ',"",' + (first ? ref('PRICE') : '$D' + p) + ')',
      '=IF($B' + r + '="","",' + v('PRICE', '$B' + r) + ')',
      '=IF(OR($C' + r + '="",$D' + r + '=""),"",($D' + r + '/$C' + r + '-1)*100)',
      '=IF(OR(' + has + ',$G' + r + '=""),"",' + (first ? '$G' + r : 'IF($G' + p + '="","",$G' + r + '-$G' + p + ')') + ')',
      '=IF(' + has + ',"",' + v('CASH VOL', '$B' + r) + ')',
      '=IF(' + has + ',"",' + v('F&O OI', '$B' + r) + ')',
      '=IF(OR(' + has + ',$H' + r + '=""),"",' + (first ? 'IF(' + ref('F&O OI') + '="","",$H' + r + '-' + ref('F&O OI') + ')'
                                                         : 'IF($H' + p + '="","",$H' + r + '-$H' + p + ')') + ')',
      label(r),
      '=IF(' + has + ',"",' + v('CALL OI FIX', '$B' + r) + ')',
      '=IF(OR(' + has + ',$K' + r + '=""),"",' + (first ? 'IF(' + ref('CALL OI FIX') + '="","",$K' + r + '-' + ref('CALL OI FIX') + ')'
                                                         : 'IF($K' + p + '="","",$K' + r + '-$K' + p + ')') + ')',
      '=IF(' + has + ',"",' + v('PUT OI FIX', '$B' + r) + ')',
      '=IF(OR(' + has + ',$M' + r + '=""),"",' + (first ? 'IF(' + ref('PUT OI FIX') + '="","",$M' + r + '-' + ref('PUT OI FIX') + ')'
                                                         : 'IF($M' + p + '="","",$M' + r + '-$M' + p + ')') + ')',
      m
    ]);
  }
  sh.getRange(BLK_FIRST, 1, BLK_ROWS, H.length).setFormulas(f);
  /* whole day so far */
  const lastOf = function (c) {
    const rg = '$' + c + '$' + BLK_FIRST + ':$' + c + '$' + (BLK_FIRST + BLK_ROWS - 1);
    return 'IFERROR(INDEX(FILTER(' + rg + ',' + rg + '<>""),ROWS(FILTER(' + rg + ',' + rg + '<>""))),"")';
  };
  const sumOf = function (c) { return '=SUM(' + c + BLK_FIRST + ':' + c + (BLK_FIRST + BLK_ROWS - 1) + ')'; };
  sh.getRange(6, 1, 1, 14).setFormulas([[
    '="WHOLE DAY"', '=' + lastOf('B'), '=' + ref('PRICE'), '=' + lastOf('D'),
    '=IF(OR($C6="",$D6=""),"",($D6/$C6-1)*100)', sumOf('F'), '=' + lastOf('G'), '=' + lastOf('H'), sumOf('I'),
    '', '=' + lastOf('K'), sumOf('L'), '=' + lastOf('M'), sumOf('N')]]);
  sh.getRange(6, 1, 1, 14).setFontWeight('bold').setBackground('#F1F3F4');
  const all = function (c) { return sh.getRange(6, c, BLK_ROWS + 1, 1); };
  all(2).setNumberFormat('@');
  [3, 4].forEach(function (c) { all(c).setNumberFormat('#,##0.00'); });
  all(5).setNumberFormat('0.00;-0.00');
  [6, 7, 8, 11, 13].forEach(function (c) { all(c).setNumberFormat('#,##0'); });
  [9, 12, 14].forEach(function (c) { all(c).setNumberFormat('#,##0;-#,##0'); });
  const rules = [];
  const add = function (rng, f_, color) {
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(f_).setFontColor(color).setBold(true)
      .setRanges([rng]).build());
  };
  add(all(5), '=AND(ISNUMBER($E6),$E6>0)', '#137333');
  add(all(5), '=AND(ISNUMBER($E6),$E6<0)', '#B3261E');
  add(all(10), '=OR($J6="FRESH LONGS",$J6="SHORT COVERING")', '#137333');
  add(all(10), '=OR($J6="FRESH SHORTS",$J6="LONG UNWINDING")', '#B3261E');
  sh.setConditionalFormatRules(rules);
  sh.hideColumns(15);
  sh.setFrozenRows(6);
  sh.setRowHeight(5, 45);
  for (let c = 1; c <= 14; c++) sh.setColumnWidth(c, c === 10 ? 120 : 92);
  setCalcSymbols_(sh);
  console.log('BLOCKS built: ' + BLK_ROWS + ' block rows');
}

function ensureBlocks_() {
  const sh = book_().getSheetByName(BLOCKS_TAB);
  if (!sh || sh.getRange(BLK_FIRST, 4).getFormula().indexOf(LONG_TAB) < 0) setupBlocks();
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
  /* Both are conveniences, not requirements, and Google sometimes refuses
     them ("Unexpected error while getting the method ... setRecalculation-
     Interval") -- so a refusal must not stop the build. The manual route is
     File > Settings: time zone (GMT+05:30) India, and Calculation >
     "On change and every minute". */
  try { ss.setSpreadsheetTimeZone('Asia/Kolkata'); }
  catch (e) { console.log('time zone not set (' + e.message + ') - set it in File > Settings'); }
  try { ss.setRecalculationInterval(SpreadsheetApp.RecalculationInterval.ON_CHANGE_AND_MINUTE); }
  catch (e) { console.log('recalculation not set (' + e.message + ') - File > Settings > '
                          + 'Calculation > On change and every minute'); }
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
    '="WATCH LIST  -  15 most active F&O stocks   "&IF(' + day + '="","",TEXT(' + day + ',"dd-mmm-yyyy"))'
    + '&"      NOT a buy/sell recommendation  -  ranked by activity only (0.4 volume + 0.3 options + 0.3 OI)"')
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
    'WATCH ONLY: this ranking has no proven edge (scorecard: it trailed the average F&O stock). '
    + 'Use it to choose what to watch, not what to trade.   |   '
    + 'Click a stock name to open its step-by-step calculations (CALC tab)   |   '
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
      /* Number(), not parseFloat(): parseFloat('2026-10-27') is 2026, which
         would print the EXPIRY row as a number. */
      const v = Number(raw);
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
