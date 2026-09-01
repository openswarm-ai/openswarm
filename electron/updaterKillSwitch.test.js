// OPENSWARM_NO_UPDATE=1 is the documented way to drill a packaged build. It used to be honoured in
// ONE place (setupAutoUpdater) while the renderer's own `check-for-updates` walked past it, so a
// drill logged "updater disabled", downloaded the published release, and let Squirrel apply it on
// quit. The bundle under test silently became a DIFFERENT build, which is worse than no gate at all:
// it makes a drill report the wrong version's behaviour as if it were the candidate's.
//
// Caught live 2026-08-31: a /tmp copy of 1.7.10-exp.3 came back as 1.7.9 (398 py files, no pruner)
// after a load run, with `[updater] disabled via OPENSWARM_NO_UPDATE=1` sitting in the same log.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('the env var is read in exactly ONE place, so no door can forget it', () => {
  const reads = SRC.match(/process\.env\.OPENSWARM_NO_UPDATE/g) || [];
  assert.equal(reads.length, 1, `OPENSWARM_NO_UPDATE is read ${reads.length}x; a second read is a second rule that will drift`);
  assert.match(SRC, /function updatesDisabled\(/, 'the single predicate must exist');
});

test('EVERY updater door consults it, and does so FIRST', () => {
  const doors = [
    ["setupAutoUpdater", /if \(!autoUpdater\) return;[\s\S]{0,400}?updatesDisabled\('setup'\)/],
    ["check-for-updates", /ipcMain\.handle\('check-for-updates'[\s\S]{0,200}?updatesDisabled\('check-for-updates'\)/],
    ["download-update", /ipcMain\.handle\('download-update'[\s\S]{0,200}?updatesDisabled\('download-update'\)/],
  ];
  for (const [name, re] of doors) {
    assert.match(SRC, re, `${name} does not consult the gate near its top`);
  }
});

test('the check door gates BEFORE it can reach checkForUpdates()', () => {
  const start = SRC.indexOf("ipcMain.handle('check-for-updates'");
  const body = SRC.slice(start, start + 1200);
  const gate = body.indexOf('updatesDisabled');
  const call = body.indexOf('checkForUpdates(');
  assert.ok(gate > 0 && call > 0, 'both must be present');
  assert.ok(gate < call, 'the gate must precede the call, or the download starts anyway');
});

test('the download door gates BEFORE downloadUpdate()', () => {
  const start = SRC.indexOf("ipcMain.handle('download-update'");
  const body = SRC.slice(start, start + 900);
  assert.ok(body.indexOf('updatesDisabled') < body.indexOf('downloadUpdate('),
    'a staged payload is applied on quit, so blocking the check but not the download proves nothing');
});

test('the predicate is off by default: a normal user still gets updates', () => {
  const fn = SRC.slice(SRC.indexOf('function updatesDisabled('), SRC.indexOf('function updatesDisabled(') + 400);
  assert.match(fn, /return false;/, 'it must fall through to false when the var is unset');
  assert.doesNotMatch(fn, /return true;\s*}\s*$/, 'it must not default to disabling updates');
});
