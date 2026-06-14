import { useCallback, type RefObject } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { createDraftSession, expandSession } from '@/shared/state/agentsSlice';
import { placeCard, setCardPosition, DEFAULT_CARD_W, EXPANDED_CARD_MIN_H } from '@/shared/state/dashboardLayoutSlice';
import { markWelcomeShown } from '@/shared/state/onboardingProgressSlice';
import { hasFreeTrialActive, hasModelConnected } from '@/app/components/Onboarding/steps/skipPredicates';

type SpawnOrigin = { x: number; y: number; type?: 'branch' };

interface Args {
  dashboardId: string;
  /** layoutInitialized && no sessions/views/browsers on the canvas. */
  canvasEmpty: boolean;
  expandedSessionIds: string[];
  viewportRef: RefObject<HTMLDivElement | null>;
  canvasStateRef: RefObject<{ panX: number; panY: number; zoom: number }>;
  spawnOriginsRef: RefObject<Record<string, SpawnOrigin>>;
}

// First-run welcome chat. NOT auto-created: the onboarding cursor clicks the New Agent button,
// which calls handleNewAgent -> createWelcomeDraft, so the chat is clicked into existence. The
// user clicking New Agent by hand spawns the same thing (fail-safe). Returns the gate + creator.
export function useWelcomeDraft({
  dashboardId, canvasEmpty, expandedSessionIds, viewportRef, canvasStateRef, spawnOriginsRef,
}: Args): { welcomeEligible: boolean; createWelcomeDraft: () => void } {
  const dispatch = useAppDispatch();
  const reduxEligible = useAppSelector(
    (s) =>
      s.settings.loaded &&
      (hasFreeTrialActive(s) || hasModelConnected(s)) &&
      !s.onboardingProgress.welcomeShown &&
      !(s.onboardingProgress.completedSteps ?? []).includes('launch_agent'),
  );
  const model = useAppSelector((s) => s.settings.data.default_model);
  const welcomeEligible = reduxEligible && canvasEmpty;

  const createWelcomeDraft = useCallback(() => {
    try {
      // No seeded message: the greeting + chips render (and animate) inside the welcome chat,
      // so nothing here can ever reach the backend.
      const action = dispatch(
        createDraftSession({ welcome: true, model, mode: 'agent', dashboardId, setActive: true }),
      );
      const draftId = action.payload.draftId;

      const vp = viewportRef.current;
      const cs = canvasStateRef.current;
      if (vp && cs) {
        const vr = vp.getBoundingClientRect();
        const cx = (vr.width / 2 - cs.panX) / cs.zoom;
        const cy = (vr.height / 2 - cs.panY) / cs.zoom;
        const x = cx - DEFAULT_CARD_W / 2;
        const y = cy - EXPANDED_CARD_MIN_H / 2;
        if (spawnOriginsRef.current) spawnOriginsRef.current[draftId] = { x: cx, y: cy };
        dispatch(placeCard({
          sessionId: draftId,
          x, y,
          width: DEFAULT_CARD_W,
          height: EXPANDED_CARD_MIN_H,
          expandedSessionIds,
        }));
        // placeCard grid-snaps + dodges collisions; the welcome chat is the only thing on a
        // fresh dashboard, so pin it to the EXACT viewport center instead of a grid cell.
        dispatch(setCardPosition({ sessionId: draftId, x, y }));
      }
      dispatch(expandSession(draftId));
      dispatch(markWelcomeShown());
    } catch (err) {
      console.error('[welcome-draft] create failed', err);
    }
  }, [dispatch, model, dashboardId, expandedSessionIds, viewportRef, canvasStateRef, spawnOriginsRef]);

  return { welcomeEligible, createWelcomeDraft };
}
