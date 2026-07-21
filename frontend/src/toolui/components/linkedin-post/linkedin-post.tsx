"use client";

import * as React from "react";
import { ThumbsUp, Share } from "lucide-react";
import {
  cn,
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./_adapter";
import { formatCount, formatRelativeTime, getDomain } from "../shared/utils";

import { resolveSafeNavigationHref } from "../shared/media";
import type {
  LinkedInPostData,
  LinkedInPostMedia,
  LinkedInPostLinkPreview,
} from "./schema";

const TEXT_PREVIEW_LENGTH = 280;

export interface LinkedInPostProps {
  post: LinkedInPostData;
  className?: string;
  onAction?: (action: string, post: LinkedInPostData) => void;
}

function LinkedInLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 72 72"
      className={className}
      role="img"
      aria-label="LinkedIn logo"
    >
      <g fill="none" fillRule="evenodd">
        <path
          d="M8 72h56c4.42 0 8-3.58 8-8V8c0-4.42-3.58-8-8-8H8C3.58 0 0 3.58 0 8v56c0 4.42 3.58 8 8 8z"
          fill="currentColor"
        />
        <path
          d="M62 62H51.3V43.8c0-4.98-1.9-7.78-5.83-7.78-4.3 0-6.54 2.9-6.54 7.78V62H28.63V27.33h10.3v4.67c0 0 3.1-5.73 10.45-5.73 7.36 0 12.62 4.5 12.62 13.8V62zM16.35 22.8c-3.5 0-6.35-2.86-6.35-6.4 0-3.52 2.85-6.4 6.35-6.4 3.5 0 6.35 2.88 6.35 6.4 0 3.54-2.85 6.4-6.35 6.4zM11.03 62h10.74V27.33H11.03V62z"
          fill="#FFF"
        />
      </g>
    </svg>
  );
}

function Header({
  author,
  createdAt,
}: {
  author: LinkedInPostData["author"];
  createdAt?: string;
}) {
  return (
    <header className="flex items-start gap-3">
      <img
        src={author.avatarUrl}
        alt={`${author.name} avatar`}
        width={48}
        height={48}
        className="size-12 rounded-full object-cover"
      />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="text-sm font-semibold">{author.name}</span>
        {author.headline && (
          <span className="text-muted-foreground line-clamp-1 text-xs">
            {author.headline}
          </span>
        )}
        {createdAt && (
          <div className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
            <span>{formatRelativeTime(createdAt)}</span>
            <span>·</span>
            <span>Edited</span>
          </div>
        )}
      </div>
      <LinkedInLogo className="size-5 text-[#0077b5]" />
    </header>
  );
}

function PostBody({ text }: { text?: string }) {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const shouldTruncate = text && text.length > TEXT_PREVIEW_LENGTH;

  if (!text) return null;

  return (
    <div className="text-sm leading-relaxed text-pretty wrap-break-word whitespace-pre-wrap">
      {shouldTruncate && !isExpanded ? (
        <>
          {text.slice(0, TEXT_PREVIEW_LENGTH)}
          ...
          <button
            onClick={() => setIsExpanded(true)}
            className="text-muted-foreground hover:text-foreground ml-1 font-medium hover:underline"
          >
            see more
          </button>
        </>
      ) : (
        text
      )}
    </div>
  );
}

function PostMedia({ media }: { media: LinkedInPostMedia }) {
  return (
    <div className="overflow-hidden rounded-lg">
      {media.type === "image" ? (
        <img
          src={media.url}
          alt={media.alt}
          className="w-full object-cover"
          style={{ aspectRatio: "16/9" }}
          loading="lazy"
        />
      ) : (
        <video
          src={media.url}
          controls
          playsInline
          className="w-full object-contain"
          style={{ aspectRatio: "16/9" }}
        />
      )}
    </div>
  );
}

function PostLinkPreview({ preview }: { preview: LinkedInPostLinkPreview }) {
  const href = resolveSafeNavigationHref(preview.url);
  const domain = preview.domain ?? getDomain(preview.url);
  const content = (
    <>
      {preview.imageUrl && (
        <img
          src={preview.imageUrl}
          alt=""
          className="h-40 w-full object-cover"
          loading="lazy"
        />
      )}
      <div className="p-3">
        {preview.title && (
          <div className="line-clamp-2 font-medium text-pretty">
            {preview.title}
          </div>
        )}
        {domain && (
          <div className="text-muted-foreground mt-1 text-xs">{domain}</div>
        )}
      </div>
    </>
  );

  if (!href) {
    return (
      <div className="block overflow-hidden rounded-lg border">{content}</div>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:bg-muted/50 block overflow-hidden rounded-lg border transition-colors"
    >
      {content}
    </a>
  );
}

function ActionButton({
  icon: Icon,
  label,
  count,
  active,
  hoverColor,
  activeColor,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count?: number;
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
          className={cn(
            "h-auto gap-1.5 px-3 py-2",
            hoverColor,
            active && activeColor,
          )}
          aria-label={label}
        >
          <Icon className="size-4" />
          <span className="text-xs font-medium">{label}</span>
          {count !== undefined && (
            <span className="text-muted-foreground text-xs">
              ({formatCount(count)})
            </span>
          )}
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
  stats?: LinkedInPostData["stats"];
  onAction: (action: string) => void;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <div className="mt-1 flex items-center gap-1 border-t pt-1.5">
        <ActionButton
          icon={ThumbsUp}
          label="Like"
          active={stats?.isLiked}
          hoverColor="hover:bg-muted"
          activeColor="text-blue-600 fill-blue-600"
          onClick={() => onAction("like")}
        />
        <ActionButton
          icon={Share}
          label="Share"
          hoverColor="hover:bg-muted"
          onClick={() => onAction("share")}
        />
      </div>
    </TooltipProvider>
  );
}

export function LinkedInPost({ post, className, onAction }: LinkedInPostProps) {
  return (
    <div
      className={cn("flex max-w-xl flex-col gap-3", className)}
      data-tool-ui-id={post.id}
      data-slot="linkedin-post"
    >
      <article className="bg-card flex flex-col gap-3 rounded-lg border p-3 shadow-sm">
        <Header author={post.author} createdAt={post.createdAt} />
        <PostBody text={post.text} />

        {post.media && <PostMedia media={post.media} />}

        {post.linkPreview && !post.media && (
          <PostLinkPreview preview={post.linkPreview} />
        )}

        <PostActions
          stats={post.stats}
          onAction={(action) => onAction?.(action, post)}
        />
      </article>
    </div>
  );
}
