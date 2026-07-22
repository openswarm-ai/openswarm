import React, { createContext, useContext } from 'react';
import { useVoiceDictation, VoiceState, VoiceFeedback } from './useVoiceDictation';
import VoiceOverlay from './VoiceOverlay';

// One recorder for the whole app. Both mics (the Help pill and the spawn composer) plus the global
// hotkey drive the SAME dictation session, so two mics can't fight over the microphone or show
// out-of-sync state. Mounted once near the app root.
interface VoiceContextValue {
  state: VoiceState;
  lastText: string;
  error: string | null;
  pct: number;
  feedback: VoiceFeedback | null;
  toggle: () => void;
}

const NOOP: VoiceContextValue = { state: 'idle', lastText: '', error: null, pct: 0, feedback: null, toggle: () => {} };
const VoiceContext = createContext<VoiceContextValue>(NOOP);

export function VoiceDictationProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { state, lastText, error, pct, feedback, toggle } = useVoiceDictation();
  return (
    <VoiceContext.Provider value={{ state, lastText, error, pct, feedback, toggle }}>
      {children}
      <VoiceOverlay />
    </VoiceContext.Provider>
  );
}

// A component rendered outside the provider (or a web build with no Electron bridge) gets the no-op,
// so mics still render and just do nothing rather than crashing.
export function useVoice(): VoiceContextValue {
  return useContext(VoiceContext);
}
