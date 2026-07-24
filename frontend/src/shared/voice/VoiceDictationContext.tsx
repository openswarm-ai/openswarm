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

  // In-app hold-to-talk on the same combo as the global hotkey (Cmd/Ctrl+Shift+D). Main unregisters
  // the global shortcut while our window is focused, so these real keydown/keyup events reach us;
  // when the app is in the background the global shortcut still fires as a toggle (the OS gives us
  // no key-up out there without a native event tap).
  useEffect(() => {
    const isCombo = (e: KeyboardEvent): boolean => (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'd' || e.key === 'D');
    let watchdog = 0;
    const release = (): void => {
      if (!heldRef.current) return;
      heldRef.current = false;
      window.clearTimeout(watchdog);
      if (stateRef.current === 'recording') void stop();
    };
    const down = (e: KeyboardEvent): void => {
      if (!isCombo(e)) return;
      e.preventDefault();
      if (!holdMode) { if (!e.repeat) toggle(); return; }
      if (!e.repeat && stateRef.current === 'idle') { heldRef.current = true; void start(); }
      // Belt-and-braces release detection: macOS suppresses letter keyups while Cmd is held, so once
      // the OS autorepeat stream starts, its going quiet means the key was let go. Arms only after the
      // first repeat, so keyboards with repeat disabled still rely on the plain keyup below.
      if (e.repeat && heldRef.current) {
        window.clearTimeout(watchdog);
        watchdog = window.setTimeout(release, 900);
      }
    };
    const up = (e: KeyboardEvent): void => {
      if (!holdMode || !heldRef.current) return;
      // Any piece of the combo lifting ends the hold; key-order on release varies by hand.
      if (e.key === 'd' || e.key === 'D' || e.key === 'Meta' || e.key === 'Control' || e.key === 'Shift') release();
    };
    // Switching windows mid-hold must never leave the mic hot.
    const onBlur = (): void => release();
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.clearTimeout(watchdog);
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [holdMode, start, stop, toggle]);

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
