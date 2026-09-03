/**
 * NSE F&O Data Sheet — pulls the 5-minute volume + OI archive into tabs.
 *
 * SETUP
 *  1. Open your Google Sheet. Copy its ID from the address bar — the long
 *     string between /d/ and /edit :
 *       docs.google.com/spreadsheets/d/<<<THIS PART>>>/edit
 *  2. Paste it into SHEET_ID below (keep the quotes).
 *  3. Save (Ctrl+S) -> Run `refreshNow` -> approve permissions.
 *  4. Triggers (clock icon) -> Add Trigger:
 *       refreshNow | Time-driven | Minutes timer | Every 5 minutes
 *
 * Using openById means this works whether the script is bound to the Sheet
 * or is a standalone project.
 *
 * TABS: VOL RAW · VOL RATIO · OI RAW · OI RATIO · FNO LIST
 * Past days:  run  loadDay('2026-08-05')  to pull any archived date.
 */

const SHEET_ID = 'PASTE_YOUR_SHEET_ID_HERE';

const RAW = 'https://raw.githubusercontent.com/shivuppcl/morning-signal-bot/master/data/';


function refreshNow() {
  const ss = book_();
  const d  = istToday();
  pull_(ss, 'vol_raw_'   + d + '.csv', 'VOL RAW');
  pull_(ss, 'vol_ratio_' + d + '.csv', 'VOL RATIO');
  pull_(ss, 'oi_raw_'    + d + '.csv', 'OI RAW');
  pull_(ss, 'oi_ratio_'  + d + '.csv', 'OI RATIO');
  pull_(ss, 'fno_list.csv',            'FNO LIST');
  console.log('refreshNow finished');
}

/** Pull one archived date into its own dated tabs. */
function loadDay(dateStr) {
  const ss = book_();
  pull_(ss, 'vol_raw_'   + dateStr + '.csv', 'VOL RAW '   + dateStr);
  pull_(ss, 'vol_ratio_' + dateStr + '.csv', 'VOL RATIO ' + dateStr);
  pull_(ss, 'oi_raw_'    + dateStr + '.csv', 'OI RAW '    + dateStr);
  pull_(ss, 'oi_ratio_'  + dateStr + '.csv', 'OI RATIO '  + dateStr);
  console.log('loadDay ' + dateStr + ' finished');
}

/** One-click check that the ID and network both work. */
function testConnection() {
  const ss = book_();
  console.log('Sheet OK: "' + ss.getName() + '"');
  const res = UrlFetchApp.fetch(RAW + 'fno_list.csv?cb=' + Date.now(),
                                { muteHttpExceptions: true });
  console.log('GitHub HTTP ' + res.getResponseCode() +
              ' (200 = good), bytes ' + res.getContentText().length);
}


function book_() {
  if (!SHEET_ID || SHEET_ID.indexOf('PASTE') === 0) {
    throw new Error('Set SHEET_ID at the top of the script first — copy it ' +
                    'from your Sheet URL between /d/ and /edit');
  }
  return SpreadsheetApp.openById(SHEET_ID);
}

function pull_(ss, file, tabName) {
  let res;
  try {
    res = UrlFetchApp.fetch(RAW + file + '?cb=' + Date.now(),
                            { muteHttpExceptions: true });
  } catch (e) {
    console.log('fetch failed ' + file + ': ' + e);
    return;
  }
  if (res.getResponseCode() !== 200) {
    console.log('skip ' + file + ' -> HTTP ' + res.getResponseCode() +
                ' (no data recorded for that date yet)');
    return;
  }
  const rows = Utilities.parseCsv(res.getContentText());
  if (!rows || !rows.length) { console.log('empty ' + file); return; }

  let sh = ss.getSheetByName(tabName);
  if (!sh) sh = ss.insertSheet(tabName);
  sh.clear();
  sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  sh.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');

  if (tabName.indexOf('RATIO') > -1 && rows[0].length > 4 && rows.length > 1) {
    const rng  = sh.getRange(2, 5, rows.length - 1, rows[0].length - 4);
    const rule = SpreadsheetApp.newConditionalFormatRule()
      .setGradientMaxpointWithValue('#63BE7B', SpreadsheetApp.InterpolationType.NUMBER, '3')
      .setGradientMidpointWithValue('#FFEB84', SpreadsheetApp.InterpolationType.NUMBER, '2')
      .setGradientMinpointWithValue('#FFFFFF', SpreadsheetApp.InterpolationType.NUMBER, '1')
      .setRanges([rng]).build();
    sh.setConditionalFormatRules([rule]);
  }
  console.log(tabName + ': ' + rows.length + ' rows x ' + rows[0].length + ' cols');
}

function istToday() {
  const now = new Date();
  const ist = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 5.5 * 3600000);
  const p = n => (n < 10 ? '0' : '') + n;
  return ist.getFullYear() + '-' + p(ist.getMonth() + 1) + '-' + p(ist.getDate());
}
