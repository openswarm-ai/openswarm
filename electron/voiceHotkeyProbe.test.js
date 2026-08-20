// The fn dead-key deadlock (Haik, exp.16, ~99% of devices): the dictation-used marker was only
// written by a successful transcription, the fn watcher only started once the marker existed, and
// fn was the default hotkey, so a never-dictated install could never dictate. The fix is a boot
// probe that arms fn WITHOUT ever prompting (IOHIDCheckAccess preflight) plus intent arming.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const swiftSrc = fs.readFileSync(path.join(__dirname, 'native', 'fn-watcher.swift'), 'utf8');
const hotkeySrc = fs.readFileSync(path.join(__dirname, 'voiceHotkey.js'), 'utf8');

test('the swift preflight refuses to prompt in --no-prompt mode', () => {
  const preflight = swiftSrc.indexOf('--no-prompt');
  const firstTap = swiftSrc.indexOf('func armTap');
  assert.ok(preflight > -1, 'preflight missing');
  assert.ok(preflight < firstTap, 'preflight must run before any tap can raise the TCC prompt');
  assert.match(swiftSrc, /IOHIDCheckAccess\(kIOHIDRequestTypeListenEvent\)/);
});

test('boot probes fn silently when the marker is absent', () => {
  const bootBlock = hotkeySrc.split("fs.existsSync(path.join(app.getPath('userData'), 'dictation-used'))")[1].slice(0, 400);
  assert.match(bootBlock, /combo\.special === 'fn'.*startFnWatcher\(true\)/s,
    'a fresh install with the default fn hotkey must get the no-prompt probe at boot');
});

test('rebinding to fn before tiers are armed also probes', () => {
  assert.match(hotkeySrc, /else if \(combo\.special === 'fn'\) startFnWatcher\(true\);\n    unregisterFallbackShortcut/);
});

test('a focused bare Fn keydown arms the tiers and toggles', () => {
  const relay = hotkeySrc.split('installVoiceHoldRelay')[1].slice(0, 900);
  assert.match(relay, /input\.key === 'Fn'/);
  assert.match(relay, /armNativeTiers\(\)/);
  assert.match(relay, /sendFallbackToggle\(\)/);
});

test('the probe flag reaches the spawn argv', () => {
  assert.match(hotkeySrc, /spawn\(bin, noPrompt \? \['--no-prompt'\] : \[\]/);
});
