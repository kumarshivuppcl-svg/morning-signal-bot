/**
 * F&O Matrix Pinger  —  triggers the 10-minute data snapshot on GitHub.
 *
 * This is the ONLY job it does. No Telegram, no alerts — just data collection
 * for the Google Sheet.
 *
 * SETUP
 *  1. Paste your GitHub token into GH_TOKEN below (keep the quotes).
 *     Need a new one? github.com/settings/personal-access-tokens/new
 *       Repository access : Only select repositories -> morning-signal-bot
 *       Permissions       : Actions = Read and write
 *  2. Ctrl+S
 *  3. Run `testMatrix` once — the log should say "Execution completed".
 *  4. Triggers (clock icon) -> Add Trigger:
 *       tick | Time-driven | Minutes timer | Every 5 minutes
 *
 * Runs Mon-Fri only, 9:18-15:40 IST.
 */

const GH_TOKEN = 'PASTE_TOKEN_HERE';
const REPO     = 'shivuppcl/morning-signal-bot';
const BRANCH   = 'master';


function tick() {
  const ist = istNow();
  if (ist.getDay() === 0 || ist.getDay() === 6) return;      // weekends off
  const hm = ist.getHours() * 60 + ist.getMinutes();

  // F&O matrix snapshot — market hours only.
  if (hm >= 9 * 60 + 18 && hm <= 15 * 60 + 40) dispatch('matrix.yml');
}


function dispatch(workflowFile) {
  const url = 'https://api.github.com/repos/' + REPO +
              '/actions/workflows/' + workflowFile + '/dispatches';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + GH_TOKEN,
      'Accept': 'application/vnd.github+json',
    },
    payload: JSON.stringify({ ref: BRANCH }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 204) {          // 204 = accepted
    console.error(workflowFile + ' -> HTTP ' + res.getResponseCode() + ' ' +
                  res.getContentText().slice(0, 200));
  }
}


function istNow() {
  const now = new Date();
  return new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 5.5 * 3600000);
}


/** Manual test — run this from the toolbar to confirm the token works. */
function testMatrix() { dispatch('matrix.yml'); }
