// Pure window math for the virtualized transcript (AGENTCHAT_SPLIT_PLAN step 1) — no React, no DOM.
import type { AgentMessage } from '@/shared/state/agentsSlice';
import { estimateRenderedTextHeight } from '../bubbles/markdownMeasure';
import { isToolGroup, isToolPair, type RenderItem } from '../tool-bubbles/ToolGroupBubble';

// Only a fallback for never-rendered items; real heights are measured once on screen.
export const RENDER_ITEM_ESTIMATED_HEIGHT = 140;
// Conservative estimate for an unmeasured tool row: tool groups/pairs render collapsed (~40-50px) far more often than expanded. Leaning low keeps scrollHeight (and the scrollbar thumb) from jumping when a tool row measures shorter.
const COLLAPSED_TOOL_ROW_HEIGHT = 44;
// How many screens of real content to keep mounted on EACH side of the viewport. Beyond it, items unmount and are replaced by a measured-height spacer, so render/memory stays bounded no matter how long the transcript is.
export const WINDOW_BUFFER_SCREENS_PER_SIDE = 3;
// Below this item count the transcript renders WHOLE, no spacers, no windowing. Virtualization only earns its keep on huge chats; on a normal chat the spacer-height recompute just fights the scroll position (the "jumps up and down" glitch), so we skip it entirely until a chat is genuinely long.
export const WINDOW_MIN_ITEMS = 60;
// Floor on the mounted item count so a single very tall item can't strand us with an effectively empty window.
export const MIN_WINDOW_BUFFER_ITEMS = 6;

// Bootstrap count for the initial bottom-anchored slice (on open and on scroll-to-bottom): ONE screen's worth, so first paint mounts the minimum that fills the viewport. The post-settle recompute (scheduleWindowRecompute after the pin) widens to the full pixel band, so the buffer arrives a few frames later instead of taxing open-to-paint.
export function initialSeedItems(viewportHeight: number): number {
  const fillPx = 1.25 * Math.max(1, viewportHeight);
  return Math.max(MIN_WINDOW_BUFFER_ITEMS, Math.ceil(fillPx / RENDER_ITEM_ESTIMATED_HEIGHT));
}

// Pure window solver: given the current scroll position and a per-index height accessor (measured where known, estimated otherwise), return the [start, end) slice of render items that should be mounted. The buffer is measured in PIXELS (N screens of real content on each side of the viewport), not item count, so a few very tall messages can't blow the mounted set up to the whole transcript. A huge viewport naturally yields start=0/end=total (mount all).
export function computeDesiredWindow(
  scrollTop: number,
  clientHeight: number,
  total: number,
  heightOf: (index: number) => number,
  bufferPx: number,
): { start: number; end: number } {
  if (total <= 0) return { start: 0, end: 0 };
  const keepTop = scrollTop - bufferPx;
  const keepBottom = scrollTop + clientHeight + bufferPx;
  let offset = 0;
  let start = -1;
  let end = total;
  for (let i = 0; i < total; i++) {
    const h = heightOf(i);
    const itemTop = offset;
    const itemBottom = offset + h;
    if (start === -1 && itemBottom > keepTop) start = i;
    if (itemTop < keepBottom) {
      end = i + 1;
    } else {
      // Everything past here starts below the keep band.
      break;
    }
    offset += h;
  }
  if (start === -1) start = Math.max(0, total - 1);
  end = Math.min(total, Math.max(end, start + 1));
  // Always keep at least a small floor of items mounted around the viewport so a single under-measured item can't strand us with an empty window.
  if (end - start < MIN_WINDOW_BUFFER_ITEMS) {
    start = Math.max(0, Math.min(start, end - MIN_WINDOW_BUFFER_ITEMS));
  }
  return { start: Math.max(0, start), end };
}

export function stringifyContent(content: any): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}

// Content-aware height estimate for a render item that has never been measured. Tool rows and tiny system/thinking rows keep the flat fallback; message bubbles scale with their FULL text length (messages render in full once on-screen, so the estimate matches both the rendered bubble and MessageBubble's placeholder fallback).
export function estimateItemHeight(item: RenderItem, viewportWidth: number): number {
  if (isToolGroup(item) || isToolPair(item)) return COLLAPSED_TOOL_ROW_HEIGHT;
  const msg = item as AgentMessage;
  if (msg.role === 'thinking' || msg.role === 'system') return 60;
  return estimateRenderedTextHeight(stringifyContent(msg.content), viewportWidth);
}
