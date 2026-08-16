// A crashed webview guest fires NEITHER did-finish-load nor did-fail-load; the element stays
// mounted painting solid black, and nothing recovered it (caught live 2026-08-16: 7 dead guests
// under 7 mounted app cards on the packaged build, read straight off /json target list). Both
// card types now reload on guest death (ENG-322).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const view = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/Views/ViewPreview.tsx'), 'utf8');
const browser = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/Dashboard/cards/BrowserCard.tsx'), 'utf8');

test('app cards reload a dead guest with the same backoff as fail-load', () => {
  const effect = view.slice(view.indexOf('const onGuestGone'), view.indexOf('return () => {', view.indexOf('const onGuestGone')));
  assert.ok(effect.includes('wv.reload'), 'the heal is a reload, not just a listener');
  assert.ok(view.includes("addEventListener?.('render-process-gone', onGuestGone)"));
  assert.ok(view.includes("removeEventListener?.('render-process-gone', onGuestGone)"), 'leak-free both directions');
});

test('browser cards heal too, not only report', () => {
  const start = browser.indexOf('const onGuestGone');
  const handler = browser.slice(start, browser.indexOf("addEventListener('render-process-gone'", start));
  assert.ok(handler.includes('webview_gone'), 'telemetry stays');
  assert.ok(handler.includes('reload'), 'reporting alone left a black rectangle on the board');
});
