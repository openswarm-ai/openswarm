// Without allowpopups a card's <webview> eats every target="_blank" link and window.open before the shell's popup router runs: an app's PDF exports clicked in a card did nothing, silently (2026-09-01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const view = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/Views/ViewPreview.tsx'), 'utf8');
const browser = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/Dashboard/cards/BrowserCard.tsx'), 'utf8');

// The JSX tag starts a line by itself; comments mention <webview> in prose well before it.
function webviewTag(source: string): string {
  const start = source.indexOf('<webview\n');
  assert.ok(start >= 0, 'source renders a <webview>');
  return source.slice(start, source.indexOf('/>', start));
}

test('the app card webview allows popups, like the browser card', () => {
  assert.ok(webviewTag(view).includes('allowpopups'), 'app card webview must carry allowpopups');
  assert.ok(webviewTag(browser).includes('allowpopups'), 'browser card webview must carry allowpopups');
});

test('the attribute is passed as a string, since React drops boolean-valued unknown attributes', () => {
  assert.ok(webviewTag(view).includes("allowpopups: 'true'"));
});

const shell = fs.readFileSync(path.join(process.cwd(), 'src/app/components/Layout/AppShell.tsx'), 'utf8');

test('a popup from an app card becomes a browser card, never a tab on a browser that does not exist', () => {
  const start = shell.indexOf('const openUrlInBrowser');
  const router = shell.slice(start, shell.indexOf('dispatch(addBrowserCard({ url }))', start));
  const lookup = router.indexOf('findBrowserByWebContentsId(');
  const guard = router.indexOf('browserCards[browserId]');
  const tab = router.indexOf('addBrowserTab(');
  assert.ok(lookup >= 0 && guard > lookup && tab > guard, 'the registry hit must be checked against the store before addBrowserTab; app cards register in that registry too');
});
