// Run: node --test electron/voiceHotkeyRearm.test.js
//
// ENG-317: an event tap another app registers AFTER ours head-inserts AHEAD of ours and can eat fn
// with no disable event delivered, so the watcher's existing timeout re-enable never fires and fn
// goes silently dead (reproduced with a real adversary tap: watcher got ZERO bytes). The fix is a
// focus-time "r\n" poke that re-arms the tap, head-inserting us back in front (proven live: starved
// under the adversary, one poke, fn flowed again). These pin the wire and the protocol.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const swiftSrc = fs.readFileSync(path.join(__dirname, 'native', 'fn-watcher.swift'), 'utf8');
const hotkeySrc = fs.readFileSync(path.join(__dirname, 'voiceHotkey.js'), 'utf8');

test('the watcher understands the re-arm poke and dies on parent loss', () => {
  assert.match(swiftSrc, /if line == "r"/, 'the stdin re-arm command is the whole ENG-317 fix');
  assert.match(swiftSrc, /while let line = readLine/, 'stdin must be read line-wise');
  assert.match(swiftSrc, /exit\(0\)/, 'stdin EOF must exit, or a crashed parent strands a global tap');
  const armBody = swiftSrc.slice(swiftSrc.indexOf('func armTap'), swiftSrc.indexOf('guard armTap'));
  assert.ok(armBody.indexOf('tapCreate') < armBody.indexOf('CFMachPortInvalidate'), 'new tap up BEFORE old tap down, or a failed re-arm goes deaf');
});

test('electron pokes on focus through a piped stdin', () => {
  assert.match(hotkeySrc, /stdio: \['pipe', 'pipe', 'ignore'\]/, 'an ignored stdin is /dev/null, whose instant EOF would kill the watcher at birth');
  assert.match(hotkeySrc, /fnProc\.stdin\.write\('r\\n'\)/, 'the poke must reach the watcher');
  const focusLine = hotkeySrc.split('\n').find((l) => l.includes("app.on('browser-window-focus'"));
  assert.ok(focusLine && focusLine.includes('pokeFnWatcher'), 'focus is the moment we can win the tap back');
});

test('live protocol: armed watcher survives pokes and exits on EOF', { skip: process.platform !== 'darwin' }, async () => {
  const bin = path.join(require('node:os').tmpdir(), `fn-watcher-rearm-test-${process.pid}`);
  const cc = spawnSync('swiftc', ['-O', '-o', bin, path.join(__dirname, 'native', 'fn-watcher.swift')], { timeout: 120000 });
  if (cc.error || cc.status !== 0) return; // no toolchain on this runner; source checks above still hold
  const p = spawn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  let out = ''; p.stdout.on('data', (c) => { out += String(c); });
  let exitCode = null; p.on('exit', (c) => { exitCode = c; });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let waited = 0; !out.includes('r') && exitCode === null && waited < 4000; waited += 100) await sleep(100);
  try {
    // No boot marker = no grant, or a Gatekeeper-wedged machine hanging fresh binaries at
    // _dyld_start (both seen live); asserting against a process that never ran proves nothing.
    if (exitCode !== null || !out.includes('r')) return;
    p.stdin.write('r\n'); p.stdin.write('r\n');
    await sleep(500);
    assert.equal(exitCode, null, 'pokes must not kill the watcher');
    assert.ok(!out.split('\n').some((l) => l.startsWith('e')), `re-arm errored: ${out}`);
    p.stdin.end();
    for (let waited = 0; exitCode === null && waited < 5000; waited += 100) await sleep(100);
    assert.equal(exitCode, 0, 'EOF must exit cleanly; a survivor here is the orphan-tap leak');
  } finally {
    try { p.kill('SIGKILL'); } catch (_) {}
    try { fs.unlinkSync(bin); } catch (_) {}
  }
});
