import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { store } from '@/shared/state/store';
import {
  placeCard, openWorkflowsApp, setWorkflowsHubPosition, setWorkflowsHubSize,
  clearPendingFocusWorkflowsHub, setViewCardPosition,
  DEFAULT_CARD_W, EXPANDED_CARD_MIN_H,
} from '@/shared/state/dashboardLayoutSlice';
import { clearReveal, setRevealAnchor } from '@/shared/state/onboardingV3Slice';

interface Args {
  isActive: boolean;
  dashboardId: string;
  expandedSessionIds: string[];
  viewportRef: RefObject<HTMLDivElement | null>;
  canvasStateRef: RefObject<{ panX: number; panY: number; zoom: number }>;
  createWelcomeDraft: () => void;
  fitToCards: (rects: Array<{ x: number; y: number; width: number; height: number }>, maxZoom?: number, animate?: boolean, minZoom?: number, centered?: boolean) => void;
}

const GAP = 48;
// The scheduled task opens the FULL Workflows app (rich detail view), sized to span the 2-column agent
// grid below it so the default 1280x800 hub doesn't dominate the reveal.
const REVEAL_WORKFLOW_W = 2 * DEFAULT_CARD_W + GAP;
const REVEAL_WORKFLOW_H = 560;

/** Where the reveal's app view card is born: right of the welcome chat, top-aligned. The "here's what I did" legend is the fixed RevealHero panel, not a canvas note, so the app sits right next to the chat. */
export function revealAppSpot(anchor: { cx: number; cy: number }): { x: number; y: number } {
  return { x: anchor.cx + DEFAULT_CARD_W / 2 + GAP, y: anchor.cy - EXPANDED_CARD_MIN_H / 2 };
}

// The reveal: onboarding v3 finished behind the curtain and the prepped work (a personal dashboard app, a live web-research dig, a read-only file tidy-up, and one recurring task) has been running since mid-flow. Compose one tight readable cluster: welcome chat center, jobs stacked left, the plain-English note right; the app view card is born at the arc end (via revealAnchor + the lifecycle auto-add) and the camera glides to it when it arrives. The keep/discard toast owns the jobs' fate afterward.
export function useOnboardingRevealSeed({ isActive, dashboardId, expandedSessionIds, viewportRef, canvasStateRef, createWelcomeDraft, fitToCards }: Args): void {
  const dispatch = useAppDispatch();
  const revealPending = useAppSelector((s) => s.onboardingV3.revealPending);
  const prepped = useAppSelector((s) => s.onboardingV3.prepped);
  const settingsLoaded = useAppSelector((s) => s.settings.loaded);
  const seededRef = useRef(false);
  // Jobs launch async at prep-resolve, so some land in `prepped` a beat AFTER the curtain lifts. The
  // anchor + placed-set let us keep dropping those cards in the same left stack instead of losing them.
  const anchorRef = useRef<{ cx: number; cy: number } | null>(null);
  const placedRef = useRef<Set<string>>(new Set());
  // Only the agent-card jobs flow into the 2-column grid; the schedule gets its own wide slot below, so
  // count agent cards separately or the schedule would leave a hole in the grid rhythm.
  const agentCountRef = useRef(0);

  const placeJobs = useCallback(() => {
    const a = anchorRef.current;
    if (!a) return;
    // Grid geometry, shared by placement here and the schedule's below-grid slot.
    const gridLeftX = a.cx - DEFAULT_CARD_W / 2 - 2 * GAP - 2 * DEFAULT_CARD_W;
    const gridTopY = a.cy - EXPANDED_CARD_MIN_H / 2;
    prepped.forEach((job) => {
      // Every job shows its AGENT card (its live transcript), including the app builder, so the reveal
      // makes it obvious the agent is BUILDING the app, not just a "building..." box. Its finished app
      // view card appears beside it when it renders (birth-position path in useDashboardLifecycle).
      const key = job.workflowId || job.sessionId;
      if (placedRef.current.has(key)) return;
      if (job.kind === 'schedule' && job.workflowId) {
        // The scheduled task opens the FULL Workflows app (its rich detail view: schedule + steps), not
        // the compact run-monitor card, so the reveal shows off the real automation GUI. It sits in a wide
        // slot below the agent grid. Opening the app normally snaps the camera to the hub (a fitToCards on
        // pendingFocusWorkflowsHub); clear that flag so the reveal's own framing wins.
        const sy = gridTopY + 2 * (EXPANDED_CARD_MIN_H + 24);
        dispatch(openWorkflowsApp({ workflowId: job.workflowId, expandedSessionIds }));
        dispatch(clearPendingFocusWorkflowsHub());
        dispatch(setWorkflowsHubSize({ width: REVEAL_WORKFLOW_W, height: REVEAL_WORKFLOW_H }));
        dispatch(setWorkflowsHubPosition({ x: gridLeftX, y: sy }));
      } else {
        // 2-column grid to the LEFT of the welcome chat. A single tall column (enlarged cards stacked)
        // forced the camera so far out the cards went unreadable; wide-and-short frames at a legible zoom.
        const gi = agentCountRef.current;
        agentCountRef.current += 1;
        const col = gi % 2;
        const row = Math.floor(gi / 2);
        const x = gridLeftX + col * (DEFAULT_CARD_W + GAP);
        const y = gridTopY + row * (EXPANDED_CARD_MIN_H + 24);
        dispatch(placeCard({ sessionId: job.sessionId, x, y, width: DEFAULT_CARD_W, height: EXPANDED_CARD_MIN_H, expandedSessionIds, exact: true }));
      }
      placedRef.current.add(key);
    });
  }, [prepped, dispatch, expandedSessionIds]);

  // One-time: fix the anchor, seed the welcome chat + the "head start" note, place jobs present so far,
  // then frame the camera on the whole cluster so the curtain lifts onto a composed, readable scene.
  useEffect(() => {
    if (!revealPending || seededRef.current || !isActive || !settingsLoaded) return;
    seededRef.current = true;
    try {
      const vp = viewportRef.current;
      const cs = canvasStateRef.current;
      if (vp && cs) {
        const vr = vp.getBoundingClientRect();
        const cx = (vr.width / 2 - cs.panX) / cs.zoom;
        const cy = (vr.height / 2 - cs.panY) / cs.zoom;
        anchorRef.current = { cx, cy };
        dispatch(setRevealAnchor({ cx, cy }));
        const app = prepped.find((j) => j.kind === 'app');
        // The "here's what I did" legend is the fixed RevealHero panel (top-center, unmissable, live
        // status), not a canvas note, so there is no wall-of-text sticky to miss here anymore.
        placeJobs();
        // The app agent often creates its output BEFORE the curtain lifts (it gets a head start at
        // connect), so its view card was auto-added with no anchor to stage against. Move it to the
        // arc-end spot now; the birth-position path in useDashboardLifecycle covers late arrivals.
        if (app?.sessionId) {
          const now = store.getState();
          const out = Object.values(now.outputs.items).find((o) => o.session_id === app.sessionId);
          if (out && now.dashboardLayout.viewCards[out.id]) {
            const spot = revealAppSpot({ cx, cy });
            dispatch(setViewCardPosition({ outputId: out.id, x: spot.x, y: spot.y }));
          }
        }
        createWelcomeDraft();
        // Frame the whole cluster (left job column + chat + app view card on the right) so the reveal is
        // readable, not scattered. The pipeline ALWAYS sets up one scheduled task, whose RunMonitor card is
        // tall and lands late; reserve its slot now (2 short job cards + the monitor) so the camera never
        // cuts it off when it arrives. Width runs from the left column to the far edge of the app view card.
        const left = cx - DEFAULT_CARD_W / 2 - 2 * GAP - 2 * DEFAULT_CARD_W; // left edge of the 2-col grid
        const top = cy - EXPANDED_CARD_MIN_H / 2;
        const right = cx + DEFAULT_CARD_W / 2 + GAP + DEFAULT_CARD_W; // right edge of the app view card
        // The agent cards lay out as a 2-column grid (2 enlarged rows) with the full Workflows app spanning
        // a wide row below them. Reserve for both now so the schedule, which lands late, is already in frame.
        const stackH = 2 * (EXPANDED_CARD_MIN_H + 24) + REVEAL_WORKFLOW_H;
        // Reserve headroom at the top so the topmost cards clear the macOS traffic lights + the floating
        // dashboard title pill + the run-status pill, instead of the chat header landing under them.
        const TOP_CHROME_PAD = 130;
        fitToCards(
          [{ x: left, y: top - TOP_CHROME_PAD, width: right - left, height: Math.max(EXPANDED_CARD_MIN_H, stackH) + TOP_CHROME_PAD }],
          0.9,
          true,
        );
      } else {
        createWelcomeDraft();
      }
    } finally {
      dispatch(clearReveal());
    }
  }, [revealPending, isActive, settingsLoaded, prepped, dashboardId, expandedSessionIds, viewportRef, canvasStateRef, createWelcomeDraft, fitToCards, dispatch, placeJobs]);

  // Jobs that launched after the curtain lifted: drop their cards in as they arrive.
  useEffect(() => {
    if (seededRef.current) placeJobs();
  }, [prepped, placeJobs]);
}
