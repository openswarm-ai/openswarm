// ENG-400: four crashes from one user, production 1.7.9. The first came after 34 hours; every
// relaunch afterwards died in under two minutes, so the app was unusable. Safe mode WAS armed for
// launches 3 and 4 (two dirty exits inside ten minutes) and they crashed anyway, because main
// computed safeModeInfo and then did nothing with it except answer an IPC. The mitigation was
// entirely renderer-side, which cannot help a main-process crash.
//
// Two halves are pinned here: main enforces safe mode on the one process it controls (the backend's
// auto-resume, which fires the very turn that was running when the app died), and the offscreen
// browser stops tearing windows down mid-call, which is the shape of the faulting instruction
// (a virtual call on an object whose vtable pointer is zero, while walking a list).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const hidden = fs.readFileSync(path.join(__dirname, 'hiddenBrowser.js'), 'utf8');

test('safe mode is known before the backend spawns, not after', () => {
  // It used to be computed inside whenReady, BELOW the backend spawn, so the one process that can
  // act on it had already started with the wrong answer.
  const detect = main.indexOf('\nif (gotLock) detectDirtyExitAndArmSafeMode();');
  const spawn = main.indexOf('await startBackend();');
  assert.ok(detect > 0, 'detection must run at module load');
  assert.ok(detect < spawn, 'detection must precede the backend spawn');
  assert.ok(!main.includes('  detectDirtyExitAndArmSafeMode();\n  spawnCrashWatchdog();'),
    'the old whenReady call site must be gone, not duplicated');
});

test('a losing second instance cannot stamp a dirty exit over the real one', () => {
  const i = main.indexOf('detectDirtyExitAndArmSafeMode();\n\nipcMain.handle');
  assert.ok(main.slice(i - 60, i).includes('if (gotLock)'), 'the module-level call is lock-guarded');
});

test('main enforces safe mode instead of only advertising it', () => {
  const i = main.indexOf('OSW_DISABLE_AUTO_RESUME');
  assert.ok(i > 0, 'the backend must be told');
  assert.ok(main.slice(i - 400, i + 60).includes('safeModeInfo.safeMode'),
    'and told on the same condition the renderer reads, so the two cannot disagree');
});

test('the hold is one boot and leaves the user a way back in', () => {
  // Never auto-resuming would be silent work loss, a worse row than the crash loop.
  const i = main.indexOf('OSW_DISABLE_AUTO_RESUME');
  const why = main.slice(i - 400, i);
  assert.ok(/Resume chip/.test(why), 'the comment must record that the turn stays recoverable');
});

test('every offscreen page call goes through the one guarded door', () => {
  assert.ok(!/win\.webContents\.executeJavaScript/.test(hidden),
    'a direct call can fire after the killer already tore the window down');
  assert.ok(hidden.includes('async function evalInPage'));
  const body = hidden.slice(hidden.indexOf('async function evalInPage'), hidden.indexOf('async function withWindow'));
  assert.ok(body.includes('win.isDestroyed()'), 'the window must be checked');
  assert.ok(body.includes('wc.isDestroyed()'), 'and so must its contents; the window can outlive them');
  assert.ok(body.includes('return null'), 'a dead window yields nothing, it does not throw');
});

test('one idempotent disposer, graceful before violent', () => {
  const body = hidden.slice(hidden.indexOf('function disposeWindow'), hidden.indexOf('// The ONLY door'));
  assert.ok(body.includes('if (!win || win.isDestroyed()) return;'), 'calling it twice must be safe');
  assert.ok(body.indexOf('win.close()') < body.indexOf('win.destroy()'),
    'close() runs the teardown that lets observers unregister; destroy() skips it');
});

test('the timeout killer routes through the disposer, not a bare destroy', () => {
  const body = hidden.slice(hidden.indexOf('async function withWindow'), hidden.indexOf('const HARVEST_GRACE_MS'));
  assert.ok(body.includes('setTimeout(() => disposeWindow(win)'));
  assert.ok(!/killer = setTimeout\(\(\) => \{ try \{ win\.destroy/.test(body));
});

test('loading refuses to start on a window that is already gone', () => {
  const body = hidden.slice(hidden.indexOf('async function loadAndSettle'), hidden.indexOf('// Fetch a URL'));
  assert.ok(body.includes('if (win.isDestroyed()) return;'));
});
