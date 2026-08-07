// Phrase boundaries for streaming dictation: close a segment after real speech plus a short pause,
// so preview re-decodes stay bounded to the current phrase and closed phrases are never re-decoded.
// Constants come from shipping code, not guesses: the 0.004 RMS / 0.02 peak speech test matches the
// renderer's endpointer (TypeWhisper + openwhispr values), the 250ms-speech / 600ms-silence commit
// window is TypeWhisper-Windows' LegacyVad, and the 30s force-commit is whisper's native window.

const FRAME_MS = 20;
const SPEECH_RMS = 0.004;
const SPEECH_PEAK = 0.02;
const MIN_SPEECH_MS = 250;
const BOUNDARY_SILENCE_MS = 600;
const MAX_SEGMENT_MS = 30000;

// Feed Int16 PCM chunks; 'boundary' means commit the open segment now. hadSpeech() reports whether
// the segment being closed ever contained real speech (a silence-only segment must never be decoded,
// that is the classic "Thank you for watching" hallucination generator).
function createStreamSegmenter(sampleRate) {
  const frameSize = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  let speechMs = 0;
  let silenceMs = 0;
  let elapsedMs = 0;
  let sumSquares = 0;
  let peak = 0;
  let framed = 0;

  return {
    push(samples) {
      for (let i = 0; i < samples.length; i++) {
        const v = samples[i] / 0x8000;
        sumSquares += v * v;
        const mag = v < 0 ? -v : v;
        if (mag > peak) peak = mag;
        if (++framed < frameSize) continue;
        const rms = Math.sqrt(sumSquares / frameSize);
        const isSpeech = rms >= SPEECH_RMS && peak >= SPEECH_PEAK;
        sumSquares = 0;
        peak = 0;
        framed = 0;
        elapsedMs += FRAME_MS;
        if (isSpeech) {
          speechMs += FRAME_MS;
          silenceMs = 0;
        } else if (speechMs >= MIN_SPEECH_MS) {
          silenceMs += FRAME_MS;
        }
        if ((speechMs >= MIN_SPEECH_MS && silenceMs >= BOUNDARY_SILENCE_MS) || elapsedMs >= MAX_SEGMENT_MS) {
          return 'boundary';
        }
      }
      return 'open';
    },
    hadSpeech() {
      return speechMs >= MIN_SPEECH_MS;
    },
    // A boundary was acted on: start counting the next segment from zero.
    reset() {
      speechMs = 0;
      silenceMs = 0;
      elapsedMs = 0;
      sumSquares = 0;
      peak = 0;
      framed = 0;
    },
  };
}

module.exports = { createStreamSegmenter };
