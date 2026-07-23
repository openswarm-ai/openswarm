import { useEffect, useRef, type RefObject } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { DEFAULT_CARD_W, EXPANDED_CARD_MIN_H } from '@/shared/state/dashboardLayoutSlice';
import { clearReveal } from '@/shared/state/onboardingV3Slice';

interface Args {
  isActive: boolean;
  dashboardId: string;
  viewportRef: RefObject<HTMLDivElement | null>;
  canvasStateRef: RefObject<{ panX: number; panY: number; zoom: number }>;
  createWelcomeDraft: () => void;
  fitToCards: (rects: Array<{ x: number; y: number; width: number; height: number }>, maxZoom?: number, animate?: boolean, minZoom?: number, centered?: boolean) => void;
}

// The reveal: onboarding v3 finished behind the curtain and the flow lands INSTANTLY on a single clean
// welcome chat (no auto-spawned agents or app preview, that lag is gone). Its greeting + starters are
// personalized from prep; the user picks what to run first. We just seed the chat and frame the camera on
// it at readable zoom.
export function useOnboardingRevealSeed({ isActive, dashboardId, viewportRef, canvasStateRef, createWelcomeDraft, fitToCards }: Args): void {
  const dispatch = useAppDispatch();
  const revealPending = useAppSelector((s) => s.onboardingV3.revealPending);
  const settingsLoaded = useAppSelector((s) => s.settings.loaded);
  const seededRef = useRef(false);

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
        createWelcomeDraft();
        // Frame the welcome chat, centered. Reserve headroom up top so the chat header clears the macOS
        // traffic lights + the floating dashboard title pill instead of landing under them.
        const TOP_CHROME_PAD = 130;
        fitToCards(
          [{ x: cx - DEFAULT_CARD_W / 2, y: cy - EXPANDED_CARD_MIN_H / 2 - TOP_CHROME_PAD, width: DEFAULT_CARD_W, height: EXPANDED_CARD_MIN_H + TOP_CHROME_PAD }],
          0.9,
          true,
          undefined,
          true,
        );
      } else {
        createWelcomeDraft();
      }
    } finally {
      dispatch(clearReveal());
    }
  }, [revealPending, isActive, settingsLoaded, dashboardId, viewportRef, canvasStateRef, createWelcomeDraft, fitToCards, dispatch]);
}
