import { useEffect, useRef, type RefObject } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { addNote, placeCard, DEFAULT_CARD_W, DEFAULT_CARD_H } from '@/shared/state/dashboardLayoutSlice';
import { clearReveal } from '@/shared/state/onboardingV3Slice';

interface Args {
  isActive: boolean;
  dashboardId: string;
  expandedSessionIds: string[];
  viewportRef: RefObject<HTMLDivElement | null>;
  canvasStateRef: RefObject<{ panX: number; panY: number; zoom: number }>;
  createWelcomeDraft: () => void;
}

// The reveal: onboarding v3 finished behind the curtain and the prepped agents (audit + app build) have been running since mid-flow. Compose the canvas: welcome chat center, running jobs stacked left, the "while you were setting up" note right. The keep/discard toast owns the jobs' fate afterward.
export function useOnboardingRevealSeed({ isActive, dashboardId, expandedSessionIds, viewportRef, canvasStateRef, createWelcomeDraft }: Args): void {
  const dispatch = useAppDispatch();
  const revealPending = useAppSelector((s) => s.onboardingV3.revealPending);
  const starters = useAppSelector((s) => s.onboardingV3.starters);
  const scanSummary = useAppSelector((s) => s.onboardingV3.scanSummary);
  const prepped = useAppSelector((s) => s.onboardingV3.prepped);
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
        const audit = prepped.find((j) => j.kind === 'audit');
        const app = prepped.find((j) => j.kind === 'app');
        const jobLine = (j: typeof prepped[number]) => (j.reason ? `- ${j.title}: ${j.reason}` : `- ${j.title}`);
        const lines: string[] = ['While you were setting up, I got a head start.'];
        if (scanSummary) lines.push(`I looked around your Mac and saw ${scanSummary}.`);
        const cards: string[] = [];
        if (audit) cards.push(jobLine(audit));
        if (app) cards.push(jobLine(app));
        if (cards.length > 0) lines.push(`So here is what I already have going (cards on your left):\n${cards.join('\n')}`);
        if (starters.length > 0) lines.push(`Ready whenever you want:\n${starters.slice(audit ? 1 : 0).map((s) => `- ${s.title}`).join('\n')}`);
        lines.push('Nothing is saved or deleted without you. Keep it going or clear it anytime.');
        dispatch(addNote({ x: cx + DEFAULT_CARD_W / 2 + 48, y: cy - 140, color: 'yellow', content: lines.join('\n\n') }));
        prepped.forEach((job, i) => {
          dispatch(placeCard({
            sessionId: job.sessionId,
            x: cx - DEFAULT_CARD_W * 1.5 - 48,
            y: cy - DEFAULT_CARD_H / 2 + i * (DEFAULT_CARD_H + 32),
            width: DEFAULT_CARD_W,
            height: DEFAULT_CARD_H,
            expandedSessionIds,
            exact: true,
          }));
        });
      }
      createWelcomeDraft();
    } finally {
      dispatch(clearReveal());
    }
  }, [revealPending, isActive, settingsLoaded, starters, scanSummary, prepped, dashboardId, expandedSessionIds, viewportRef, canvasStateRef, createWelcomeDraft, dispatch]);
}
