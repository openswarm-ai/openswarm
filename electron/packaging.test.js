// The dictation model is a 181 MB RUNTIME download that lives in userData
// (voice/whisperModels.js resolves it from userDataDir, nothing reads it from the bundle).
// It is gitignored, which is NOT the same as excluded from electron-builder: those two lists
// diverged, so a machine that had ever used dictation baked the model into app.asar. Measured
// 2026-08-24: asar 184 MB vs 2.5 MB, DMG 475 MB vs 300 MB, i.e. 175 MB on every auto-update.
// v1.7.9 escaped only because it was cut in a detached worktree, which has no gitignored files.
const test = require('node:test');
const assert = require('node:assert');
const pkg = require('./package.json');

test('the whisper model is excluded from the package', () => {
  const files = pkg.build.files;
  assert.ok(files.includes('!whisper') && files.includes('!whisper/**'),
    'electron/whisper holds a 181MB runtime-downloaded model; packing it costs every user 175MB per update');
});

test('every heavy build artifact stays out', () => {
  for (const dir of ['python-env', 'build-staging', 'whisper']) {
    assert.ok(pkg.build.files.includes(`!${dir}/**`), `${dir} must not be packed`);
  }
});
