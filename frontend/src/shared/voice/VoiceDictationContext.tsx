import React, { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { useAppSelector } from '@/shared/hooks';
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
  // Mic-button press semantics that respect the hold/toggle setting: press starts (or toggles),
  // release stops only in hold mode. Buttons wire onPointerDown/Up to these and stay mode-agnostic.
  pressStart: () => void;
  pressEnd: () => void;
  holdMode: boolean;
  volumeRef: React.MutableRefObject<number>;
}

const NOOP_REF = { current: 0 };
const NOOP: VoiceContextValue = { state: 'idle', lastText: '', error: null, pct: 0, feedback: null, toggle: () => {}, pressStart: () => {}, pressEnd: () => {}, holdMode: true, volumeRef: NOOP_REF };
const VoiceContext = createContext<VoiceContextValue>(NOOP);

export function VoiceDictationProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { state, lastText, error, pct, feedback, toggle, start, stop, volumeRef } = useVoiceDictation();
  const holdMode = useAppSelector((s) => s.settings.data.voice_hold_to_talk ?? true);
  const stateRef = useRef(state);
  stateRef.current = state;
  const heldRef = useRef(false);

  const pressStart = useCallback((): void => {
    if (holdMode) {
      if (stateRef.current === 'idle') { heldRef.current = true; void start(); }
    } else {
      toggle();
    }
  }, [holdMode, start, toggle]);

  const pressEnd = useCallback((): void => {
    if (holdMode && heldRef.current) {
      heldRef.current = false;
      if (stateRef.current === 'recording') void stop();
    }
  }, [holdMode, stop]);

  // The hotkey (Cmd/Ctrl+Shift+D) is press-to-start / press-to-stop, NOT hold: macOS delivers
  // NEITHER the letter keyup nor the modifier releases to any Chromium layer while Cmd is held
  // (proven empirically: DOM saw zero events, main's before-input-event saw only the first keyDown),
  // so a keyboard hold-release is undetectable without a native event tap (uiohook class, the real
  // fix, needs a packaged native module). Hold-to-talk lives on the mic buttons, which DO see
  // pointerup. In-app presses arrive via main's before-input relay (works with webview focus and
  // swallows the 'd' so it never types into a field); background presses via the global shortcut.
  useEffect(() => {
    const off = (window as unknown as { openswarm?: { onVoiceHold?: (d: () => void, u: () => void) => () => void } }).openswarm?.onVoiceHold?.(
      () => toggle(),
      () => {},
    );
    return () => { off?.(); };
  }, [toggle]);

  return (
    <VoiceContext.Provider value={{ state, lastText, error, pct, feedback, toggle, pressStart, pressEnd, holdMode, volumeRef }}>
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
