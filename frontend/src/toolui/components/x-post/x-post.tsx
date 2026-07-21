"use client";

import * as React from "react";
import { Heart, Share } from "lucide-react";
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
import type { XPostData, XPostMedia, XPostLinkPreview } from "./schema";

export interface XPostProps {
  post: XPostData;
  className?: string;
  onAction?: (action: string, post: XPostData) => void;
}

function Avatar({ src, alt }: { src: string; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
      width={40}
      height={40}
      className="size-10 shrink-0 rounded-full object-cover"
    />
  );
}

function XLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 300 271"
      className={className}
      role="img"
      aria-label="X (formerly Twitter) logo"
    >
      <path
        fill="currentColor"
        d="m236 0h46l-101 115 118 156h-92.6l-72.5-94.8-83 94.8h-46l107-123-113-148h94.9l65.5 86.6zm-16.1 244h25.5l-165-218h-27.4z"
      />
    </svg>
  );
}

function VerifiedBadge({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      role="img"
      aria-label="Verified account"
    >
      <path
        fill="currentColor"
        d="M22.5 12.5c0-1.58-.875-2.95-2.148-3.6.154-.435.238-.905.238-1.4 0-2.21-1.71-3.998-3.818-3.998-.47 0-.92.084-1.336.25C14.818 2.415 13.51 1.5 12 1.5s-2.816.917-3.437 2.25c-.415-.165-.866-.25-1.336-.25-2.11 0-3.818 1.79-3.818 4 0 .495.083.965.238 1.4-1.272.65-2.147 2.018-2.147 3.6 0 1.495.782 2.798 1.942 3.486-.02.17-.032.34-.032.514 0 2.21 1.708 4 3.818 4 .47 0 .92-.086 1.335-.25.62 1.334 1.926 2.25 3.437 2.25 1.512 0 2.818-.916 3.437-2.25.415.163.865.248 1.336.248 2.11 0 3.818-1.79 3.818-4 0-.174-.012-.344-.033-.513 1.158-.687 1.943-1.99 1.943-3.484zm-6.616-3.334l-4.334 6.5c-.145.217-.382.334-.625.334-.143 0-.288-.04-.416-.126l-.115-.094-2.415-2.415c-.293-.293-.293-.768 0-1.06s.768-.294 1.06 0l1.77 1.767 3.825-5.74c.23-.345.696-.436 1.04-.207.346.23.44.696.21 1.04z"
      />
    </svg>
  );
}

function AuthorInfo({
  name,
  handle,
  verified,
  createdAt,
}: {
  name: string;
  handle: string;
  verified?: boolean;
  createdAt?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="truncate font-semibold">{name}</span>
      {verified && (
        <VerifiedBadge className="size-[18px] shrink-0 text-blue-500" />
      )}
      <span className="text-muted-foreground truncate">@{handle}</span>
      {createdAt && (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">
            {formatRelativeTime(createdAt)}
          </span>
        </>
      )}
    </div>
  );
}

function PostBody({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <p className="text-[15px] leading-normal text-pretty wrap-break-word whitespace-pre-wrap">
      {text}
    </p>
  );
}

function PostMedia({
  media,
  onOpen,
}: {
  media: XPostMedia;
  onOpen?: () => void;
}) {
  const aspectRatio =
    media.aspectRatio === "1:1"
      ? "1"
      : media.aspectRatio === "4:3"
        ? "4/3"
        : "16/9";

  return (
    <button
      type="button"
      className="bg-muted mt-2 w-full overflow-hidden rounded-xl"
      style={{ aspectRatio }}
      onClick={() => onOpen?.()}
    >
      {media.type === "image" ? (
        <img
          src={media.url}
          alt={media.alt}
          className="size-full object-cover"
          loading="lazy"
        />
      ) : (
        <video
          src={media.url}
          controls
          playsInline
          className="size-full object-contain"
        />
      )}
    </button>
  );
}

function PostLinkPreview({ preview }: { preview: XPostLinkPreview }) {
  const href = resolveSafeNavigationHref(preview.url);
  const domain = preview.domain ?? getDomain(preview.url);
  const content = (
    <>
      {preview.imageUrl && (
        <img
          src={preview.imageUrl}
          alt=""
          className="h-48 w-full object-cover"
          loading="lazy"
        />
      )}
      <div className="p-3">
        {domain && (
          <div className="text-muted-foreground text-xs">{domain}</div>
        )}
        {preview.title && (
          <div className="font-medium text-pretty">{preview.title}</div>
        )}
        {preview.description && (
          <div className="text-muted-foreground line-clamp-2 text-sm text-pretty">
            {preview.description}
          </div>
        )}
      </div>
    </>
  );

  if (!href) {
    return (
      <div className="mt-2 block overflow-hidden rounded-xl border">
        {content}
      </div>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:bg-muted/50 mt-2 block overflow-hidden rounded-xl border transition-colors"
    >
      {content}
    </a>
  );
}

function QuotedPostCard({ post }: { post: XPostData }) {
  return (
    <div className="hover:bg-muted/30 mt-2 rounded-xl border p-3 transition-colors">
      <div className="flex min-w-0 items-center gap-1">
        <img
          src={post.author.avatarUrl}
          alt={`${post.author.name} avatar`}
          width={16}
          height={16}
          className="size-4 rounded-full object-cover"
        />
        <span className="truncate font-semibold">{post.author.name}</span>
        {post.author.verified && (
          <VerifiedBadge className="size-3.5 shrink-0 text-blue-500" />
        )}
        <span className="text-muted-foreground truncate">
          @{post.author.handle}
        </span>
        {post.createdAt && (
          <>
            <span className="text-muted-foreground shrink-0">·</span>
            <span className="text-muted-foreground shrink-0">
              {formatRelativeTime(post.createdAt)}
            </span>
          </>
        )}
      </div>
      {post.text && <p className="mt-1.5">{post.text}</p>}
      {post.media && (
        <img
          src={post.media.url}
          alt={post.media.alt}
          className="mt-2 rounded-lg"
        />
      )}
    </div>
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
            "h-auto gap-1.5 px-2 py-1",
            hoverColor,
            active && activeColor,
          )}
          aria-label={label}
        >
          <Icon className="size-4" />
          {count !== undefined && (
            <span className="text-sm">{formatCount(count)}</span>
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
  stats?: XPostData["stats"];
  onAction: (action: string) => void;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <div className="mt-3 flex items-center gap-4">
        <ActionButton
          icon={Heart}
          label="Like"
          count={stats?.likes}
          active={stats?.isLiked}
          hoverColor="hover:text-pink-500 hover:bg-pink-500/10"
          activeColor="text-pink-500 fill-pink-500"
          onClick={() => onAction("like")}
        />
        <ActionButton
          icon={Share}
          label="Share"
          hoverColor="hover:text-blue-500 hover:bg-blue-500/10"
          onClick={() => onAction("share")}
        />
      </div>
    </TooltipProvider>
  );
}

export function XPost({ post, className, onAction }: XPostProps) {
  return (
    <div
      className={cn("flex max-w-xl flex-col gap-3", className)}
      data-tool-ui-id={post.id}
      data-slot="x-post"
    >
      <article className="bg-card rounded-xl border p-3 shadow-sm">
        <div className="flex gap-3">
          <Avatar
            src={post.author.avatarUrl}
            alt={`${post.author.name} avatar`}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <AuthorInfo
                name={post.author.name}
                handle={post.author.handle}
                verified={post.author.verified}
                createdAt={post.createdAt}
              />
              <XLogo className="text-muted-foreground/40 size-4" />
            </div>
            <PostBody text={post.text} />
            {post.media && <PostMedia media={post.media} />}
            {post.quotedPost && <QuotedPostCard post={post.quotedPost} />}
            {post.linkPreview && !post.quotedPost && (
              <PostLinkPreview preview={post.linkPreview} />
            )}
            <PostActions
              stats={post.stats}
              onAction={(action) => onAction?.(action, post)}
            />
          </div>
        </div>
      </article>
    </div>
  );
}
