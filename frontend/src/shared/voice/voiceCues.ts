import { VOICE_CUE_START, VOICE_CUE_STOP, VOICE_CUE_LOCK } from './voiceCueSounds';

// Eric picked these from Google's Material product sound set after a bake-off against Wispr Flow's
// real cues; the synth versions never survived an ear test. Files are embedded data URIs (see
// voiceCueSounds.ts), pre-instantiated so playback is instant on the press. Start and stop taps plus the
// hands-free lock mark; Eric explicitly cut the text-landed chime.

type CueKind = 'start' | 'stop' | 'lock';

// Pushed from Settings (dictation_sounds / dictation_sound_volume); defaults match the shipped feel.
let cueEnabled = true;
let cueVolume = 0.7;

export function configureVoiceCues(enabled: boolean, volume: number): void {
  cueEnabled = enabled;
  cueVolume = Math.min(1, Math.max(0, volume));
  for (const kind of Object.keys(p_players) as CueKind[]) {
    const a = p_players[kind];
    if (a) a.volume = cueVolume;
  }
}

const SOURCES: Record<CueKind, string> = {
  start: VOICE_CUE_START,
  stop: VOICE_CUE_STOP,
  lock: VOICE_CUE_LOCK,
};

const p_players: Partial<Record<CueKind, HTMLAudioElement>> = {};

function player(kind: CueKind): HTMLAudioElement {
  let a = p_players[kind];
  if (!a) {
    a = new Audio(SOURCES[kind]);
    a.volume = cueVolume;
    p_players[kind] = a;
  }
  return a;
}

export function playVoiceCue(kind: CueKind): void {
  if (!cueEnabled) return;
  try {
    const a = player(kind);
    a.currentTime = 0;
    void a.play();
  } catch { /* a missing audio device must never break dictation */ }
}
