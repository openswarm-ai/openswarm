// A user who never dictated must not pay a boot-warmed whisper-server (~210MB resident for 10
// minutes after every boot); the first real transcription writes the marker that unlocks boot-warm
// for every later boot. The gate must sit in FRONT of model resolution so an unused install does
// zero work, and behind it the no-model refusal still guards the 190MB silent download.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const whisperService = require('./voice/whisperService');

function freshDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'osw-whisper-'));
  const res = path.join(base, 'res');
  const data = path.join(base, 'data');
  fs.mkdirSync(res); fs.mkdirSync(data);
  return { res, data };
}

test('never-dictated install skips boot warm even with a model on disk', () => {
  const { res, data } = freshDirs();
  const fakeModel = path.join(res, 'fake-model.bin');
  fs.writeFileSync(fakeModel, 'x');
  process.env.OPENSWARM_WHISPER_MODEL = fakeModel;
  try {
    assert.strictEqual(whisperService.hasBeenUsed(data), false);
    assert.strictEqual(whisperService.warmInBackground(res, data), false);
  } finally {
    delete process.env.OPENSWARM_WHISPER_MODEL;
  }
});

test('the first transcription marker unlocks boot warm', () => {
  const { res, data } = freshDirs();
  const fakeModel = path.join(res, 'fake-model.bin');
  fs.writeFileSync(fakeModel, 'x');
  process.env.OPENSWARM_WHISPER_MODEL = fakeModel;
  try {
    whisperService.markUsed(data);
    assert.strictEqual(whisperService.hasBeenUsed(data), true);
    assert.strictEqual(whisperService.warmInBackground(res, data), true);
  } finally {
    delete process.env.OPENSWARM_WHISPER_MODEL;
    whisperService.stopServer();
  }
});

test('marker alone does not defeat the no-model download guard', () => {
  const { res, data } = freshDirs();
  whisperService.markUsed(data);
  assert.strictEqual(whisperService.warmInBackground(res, data), false);
});
