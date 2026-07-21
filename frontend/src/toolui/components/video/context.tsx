"use client";

import * as React from "react";

export interface VideoPlaybackState {
  playing: boolean;
  muted: boolean;
}

export interface VideoContextValue {
  state: VideoPlaybackState;
  setState: (patch: Partial<VideoPlaybackState>) => void;
  videoElement: HTMLVideoElement | null;
  setVideoElement: (node: HTMLVideoElement | null) => void;
}

const VideoContext = React.createContext<VideoContextValue | null>(null);

export function useVideo() {
  const ctx = React.useContext(VideoContext);
  if (!ctx) {
    throw new Error("useVideo must be used within a <VideoProvider />");
  }
  return ctx;
}

export interface VideoProviderProps {
  children: React.ReactNode;
  defaultState?: Partial<VideoPlaybackState>;
}

export function VideoProvider({ children, defaultState }: VideoProviderProps) {
  const [state, setStateInternal] = React.useState<VideoPlaybackState>({
    playing: defaultState?.playing ?? false,
    muted: defaultState?.muted ?? true,
  });

  const [videoElement, setVideoElement] =
    React.useState<HTMLVideoElement | null>(null);

  const setState = React.useCallback((patch: Partial<VideoPlaybackState>) => {
    setStateInternal((prev) => ({ ...prev, ...patch }));
  }, []);

  const value = React.useMemo(
    () => ({ state, setState, videoElement, setVideoElement }),
    [state, setState, videoElement],
  );

  return (
    <VideoContext.Provider value={value}>{children}</VideoContext.Provider>
  );
}
