import React, { createContext, useContext } from 'react';
import { InjectTargetInfo, VoiceState, VoiceFeedback, VoicePartial } from './useVoiceDictation';

// The context lives below both the provider and the overlay so neither imports the other
// (VoiceDictationContext renders VoiceOverlay; both reach down here instead of sideways).
export interface VoiceContextValue {
  state: VoiceState;
  lastText: string;
  error: string | null;
  pct: number;
  feedback: VoiceFeedback | null;
  partial: VoicePartial | null;
  // Where the transcript will land right now, in user words plus the surface's icon.
  target: InjectTargetInfo;
  toggle: () => void;
  // Open and park the mic before the first press, so it is not cold when the user actually
  // clicks (ENG-300). Safe to call repeatedly; a no-op once armed or while recording.
  prewarm: () => void;
  // Mic-button press semantics that respect the hold/toggle setting: press starts (or toggles),
  // release stops only in hold mode. Buttons wire onPointerDown/Up to these and stay mode-agnostic.
  pressStart: () => void;
  pressEnd: () => void;
  // The recording capsule's two endings: keep the take (transcribe + inject) or throw it away.
  confirmRecording: () => void;
  cancelRecording: () => void;
  holdMode: boolean;
  volumeRef: React.MutableRefObject<number>;
}

const NOOP_REF = { current: 0 };
const NOOP: VoiceContextValue = { state: 'idle', lastText: '', error: null, pct: 0, feedback: null, partial: null, target: { label: '', icon: null, composerId: null }, toggle: () => {}, prewarm: () => {}, pressStart: () => {}, pressEnd: () => {}, confirmRecording: () => {}, cancelRecording: () => {}, holdMode: true, volumeRef: NOOP_REF };

export const VoiceContext = createContext<VoiceContextValue>(NOOP);

// A component rendered outside the provider (or a web build with no Electron bridge) gets the no-op,
// so mics still render and just do nothing rather than crashing.
export function useVoice(): VoiceContextValue {
  return useContext(VoiceContext);
}
