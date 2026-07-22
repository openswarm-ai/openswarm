import React, { createContext, useContext } from 'react';
import { useVoiceDictation, VoiceState } from './useVoiceDictation';

// One recorder for the whole app. Both mics (the Help pill and the spawn composer) plus the global
// hotkey drive the SAME dictation session, so two mics can't fight over the microphone or show
// out-of-sync state. Mounted once near the app root.
interface VoiceContextValue {
  state: VoiceState;
  lastText: string;
  error: string | null;
  pct: number;
  toggle: () => void;
}

const NOOP: VoiceContextValue = { state: 'idle', lastText: '', error: null, pct: 0, toggle: () => {} };
const VoiceContext = createContext<VoiceContextValue>(NOOP);

export function VoiceDictationProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { state, lastText, error, pct, toggle } = useVoiceDictation();
  return (
    <VoiceContext.Provider value={{ state, lastText, error, pct, toggle }}>
      {children}
    </VoiceContext.Provider>
  );
}

// A component rendered outside the provider (or a web build with no Electron bridge) gets the no-op,
// so mics still render and just do nothing rather than crashing.
export function useVoice(): VoiceContextValue {
  return useContext(VoiceContext);
}
