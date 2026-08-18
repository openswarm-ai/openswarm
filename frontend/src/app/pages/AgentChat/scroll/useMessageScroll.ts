import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WINDOW_MIN_ITEMS, initialSeedItems } from '../windowing/messageWindow';
import type { RenderItem } from '../tool-bubbles/ToolGroupBubble';
import { measureMountedHeights, nextWindowForItems, reservedHeightFor, solveWindowFromScroll, sumReservedHeights } from './windowingCore';
import { attachWheelBoundaryGuard, cancelRafRefs, runBottomJumpPin, runInitialBottomPin, runLiveStreamPin, runStreamEndRepin } from './pinningCore';

const SCROLL_THRESHOLD = 50;

export interface MessageScrollInputs {
  renderItems: RenderItem[];
  streamingMessageId: string | null;
  sessionId: string | undefined;
  activeBranchId: string | undefined;
  messagesLength: number | undefined;
  id: string | undefined;
}

export type MessageScrollApi = ReturnType<typeof useMessageScroll>;

// The transcript's virtualization + scroll-pinning subsystem, lifted out of AgentChat verbatim. Owns the
// mounted window (which render items are live), the measured-height spacers that keep scroll geometry
// stable, and every rAF pin path (open, per-delta stick, stream-end re-pin, scroll-to-bottom). This is
// the single public scroll API; the solver math and pin loops live in windowingCore/pinningCore, while
// every hook declaration — and with it the EFFECT FIRING ORDER — stays in this file, in original source
// order. None of this is meaningfully testable in jsdom (scrollTop/scrollHeight/getBoundingClientRect
// are 0) — it is verified in the real app. The component owns `renderItems` (domain) and the per-item
// render; this owns the scroll mechanism and returns the visible slice + spacer heights + refs/handlers
// the render consumes.
export function useMessageScroll({
  renderItems, streamingMessageId, sessionId, activeBranchId, messagesLength, id,
}: MessageScrollInputs) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastVisibleItemRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const pendingInitialBottomScrollRef = useRef(false);
  const initialBottomScrollSettledRef = useRef(false);
  const renderItemsLengthRef = useRef(0);
  const renderItemsRef = useRef<RenderItem[]>([]);
  const itemHeightsRef = useRef<Map<string, number>>(new Map());
  const estimateCacheRef = useRef<Map<string, number>>(new Map());
  const viewportWidthRef = useRef(0);
  const windowStartRef = useRef(0);
  const windowEndRef = useRef(0);
  const windowScrollRafRef = useRef<number | null>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [windowStart, setWindowStart] = useState(0);
  const [windowEnd, setWindowEnd] = useState(0);
  const [heightVersion, setHeightVersion] = useState(0);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const reservedHeightForItem = useCallback((item: RenderItem | undefined): number =>
    reservedHeightFor(item, itemHeightsRef.current, estimateCacheRef.current, viewportWidthRef.current), []);

  // Measured-or-estimated pixel height of render item at `index`, for the window solver (reads the renderItems ref so it is valid inside rAF callbacks).
  const heightOf = useCallback((index: number): number => {
    return reservedHeightForItem(renderItemsRef.current[index]);
  }, [reservedHeightForItem]);

  // Solve the mounted window from the live scroll position and push it to state when it changes.
  const applyWindowFromScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (!initialBottomScrollSettledRef.current) return;
    const total = renderItemsLengthRef.current;
    // Below the windowing threshold the whole transcript is mounted; recomputing a window here would only churn the spacers and shift scroll. Leave it alone.
    if (total < WINDOW_MIN_ITEMS) return;
    const next = solveWindowFromScroll(el, total, windowStartRef.current, windowEndRef.current, isAtBottomRef.current, heightOf);
    if (!next) return;
    windowStartRef.current = next.start;
    windowEndRef.current = next.end;
    setWindowStart(next.start);
    setWindowEnd(next.end);
  }, [heightOf]);

  const scheduleWindowRecompute = useCallback(() => {
    if (windowScrollRafRef.current != null) return;
    windowScrollRafRef.current = requestAnimationFrame(() => {
      windowScrollRafRef.current = null;
      applyWindowFromScroll();
    });
  }, [applyWindowFromScroll]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setScrollRoot(el);

    const updateViewport = () => {
      setViewportHeight(el.clientHeight);
      setViewportWidth(el.clientWidth);
      // Width drives the char-per-line estimate; drop cached estimates so they recompute at the new width (measured heights are unaffected and kept).
      estimateCacheRef.current.clear();
      // Resize changes the budgets and how many items fit; re-solve the window off the current scroll position WITHOUT resetting it (only session / branch changes reset). overflow-anchor holds the visible content.
      scheduleWindowRecompute();
    };

    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (windowScrollRafRef.current != null) {
        cancelAnimationFrame(windowScrollRafRef.current);
        windowScrollRafRef.current = null;
      }
      setScrollRoot(null);
    };
  }, [id, sessionId, scheduleWindowRecompute]);

  React.useLayoutEffect(() => {
    const seed = initialSeedItems(viewportHeight);
    const total = renderItemsLengthRef.current;
    const end = total;
    const start = Math.max(0, end - seed);
    windowStartRef.current = start;
    windowEndRef.current = end;
    setWindowStart(start);
    setWindowEnd(end);
    itemHeightsRef.current.clear();
    estimateCacheRef.current.clear();
    if (initialPinRafRef.current != null) {
      cancelAnimationFrame(initialPinRafRef.current);
      initialPinRafRef.current = null;
    }
    pendingInitialBottomScrollRef.current = true;
    initialBottomScrollSettledRef.current = false;
    isAtBottomRef.current = true;
    setShowScrollButton(false);
  }, [id, activeBranchId]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // Measure against the real content bottom, not the locked-height pad below it.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
    isAtBottomRef.current = atBottom;
    setShowScrollButton(!atBottom);
    // Slide the mounted window to follow the viewport (loads newer/older items and unloads ones that drifted past the buffer on either side).
    scheduleWindowRecompute();
  }, [scheduleWindowRecompute]);

  // Prevent scroll from leaking into the dashboard canvas when at boundaries.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    return attachWheelBoundaryGuard(el);
  }, []);

  const scrollToBottomRafRef = useRef<number | null>(null);
  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    isAtBottomRef.current = true;
    setShowScrollButton(false);
    // When scrolled far up the newest items are unmounted behind the bottom spacer (estimated height). Jump the window to the bottom slice so they actually mount, then pin across several frames (runBottomJumpPin).
    const total = renderItemsLengthRef.current;
    const start = Math.max(0, total - initialSeedItems(el.clientHeight));
    windowStartRef.current = start;
    windowEndRef.current = total;
    setWindowStart(start);
    setWindowEnd(total);
    runBottomJumpPin({ scrollContainerRef, isAtBottomRef, lastScrollHeightRef }, scrollToBottomRafRef);
  }, []);

  const scrollRafRef = useRef<number | null>(null);
  const pinRafRef = useRef<number | null>(null);
  const initialPinRafRef = useRef<number | null>(null);
  const lastScrollHeightRef = useRef<number>(0);
  // Shared scroll-stick routine. Used both by the structural-events useEffect below (new message lands / stream starts/ends) and by StreamingBubble's onStreamGrew callback (per-delta growth). RAF + height-grew gate ensures we only set scrollTop when needed.
  const stickToBottomIfNeeded = useCallback(() => {
    if (!isAtBottomRef.current) return;
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (!isAtBottomRef.current) return;
      const el = scrollContainerRef.current;
      if (!el) return;
      const newHeight = el.scrollHeight;
      if (newHeight === lastScrollHeightRef.current) return;
      lastScrollHeightRef.current = newHeight;
      el.scrollTop = newHeight;
    });
  }, []);
  useEffect(() => {
    stickToBottomIfNeeded();
    // Structural triggers only: a new message lands or a stream starts/ends. Streaming content updates trigger this via <StreamingBubble onStreamGrew={stickToBottomIfNeeded} /> instead so AgentChat stays dormant during the 30Hz delta storm.
  }, [messagesLength, streamingMessageId, stickToBottomIfNeeded]);

  // Live-stream per-frame pin (runLiveStreamPin): the per-delta stick above defers by one rAF and let the bottom drift; this holds it every frame and parks the moment the stream ends.
  useEffect(() => {
    if (!streamingMessageId) return undefined;
    return runLiveStreamPin({ scrollContainerRef, isAtBottomRef, lastScrollHeightRef });
  }, [streamingMessageId]);

  // Stream-end re-stick. When a stream finishes, the live bubble (smooth-revealed text) is replaced by the committed bubble rendering FULL markdown with contentVisibility placeholders; as those resolve, Chromium's overflow-anchor re-anchors to an EARLIER element (the user message), yanking the view up to "the top of the user input". A single deferred scroll loses the race because that anchor shift fires an onScroll that flips isAtBottomRef false before we run. Fix: snapshot the "was following" intent the moment streaming stops (captured continuously during the stream, before any completion re-render), then pin to bottom across a short multi-frame window that OVERRIDES the layout-induced flip. A genuine user scroll-away (wheel/touch) during that window aborts the pin, honoring "unless the user scrolls up".
  const prevStreamingIdRef = useRef<string | null>(null);
  const wasFollowingRef = useRef(true);
  const pinAbortRef = useRef(false);
  // Keep the follow-intent fresh while streaming so it's accurate at the instant the stream ends (handleScroll updates isAtBottomRef on every real scroll).
  if (streamingMessageId) wasFollowingRef.current = isAtBottomRef.current;
  useEffect(() => {
    const prev = prevStreamingIdRef.current;
    prevStreamingIdRef.current = streamingMessageId;
    if (!(prev && !streamingMessageId)) return;
    if (!wasFollowingRef.current) return; // user had scrolled up; leave them be
    pinAbortRef.current = false;
    const el = scrollContainerRef.current;
    if (!el) return;
    return runStreamEndRepin(el, { scrollContainerRef, isAtBottomRef, lastScrollHeightRef }, pinRafRef, pinAbortRef);
  }, [streamingMessageId]);

  useEffect(() => () =>
    cancelRafRefs([scrollRafRef, pinRafRef, initialPinRafRef, scrollToBottomRafRef]), []);

  React.useLayoutEffect(() => {
    const total = renderItems.length;
    renderItemsLengthRef.current = total;
    renderItemsRef.current = renderItems;
    const next = nextWindowForItems(total, viewportHeight, windowStartRef.current, windowEndRef.current, isAtBottomRef.current);
    if (next.start !== windowStartRef.current) { windowStartRef.current = next.start; setWindowStart(next.start); }
    if (next.end !== windowEndRef.current) { windowEndRef.current = next.end; setWindowEnd(next.end); }
  }, [id, renderItems, viewportHeight]);

  const total = renderItems.length;
  // Small chats render whole (no windowing): forces the full slice so both spacer loops sum to 0, which removes the recompute-driven scroll jump entirely.
  const windowingActive = total >= WINDOW_MIN_ITEMS;
  const safeWindowEnd = !windowingActive ? total : (windowEnd > 0 ? Math.min(windowEnd, total) : total);
  const safeWindowStart = !windowingActive ? 0 : Math.min(Math.max(0, windowStart), Math.max(0, safeWindowEnd - 1));
  const visibleStartIndex = safeWindowStart;
  const visibleRenderItems = useMemo(
    () => renderItems.slice(safeWindowStart, safeWindowEnd),
    [renderItems, safeWindowStart, safeWindowEnd]
  );
  const renderedVisibleItems = useMemo(
    () => visibleRenderItems.filter((item) => !streamingMessageId || item.id !== streamingMessageId),
    [streamingMessageId, visibleRenderItems]
  );
  // Keep the ref the height estimator reads in sync with the live viewport width.
  viewportWidthRef.current = viewportWidth;

  // Measure mounted item heights so the spacers stand in at true size (no jump when unloading above).
  React.useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // Guarded so this converges: once heights stop moving, no more version bumps.
    if (measureMountedHeights(el, itemHeightsRef.current)) setHeightVersion((v) => v + 1);
  });

  // Spacers reserve the cumulative height of the unmounted items above/below the window. heightVersion gates recompute off the ref-held measurements; we index the render-scope renderItems directly so id->height stays correct on the frame the transcript changes.
  const topSpacerHeight = useMemo(
    () => sumReservedHeights(renderItems, 0, safeWindowStart, reservedHeightForItem),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [renderItems, safeWindowStart, heightVersion, reservedHeightForItem]
  );
  const bottomSpacerHeight = useMemo(
    () => sumReservedHeights(renderItems, safeWindowEnd, total, reservedHeightForItem),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [renderItems, safeWindowEnd, total, heightVersion, reservedHeightForItem]
  );

  React.useLayoutEffect(() => {
    if (pendingInitialBottomScrollRef.current) {
      const el = scrollContainerRef.current;
      if (!el || visibleRenderItems.length === 0) return;
      pendingInitialBottomScrollRef.current = false;
      runInitialBottomPin(
        { scrollContainerRef, isAtBottomRef, lastScrollHeightRef, lastVisibleItemRef, initialPinRafRef, initialBottomScrollSettledRef },
        () => setShowScrollButton(false),
        // The open slice is sized by item COUNT; once settled and measured, trim it down to the pixel-based band so tall messages high in the slice unload instead of sitting fully rendered off-screen.
        scheduleWindowRecompute,
      );
    }
  }, [id, activeBranchId, renderItems.length, renderedVisibleItems.length, visibleStartIndex]);

  return {
    scrollContainerRef,
    lastVisibleItemRef,
    onScroll: handleScroll,
    scrollToBottom,
    stickToBottomIfNeeded,
    showScrollButton,
    renderedVisibleItems,
    topSpacerHeight,
    bottomSpacerHeight,
    scrollRoot,
    viewportWidth,
    viewportHeight,
  };
}
