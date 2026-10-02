/**
 * Click a stock name -> open its step-by-step calculations.
 *
 * WHERE THIS GOES: in the Google Sheet itself -> Extensions -> Apps Script,
 * NOT in the refresh project. A click trigger only works in a script that is
 * attached to the sheet, and the refresh project is a separate one.
 *
 * Nothing to run or approve: onSelectionChange is a built-in trigger that
 * fires on every click. After saving, reload the sheet once.
 */
function onSelectionChange(e) {
  const r = e.range;
  if (r.getNumRows() !== 1 || r.getNumColumns() !== 1) return;
  const name = r.getSheet().getName();
  let sym = '';
  if (name === 'Sheet1' && r.getColumn() === 2 && r.getRow() >= 5) {
    sym = String(r.getValue()).trim();              /* TOP 15: SYMBOL column */
  } else if (name === 'MATRIX' && r.getColumn() === 1 && r.getRow() >= 2) {
    sym = String(r.getValue()).trim();              /* MATRIX: first column */
  }
  if (!sym) return;
  const calc = e.source.getSheetByName('CALC');
  if (!calc) return;
  calc.getRange('B2').setValue(sym);
  calc.activate();
}
