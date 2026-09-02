// Run: node --test electron/popupRoute.test.js
//
// ENG-279, second cut. The first version routed every popup opened by a browser card into a card so
// an agent could address it. An Electron probe then measured what that costs: a reopened card has
// window.opener = false and never receives the postMessage an OAuth popup uses to return the auth
// code, while a native popup gets both. So the routing broke sign-in AFTER the user authenticated.
//
// These tests encode the surviving invariant: a real window.open stays native, whoever opened it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { popupRoute } = require('./popupRoute');

test('a real window.open from a browser card stays NATIVE so window.opener survives', () => {
  for (const d of ['new-window', 'default', 'other', undefined]) {
    assert.equal(
      popupRoute('webview', d),
      'native',
      `disposition ${d} was reopened as a card, which nulls window.opener and breaks the OAuth return channel`,
    );
  }
});

test('provider sign-in from the main window keeps its native popup', () => {
  for (const d of ['new-window', 'default', undefined]) {
    assert.equal(popupRoute('window', d), 'native', `disposition ${d} hijacked provider auth`);
  }
});

test('tab dispositions still route to a card from anywhere, which predates ENG-279', () => {
  for (const t of ['webview', 'window', 'browserView']) {
    assert.equal(popupRoute(t, 'foreground-tab'), 'card');
    assert.equal(popupRoute(t, 'background-tab'), 'card');
  }
});

test('both routes are reachable, so the decision is not one-armed', () => {
  const seen = new Set([popupRoute('webview', 'new-window'), popupRoute('webview', 'foreground-tab')]);
  assert.equal(seen.size, 2, `only reached ${[...seen].join(', ')}`);
});

test('a popup from an App card goes native whatever the disposition: a browser card would not carry the app session', () => {
  for (const d of ['foreground-tab', 'background-tab', 'new-window', undefined]) {
    assert.equal(popupRoute('webview', d, true), 'native', `disposition ${d} from an app preview was reopened in the browser partition`);
  }
});

test('the app-preview flag defaults off, so browser cards keep the ENG-279 routing', () => {
  assert.equal(popupRoute('webview', 'foreground-tab'), 'card');
  assert.equal(popupRoute('webview', 'foreground-tab', false), 'card');
});

test('main.js hands the app-preview verdict to popupRoute instead of deciding inline', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const handler = main.slice(main.indexOf('contents.setWindowOpenHandler(({ url, disposition })'));
  const call = handler.slice(0, handler.indexOf('=== \'card\''));
  assert.match(call, /popupRoute\(contents\.getType\(\), disposition, isAppPreview\)/, 'the handler must pass isAppPreview through');
  assert.match(call, /contents\.session === mainWindow\.webContents\.session/, 'app preview is recognised by session, the same test the context menu uses');
});
