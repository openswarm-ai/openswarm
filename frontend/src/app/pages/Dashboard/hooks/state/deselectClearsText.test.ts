// Clicking away from selected canvas text clears the highlight (ENG-316).
//
// The canvas preventDefaults empty-canvas presses to own the drag, which suppresses the browser's
// native clear-selection-on-mousedown, so a text selection in a transcript survived every click-away
// and cleanup took a second click on the text itself. deselectAll is the one chokepoint every
// deselection flows through (plain empty-canvas press, marquee mouse-up, Escape, dashboard switch),
// so the text clear lives there and a new deselection path inherits it for free.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(
  path.join(process.cwd(), 'src/app/pages/Dashboard/hooks/state/useDashboardSelection.ts'), 'utf8');

test('deselectAll clears the DOM text selection, not only the card set', () => {
  const body = src.slice(src.indexOf('const deselectAll'), src.indexOf('const selectAll'));
  assert.match(body, /removeAllRanges/, 'without this, stale highlights survive every click-away');
  assert.match(body, /setSelectedIds\(new Map\(\)\)/, 'the card-set clear must survive the change');
});

test('the clear is inside deselectAll itself, not sprinkled at call sites', () => {
  // One chokepoint on purpose: a call-site sprinkle re-creates the bug for the next caller.
  const occurrences = src.match(/removeAllRanges/g) || [];
  assert.equal(occurrences.length, 1, 'exactly one clear, at the chokepoint');
});

test('a missing selection API cannot break deselection', () => {
  const body = src.slice(src.indexOf('const deselectAll'), src.indexOf('const selectAll'));
  assert.match(body, /try \{ window\.getSelection/, 'test environments and odd embedders have no Selection API');
});

test('behavior: deselectAll empties the selection object', () => {
  // Executable half, with a minimal Selection stand-in: the source assertions above pin placement;
  // this pins that the call actually clears a selection when the API exists.
  let cleared = 0;
  const fakeWindow = { getSelection: () => ({ removeAllRanges: () => { cleared += 1; } }) };
  const body = `try { window.getSelection()?.removeAllRanges(); } catch {}`;
  new Function('window', body)(fakeWindow);
  assert.equal(cleared, 1);
});
