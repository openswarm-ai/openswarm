"use client";

import * as React from "react";
import { ExternalLink, Play } from "lucide-react";
import { cn, Button } from "./_adapter";

import {
  formatDuration,
  getFitClass,
  openSafeNavigationHref,
  OVERLAY_GRADIENT,
  RATIO_CLASS_MAP,
} from "../shared/media";
import { VideoProvider, useVideo } from "./context";
import type { SerializableVideo } from "./schema";
import {
  getMuteMediaEvent,
  normalizeVideoDataForCallback,
  resolveVideoNavigation,
} from "./video-helpers";

const FALLBACK_LOCALE = "en-US";

export interface VideoProps extends SerializableVideo {
  className?: string;
  // Keep behavior flags intentionally minimal; prefer explicit variants over more booleans.
  autoPlay?: boolean;
  defaultMuted?: boolean;
  onNavigate?: (href: string, video: SerializableVideo) => void;
  onMediaEvent?: (type: "play" | "pause" | "mute" | "unmute") => void;
}

function VideoRoot(props: VideoProps) {
  const { defaultMuted = true, ...rest } = props;

  return (
    <VideoProvider defaultState={{ muted: defaultMuted }}>
      <VideoInner {...rest} />
    </VideoProvider>
  );
}

function VideoInner(props: Omit<VideoProps, "defaultMuted">) {
  const {
    className,
    autoPlay = true,
    onNavigate,
    onMediaEvent,
    ...serializable
  } = props;

  const {
    id,
    src,
    poster,
    title,
    description,
    href: rawHref,
    domain,
    durationMs,
    ratio = "16:9",
    fit = "cover",
    createdAt,
    source,
    locale: providedLocale,
  } = serializable;

  const locale = providedLocale ?? FALLBACK_LOCALE;
  const { sanitizedHref, sanitizedSourceUrl, primaryHref } =
    resolveVideoNavigation(rawHref, source?.url);

  const videoData: SerializableVideo = normalizeVideoDataForCallback(
    serializable,
    {
      ratio,
      fit,
      locale,
      sanitizedHref,
      sanitizedSourceUrl,
    },
  );

  const { state, setState, setVideoElement } = useVideo();
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const previousMutedRef = React.useRef(state.muted);

  React.useEffect(() => {
    setVideoElement(videoRef.current);
    return () => setVideoElement(null);
  }, [setVideoElement]);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.muted !== state.muted) {
      video.muted = state.muted;
    }
  }, [state.muted]);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (state.playing && video.paused) {
      void video.play().catch(() => undefined);
    } else if (!state.playing && !video.paused) {
      video.pause();
    }
  }, [state.playing]);

  const navigate = (targetHref: string) => {
    if (onNavigate) {
      onNavigate(targetHref, videoData);
    } else {
      openSafeNavigationHref(targetHref);
    }
  };

  const handleWatch = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  };

  const handleOpen = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!primaryHref) return;
    navigate(primaryHref);
  };

  const sourceLabel = source?.label;
  const metadataDomain = domain && domain !== sourceLabel ? domain : undefined;
  const hasMetadata = Boolean(
    description || sourceLabel || metadataDomain || durationMs || createdAt,
  );
  const hasOverlay = Boolean(title || primaryHref);

  return (
    <article
      className={cn("relative w-full min-w-80 max-w-md", className)}
      lang={locale}
      data-tool-ui-id={id}
      data-slot="video"
    >
      <div
        className={cn(
          "group @container relative isolate flex w-full min-w-0 flex-col overflow-hidden rounded-xl",
          "border border-border bg-card text-sm shadow-xs",
        )}
      >
        <div
          className={cn(
            "group relative w-full overflow-hidden bg-black",
            ratio !== "auto" ? RATIO_CLASS_MAP[ratio] : "aspect-video",
          )}
        >
          <video
            ref={videoRef}
            className={cn(
              "relative z-10 h-full w-full transition-transform duration-200 group-hover:scale-[1.01]",
              getFitClass(fit),
              ratio !== "auto" && "absolute inset-0 h-full w-full",
            )}
            src={src}
            poster={poster}
            controls
            playsInline
            autoPlay={autoPlay}
            preload="metadata"
            muted={state.muted}
            onPlay={() => {
              setState({ playing: true });
              onMediaEvent?.("play");
            }}
            onPause={() => {
              setState({ playing: false });
              onMediaEvent?.("pause");
            }}
            onVolumeChange={(event) => {
              const target = event.currentTarget;
              setState({ muted: target.muted });
              const mediaEvent = getMuteMediaEvent(
                previousMutedRef.current,
                target.muted,
              );
              previousMutedRef.current = target.muted;
              if (mediaEvent) {
                onMediaEvent?.(mediaEvent);
              }
            }}
          />
          {hasOverlay && (
            <>
              <div
                className="pointer-events-none absolute inset-x-0 top-0 z-20 h-32 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100"
                style={{ backgroundImage: OVERLAY_GRADIENT }}
              />
              <div className="absolute inset-x-0 top-0 z-30 flex items-start justify-between gap-2 px-5 pt-4 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
                {title ? (
                  <div className="line-clamp-2 max-w-[70%] font-semibold text-white drop-shadow-sm">
                    {title}
                  </div>
                ) : (
                  <span className="sr-only">Video controls</span>
                )}
                <div className="flex items-center gap-2">
                  {primaryHref && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleOpen}
                      className="bg-black/55 text-white hover:bg-black/70"
                    >
                      <ExternalLink
                        className="mr-1 h-4 w-4"
                        aria-hidden="true"
                      />
                      Open
                    </Button>
                  )}
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleWatch}
                    className="shadow-sm"
                  >
                    <Play className="mr-1 h-4 w-4" aria-hidden="true" />
                    Watch
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>

        {hasMetadata && (
          <div className="flex flex-col gap-1.5 px-4 py-3">
            {description && (
              <p className="text-foreground line-clamp-2 text-sm leading-snug">
                {description}
              </p>
            )}
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {sourceLabel && <span>{sourceLabel}</span>}
              {metadataDomain && <span>{metadataDomain}</span>}
              {typeof durationMs === "number" && (
                <span>{formatDuration(durationMs)}</span>
              )}
              {createdAt && (
                <time dateTime={createdAt}>
                  {formatCreatedAt(createdAt, locale)}
                </time>
              )}
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

function formatCreatedAt(createdAt: string, locale: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return createdAt;
  }

  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

type VideoComponent = typeof VideoRoot & {
  Root: typeof VideoRoot;
};

export const Video = Object.assign(VideoRoot, {
  Root: VideoRoot,
}) as VideoComponent;
