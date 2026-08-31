const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// The fn watcher taps flagsChanged ONLY, so its "wire alive" proof needs a MODIFIER press. The old
// code declared 'tap-deaf' from a bare 60s timer, which meant a user who simply did not press a
// modifier in the first minute was told their fn key was not reaching OpenSwarm and pushed onto the
// fallback chord. Observed on the packaged 1.7.10-exp.1 candidate, 2026-08-30: "Input Monitoring:
// granted" followed by "fn primary unusable (tap-deaf)" on a tap nobody had touched.
//
// Deafness is only a FACT when the user was demonstrably at the keyboard and the watcher still
// heard nothing. These pin that pairing.
const src = fs.readFileSync(path.join(process.cwd(), 'voiceHotkey.js'), 'utf8');

test('tap-deaf is never declared from silence alone', () => {
  assert.doesNotMatch(
    src,
    /if \(fnProc && !primaryProven\(\) && !fnWireAlive\) notifyPrimaryUnusable\('tap-deaf'\)/,
    'the bare timer-only check must be gone: it fires on a healthy tap nobody pressed',
  );
});

test('tap-deaf requires evidence the user was actually typing', () => {
  assert.match(src, /let rendererSawKeys = false;/, 'the keyboard-activity fact must be tracked');
  assert.match(src, /rendererSawKeys = true;/, 'a focused-window key must record that fact');
  const poll = src.slice(src.indexOf('const deafPoll'), src.indexOf('FN_DEAF_POLL_MS);') + 40);
  assert.ok(poll.length > 0, 'the evidence poll must exist');
  assert.match(poll, /if \(!rendererSawKeys\) return;/,
    'no keyboard activity means no verdict, ever');
  assert.match(poll, /notifyPrimaryUnusable\('tap-deaf'\)/,
    'once the pairing holds it must still report, or a genuinely deaf key goes unreported');
});

test('the guard still gives up cleanly once the tap proves itself', () => {
  const poll = src.slice(src.indexOf('const deafPoll'), src.indexOf('FN_DEAF_POLL_MS);') + 40);
  assert.match(poll, /if \(fnWireAlive\) \{ clearInterval\(deafPoll\); return; \}/,
    'a live wire must stop the poll rather than leave a timer running forever');
  assert.match(poll, /unusableNotified \|\| primaryProven\(\) \|\| !fnProc/,
    'notified, proven, or no watcher must all end the poll');
});

test('the real denial path is untouched', () => {
  // input-monitoring-denied is a FACT the watcher reports; it must still fire immediately.
  assert.match(src, /if \(fnPermission === 'denied'\) notifyPrimaryUnusable\('input-monitoring-denied'\)/);
  assert.match(src, /line\.includes\('no-permission'\)/);
});
