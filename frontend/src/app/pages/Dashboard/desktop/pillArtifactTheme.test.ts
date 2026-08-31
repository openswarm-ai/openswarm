import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ENG-419, second surface. A pill artifact forces the dark glass look with the CSS class
// "osw-artifact dark". That class only dresses the VENDORED tool-ui styles; every MUI control
// inside kept the app's light-mode text.primary, so on a light-mode app the AskUI free-text box
// painted rgb(26,26,24) on a dark panel: measured contrast ~1.07, i.e. invisible. Found live on
// the packaged 1.7.10-exp.1 candidate, 2026-08-30, with the exact box Eric screenshotted.
//
// The rule this pins is the one ENG-419 already paid for: a scope that overrides one theme source
// must override the other IN THE SAME PLACE.
const here = path.join(process.cwd(), 'src/app/pages/Dashboard/desktop');
const src = fs.readFileSync(path.join(here, 'PillArtifactFrame.tsx'), 'utf8');

test('the pill artifact carries the dark MUI theme, not just the dark CSS class', () => {
  assert.match(src, /className="osw-artifact dark"/, 'the dark class is the premise of this test');
  assert.match(src, /import \{ DarkTokensScope \}/, 'the dark MUI theme must be imported');
  assert.match(src, /<DarkTokensScope>\{children\}<\/DarkTokensScope>/,
    'children must render inside DarkTokensScope, or MUI inputs inherit light-mode text on dark glass');
});

test('the dark class never appears without the scope that pairs with it', () => {
  const classAt = src.indexOf('className="osw-artifact dark"');
  const scopeAt = src.indexOf('<DarkTokensScope>');
  assert.ok(classAt !== -1 && scopeAt !== -1, 'both halves must be present');
  // Ordering matters: the scope has to wrap the content INSIDE the element carrying the class,
  // so a later edit that hoists the scope out of the frame fails here rather than shipping.
  assert.ok(scopeAt > classAt, 'the scope must sit inside the element that carries the dark class');
});
