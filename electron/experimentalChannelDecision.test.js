// Run: node --test electron/experimentalChannelDecision.test.js
//
// ENG-292. The measured failure this encodes: 1.7.8-exp.1 installed from the DMG, Settings never
// opened, quit once, and CFBundleShortVersionString came back 1.7.7. The experimental build
// uninstalled itself because a default toggle was read as a deliberate opt-out.
const test = require('node:test');
const assert = require('node:assert/strict');
const { experimentalChannelDecision } = require('./experimentalChannelDecision');

const EXP = '1.7.8-exp.1';
const STABLE = '1.7.7';

test('the exact measured failure: fresh prerelease install, toggle never touched', () => {
  const d = experimentalChannelDecision(EXP, undefined);
  assert.equal(d.allowPrerelease, true, 'installing a prerelease is the opt-in');
  assert.equal(d.allowDowngrade, false, 'this is what silently reverted the user to stable');
  assert.equal(d.seedStoredTo, true, 'persist it so the renderer push does not re-assert the default');
});

test('an explicit opt-out on a prerelease still moves you to stable', () => {
  const d = experimentalChannelDecision(EXP, false);
  assert.equal(d.allowPrerelease, false);
  assert.equal(d.allowDowngrade, true, 'the deliberate opt-out path must keep working');
  assert.equal(d.seedStoredTo, null, 'never overwrite a choice the user actually made');
});

test('an explicit opt-in on a prerelease stays put', () => {
  const d = experimentalChannelDecision(EXP, true);
  assert.equal(d.allowPrerelease, true);
  assert.equal(d.allowDowngrade, false, 'nothing to downgrade to; staying is correct');
});

test('a stable build keeps the un-ship-a-bad-release lever', () => {
  for (const stored of [undefined, false]) {
    const d = experimentalChannelDecision(STABLE, stored);
    assert.equal(d.allowPrerelease, false);
    assert.equal(d.allowDowngrade, true, 'we must still be able to re-flip GH latest and pull users back');
    assert.equal(d.seedStoredTo, null);
  }
});

test('a stable build with the toggle on takes prereleases, and may downgrade', () => {
  const d = experimentalChannelDecision(STABLE, true);
  assert.equal(d.allowPrerelease, true);
  assert.equal(d.allowDowngrade, true);
});

test('garbage stored values are treated as never-set, not as false', () => {
  for (const junk of [null, 0, 1, '', 'true', 'false', {}, []]) {
    const d = experimentalChannelDecision(EXP, junk);
    assert.equal(d.allowPrerelease, true, `stored=${JSON.stringify(junk)} must not read as an opt-out`);
    assert.equal(d.allowDowngrade, false, `stored=${JSON.stringify(junk)} must not license a downgrade`);
  }
});

test('a missing version string cannot be mistaken for a prerelease', () => {
  for (const v of [undefined, null, '']) {
    const d = experimentalChannelDecision(v, undefined);
    assert.equal(d.allowPrerelease, false);
    assert.equal(d.allowDowngrade, true);
  }
});
