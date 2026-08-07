import React, { useCallback, useEffect, useRef } from 'react';
import { useAppSelector } from '@/shared/hooks';
import { useVoiceDictation } from './useVoiceDictation';
import { playVoiceCue, configureVoiceCues } from './voiceCues';
import { setManualDictionary } from './voiceDictionary';
import { VoiceContext } from './voiceContext';
import VoiceOverlay from './VoiceOverlay';

// One recorder for the whole app. Both mics (the Help pill and the spawn composer) plus the global
// hotkey drive the SAME dictation session, so two mics can't fight over the microphone or show
// out-of-sync state. Mounted once near the app root.

export function VoiceDictationProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { state, lastText, error, pct, feedback, partial, target, toggle, start, stop, cancel, notify, volumeRef } = useVoiceDictation();

  // fn is the dictation key, but macOS may still have its own Globe action bound (emoji picker on a quick tap); say so once.
  const globeWarnedRef = useRef(false);
  useEffect(() => {
    const bridge = window as unknown as { openswarm?: { onVoiceGlobeConflict?: (cb: () => void) => () => void } };
    const off = bridge.openswarm?.onVoiceGlobeConflict?.(() => {
      if (globeWarnedRef.current) return;
      globeWarnedRef.current = true;
      notify('Tip: set System Settings > Keyboard > "Press Globe key to" to "Do Nothing" so fn only dictates.');
    });
    return () => { off?.(); };
  }, [notify]);
  const holdMode = useAppSelector((s) => s.settings.data.voice_hold_to_talk ?? true);
  const dictationShortcut = useAppSelector((s) => s.settings.data.dictation_shortcut ?? null);
  const dictationModel = useAppSelector((s) => s.settings.data.dictation_model ?? null);

  // Push the user's combo to main on boot and on change so every hotkey tier rebinds live.
  useEffect(() => {
    const bridge = window as unknown as { openswarm?: { setVoiceHotkey?: (combo: string | null) => void } };
    bridge.openswarm?.setVoiceHotkey?.(dictationShortcut);
  }, [dictationShortcut]);

  // Main boots with the catalog default, so a user who picked something else has to say so on every
  // launch or dictation quietly runs on the wrong model.
  useEffect(() => {
    if (dictationModel) void window.openswarm?.voiceSetModel?.(dictationModel);
  }, [dictationModel]);

  // Personal glossary rides every decode as a whisper prompt (manual list merged with learned nouns).
  const dictationDictionary = useAppSelector((s) => s.settings.data.dictation_dictionary ?? '');
  useEffect(() => {
    setManualDictionary(dictationDictionary);
  }, [dictationDictionary]);

  // Cue sounds honor the user's toggle and loudness.
  const cueSounds = useAppSelector((s) => s.settings.data.dictation_sounds ?? true);
  const cueVolume = useAppSelector((s) => s.settings.data.dictation_sound_volume ?? 0.7);
  useEffect(() => {
    configureVoiceCues(cueSounds, cueVolume);
  }, [cueSounds, cueVolume]);
  const stateRef = useRef(state);
  stateRef.current = state;
  const heldRef = useRef(false);

  // A quick tap releases before start() flips state to 'recording': the session latches hands-free
  // (Wispr's lock). The lock cue lands once recording is actually live, confirming the latch.
  const latchedRef = useRef(false);

  const pressStart = useCallback((): void => {
    if (holdMode) {
      // A TAP while recording must stop: the quick tap's press-end fires before the async start
      // flips state to 'recording', so without this the mic could be started by a click but never
      // stopped by one.
      if (stateRef.current === 'recording') { heldRef.current = false; void stop(); return; }
      if (stateRef.current === 'idle') { heldRef.current = true; latchedRef.current = false; void start(true); }
    } else {
      toggle();
    }
  }, [holdMode, start, stop, toggle]);

  const pressEnd = useCallback((): void => {
    if (holdMode && heldRef.current) {
      heldRef.current = false;
      if (stateRef.current === 'recording') void stop();
      else latchedRef.current = true;
    }
  }, [holdMode, stop]);

  useEffect(() => {
    if (state === 'recording' && latchedRef.current) {
      latchedRef.current = false;
      const t = setTimeout(() => playVoiceCue('lock'), 160);
      return () => clearTimeout(t);
    }
    if (state === 'idle') latchedRef.current = false;
    return undefined;
  }, [state]);

  // Keyboard hotkey channels, matched to what the source can actually see:
  // voice:hold-down/up come ONLY from main's native uiohook tap (real global key-up, so the keyboard
  // gets the same hold-vs-toggle press semantics as the mic buttons); voice:toggle comes from the
  // fallback tier (globalShortcut / before-input relay), where key-ups are undetectable, so each
  // press toggles. Whichever tier main activated, the renderer just honors the channel it hears.
  useEffect(() => {
    const bridge = window as unknown as {
      openswarm?: { onVoiceHold?: (d: () => void, u: () => void) => () => void };
    };
    const offHold = bridge.openswarm?.onVoiceHold?.(pressStart, pressEnd);
    return () => { offHold?.(); };
  }, [pressStart, pressEnd]);

  // Wispr grammar: Esc while the mic is hot throws the take away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && stateRef.current === 'recording') {
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [cancel]);

  const confirmRecording = useCallback((): void => { void stop(); }, [stop]);

  return (
    <VoiceContext.Provider value={{ state, lastText, error, pct, feedback, partial, target, toggle, pressStart, pressEnd, confirmRecording, cancelRecording: cancel, holdMode, volumeRef }}>
      {children}
      <VoiceOverlay />
    </VoiceContext.Provider>
  );
}
