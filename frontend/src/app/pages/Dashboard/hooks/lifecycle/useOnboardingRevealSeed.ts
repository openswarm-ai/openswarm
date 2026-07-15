import { useEffect, useRef, type RefObject } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { addNote, DEFAULT_CARD_W } from '@/shared/state/dashboardLayoutSlice';
import { clearReveal } from '@/shared/state/onboardingV3Slice';

interface Args {
  isActive: boolean;
  canvasEmpty: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
  canvasStateRef: RefObject<{ panX: number; panY: number; zoom: number }>;
  createWelcomeDraft: () => void;
}

// The reveal: onboarding v3 finished behind the curtain, so dress the canvas BEFORE the overlay's exit fade lands. Welcome chat (with personalized greeting + chips) at center, a "while you were setting up" note docked beside it. Everything seeded is a draft or a note; nothing runs until the user clicks.
export function useOnboardingRevealSeed({ isActive, canvasEmpty, viewportRef, canvasStateRef, createWelcomeDraft }: Args): void {
  const dispatch = useAppDispatch();
  const revealPending = useAppSelector((s) => s.onboardingV3.revealPending);
  const greeting = useAppSelector((s) => s.onboardingV3.greeting);
  const starters = useAppSelector((s) => s.onboardingV3.starters);
  const scanSummary = useAppSelector((s) => s.onboardingV3.scanSummary);
  const settingsLoaded = useAppSelector((s) => s.settings.loaded);
  const seededRef = useRef(false);

  useEffect(() => {
    if (!revealPending || seededRef.current || !isActive || !canvasEmpty || !settingsLoaded) return;
    seededRef.current = true;
    try {
      const vp = viewportRef.current;
      const cs = canvasStateRef.current;
      if (vp && cs) {
        const vr = vp.getBoundingClientRect();
        const cx = (vr.width / 2 - cs.panX) / cs.zoom;
        const cy = (vr.height / 2 - cs.panY) / cs.zoom;
        const lines: string[] = ['While you were setting up, I got some ideas ready.'];
        if (scanSummary) lines.push(`Spotted on this Mac: ${scanSummary}.`);
        if (starters.length > 0) lines.push(`Ready to run:\n${starters.map((s) => `- ${s.title}`).join('\n')}`);
        lines.push('Pick one in the chat, or just type what you need.');
        dispatch(addNote({ x: cx + DEFAULT_CARD_W / 2 + 48, y: cy - 140, color: 'yellow', content: lines.join('\n\n') }));
      }
      createWelcomeDraft();
    } finally {
      dispatch(clearReveal());
    }
  }, [revealPending, isActive, canvasEmpty, settingsLoaded, greeting, starters, scanSummary, viewportRef, canvasStateRef, createWelcomeDraft, dispatch]);
}
