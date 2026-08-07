// Streaming dictation over the SAME warm whisper-server the batch path uses: no engine swap, the
// renderer streams PCM here and this loop re-decodes the current open phrase every ~1.2s so partials
// appear live (openwhispr's preview-loop design). A phrase closed by the segmenter is decoded ONCE
// and committed forever, so per-tick decode cost is O(open phrase), never O(whole utterance).
// All state transitions are synchronous; only decodes are async and each carries the epoch it was
// started under, so a stale decode can never rewrite a later segment's text.

const whisperService = require('./whisperService');
const { createStreamSegmenter } = require('./streamSegmenter');

const PREVIEW_INTERVAL_MS = 1200;
// openwhispr's gate: silence must never buy a decode (cost) or a hallucinated caption (worse).
const PREVIEW_RMS_GATE = 0.002;
const SAMPLE_RATE = 16000;
// A speechless open buffer is trimmed so holding the hotkey in a quiet room can't grow memory forever.
const SILENT_KEEP_BYTES = SAMPLE_RATE * 2 * 2;
const SILENT_TRIM_BYTES = SAMPLE_RATE * 2 * 10;

// Whisper captions non-speech in brackets/parens ("[ Background sounds ]", "(laughs)"); strip them so
// neither the live preview nor a committed phrase ever carries a caption instead of dictation.
function stripSoundCaptions(text) {
  return String(text || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|(?:^|\s)>>\s?/g, ' ').replace(/\s+/g, ' ').trim();
}

function wavFromPcm16(pcm) {
  const buf = Buffer.alloc(44 + pcm.length);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24); buf.writeUInt32LE(SAMPLE_RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(pcm.length, 40);
  pcm.copy(buf, 44);
  return buf;
}

function createStreamingSession({ resourceDir, userDataDir, onPartial, previewIntervalMs = PREVIEW_INTERVAL_MS }) {
  let open = [];
  let openBytes = 0;
  const committed = [];
  let tentative = '';
  let seq = 0;
  let closedDown = false;
  let degraded = false;
  let inflight = null;
  let skipNext = false;
  let sinceTickSumSq = 0;
  let sinceTickSamples = 0;
  let segEpoch = 0;
  // Segment finals must land in spoken order; preview decodes stay outside the chain, epoch-guarded.
  let commitChain = Promise.resolve();
  const segmenter = createStreamSegmenter(SAMPLE_RATE);
  const timer = setInterval(() => { void previewTick(); }, previewIntervalMs);
  if (timer.unref) timer.unref();

  function emit() {
    seq += 1;
    try { onPartial({ committed: committed.join(' ').trim(), tentative, seq }); } catch (_) { /* renderer gone */ }
  }

  function decodePcm(pcm) {
    return whisperService.transcribe(resourceDir, userDataDir, wavFromPcm16(pcm));
  }

  async function previewTick() {
    if (closedDown || inflight) return;
    if (skipNext) { skipNext = false; return; }
    if (!openBytes || !segmenter.hadSpeech()) return;
    const rms = sinceTickSamples ? Math.sqrt(sinceTickSumSq / sinceTickSamples) : 0;
    sinceTickSumSq = 0;
    sinceTickSamples = 0;
    if (rms < PREVIEW_RMS_GATE) return; // nothing new was said; the last hypothesis stands
    const pcm = Buffer.concat(open);
    const epoch = segEpoch;
    const t0 = Date.now();
    inflight = decodePcm(pcm)
      .then((text) => {
        if (closedDown || epoch !== segEpoch) return; // the segment closed mid-decode; its final wins
        tentative = stripSoundCaptions(text);
        emit();
      })
      .catch(() => { skipNext = true; })
      .finally(() => {
        inflight = null;
        // FluidVoice back-pressure: a decode that overran its interval earns the next tick off.
        if (Date.now() - t0 > previewIntervalMs) skipNext = true;
      });
    await inflight;
  }

  // Synchronously seals the open buffer into a segment, then decodes it once on the ordered chain.
  function closeOpenSegment() {
    if (!openBytes) return;
    const hadSpeech = segmenter.hadSpeech();
    const pcm = Buffer.concat(open);
    open = [];
    openBytes = 0;
    segEpoch += 1;
    tentative = '';
    segmenter.reset();
    if (!hadSpeech) { emit(); return; }
    commitChain = commitChain.then(async () => {
      if (inflight) await inflight;
      try {
        const text = stripSoundCaptions(await decodePcm(pcm));
        if (text) committed.push(text);
      } catch (_) {
        degraded = true; // a lost phrase final means the caller must fall back to the full-clip decode
      }
      emit();
    });
  }

  return {
    pushChunk(buf) {
      if (closedDown || !buf || !buf.length) return;
      open.push(buf);
      openBytes += buf.length;
      const i16 = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
      for (let i = 0; i < i16.length; i++) {
        const v = i16[i] / 0x8000;
        sinceTickSumSq += v * v;
      }
      sinceTickSamples += i16.length;
      if (segmenter.push(i16) === 'boundary') {
        closeOpenSegment();
      } else if (!segmenter.hadSpeech() && openBytes > SILENT_TRIM_BYTES) {
        while (openBytes - open[0].length >= SILENT_KEEP_BYTES) openBytes -= open.shift().length;
      }
    },
    async stop() {
      if (closedDown) return { ok: false, error: 'stopped' };
      clearInterval(timer);
      closeOpenSegment();
      closedDown = true;
      await commitChain;
      return { ok: true, text: committed.join(' ').trim(), degraded };
    },
    cancel() {
      clearInterval(timer);
      closedDown = true;
      open = [];
      openBytes = 0;
    },
  };
}

module.exports = { createStreamingSession, wavFromPcm16, stripSoundCaptions };
