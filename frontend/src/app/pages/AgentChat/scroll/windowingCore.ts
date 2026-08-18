import {
  RENDER_ITEM_ESTIMATED_HEIGHT,
  WINDOW_BUFFER_SCREENS_PER_SIDE,
  computeDesiredWindow,
  estimateItemHeight,
  initialSeedItems,
} from '../windowing/messageWindow';
import type { RenderItem } from '../tool-bubbles/ToolGroupBubble';

// Private windowing internals behind useMessageScroll (the single public scroll API). Plain functions
// over explicit inputs — no hooks, no refs of their own — so every useRef/useState/useEffect declaration
// (and with it the effect firing order) stays in useMessageScroll.ts while the solver math lives here.

// Reserved pixel height for a render item: the measured height once we have one, otherwise a
// content-aware estimate (cached per id). The spacer math and the window solver both go through this so
// unmounted spacers, freshly-mounted placeholders, and the real rendered bubble all reserve the same
// space.
export function reservedHeightFor(
  item: RenderItem | undefined,
  measured: Map<string, number>,
  estimates: Map<string, number>,
  viewportWidth: number,
): number {
  if (!item) return RENDER_ITEM_ESTIMATED_HEIGHT;
  const m = measured.get(item.id);
  if (m != null) return m;
  const cached = estimates.get(item.id);
  if (cached != null) return cached;
  const est = estimateItemHeight(item, viewportWidth);
  estimates.set(item.id, est);
  return est;
}

// Solve the mounted window from the live scroll position. Scroll position itself is preserved by the
// container's overflow-anchor plus the measured-height spacers, so the caller never touches scrollTop
// here. Following (pinned to bottom) always keeps the newest item. Returns null when the window is
// unchanged.
export function solveWindowFromScroll(
  el: HTMLElement,
  total: number,
  curStart: number,
  curEnd: number,
  isAtBottom: boolean,
  heightOf: (index: number) => number,
): { start: number; end: number } | null {
  const clientHeight = Math.max(1, el.clientHeight);
  const tightPx = WINDOW_BUFFER_SCREENS_PER_SIDE * clientHeight;
  // Mount with the tight buffer, but keep already-mounted items until they drift a full extra screen past it. Without this, an item sitting right on the buffer edge flip-flops mounted/unmounted forever: mounting it shifts content above the viewport, overflow-anchor nudges scrollTop a few px, that re-runs the solver, which now excludes it, and round it goes.
  const loosePx = tightPx + clientHeight;
  const tight = computeDesiredWindow(el.scrollTop, clientHeight, total, heightOf, tightPx);
  const loose = computeDesiredWindow(el.scrollTop, clientHeight, total, heightOf, loosePx);
  // Must-mount the tight band; keep current edges only while still inside loose.
  let start = Math.max(loose.start, Math.min(curStart, tight.start));
  let end = Math.min(loose.end, Math.max(curEnd, tight.end));
  if (isAtBottom) end = total;
  start = Math.max(0, Math.min(start, Math.max(0, end - 1)));
  if (start === curStart && end === curEnd) return null;
  return { start, end };
}

// Window update when the transcript itself changes (new items land or the branch slice is rebuilt).
export function nextWindowForItems(
  total: number,
  viewportHeight: number,
  curStart: number,
  curEnd: number,
  following: boolean,
): { start: number; end: number } {
  const seed = initialSeedItems(viewportHeight);
  let start = curStart;
  let end = curEnd;
  if (following || end === 0) {
    // Following the live tail: keep the newest item mounted and unload the oldest beyond a bounded recent slice so memory stays flat as the transcript grows. The pixel solver refines this seed on the next scroll.
    end = total;
    start = Math.max(0, end - seed);
  } else {
    // Scrolled up: just keep the existing window valid against the new length.
    end = Math.min(end, total);
    start = Math.min(start, Math.max(0, end - 1));
  }
  return { start, end };
}

// Measure mounted item heights so the spacers that stand in for unmounted items keep the scrollbar
// geometry stable (no jump when unloading above). Returns whether any measurement changed.
export function measureMountedHeights(el: HTMLElement, measured: Map<string, number>): boolean {
  let changed = false;
  el.querySelectorAll<HTMLElement>('[data-window-item-id]').forEach((node) => {
    const itemId = node.dataset.windowItemId;
    if (!itemId) return;
    const h = node.offsetHeight;
    if (h <= 0) return;
    const prev = measured.get(itemId);
    if (prev === undefined || Math.abs(prev - h) > 1) {
      measured.set(itemId, h);
      changed = true;
    }
  });
  return changed;
}

// Cumulative reserved height of the unmounted items in [from, to) — the spacer heights.
export function sumReservedHeights(
  items: RenderItem[],
  from: number,
  to: number,
  reserve: (item: RenderItem | undefined) => number,
): number {
  let h = 0;
  for (let i = from; i < to; i++) h += reserve(items[i]);
  return h;
}
