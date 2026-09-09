/**
 * F&O MATRIX  —  Google Sheet renderer
 *
 * Pulls the 10-minute matrix from GitHub and renders it:
 *   8 rows per script (price, cash vol, F&O vol/OI, call vol/OI, put vol/OI)
 *   every value an ABSOLUTE number. Ratios are yours to compute in-sheet:
 *   a time cell divided by that row's PrevDay is the headline ratio, and
 *   having the raw figures means PCR, skew and the rest are one division too.
 *
 * NOTE: cumulative rows (the volume ones) only ever rise, so the cell-vs-cell
 * arrow on them is always up and carries no information. It is meaningful on
 * the OI rows, which move both ways.
 *
 * SETUP
 *  1. Copy your Sheet ID from its URL, between /d/ and /edit
 *  2. Paste it into SHEET_ID below (keep the quotes), Ctrl+S
 *  3. Run `testConnection` -> then `refreshNow`
 *  4. Triggers (clock) -> refreshNow | Time-driven | Minutes | Every 10 minutes
 *
 * Past days:  loadDay('2026-09-04')
 */

const SHEET_ID = 'PASTE_YOUR_SHEET_ID_HERE';
const GH_TOKEN = 'PASTE_TOKEN_HERE';      /* now works - you own the repo */

const REPO = 'kumarshivuppcl-svg/morning-signal-bot';
const RAW  = 'https://raw.githubusercontent.com/' + REPO + '/master/data/';
const UP = ' ▲', DOWN = ' ▼', FLAT = '';
/* Symbol, Metric, PrevDay, PrevDay2, PrevLastHr, DelivPct, DelivPctPrev */
const FIXED = 7;
const BLOCK = 8;   /* rows per stock - keep in step with METRICS */


/* Fires a fresh collection on GitHub, then pulls the latest CSV in.
   Because collection takes ~2 minutes, the pull shows the PREVIOUS snapshot —
   so each 10-minute run collects now and displays the last one. Your Google
   trigger therefore drives the whole system; GitHub's own cron is just backup. */
function refreshNow() {
  collect_();
  const day = istToday();
  const res = fetchCsv_(day);
  if (res) { render_(res, day, 'MATRIX'); return; }
  /* No snapshot for today yet (before 9:20, or a holiday). Wipe any leftover
     data from a previous day so yesterday's numbers are never mistaken for
     today's — reference columns are rebuilt on the first real snapshot. */
  clearStale_(day);
}

/* Ask GitHub to run a snapshot now. Non-fatal: if the token is missing or
   rejected, we simply carry on and display whatever data already exists. */
function collect_() {
  if (!GH_TOKEN || GH_TOKEN.indexOf('PASTE') === 0) {
    console.log('no token set - display only, no fresh collection');
    return;
  }
  const ist = istNow_();
  if (ist.getDay() === 0 || ist.getDay() === 6) return;
  const hm = ist.getHours() * 60 + ist.getMinutes();
  if (hm < 558 || hm > 940) { console.log('outside market hours'); return; }

  const res = UrlFetchApp.fetch(
    'https://api.github.com/repos/' + REPO + '/actions/workflows/matrix.yml/dispatches',
    { method: 'post', contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + GH_TOKEN,
                 'Accept': 'application/vnd.github+json' },
      payload: JSON.stringify({ ref: 'master' }),
      muteHttpExceptions: true });
  console.log(res.getResponseCode() === 204
    ? 'snapshot triggered'
    : 'trigger failed HTTP ' + res.getResponseCode() + ' ' +
      res.getContentText().slice(0, 120));
}

function istNow_() {
  const n = new Date();
  return new Date(n.getTime() + n.getTimezoneOffset() * 60000 + 19800000);
}

/* Pull only, no collection - use when you just want to redraw the sheet. */
function pullOnly() {
  const day = istToday();
  const res = fetchCsv_(day);
  if (res) render_(res, day, 'MATRIX'); else clearStale_(day);
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

/* Blank the MATRIX tab when there is no data for `day` yet, leaving a clear
   note. Keeps the sheet honest at the start of every trading day. */
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
  const out = [], colors = [];

  // header
  out.push(rows[0].slice());
  colors.push(rows[0].map(() => '#000000'));

  let lastSym = '';
  for (let r = 1; r < rows.length; r++) {
    const src = rows[r], line = [], col = [];
    for (let c = 0; c < nCol; c++) {
      let raw = (src[c] || '').trim();
      if (c === 0) {                         /* symbol shown once per block */
        const shown = (raw === lastSym) ? '' : raw;
        lastSym = raw;
        line.push(shown);
        col.push('#111111');
        continue;
      }
      /* Reference columns are absolute prior-session figures now, not ratios,
         so the >1 green / <1 red tint no longer means anything here. */
      if (c < FIXED) {
        line.push(raw);
        col.push('#111111');
        continue;
      }
      if (raw === '') { line.push(''); col.push('#000000'); continue; }
      const v = parseFloat(raw);
      if (isNaN(v)) { line.push(raw); col.push('#111111'); continue; }

      // arrow vs the previous non-empty time cell in this row
      let prev = NaN;
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
  let sh = ss.getSheetByName(tabName) || ss.insertSheet(tabName);
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

  // alternate shading per stock block so stocks read as groups
  for (let r = 1; r < out.length; r += BLOCK) {
    if (((r - 1) / BLOCK) % 2 === 1) {
      sh.getRange(r + 1, 1, Math.min(BLOCK, out.length - r), nCol)
        .setBackground('#F1F3F4');
    }
  }
  console.log(tabName + ': ' + out.length + ' rows x ' + nCol + ' cols');
}


/** ratios read best at 2dp; large raw counts get thousands separators. */
function fmt_(v) {
  if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString('en-IN');
  return v.toFixed(2);
}

function istToday() {
  const n = new Date();
  const i = new Date(n.getTime() + n.getTimezoneOffset() * 60000 + 5.5 * 3600000);
  const p = x => (x < 10 ? '0' : '') + x;
  return i.getFullYear() + '-' + p(i.getMonth() + 1) + '-' + p(i.getDate());
}
