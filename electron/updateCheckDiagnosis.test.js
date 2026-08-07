// Run: cd electron && node --test updateCheckDiagnosis.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnoseSilentUpdateCheck } = require('./updateCheckDiagnosis');

test('a quarantined Update.exe names the reinstall, whatever the network says', () => {
  for (const feedReachable of [true, false]) {
    const msg = diagnoseSilentUpdateCheck({ updateExeExists: false, feedReachable });
    assert.match(msg, /update helper is missing/i);
    assert.match(msg, /Reinstall/);
  }
});

test('an unreachable feed names the firewall, not the user', () => {
  const msg = diagnoseSilentUpdateCheck({ updateExeExists: true, feedReachable: false });
  assert.match(msg, /firewall or proxy/i);
  assert.doesNotMatch(msg, /try again/i);
});

test('helper present and feed reachable still gets an actionable message, never a shrug', () => {
  const msg = diagnoseSilentUpdateCheck({ updateExeExists: true, feedReachable: true });
  assert.match(msg, /Security software|reinstalling/i);
  assert.doesNotMatch(msg, /timed out/i);
});
