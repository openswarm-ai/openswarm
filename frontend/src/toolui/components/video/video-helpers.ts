import type { SerializableVideo } from "./schema";
import { resolveSafeNavigationHref, sanitizeHref } from "../shared/media";

export type VideoMediaEvent = "mute" | "unmute";

export interface ResolvedVideoNavigation {
  sanitizedHref: string | undefined;
  sanitizedSourceUrl: string | undefined;
  primaryHref: string | undefined;
}

export function getMuteMediaEvent(
  previousMuted: boolean,
  nextMuted: boolean,
): VideoMediaEvent | null {
  if (previousMuted === nextMuted) {
    return null;
  }

  return nextMuted ? "mute" : "unmute";
}

export function resolveVideoNavigation(
  rawHref: string | undefined,
  rawSourceUrl: string | undefined,
): ResolvedVideoNavigation {
  const sanitizedHref = sanitizeHref(rawHref);
  const sanitizedSourceUrl = sanitizeHref(rawSourceUrl);

  return {
    sanitizedHref,
    sanitizedSourceUrl,
    primaryHref: resolveSafeNavigationHref(sanitizedHref, sanitizedSourceUrl),
  };
}

export function normalizeVideoDataForCallback(
  video: SerializableVideo,
  normalized: {
    ratio: NonNullable<SerializableVideo["ratio"]>;
    fit: NonNullable<SerializableVideo["fit"]>;
    locale: string;
    sanitizedHref: string | undefined;
    sanitizedSourceUrl: string | undefined;
  },
): SerializableVideo {
  return {
    ...video,
    ratio: normalized.ratio,
    fit: normalized.fit,
    href: normalized.sanitizedHref,
    source: video.source
      ? { ...video.source, url: normalized.sanitizedSourceUrl }
      : undefined,
    locale: normalized.locale,
  };
}
