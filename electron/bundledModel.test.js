// Dictation has to work the instant the app opens: press fn, talk, done. The model is 190MB and
// lived only as a runtime download, so a fresh install (or anyone offline, or on slow wifi) pressed
// fn into silence while it fetched. It is now staged into Resources/whisper at build time.
//
// resolveModelFile already prefers a bundled model over userData, so these pin the two halves that
// can silently drift: the build must stage it, and the resolver must look for the one we staged.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SH = path.join(__dirname, 'scripts', 'build-whisper.sh');
const MODELS = require('./voice/whisperModels.js');

test('the build stages the DEFAULT model, the same one the resolver looks for', () => {
  const sh = fs.readFileSync(SH, 'utf-8');
  const wanted = MODELS.modelById(MODELS.DEFAULT_MODEL_ID).file;
  assert.ok(sh.includes(wanted),
    `build-whisper.sh must stage ${wanted}; the resolver checks resourceDir for exactly that name`);
});

test('a corrupt model is refused at build time rather than shipped', () => {
  const sh = fs.readFileSync(SH, 'utf-8');
  const expected = MODELS.modelById(MODELS.DEFAULT_MODEL_ID).sha256;
  assert.ok(sh.includes(expected), 'the staged checksum must match the catalog');
  assert.ok(sh.includes('checksum mismatch') && sh.includes('exit 1'),
    'a truncated model ships silently and dies at the first press, so it must fail the build');
});

test('a build without the model FETCHES it rather than warning', () => {
  // This used to assert only that a missing model printed a WARNING. A warning on the release path
  // is indistinguishable from success, and the source is gitignored while releases are cut in a
  // detached worktree, so every real cut took that branch. See whisperModelBundling.test.js.
  const sh = fs.readFileSync(SH, 'utf-8');
  assert.ok(sh.includes('MODEL_URL='), 'the build must be able to get the file itself');
  assert.ok(!sh.includes('WITHOUT a bundled model (first fn press'),
    'the old warn-and-continue branch must be gone');
});

test('the bundled model is NOT swept into app.asar', () => {
  // It belongs in extraResources. Inside the asar it would cost every user the 181MB twice over,
  // which is the regression removed on 2026-08-25.
  const pkg = require('./package.json');
  assert.ok(pkg.build.files.includes('!whisper') && pkg.build.files.includes('!whisper/**'));
  // Platform-scoped: the entry lives under build.mac.extraResources, not build.extraResources.
  const extra = JSON.stringify(pkg.build.mac.extraResources);
  assert.ok(extra.includes('build-staging/whisper'), 'it reaches Resources via extraResources only');
  assert.ok(extra.includes('"to":"whisper"') || extra.includes('"to": "whisper"'),
    'and lands at Resources/whisper, which is what voiceResourceDir() resolves');
});
