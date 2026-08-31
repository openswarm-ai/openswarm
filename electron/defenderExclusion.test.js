// ENG-422: the Defender exclusion toggle. Excluding a folder from antivirus is a security decision,
// so the tests here are mostly about what this must REFUSE to do.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { applyDefenderExclusion, buildArgs, scriptPath, SCRIPT_REL } = require('./defenderExclusion');

function tmpWithScript() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osw-def-'));
  const full = path.join(root, SCRIPT_REL);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '# stub');
  return { root, full };
}

test('it refuses to run on anything but Windows, whatever the renderer asks for', async () => {
  const { root } = tmpWithScript();
  let spawned = false;
  for (const platform of ['darwin', 'linux']) {
    const r = await applyDefenderExclusion({
      enable: true, platform, resourcesPath: root, spawnFn: () => { spawned = true; },
    });
    assert.equal(r.ok, false);
    assert.match(r.detail, /Windows/);
  }
  assert.equal(spawned, false, 'nothing may be spawned off Windows');
});

test('a missing script fails honestly instead of pretending', async () => {
  const r = await applyDefenderExclusion({
    enable: true, platform: 'win32', resourcesPath: os.tmpdir(), devRoot: os.tmpdir(),
    spawnFn: () => { throw new Error('must not spawn'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /missing/);
});

test('the packaged path wins, and dev is the fallback', () => {
  const { root, full } = tmpWithScript();
  assert.equal(scriptPath(root, os.tmpdir()), full);
  assert.equal(scriptPath(os.tmpdir(), root), full, 'falls back to the dev tree');
  assert.equal(scriptPath(os.tmpdir(), os.tmpdir()), null);
});

test('enable runs -Apply and disable runs -Remove, both elevated, never silently', () => {
  const on = buildArgs('C:\\app\\x.ps1', true).join(' ');
  const off = buildArgs('C:\\app\\x.ps1', false).join(' ');
  assert.match(on, /-Verb RunAs/, 'the UAC prompt IS the consent; never elevate without it');
  assert.match(on, /'-Apply'/);
  assert.doesNotMatch(on, /-Remove/);
  assert.match(off, /'-Remove'/, 'the toggle must be reversible');
  assert.doesNotMatch(off, /-Apply/);
  // No password, no credential, no bypassing the dialog.
  for (const s of [on, off]) {
    assert.doesNotMatch(s, /-Credential|ConvertTo-SecureString|password/i);
  }
});

test('a path containing a quote cannot break out of its argument', () => {
  const args = buildArgs("C:\\a'b\\x.ps1", true);
  const cmd = args[args.length - 1];
  assert.match(cmd, /'C:\\a''b\\x\.ps1'/, 'the quote must be doubled, not left to end the argument');
});

test('a declined UAC reports failure so the toggle can revert, and never throws', async () => {
  const { root } = tmpWithScript();
  const fake = () => {
    const handlers = {};
    setImmediate(() => handlers.exit && handlers.exit(1));
    return { on: (ev, fn) => { handlers[ev] = fn; } };
  };
  const r = await applyDefenderExclusion({ enable: true, platform: 'win32', resourcesPath: root, spawnFn: fake });
  assert.equal(r.ok, false);
  assert.match(r.detail, /not approved/);
});

test('a spawn that errors resolves rather than rejecting', async () => {
  const { root } = tmpWithScript();
  const fake = () => {
    const handlers = {};
    setImmediate(() => handlers.error && handlers.error(new Error('boom')));
    return { on: (ev, fn) => { handlers[ev] = fn; } };
  };
  const r = await applyDefenderExclusion({ enable: true, platform: 'win32', resourcesPath: root, spawnFn: fake });
  assert.equal(r.ok, false);
  assert.match(r.detail, /boom/);
});

test('approval reports success once, for the right direction', async () => {
  const { root } = tmpWithScript();
  const fake = () => {
    const handlers = {};
    setImmediate(() => { handlers.exit && handlers.exit(0); handlers.exit && handlers.exit(0); });
    return { on: (ev, fn) => { handlers[ev] = fn; } };
  };
  const r = await applyDefenderExclusion({ enable: false, platform: 'win32', resourcesPath: root, spawnFn: fake });
  assert.equal(r.ok, true);
  assert.match(r.detail, /removed/);
});

test('WIRING: main exposes it only as a user-invoked IPC call, with no auto-run path', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('defender:set-exclusion'/, 'the renderer toggle must reach it');
  assert.match(main, /platform: process\.platform/, 'main enforces the platform, not the renderer');
  const calls = main.match(/applyDefenderExclusion\(/g) || [];
  assert.equal(calls.length, 1, 'exactly one call site: no boot path, no prompt, no auto-run');
  const preload = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  assert.match(preload, /setDefenderExclusion/, 'the bridge must exist');
});

test('WIRING: the script ships in the packaged tree, not inside the asar', () => {
  const repoRoot = path.join(__dirname, '..');
  assert.ok(fs.existsSync(path.join(repoRoot, SCRIPT_REL)),
    'the script must live under backend/, which is copied to Resources as real files; PowerShell cannot execute a path inside app.asar');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const staged = (pkg.build.extraResources || []).some((r) => r.from === 'build-staging/backend');
  assert.ok(staged, 'backend/ must be an extraResources entry or the script never reaches the install');
});
