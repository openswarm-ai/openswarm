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
  // Bounded by the region's real end, not a magic character count: a fixed slice silently stops
  // covering the code it is supposed to guard the moment anyone adds a line above it.
  const relay = hotkeySrc.split('installVoiceHoldRelay')[1].split("web-contents-created")[0];
  assert.match(relay, /input\.key === 'Fn'/);
  assert.match(relay, /armNativeTiers\(\)/);
  assert.match(relay, /sendFallbackToggle\(\)/);
});

test('the probe flag reaches the spawn argv', () => {
  assert.match(hotkeySrc, /spawn\(bin, noPrompt \? \['--no-prompt'\] : \[\]/);
});

// ---- The deaf-tap class (Eric, exp.20, and the same "99% of devices" report) ----
// tapCreate hands back a valid port even with Input Monitoring DENIED, and that tap then never
// delivers an event. So "the watcher process is alive" was read as "fn works" by every layer above
// it, and a permanently dead key looked identical to a key nobody had pressed yet. Measured live on
// a dev machine: `p denied` followed by a successful `t ok`.

test('the watcher reports its permission instead of leaving it to be inferred', () => {
  assert.match(swiftSrc, /print\(hidGranted \? "p granted" : "p denied"\)/,
    'permission must be stated on stdout, not guessed from the process still being alive');
});

test('a denied watcher reports it and STAYS ALIVE, or the Settings pane has nothing to flip', () => {
  // Exiting on denial looked tidy and silently removed the only mechanism that lists the app under
  // Input Monitoring, so "Open Settings" led to a pane with no OpenSwarm row in it.
  const guard = swiftSrc.split('if !hidGranted {')[1].split('}')[0];
  assert.match(guard, /e no-permission/);
  assert.ok(!/exit\(/.test(guard), 'must not exit: a live tap is what keeps the app listed in the pane');
});

test('denial is carried by the reported line, never by liveness', () => {
  assert.match(hotkeySrc, /line\.includes\('no-permission'\)\) notifyPrimaryUnusable\('input-monitoring-denied'\)/,
    'with the process staying alive, the stdout report is the only honest signal');
});

test('the grant is REQUESTED on the intent path and never on the boot probe', () => {
  assert.match(swiftSrc, /if !hidGranted && !isProbe \{\s*\n\s*hidGranted = IOHIDRequestAccess\(kIOHIDRequestTypeListenEvent\)/,
    'a denied machine can only be fixed by asking; the probe must still stay silent (ENG-341)');
});

test('the tap proves it is on the wire, separately from any fn press', () => {
  assert.match(swiftSrc, /if !wireAlive \{/);
  assert.match(swiftSrc, /print\("w"\)/);
});

test('every way fn can fail tells the user which chord still works', () => {
  for (const reason of ['input-monitoring-denied', 'no-watcher-binary', 'tap-deaf']) {
    assert.ok(hotkeySrc.includes(reason), `unhandled fn failure mode: ${reason}`);
  }
  assert.match(hotkeySrc, /notifyPrimaryUnusable\(`watcher-exit-\$\{code\}`\)/,
    'a watcher that exits leaves no primary, so it must notify too');
  assert.match(hotkeySrc, /fallback: fallbackCombo\.accel/,
    'the notice is only useful if it names the chord that works');
});

test('the notice is remembered, not just fired', () => {
  // Arming happens at boot and the renderer subscribes later, so a pure event reaches nobody.
  assert.match(hotkeySrc, /lastHotkeyIssue = \{ ok: false, reason, fallback: fallbackCombo\.accel \}/);
  assert.match(hotkeySrc, /ipcMain\.handle\('voice:hotkey-issue', \(\) => lastHotkeyIssue\)/);
});

test('a key that starts working retracts its own warning', () => {
  const provenBlock = hotkeySrc.split("fn watcher PROVEN")[1].slice(0, 400);
  assert.match(provenBlock, /lastHotkeyIssue = null/);
  assert.match(provenBlock, /voice:primary-usable/);
});

// ---- Asking is part of the feature, not a one-shot side effect ----
// Eric: "if the user clicks it, they should still ask for microphone permission and fn permissions".
// armNativeTiers is one-shot, so a denied (or dismissed) grant could never be re-requested and the
// key stayed dead for the life of the install even though the user was willing to grant it.

test('using dictation re-asks for the fn grant, not just the first time', () => {
  assert.match(hotkeySrc, /const askForFnPermission = \(\) => \{/);
  const micHandler = hotkeySrc.split("ipcMain.handle('voice:request-mic-access'")[1].slice(0, 300);
  assert.match(micHandler, /askForFnPermission\(\)/,
    'the mic prompt and the fn prompt are the same moment of intent');
  const holdHandler = hotkeySrc.split("ipcMain.handle('voice:request-hold-permission'")[1].slice(0, 300);
  assert.match(holdHandler, /askForFnPermission\(\)/);
});

test('the re-ask is throttled so it cannot spawn a watcher per keystroke', () => {
  const fn = hotkeySrc.split('const askForFnPermission')[1].slice(0, 400);
  assert.match(fn, /lastFnAskMs/);
  assert.match(fn, /return;/);
});

test('the intent path spawns WITHOUT --no-prompt, or nothing is ever asked', () => {
  const fn = hotkeySrc.split('const askForFnPermission')[1].slice(0, 400);
  assert.match(fn, /startFnWatcher\(\);/, 'a --no-prompt spawn here would silently never prompt');
});
