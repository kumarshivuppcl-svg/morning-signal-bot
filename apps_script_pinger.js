/* F&O Matrix Pinger - triggers the 10-minute data snapshot on GitHub.
   SETUP: 1) paste your GitHub token into GH_TOKEN below, keeping the quotes.
          2) Ctrl+S  3) Run testMatrix  4) Triggers: tick, Time-driven,
             Minutes timer, Every 5 minutes.
   Runs Mon-Fri only, 9:18-15:40 IST. No Telegram, data collection only. */

const GH_TOKEN = 'PASTE_TOKEN_HERE';
const REPO     = 'shivuppcl/morning-signal-bot';
const BRANCH   = 'master';

function tick() {
  const ist = istNow();
  if (ist.getDay() === 0 || ist.getDay() === 6) return;
  const hm = ist.getHours() * 60 + ist.getMinutes();
  if (hm >= 558 && hm <= 940) dispatch('matrix.yml');
}

function dispatch(workflowFile) {
  const url = 'https://api.github.com/repos/' + REPO + '/actions/workflows/' + workflowFile + '/dispatches';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + GH_TOKEN, 'Accept': 'application/vnd.github+json' },
    payload: JSON.stringify({ ref: BRANCH }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 204) {
    console.error(workflowFile + ' -> HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  } else {
    console.log(workflowFile + ' dispatched OK');
  }
}

function istNow() {
  const now = new Date();
  return new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 19800000);
}

function testMatrix() { dispatch('matrix.yml'); }
