import React, { useCallback, useMemo } from 'react';
import Box from '@mui/material/Box';
import { useAppSelector } from '@/shared/hooks';
import type { AgentMessage } from '@/shared/state/agentsSlice';
import type { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { getMinimizedShot } from '@/app/pages/Dashboard/desktop/minimizedShots';
import { type RenderItem, isToolGroup, isToolPair } from '../tool-bubbles/ToolGroupBubble';

// The in-transcript dock slot for a spawned surface (browser or built app) that calls this chat home.
// The real card overlays the slot rect geometrically, so the webview never remounts; this hook owns
// the slot's selectors, sizing, mount announcement, frozen-shot backdrop, and where in the transcript
// it anchors (the LAST browser-agent tool row, else the end-of-transcript fallback). Lifted from
// AgentChat.
export function useDockedBrowserSlot({
  id,
  c,
  renderItems,
}: {
  id: string | undefined;
  c: ReturnType<typeof useClaudeTokens>;
  renderItems: RenderItem[];
}) {
  // True while a spawned surface (browser or built app) calls this chat home; gates the dock slot the real card overlays.
  const hasDockedBrowser = useAppSelector((st) =>
    Object.values(st.dashboardLayout.browserCards).some((bc) => bc.docked_to === id) ||
    Object.values(st.dashboardLayout.viewCards).some((vc) => vc.docked_to === id));
  // The docked surface's aspect ratio, so the inline slot hugs the browser's shape instead of reserving a fixed letterbox band (primitive selectors so no fresh-object rerenders). Highest z wins, mirroring BrowserCard's dock-owner election, so a dead rival's stale dock never feeds dims or shots.
  const pickTopDocked = (st: { dashboardLayout: { zOrders: Record<string, number>; browserCards: Record<string, { browser_id: string; docked_to?: string | null; width: number; height: number; zOrder: number }> } }) => {
    let best: { browser_id: string; width: number; height: number; zOrder: number } | null = null;
    let bestZ = -1;
    const zOf = (b: { browser_id: string; zOrder: number }): number => st.dashboardLayout.zOrders[b.browser_id] ?? b.zOrder ?? 0;
    for (const b of Object.values(st.dashboardLayout.browserCards)) {
      if (b.docked_to !== id) continue;
      if (!best || zOf(b) > bestZ) { best = b; bestZ = zOf(b); }
    }
    return best;
  };
  const dockedSurfaceW = useAppSelector((st) => pickTopDocked(st)?.width ?? 0);
  const dockedSurfaceH = useAppSelector((st) => pickTopDocked(st)?.height ?? 0);
  const dockedSurfaceId = useAppSelector((st) => pickTopDocked(st)?.browser_id ?? null);
  // Shared by the anchor slot and the fallback slot so both read as the same framed block.
  const browserSlotSx = {
    position: 'relative',
    // When the height cap bites, the WIDTH shrinks to keep the slot at the page's exact aspect (a maxHeight that broke the ratio left the live overlay letterboxed inside its own frame).
    width: dockedSurfaceW > 0 && dockedSurfaceH > 0 ? `min(100%, calc(min(480px, 52vh) * ${dockedSurfaceW / dockedSurfaceH}))` : '100%',
    aspectRatio: dockedSurfaceW > 0 && dockedSurfaceH > 0 ? `${dockedSurfaceW} / ${dockedSurfaceH}` : undefined,
    height: dockedSurfaceW > 0 && dockedSurfaceH > 0 ? 'auto' : 'min(360px, 38vh)',
    minHeight: 140,
    mx: 'auto',
    mt: 1,
    mb: 0.5,
    borderRadius: '12px',
    overflow: 'hidden',
    border: `1px solid ${c.border.medium}`,
    // The live overlay stamps data-mini-live; while it paints, the frozen-shot backdrop must not (the clamped overlay leaves margins where a misaligned second copy of the page peeked through).
    '&[data-mini-live="1"] img': { opacity: 0 },
  } as const;
  // The slot announces its own (re)mount so the docked mini re-measures exactly then, instead of polling rects on a timer (the windowed transcript remounts it with no resize/pan event firing).
  const announceBrowserSlot = useCallback((el: HTMLElement | null) => {
    if (el) window.dispatchEvent(new CustomEvent('openswarm:browser-slot-mounted', { detail: { id } }));
  }, [id]);
  // A live webview cannot be clipped by the scroller, so the OVERLAY only shows while fully in view; this frozen shot is what scrolls and clips underneath it, ChatGPT-style.
  const dockedShot = dockedSurfaceId ? getMinimizedShot(dockedSurfaceId) : undefined;
  const browserSlotBody = dockedShot ? (
    <Box component="img" src={dockedShot} alt="" sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
  ) : null;

  // The docked browser anchors at the LAST browser-agent tool row (one live browser, latest work site wins); no row yet falls back to the end-of-transcript slot.
  const browserAnchorItemId = useMemo((): string | null => {
    const isBrowserCall = (m: AgentMessage): boolean =>
      m.role === 'tool_call' && typeof m.content === 'object' && String((m.content as { tool?: string })?.tool || '').toLowerCase().endsWith('browseragent');
    let anchor: string | null = null;
    for (const item of renderItems) {
      if (isToolGroup(item)) { if (item.pairs.some((p) => isBrowserCall(p.call))) anchor = item.id; }
      else if (isToolPair(item)) { if (isBrowserCall(item.call)) anchor = item.id; }
      else if (isBrowserCall(item as AgentMessage)) anchor = item.id;
    }
    return anchor;
  }, [renderItems]);

  // One slot element for both homes: rendered right after the anchor row when one exists, else at the transcript tail (fallback for a browser that docked before any browser tool row exists, or whose row was compacted away). The mini hides itself when its slot scrolls mostly out of view, since a live webview can't be clipped by the scroller.
  const browserSlot: React.ReactNode = hasDockedBrowser
    ? <Box data-browser-slot={id} ref={announceBrowserSlot} sx={browserSlotSx}>{browserSlotBody}</Box>
    : null;

  return { hasDockedBrowser, browserAnchorItemId, browserSlot };
}
