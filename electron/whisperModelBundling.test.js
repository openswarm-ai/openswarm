// "we want this to work right out of the box": the 190MB dictation model is bundled so the first fn
// press transcribes instead of waiting on a download. Two silent paths defeated that, and both end
// in a build that looks fine and ships without the model, saying so only in a log line.
//
//   1. The model is read from electron/whisper/, which is GITIGNORED, and releases are cut in a
//      detached worktree, which by definition has no gitignored files.
//   2. The staging cache exits early on a staged BINARY alone, so any publish rerun skipped the
//      model block entirely. Measured on the 1.7.9 script with the model sitting right there:
//      "already staged at v1.7.6, skipping", exit 0, zero model files staged.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const sh = fs.readFileSync(path.join(__dirname, 'scripts/build-whisper.sh'), 'utf8');

test('a missing model is fetched, not warned about', () => {
  assert.ok(sh.includes('MODEL_URL='), 'the build must be able to get the file itself');
  assert.ok(!/WARNING: .*missing; shipping WITHOUT a bundled model/.test(sh),
    'a warning on the release path is indistinguishable from success');
});

test('a failed fetch fails the build instead of shipping without it', () => {
  const i = sh.indexOf('could not download');
  assert.ok(i > 0);
  assert.ok(sh.slice(i, i + 200).includes('exit 1'));
});

test('building without the model stays possible, but only on purpose', () => {
  assert.ok(sh.includes('OPENSWARM_SKIP_WHISPER_MODEL'), 'a declared opt-out, never an accident');
});

test('the staging cache counts the model, not just the binary', () => {
  const i = sh.indexOf('already staged at $WHISPER_VERSION, skipping');
  const cond = sh.slice(sh.lastIndexOf('if [[', i), i);
  assert.ok(cond.includes('$OUT/$MODEL_FILE'),
    'a cached binary alone used to exit 0 and stage no model');
  assert.ok(cond.includes('OPENSWARM_SKIP_WHISPER_MODEL'),
    'and a deliberate no-model build must still be able to short-circuit');
});

test('a cached binary with no model stages the model without rebuilding', () => {
  assert.ok(sh.includes('SKIP_BUILD=1'));
  assert.ok(sh.includes('if [[ "${SKIP_BUILD:-}" != "1" ]]; then'), 'the compile is what gets skipped');
});

test('the checksum is still verified before anything is copied', () => {
  const iSha = sh.indexOf('checksum mismatch');
  const iCopy = sh.indexOf('cp "$MODEL_SRC" "$OUT/$MODEL_FILE"');
  assert.ok(iSha > 0 && iCopy > iSha, 'a truncated model must never reach the bundle');
});

test('the packaged app can actually find what was staged', () => {
  // Staging into a directory extraResources does not copy is the same bug with extra steps.
  const pkg = require('./package.json');
  // It lives in the mac block, not the top level: dictation is macOS-only today.
  const entry = (pkg.build.mac.extraResources || []).find((r) => String(r.from).includes('build-staging/whisper'));
  assert.ok(entry, 'the mac extraResources must carry the staged whisper dir');
  assert.equal(entry.to, 'whisper');
  const models = fs.readFileSync(path.join(__dirname, 'voice/whisperModels.js'), 'utf8');
  assert.ok(models.includes('path.join(resourceDir, modelById(DEFAULT_MODEL_ID).file)'),
    'and resolveModelFile must look there before the userData download');
});
