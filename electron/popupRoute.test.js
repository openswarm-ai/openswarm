// Run: node --test electron/popupRoute.test.js
//
// ENG-279. A "Sign in with Google" opened from inside a browser card used to become a native
// window with no browser_id, so an agent driving that card could not see or touch it and the run
// stalled with nothing on screen to explain why.
const test = require('node:test');
const assert = require('node:assert/strict');
const { popupRoute } = require('./popupRoute');

test('a popup opened BY a browser card becomes a card, so an agent can address it', () => {
  for (const d of ['new-window', 'default', 'other', undefined]) {
    assert.equal(popupRoute('webview', d), 'card', `disposition ${d} escaped the card system`);
  }
});

test('provider sign-in from the main window keeps its native popup', () => {
  for (const d of ['new-window', 'default', undefined]) {
    assert.equal(popupRoute('window', d), 'native', `disposition ${d} hijacked provider auth`);
  }
});

test('tab dispositions still route to a card from anywhere', () => {
  for (const t of ['webview', 'window', 'browserView']) {
    assert.equal(popupRoute(t, 'foreground-tab'), 'card');
    assert.equal(popupRoute(t, 'background-tab'), 'card');
  }
});

test('both routes are reachable, so the decision is not one-armed', () => {
  const seen = new Set([popupRoute('webview', 'new-window'), popupRoute('window', 'new-window')]);
  assert.equal(seen.size, 2, `only reached ${[...seen].join(', ')}`);
});
