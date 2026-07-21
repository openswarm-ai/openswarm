"use client";

import * as React from "react";
import { cn } from "./_adapter";

import {
  RATIO_CLASS_MAP,
  getFitClass,
  openSafeNavigationHref,
  resolveSafeNavigationHref,
  sanitizeHref,
} from "../shared/media";
import type { SerializableImage, Source } from "./schema";

const FALLBACK_LOCALE = "en-US";

export interface ImageProps extends SerializableImage {
  className?: string;
  onNavigate?: (href: string, image: SerializableImage) => void;
}

export function Image(props: ImageProps) {
  const { className, onNavigate, ...serializable } = props;

  const {
    id,
    src,
    alt,
    title,
    href: rawHref,
    domain,
    ratio = "auto",
    fit = "cover",
    source,
    locale: providedLocale,
  } = serializable;

  const locale = providedLocale ?? FALLBACK_LOCALE;
  const sanitizedHref = sanitizeHref(rawHref);
  const resolvedSourceUrl = sanitizeHref(source?.url);

  const imageData: SerializableImage = {
    ...serializable,
    href: sanitizedHref,
    source: source ? { ...source, url: resolvedSourceUrl } : undefined,
    locale,
  };

  const sourceLabel = source?.label ?? domain;
  const fallbackInitial = (sourceLabel ?? "").trim().charAt(0).toUpperCase();
  const hasSource = Boolean(sourceLabel || source?.iconUrl);

  const handleSourceClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const targetUrl = resolveSafeNavigationHref(
      resolvedSourceUrl,
      source?.url,
      sanitizedHref,
      src,
    );
    if (!targetUrl) return;
    if (onNavigate) {
      onNavigate(targetUrl, imageData);
    } else {
      openSafeNavigationHref(targetUrl);
    }
  };

  const handleImageClick = () => {
    if (!sanitizedHref) return;
    if (onNavigate) {
      onNavigate(sanitizedHref, imageData);
    } else {
      openSafeNavigationHref(sanitizedHref);
    }
  };

  const hasMetadata = title || hasSource;

  return (
    <article
      className={cn("relative w-full max-w-md min-w-80", className)}
      lang={locale}
      data-tool-ui-id={id}
      data-slot="image"
    >
      <div
        className={cn(
          "group @container relative isolate flex w-full min-w-0 flex-col overflow-hidden rounded-xl",
          "border-border bg-card border text-sm shadow-xs",
        )}
      >
        <>
          <div
            className={cn(
              "bg-muted group relative w-full overflow-hidden",
              ratio !== "auto" ? RATIO_CLASS_MAP[ratio] : "min-h-[160px]",
              sanitizedHref && "cursor-pointer",
            )}
            onClick={sanitizedHref ? handleImageClick : undefined}
            role={sanitizedHref ? "link" : undefined}
            tabIndex={sanitizedHref ? 0 : undefined}
            onKeyDown={
              sanitizedHref
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleImageClick();
                    }
                  }
                : undefined
            }
          >
            <img
              src={src}
              alt={alt}
              loading="lazy"
              decoding="async"
              className={cn("absolute inset-0 h-full w-full", getFitClass(fit))}
            />
          </div>
          {hasMetadata && (
            <div className="flex items-center gap-3 px-4 py-3">
              <SourceAttribution
                source={source}
                sourceLabel={sourceLabel}
                fallbackInitial={fallbackInitial}
                hasClickableUrl={Boolean(resolvedSourceUrl)}
                onSourceClick={handleSourceClick}
                title={title}
              />
            </div>
          )}
        </>
      </div>
    </article>
  );
}

interface SourceAttributionProps {
  source?: Source;
  sourceLabel?: string;
  fallbackInitial: string;
  hasClickableUrl: boolean;
  onSourceClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  title?: string;
}

function SourceAttribution({
  source,
  sourceLabel,
  fallbackInitial,
  hasClickableUrl,
  onSourceClick,
  title,
}: SourceAttributionProps) {
  const hasSource = Boolean(sourceLabel || source?.iconUrl);

  const content = (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      {source?.iconUrl ? (
        <img
          src={source.iconUrl}
          alt=""
          aria-hidden="true"
          width={32}
          height={32}
          className="size-8 shrink-0 rounded-full object-cover"
          loading="lazy"
          decoding="async"
        />
      ) : fallbackInitial ? (
        <div className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold uppercase">
          {fallbackInitial}
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        {title && (
          <div className="text-foreground line-clamp-1 text-sm font-medium">
            {title}
          </div>
        )}
        {sourceLabel && (
          <div className="text-muted-foreground line-clamp-1 text-xs">
            {sourceLabel}
          </div>
        )}
      </div>
    </div>
  );

  if (hasClickableUrl && hasSource) {
    return (
      <button
        type="button"
        onClick={onSourceClick}
        className="focus-visible:ring-ring flex w-full items-center gap-3 text-left hover:opacity-80 focus-visible:ring-2 focus-visible:outline-none"
      >
        {content}
      </button>
    );
  }

  return <div className="flex w-full items-center gap-3">{content}</div>;
}
