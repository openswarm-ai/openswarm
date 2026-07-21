"use client";

import { Globe } from "lucide-react";
import { cn } from "./_adapter";

import {
  RATIO_CLASS_MAP,
  getFitClass,
  openSafeNavigationHref,
  sanitizeHref,
} from "../shared/media";
import type { SerializableLinkPreview } from "./schema";

const FALLBACK_LOCALE = "en-US";
const CONTENT_SPACING = "px-5 py-4 gap-2";

export interface LinkPreviewProps extends SerializableLinkPreview {
  className?: string;
  onNavigate?: (href: string, preview: SerializableLinkPreview) => void;
}

export function LinkPreview(props: LinkPreviewProps) {
  const { className, onNavigate, ...serializable } = props;

  const {
    id,
    href: rawHref,
    title,
    description,
    image,
    domain,
    favicon,
    ratio = "16:9",
    fit = "cover",
    locale: providedLocale,
  } = serializable;

  const locale = providedLocale ?? FALLBACK_LOCALE;
  const sanitizedHref = sanitizeHref(rawHref);

  const previewData: SerializableLinkPreview = {
    ...serializable,
    href: sanitizedHref ?? rawHref,
    locale,
  };

  const handleClick = () => {
    if (!sanitizedHref) return;
    if (onNavigate) {
      onNavigate(sanitizedHref, previewData);
    } else {
      openSafeNavigationHref(sanitizedHref);
    }
  };

  return (
    <article
      className={cn("relative w-full max-w-md min-w-80", className)}
      lang={locale}
      data-tool-ui-id={id}
      data-slot="link-preview"
    >
      <div
        className={cn(
          "group @container relative isolate flex w-full min-w-0 flex-col overflow-hidden rounded-xl",
          "border-border bg-card border text-sm shadow-xs",
          sanitizedHref && "cursor-pointer",
        )}
        onClick={sanitizedHref ? handleClick : undefined}
        role={sanitizedHref ? "link" : undefined}
        tabIndex={sanitizedHref ? 0 : undefined}
        onKeyDown={
          sanitizedHref
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleClick();
                }
              }
            : undefined
        }
      >
        <div className="flex flex-col">
          {image && (
            <div
              className={cn(
                "bg-muted relative w-full overflow-hidden",
                ratio !== "auto" ? RATIO_CLASS_MAP[ratio] : "aspect-[5/3]",
              )}
            >
              <img
                src={image}
                alt=""
                loading="lazy"
                decoding="async"
                className={cn(
                  "absolute inset-0 h-full w-full",
                  getFitClass(fit),
                  "object-center transition-transform duration-200 group-hover:scale-[1.01]",
                )}
              />
            </div>
          )}
          <div className={cn("flex flex-col", CONTENT_SPACING)}>
            {domain && (
              <div className="text-muted-foreground flex items-center gap-2 text-xs">
                {favicon ? (
                  <img
                    src={favicon}
                    alt=""
                    aria-hidden="true"
                    width={16}
                    height={16}
                    className="size-4 rounded-full object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <div className="border-border/60 bg-muted flex size-4 shrink-0 items-center justify-center rounded-full border">
                    <Globe className="h-2.5 w-2.5" aria-hidden="true" />
                  </div>
                )}
                <span>{domain}</span>
              </div>
            )}
            {title && (
              <h3 className="text-foreground text-base font-medium text-pretty">
                <span className="line-clamp-2">{title}</span>
              </h3>
            )}
            {description && (
              <p className="text-muted-foreground leading-snug text-pretty">
                <span className="line-clamp-2">{description}</span>
              </p>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
