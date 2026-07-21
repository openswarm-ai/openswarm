"use client";

import * as React from "react";

export interface AudioPlaybackState {
  playing: boolean;
  muted: boolean;
}

export interface AudioContextValue {
  state: AudioPlaybackState;
  setState: (patch: Partial<AudioPlaybackState>) => void;
  audioElement: HTMLAudioElement | null;
  setAudioElement: (node: HTMLAudioElement | null) => void;
}

const AudioContext = React.createContext<AudioContextValue | null>(null);

export function useAudio() {
  const ctx = React.useContext(AudioContext);
  if (!ctx) {
    throw new Error("useAudio must be used within an <AudioProvider />");
  }
  return ctx;
}

export interface AudioProviderProps {
  children: React.ReactNode;
  defaultState?: Partial<AudioPlaybackState>;
}

export function AudioProvider({ children, defaultState }: AudioProviderProps) {
  const [state, setStateInternal] = React.useState<AudioPlaybackState>({
    playing: defaultState?.playing ?? false,
    muted: defaultState?.muted ?? false,
  });

  const [audioElement, setAudioElement] =
    React.useState<HTMLAudioElement | null>(null);

  const setState = React.useCallback((patch: Partial<AudioPlaybackState>) => {
    setStateInternal((prev) => ({ ...prev, ...patch }));
  }, []);

  const value = React.useMemo(
    () => ({ state, setState, audioElement, setAudioElement }),
    [state, setState, audioElement],
  );

  return (
    <AudioContext.Provider value={value}>{children}</AudioContext.Provider>
  );
}
