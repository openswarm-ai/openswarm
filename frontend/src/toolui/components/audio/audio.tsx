"use client";

import * as React from "react";
import { Pause, Play } from "lucide-react";
import { cn, Button, Slider } from "./_adapter";

import { AudioProvider, useAudio } from "./context";
import type { SerializableAudio, AudioVariant } from "./schema";

const FALLBACK_LOCALE = "en-US";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export interface AudioProps extends SerializableAudio {
  variant?: AudioVariant;
  className?: string;
  onMediaEvent?: (type: "play" | "pause" | "mute" | "unmute") => void;
}

export function Audio(props: AudioProps) {
  return (
    <AudioProvider>
      <AudioInner {...props} />
    </AudioProvider>
  );
}

interface PlayerControls {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onPlayPause: () => void;
  onSeek: (value: number[]) => void;
  onSeekStart: () => void;
  onSeekEnd: () => void;
}

interface FullPlayerProps {
  artwork?: string;
  title?: string;
  description?: string;
  controls: PlayerControls;
}

function FullPlayer({
  artwork,
  title,
  description,
  controls,
}: FullPlayerProps) {
  return (
    <div className="flex w-full flex-col">
      {artwork && (
        <div className="bg-muted relative aspect-[4/3] w-full overflow-hidden">
          <img
            src={artwork}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover"
          />
        </div>
      )}
      <div className="flex flex-col gap-5 p-4">
        {(title || description) && (
          <div className="space-y-0.5">
            {title && (
              <div className="text-foreground line-clamp-2 font-semibold leading-snug">
                {title}
              </div>
            )}
            {description && (
              <div className="text-muted-foreground line-clamp-2 text-sm leading-snug">
                {description}
              </div>
            )}
          </div>
        )}
        <div className="flex items-start gap-3">
          <div className="flex flex-1 flex-col gap-2">
            <Slider
              value={[controls.currentTime]}
              max={controls.duration || 100}
              step={0.1}
              onValueChange={controls.onSeek}
              onPointerDown={controls.onSeekStart}
              onPointerUp={controls.onSeekEnd}
              className="cursor-pointer [&_[data-slot=range]]:bg-foreground [&_[data-slot=thumb]]:size-3 [&_[data-slot=thumb]]:border-2 [&_[data-slot=thumb]]:border-background [&_[data-slot=thumb]]:bg-foreground"
              aria-label="Audio progress"
            />
            <div className="text-muted-foreground flex items-center justify-between text-xs tabular-nums">
              <span>{formatTime(controls.currentTime)}</span>
              <span>{formatTime(controls.duration)}</span>
            </div>
          </div>
          <Button
            variant="default"
            size="icon"
            onClick={controls.onPlayPause}
            className="-mt-4 size-10 shrink-0 rounded-full"
            aria-label={controls.isPlaying ? "Pause" : "Play"}
          >
            {controls.isPlaying ? (
              <Pause className="size-4" fill="currentColor" />
            ) : (
              <Play className="size-4 ml-0.5" fill="currentColor" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface CompactPlayerProps {
  artwork?: string;
  title?: string;
  description?: string;
  controls: PlayerControls;
}

function CompactPlayer({
  artwork,
  title,
  description,
  controls,
}: CompactPlayerProps) {
  const progress =
    controls.duration > 0
      ? (controls.currentTime / controls.duration) * 100
      : 0;

  return (
    <div className="relative flex w-full items-center gap-3 overflow-hidden p-3">
      {artwork && (
        <>
          <img
            src={artwork}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute -left-1/4 top-1/2 h-[200%] w-auto -translate-y-1/2 object-cover opacity-40 blur-2xl saturate-150"
          />
          <div className="from-card/60 to-card/90 pointer-events-none absolute inset-0 bg-gradient-to-r" />
        </>
      )}
      {artwork && (
        <div className="ring-background/20 relative size-12 shrink-0 overflow-hidden rounded-lg shadow-lg ring-1">
          <img
            src={artwork}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover"
          />
        </div>
      )}
      <div className="relative flex min-w-0 flex-1 flex-col justify-center">
        {title && (
          <div className="text-foreground truncate text-sm font-semibold leading-tight">
            {title}
          </div>
        )}
        {description && (
          <div className="text-muted-foreground mt-0.5 truncate text-xs leading-tight">
            {description}
          </div>
        )}
        {controls.duration > 0 && (
          <div className="mt-1 flex items-center gap-2">
            <div className="bg-foreground/20 relative h-1 flex-1 overflow-hidden rounded-full">
              <div
                className="bg-foreground absolute inset-y-0 left-0 rounded-full transition-all duration-150"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-muted-foreground text-xs tabular-nums">
              {formatTime(controls.currentTime)}
            </span>
          </div>
        )}
      </div>
      <Button
        variant="default"
        size="icon"
        onClick={controls.onPlayPause}
        className="relative size-10 shrink-0 rounded-full shadow-md"
        aria-label={controls.isPlaying ? "Pause" : "Play"}
      >
        {controls.isPlaying ? (
          <Pause className="size-4" fill="currentColor" />
        ) : (
          <Play className="size-4 ml-0.5" fill="currentColor" />
        )}
      </Button>
    </div>
  );
}

function AudioInner(props: AudioProps) {
  const { variant = "full", className, onMediaEvent, ...serializable } = props;

  const {
    id,
    src,
    title,
    description,
    artwork,
    locale: providedLocale,
  } = serializable;

  const locale = providedLocale ?? FALLBACK_LOCALE;

  const { state, setState, setAudioElement } = useAudio();
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [isSeeking, setIsSeeking] = React.useState(false);

  React.useEffect(() => {
    setAudioElement(audioRef.current);
    return () => setAudioElement(null);
  }, [setAudioElement]);

  React.useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (state.playing && audio.paused) {
      void audio.play().catch(() => undefined);
    } else if (!state.playing && !audio.paused) {
      audio.pause();
    }
  }, [state.playing]);

  const handlePlayPause = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch(() => undefined);
    } else {
      audio.pause();
    }
  };

  const handleSeek = (value: number[]) => {
    const audio = audioRef.current;
    if (!audio) return;
    const newTime = value[0];
    audio.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const handleSeekStart = () => {
    setIsSeeking(true);
  };

  const handleSeekEnd = () => {
    setIsSeeking(false);
  };

  const controls: PlayerControls = {
    isPlaying: state.playing,
    currentTime,
    duration,
    onPlayPause: handlePlayPause,
    onSeek: handleSeek,
    onSeekStart: handleSeekStart,
    onSeekEnd: handleSeekEnd,
  };

  const isCompact = variant === "compact";

  return (
    <article
      className={cn(
        "@container/actions relative w-full",
        isCompact ? "min-w-72 max-w-md" : "min-w-52 max-w-sm",
        className,
      )}
      lang={locale}
      data-tool-ui-id={id}
      data-slot="audio"
    >
      <div
        className={cn(
          "group @container relative isolate flex w-full min-w-0 flex-col overflow-hidden",
          "border-border bg-card border text-sm shadow-xs",
          "rounded-xl",
        )}
      >
        {isCompact ? (
          <CompactPlayer
            artwork={artwork}
            title={title}
            description={description}
            controls={controls}
          />
        ) : (
          <FullPlayer
            artwork={artwork}
            title={title}
            description={description}
            controls={controls}
          />
        )}

        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          className="hidden"
          onPlay={() => {
            setState({ playing: true });
            onMediaEvent?.("play");
          }}
          onPause={() => {
            setState({ playing: false });
            onMediaEvent?.("pause");
          }}
          onTimeUpdate={(event) => {
            if (!isSeeking) {
              setCurrentTime(event.currentTarget.currentTime);
            }
          }}
          onLoadedMetadata={(event) => {
            setDuration(event.currentTarget.duration);
          }}
          onDurationChange={(event) => {
            setDuration(event.currentTarget.duration);
          }}
        />
      </div>
    </article>
  );
}
