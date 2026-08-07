const { test } = require('node:test');
const assert = require('node:assert');
const { createStreamSegmenter } = require('./streamSegmenter');
const whisperService = require('./whisperService');
const { createStreamingSession, wavFromPcm16, stripSoundCaptions } = require('./streamingSession');

const RATE = 16000;

function tone(ms, amplitude = 3000) {
  const out = new Int16Array(Math.round((RATE * ms) / 1000));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin(i / 8) * amplitude);
  return out;
}

function silence(ms) {
  return new Int16Array(Math.round((RATE * ms) / 1000));
}

function asBuffer(i16) {
  return Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength);
}

test('segmenter: speech then a pause is a boundary; silence alone never is', () => {
  const seg = createStreamSegmenter(RATE);
  assert.strictEqual(seg.push(silence(5000)), 'open');
  assert.strictEqual(seg.hadSpeech(), false);
  assert.strictEqual(seg.push(tone(400)), 'open');
  assert.strictEqual(seg.hadSpeech(), true);
  assert.strictEqual(seg.push(silence(700)), 'boundary');
});

test('segmenter: reset starts the next phrase from zero', () => {
  const seg = createStreamSegmenter(RATE);
  seg.push(tone(400));
  seg.push(silence(700));
  seg.reset();
  assert.strictEqual(seg.hadSpeech(), false);
  assert.strictEqual(seg.push(silence(2000)), 'open');
});

test('wavFromPcm16 writes a valid 16kHz mono RIFF header', () => {
  const wav = wavFromPcm16(asBuffer(tone(100)));
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.readUInt32LE(24), RATE);
  assert.strictEqual(wav.readUInt16LE(22), 1);
  assert.strictEqual(wav.readUInt32LE(40), wav.length - 44);
});

function stubTranscribe(fn) {
  const real = whisperService.transcribe;
  whisperService.transcribe = fn;
  return () => { whisperService.transcribe = real; };
}

test('session: phrase boundaries commit in order and stop() joins them', async () => {
  let calls = 0;
  const restore = stubTranscribe(async () => { calls += 1; return `phrase${calls}`; });
  const partials = [];
  const s = createStreamingSession({ resourceDir: '', userDataDir: '', onPartial: (p) => partials.push(p), previewIntervalMs: 3600000 });
  s.pushChunk(asBuffer(tone(400)));
  s.pushChunk(asBuffer(silence(700)));
  s.pushChunk(asBuffer(tone(400)));
  const out = await s.stop();
  restore();
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.text, 'phrase1 phrase2');
  assert.strictEqual(out.degraded, false);
  assert.strictEqual(partials[partials.length - 1].committed, 'phrase1 phrase2');
  const seqs = partials.map((p) => p.seq);
  assert.deepStrictEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test('session: a silence-only recording never buys a decode', async () => {
  let calls = 0;
  const restore = stubTranscribe(async () => { calls += 1; return 'hallucination'; });
  const s = createStreamingSession({ resourceDir: '', userDataDir: '', onPartial: () => {}, previewIntervalMs: 3600000 });
  s.pushChunk(asBuffer(silence(3000)));
  const out = await s.stop();
  restore();
  assert.strictEqual(calls, 0);
  assert.strictEqual(out.text, '');
});

test('session: a failed segment decode marks the result degraded', async () => {
  const restore = stubTranscribe(async () => { throw new Error('server-timeout'); });
  const s = createStreamingSession({ resourceDir: '', userDataDir: '', onPartial: () => {}, previewIntervalMs: 3600000 });
  s.pushChunk(asBuffer(tone(400)));
  const out = await s.stop();
  restore();
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.degraded, true);
});

test('stripSoundCaptions: captions and speaker marks go, words stay', () => {
  assert.strictEqual(stripSoundCaptions('[ Background sounds ]'), '');
  assert.strictEqual(stripSoundCaptions('[ Silence ] >> Hello world. [ Silence ]'), 'Hello world.');
  assert.strictEqual(stripSoundCaptions('(laughs) okay *music* done'), 'okay done');
  assert.strictEqual(stripSoundCaptions('plain dictated text'), 'plain dictated text');
});

test('session: a caption-only decode never becomes a committed phrase', async () => {
  const restore = stubTranscribe(async () => '[ Background sounds ]');
  const s = createStreamingSession({ resourceDir: '', userDataDir: '', onPartial: () => {}, previewIntervalMs: 3600000 });
  s.pushChunk(asBuffer(tone(400)));
  const out = await s.stop();
  restore();
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.text, '');
  assert.strictEqual(out.degraded, false);
});

test('session: chunks after cancel are dropped and stop reports stopped', async () => {
  const restore = stubTranscribe(async () => 'never');
  const s = createStreamingSession({ resourceDir: '', userDataDir: '', onPartial: () => {}, previewIntervalMs: 3600000 });
  s.cancel();
  s.pushChunk(asBuffer(tone(400)));
  const out = await s.stop();
  restore();
  assert.strictEqual(out.ok, false);
});
