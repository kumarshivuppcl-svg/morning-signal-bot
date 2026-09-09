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
  /* Ranked list first: it is the tab you actually read, and it must not be
     skipped if the much larger matrix render fails or times out. */
  renderTop_(day);
  const res = fetchCsv_(day);
  if (res) { render_(res, day, 'MATRIX'); return; }
  /* No snapshot for today yet (before 9:20, or a holiday). Wipe any leftover
     data from a previous day so yesterday's numbers are never mistaken for
     today's — reference columns are rebuilt on the first real snapshot. */
  clearStale_(day);
}

/* Draw the composite top 15 on the FIRST tab, so it is what opens.
   Returns false when no ranking exists for `day` yet. */
function renderTop_(day) {
  const r = UrlFetchApp.fetch(RAW + 'top15_' + day + '.csv?cb=' + Date.now(),
                              { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) { console.log('no ranking for ' + day); return false; }
  const rows = Utilities.parseCsv(r.getContentText());
  if (!rows || rows.length < 2) return false;

  /* Locate columns by NAME so a change in rank_top.py's column order cannot
     silently shift the values under the headings. */
  const h = {}; rows[0].forEach(function (n, i) { h[String(n).trim()] = i; });
  const need = ['Symbol', 'Rank', 'SCORE', 'VOL', 'OPT', 'OIC', 'GAP', 'OPN',
                'CHG', 'SOI', 'PCR', 'LEV', 'DLV', 'BUILD', 'SESS'];
  for (let i = 0; i < need.length; i++) {
    if (h[need[i]] === undefined) { console.log('ranking missing column ' + need[i]); return false; }
  }

  const HEAD = ['#', 'SYMBOL', 'SCORE', 'VOL x', 'OPT x', 'OI x', 'GAP %',
                'OPEN %', 'CHG %', 'sOI', 'PCR', 'LEV', 'DELIV Δ',
                'BUILD (day)', 'SESSION'];
  const out = [HEAD];
  const num = function (v) { const x = parseFloat(v); return isNaN(x) ? '' : x; };
  for (let i = 1; i < rows.length; i++) {
    const s = rows[i];
    out.push([num(s[h.Rank]), s[h.Symbol], num(s[h.SCORE]), num(s[h.VOL]),
              num(s[h.OPT]), num(s[h.OIC]), num(s[h.GAP]), num(s[h.OPN]),
              num(s[h.CHG]), num(s[h.SOI]), num(s[h.PCR]), num(s[h.LEV]),
              num(s[h.DLV]), s[h.BUILD], s[h.SESS]]);
  }

  const ss = book_();
  /* Write into Sheet1 - the tab that opens - rather than making you hunt for
     a new one. Falls back to the first tab, and only creates a tab if the
     book has neither. MATRIX is never overwritten. */
  let sh = ss.getSheetByName('Sheet1');
  if (!sh) {
    const first = ss.getSheets()[0];
    sh = (first && first.getName() !== 'MATRIX') ? first
                                                 : ss.insertSheet('TOP 15', 0);
  }
  sh.clear();

  sh.getRange(1, 1).setValue('TOP 15 OPPORTUNITIES   ' + day +
      '     ranked on 0.4 volume + 0.3 options + 0.3 OI, vs a 2-session baseline')
    .setFontWeight('bold').setFontSize(11);
  sh.getRange(2, 1).setValue('GAP% = open vs prev close   OPEN% = now vs '
      + 'today\'s open   CHG% = now vs prev close      BUILD reads the whole '
      + 'day, SESSION reads since the open - bold where they disagree')
    .setFontSize(9).setFontColor('#5F6368');

  const n = out.length, w = HEAD.length;
  const rng = sh.getRange(3, 1, n, w);
  rng.setValues(out);
  rng.setFontFamily('Roboto Mono').setFontSize(10);
  sh.getRange(3, 1, 1, w).setFontWeight('bold')
    .setBackground('#1F3864').setFontColor('#FFFFFF');

  sh.getRange(4, 3, n - 1, 1).setNumberFormat('0.000');   /* SCORE */
  sh.getRange(4, 4, n - 1, 6).setNumberFormat('0.00');    /* VOL..OPEN% */
  sh.getRange(4, 9, n - 1, 1).setNumberFormat('0.00');    /* CHG% */
  sh.getRange(4, 10, n - 1, 1).setNumberFormat('0.000');  /* sOI */
  sh.getRange(4, 11, n - 1, 2).setNumberFormat('0.00');   /* PCR, LEV */
  sh.getRange(4, 13, n - 1, 1).setNumberFormat('0.0');    /* DELIV */
  sh.getRange(4, 2, n - 1, 1).setFontWeight('bold');

  const stateColor = function (b) {
    return b === 'LONG BUILD'  ? '#137333' : b === 'SHORT BUILD' ? '#B3261E' :
           b === 'SHORT COVER' ? '#1A73E8' : '#B06000';
  };

  for (let i = 1; i < n; i++) {
    const row = out[i], at = 3 + i;
    /* GAP, OPEN and CHG each green or red by sign: the three together say
       whether a move is the gap, the session, or both. */
    [6, 7, 8].forEach(function (k) {
      if (row[k] !== '') {
        sh.getRange(at, k + 1).setFontColor(
          row[k] > 0 ? '#137333' : row[k] < 0 ? '#B3261E' : '#111111');
      }
    });
    /* Options far hotter than cash = positioning is happening in the
       derivatives; a low value on a big VOL is block or index flow. */
    if (row[3] !== '' && row[3] >= 2) sh.getRange(at, 4).setFontWeight('bold');
    if (row[4] !== '' && row[4] >= 2) sh.getRange(at, 5).setFontWeight('bold');
    if (row[11] !== '' && row[11] >= 2) sh.getRange(at, 12).setFontWeight('bold');

    const bDay = String(row[13]), bSess = String(row[14]);
    sh.getRange(at, 14).setFontColor(stateColor(bDay));
    sh.getRange(at, 15).setFontColor(stateColor(bSess));
    /* The two frames disagreeing IS the signal - the day was built one way
       and the session is going the other. Bold it so it cannot be missed. */
    if (bDay && bSess && bDay !== bSess) {
      sh.getRange(at, 14, 1, 2).setFontWeight('bold');
    }
    if (i % 2 === 0) sh.getRange(at, 1, 1, w).setBackground('#F1F3F4');
  }

  sh.setFrozenRows(3);
  sh.setFrozenColumns(2);
  sh.setColumnWidth(1, 34);
  sh.setColumnWidth(2, 106);
  for (let c = 3; c <= 13; c++) sh.setColumnWidth(c, 58);
  sh.setColumnWidth(14, 104);
  sh.setColumnWidth(15, 104);
  console.log('TOP 15 rendered for ' + day);
  return true;
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
  renderTop_(day);
  const res = fetchCsv_(day);
  if (res) render_(res, day, 'MATRIX'); else clearStale_(day);
}

/* Draw only the ranked list - fastest way to see today's opportunities. */
function topOnly() { renderTop_(istToday()); }

/* Run this if the tab stays blank. It reports each step separately so the
   failing one is obvious, instead of a silent no-op. */
function testTop() {
  const day = istToday();
  console.log('1. IST date used: ' + day);

  if (!SHEET_ID || SHEET_ID.indexOf('PASTE') === 0) {
    console.log('2. STOP - SHEET_ID is still the placeholder. Copy your Sheet '
              + 'ID from its URL, the part between /d/ and /edit');
    return;
  }
  let ss;
  try { ss = book_(); } catch (e) { console.log('2. STOP - ' + e.message); return; }
  console.log('2. opened book: "' + ss.getName() + '"');
  console.log('3. tabs present: '
            + ss.getSheets().map(function (s) { return s.getName(); }).join(', '));

  const url = RAW + 'top15_' + day + '.csv?cb=' + Date.now();
  const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  console.log('4. ranking file HTTP ' + r.getResponseCode() + '  ' + url);
  if (r.getResponseCode() !== 200) {
    console.log('   -> no ranking published for ' + day + ' yet. Before the '
              + 'first snapshot (9:20 IST), on a holiday, or the date is off.');
    return;
  }
  const rows = Utilities.parseCsv(r.getContentText());
  console.log('5. parsed ' + rows.length + ' lines; header: ' + rows[0].join(','));
  const ok = renderTop_(day);
  console.log('6. render returned ' + ok
            + (ok ? ' - look at the first tab' : ' - see the message above'));
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
