// Tiny WebAudio cues for dictation, generated in code (no bundled assets): a soft rising two-note on
// start, falling on cancel, and a quiet tick when text lands. Volumes stay whisper-level on purpose.
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function blip(freqs: Array<[number, number, number]>): void {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime;
  for (const [freq, at, dur] of freqs) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0 + at);
    gain.gain.linearRampToValueAtTime(0.055, t0 + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + dur + 0.05);
  }
}

export function playStart(): void { blip([[523, 0, 0.12], [784, 0.09, 0.16]]); }
export function playCancel(): void { blip([[784, 0, 0.1], [523, 0.08, 0.14]]); }
export function playDone(): void { blip([[1047, 0, 0.09]]); }
