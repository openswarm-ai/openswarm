"use client";

import * as React from "react";
import { BadgeCheck, Heart, Share } from "lucide-react";
import {
  cn,
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./_adapter";
import { formatRelativeTime } from "../shared/utils";

import type { InstagramPostData, InstagramPostMedia } from "./schema";

export interface InstagramPostProps {
  post: InstagramPostData;
  className?: string;
  onAction?: (action: string, post: InstagramPostData) => void;
}

function InstagramLogo({ className }: { className?: string }) {
  const id = React.useId();
  const gradientPrimaryId = `ig-primary-${id}`;
  const gradientSecondaryId = `ig-secondary-${id}`;

  return (
    <svg
      viewBox="0 0 132 132"
      className={className}
      role="img"
      aria-label="Instagram logo"
    >
      <defs>
        <radialGradient
          id={gradientPrimaryId}
          cx="158.429"
          cy="578.088"
          r="65"
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(0 -1.982 1.844 0 -1031.4 454)"
        >
          <stop offset="0" stopColor="#fd5" />
          <stop offset=".1" stopColor="#fd5" />
          <stop offset=".5" stopColor="#ff543e" />
          <stop offset="1" stopColor="#c837ab" />
        </radialGradient>
        <radialGradient
          id={gradientSecondaryId}
          cx="147.694"
          cy="473.455"
          r="65"
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(.174 .869 -3.58 .717 1648 -458.5)"
        >
          <stop offset="0" stopColor="#3771c8" />
          <stop offset=".128" stopColor="#3771c8" />
          <stop offset="1" stopColor="#60f" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path
        fill={`url(#${gradientPrimaryId})`}
        d="M65 0C37.9 0 30 .03 28.4.16c-5.6.46-9 1.34-12.8 3.22-2.9 1.44-5.2 3.12-7.5 5.47C4 13.1 1.5 18.4.6 24.66c-.44 3.04-.57 3.66-.6 19.2-.01 5.16 0 12 0 21.1 0 27.12.03 35.05.16 36.6.45 5.4 1.3 8.82 3.1 12.55 3.44 7.14 10 12.5 17.76 14.5 2.68.7 5.64 1.1 9.44 1.26 1.6.07 18 .12 34.44.12s32.84-.02 34.4-.1c4.4-.2 6.96-.55 9.8-1.28 7.78-2.01 14.23-7.3 17.74-14.53 1.76-3.64 2.66-7.18 3.07-12.32.08-1.12.12-18.97.12-36.8 0-17.85-.04-35.67-.13-36.8-.4-5.2-1.3-8.7-3.13-12.43-1.5-3.04-3.16-5.3-5.56-7.62C116.9 4 111.64 1.5 105.37.6 102.34.16 101.73.03 86.2 0H65z"
        transform="translate(1 1)"
      />
      <path
        fill={`url(#${gradientSecondaryId})`}
        d="M65 0C37.9 0 30 .03 28.4.16c-5.6.46-9 1.34-12.8 3.22-2.9 1.44-5.2 3.12-7.5 5.47C4 13.1 1.5 18.4.6 24.66c-.44 3.04-.57 3.66-.6 19.2-.01 5.16 0 12 0 21.1 0 27.12.03 35.05.16 36.6.45 5.4 1.3 8.82 3.1 12.55 3.44 7.14 10 12.5 17.76 14.5 2.68.7 5.64 1.1 9.44 1.26 1.6.07 18 .12 34.44.12s32.84-.02 34.4-.1c4.4-.2 6.96-.55 9.8-1.28 7.78-2.01 14.23-7.3 17.74-14.53 1.76-3.64 2.66-7.18 3.07-12.32.08-1.12.12-18.97.12-36.8 0-17.85-.04-35.67-.13-36.8-.4-5.2-1.3-8.7-3.13-12.43-1.5-3.04-3.16-5.3-5.56-7.62C116.9 4 111.64 1.5 105.37.6 102.34.16 101.73.03 86.2 0H65z"
        transform="translate(1 1)"
      />
      <path
        fill="#fff"
        d="M66 18c-13 0-14.67.06-19.8.3-5.1.23-8.6 1.04-11.64 2.22-3.16 1.23-5.84 2.87-8.5 5.54-2.67 2.67-4.3 5.35-5.54 8.5-1.2 3.05-2 6.54-2.23 11.65C18.06 51.33 18 52.96 18 66s.06 14.67.3 19.78c.22 5.12 1.03 8.6 2.22 11.66 1.22 3.15 2.86 5.83 5.53 8.5 2.67 2.67 5.35 4.3 8.5 5.53 3.06 1.2 6.55 2 11.65 2.23 5.12.23 6.76.3 19.8.3 13 0 14.66-.07 19.78-.3 5.12-.23 8.6-1.03 11.66-2.23 3.15-1.23 5.83-2.87 8.5-5.53 2.67-2.67 4.3-5.35 5.53-8.5 1.2-3.06 2-6.54 2.23-11.66.23-5.1.3-6.75.3-19.78 0-13.04-.07-14.68-.3-19.8-.23-5.1-1.04-8.6-2.22-11.64-1.23-3.16-2.87-5.84-5.54-8.5-2.67-2.67-5.35-4.3-8.5-5.54-3.06-1.18-6.55-2-11.66-2.22-5.12-.24-6.75-.3-19.8-.3zm-4.3 8.65c1.28 0 2.7 0 4.3 0 12.82 0 14.34.05 19.4.28 4.67.2 7.22 1 8.9 1.65 2.25.87 3.84 1.9 5.52 3.6 1.68 1.67 2.72 3.27 3.6 5.5.65 1.7 1.43 4.24 1.64 8.92.23 5.05.28 6.57.28 19.4s-.05 14.32-.28 19.4c-.2 4.67-1 7.2-1.64 8.9-.88 2.25-1.92 3.84-3.6 5.52-1.68 1.68-3.27 2.72-5.52 3.6-1.7.65-4.23 1.43-8.9 1.64-5.06.23-6.58.28-19.4.28-12.82 0-14.34-.05-19.4-.28-4.68-.2-7.22-1-8.9-1.64-2.25-.88-3.84-1.92-5.52-3.6-1.68-1.68-2.72-3.27-3.6-5.52-.65-1.7-1.43-4.23-1.64-8.9-.23-5.06-.28-6.58-.28-19.4s.05-14.34.28-19.4c.2-4.68 1-7.22 1.64-8.9.88-2.24 1.92-3.83 3.6-5.52 1.68-1.68 3.27-2.72 5.52-3.6 1.7-.65 4.23-1.43 8.9-1.65 4.43-.2 6.15-.26 15.1-.27zm30 8c-3.2 0-5.77 2.57-5.77 5.75 0 3.2 2.58 5.77 5.77 5.77 3.18 0 5.76-2.58 5.76-5.77 0-3.18-2.58-5.76-5.76-5.76zm-25.63 6.72c-13.6 0-24.64 11.04-24.64 24.65 0 13.6 11.03 24.64 24.64 24.64 13.6 0 24.65-11.03 24.65-24.64 0-13.6-11.04-24.64-24.65-24.64zm0 8.65c8.84 0 16 7.16 16 16 0 8.84-7.16 16-16 16-8.84 0-16-7.16-16-16 0-8.84 7.16-16 16-16z"
      />
    </svg>
  );
}

function Header({
  author,
  createdAt,
}: {
  author: InstagramPostData["author"];
  createdAt?: string;
}) {
  return (
    <header className="flex items-center gap-3 p-3">
      <img
        src={author.avatarUrl}
        alt={`${author.name} avatar`}
        width={32}
        height={32}
        className="size-8 rounded-full object-cover"
      />
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-sm font-semibold">{author.handle}</span>
        {author.verified && (
          <BadgeCheck
            aria-label="Verified"
            className="size-3.5 shrink-0 text-sky-500"
          />
        )}
        {createdAt && (
          <>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground text-sm">
              {formatRelativeTime(createdAt)}
            </span>
          </>
        )}
      </div>
      <InstagramLogo className="size-5" />
    </header>
  );
}

function MediaGrid({
  media,
  onOpen,
}: {
  media: InstagramPostMedia[];
  onOpen?: (index: number) => void;
}) {
  if (media.length === 0) return null;

  const renderItem = (item: InstagramPostMedia, index: number) => (
    <button
      key={index}
      type="button"
      className="bg-muted relative block size-full overflow-hidden"
      onClick={() => onOpen?.(index)}
    >
      {item.type === "image" ? (
        <img
          src={item.url}
          alt={item.alt}
          className="size-full object-cover"
          loading="lazy"
        />
      ) : (
        <video src={item.url} playsInline className="size-full object-cover" />
      )}
    </button>
  );

  if (media.length === 1) {
    return (
      <div className="aspect-square w-full overflow-hidden">
        {renderItem(media[0], 0)}
      </div>
    );
  }

  if (media.length === 2) {
    return (
      <div className="grid aspect-square w-full grid-cols-2 gap-0.5 overflow-hidden">
        {media.map(renderItem)}
      </div>
    );
  }

  if (media.length === 3) {
    return (
      <div className="grid aspect-square w-full grid-cols-2 gap-0.5 overflow-hidden">
        <div className="h-full">{renderItem(media[0], 0)}</div>
        <div className="grid h-full grid-rows-2 gap-0.5">
          {media.slice(1).map((item, i) => (
            <div key={i + 1} className="h-full">
              {renderItem(item, i + 1)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="grid aspect-square w-full grid-cols-2 gap-0.5 overflow-hidden">
      {media.slice(0, 4).map((item, index) => (
        <div key={index} className="relative h-full w-full">
          {renderItem(item, index)}
          {index === 3 && media.length > 4 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50">
              <span className="text-2xl font-semibold text-white">
                +{media.length - 4}
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function PostBody({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <span className="text-sm leading-relaxed text-pretty wrap-break-word whitespace-pre-wrap">
      {text}
    </span>
  );
}

function ActionButton({
  icon: Icon,
  label,
  active,
  hoverColor,
  activeColor,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  hoverColor: string;
  activeColor?: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          className={cn("h-auto", hoverColor, active && activeColor)}
          aria-label={label}
        >
          <Icon className="size-5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function PostActions({
  stats,
  onAction,
}: {
  stats?: InstagramPostData["stats"];
  onAction: (action: string) => void;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center gap-1">
        <ActionButton
          icon={Heart}
          label="Like"
          active={stats?.isLiked}
          hoverColor="hover:opacity-60"
          activeColor="text-red-500 fill-red-500"
          onClick={() => onAction("like")}
        />
        <ActionButton
          icon={Share}
          label="Share"
          hoverColor="hover:opacity-60"
          onClick={() => onAction("share")}
        />
      </div>
    </TooltipProvider>
  );
}

export function InstagramPost({
  post,
  className,
  onAction,
}: InstagramPostProps) {
  return (
    <div
      className={cn("flex max-w-xl flex-col gap-3", className)}
      data-tool-ui-id={post.id}
      data-slot="instagram-post"
    >
      <article className="bg-card overflow-hidden rounded-lg border shadow-sm">
        <Header author={post.author} createdAt={post.createdAt} />

        {post.media && post.media.length > 0 && (
          <MediaGrid media={post.media} />
        )}

        <div className="flex flex-col gap-2 p-3">
          <PostActions
            stats={post.stats}
            onAction={(action) => onAction?.(action, post)}
          />
          {post.text && (
            <div>
              <span className="text-sm font-semibold">
                {post.author.handle}
              </span>{" "}
              <PostBody text={post.text} />
            </div>
          )}
        </div>
      </article>
    </div>
  );
}
