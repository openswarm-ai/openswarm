import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { motion, useAnimationControls, AnimatePresence } from '../_motionWin';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { cursorStore, useCursorPosition } from './cursorStore';
import { resolveSelector } from '../selectors';
import ACPopup from './ACPopup';
import ACMultiChoice from './ACMultiChoice';
import type { ACMultiChoiceOption } from '../steps/types';

export interface AgenticCursorHandle {
  fadeIn: (from: { x: number; y: number }) => Promise<void>;
  fadeOut: (to: { x: number; y: number }) => Promise<void>;
  /**
   * Animated jump to (x, y). Defaults to the spring used for normal hops;
   * pass an override (e.g. a tween) when the cursor needs to ride alongside
   * a CSS-transitioned visual like the drag-select rect, where spring
   * overshoot would visibly desync from the rect's bottom-right corner.
   */
  moveTo: (
    x: number,
    y: number,
    transition?: Record<string, unknown>,
  ) => Promise<void>;
  pressClick: () => Promise<void>;
  /** Pin cursor to a live selector; rAF re-resolves so it follows reflows + React node swaps. */
  startTracking: (selector: string, offset?: { x: number; y: number }) => void;
  stopTracking: () => void;
  /** Non-blocking popup above cursor; auto-clears on next physical-move op. */
  showPopup: (text: string) => void;
  /** Single-select multi-choice; resolves with the chosen option id. */
  showMultiChoice: (q: string, opts: ACMultiChoiceOption[]) => Promise<string>;
  hidePopup: () => void;
  getPosition: () => { x: number; y: number };
}

interface PopupState {
  text: string;
}

interface MultiChoiceState {
  question: string;
  options: ACMultiChoiceOption[];
  resolve: (id: string) => void;
}

// Snappy 260/26 spring; calm comes from popup cadence + 3s dwell, not cursor delay.
const SPRING = { type: 'spring' as const, stiffness: 260, damping: 26 };

// On Windows the motionWin shim strips Framer Motion's animate prop, so controls.set({x,y}) never moves the wrapper. We bypass by reading the same store the popups read and applying style.transform directly; Mac is unaffected since Framer's own transform writes win the cascade.
const IS_WIN = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');

// Windows fallback-ease duration. Mirrors the CSS `transform 420ms` transition
// on the cursor wrapper below; on Windows the Director holds for this (plus a
// small settle margin) after a moveTo/fadeOut so the CSS ease actually plays
// before the next step's instant write lands.
const WIN_EASE_MS = 420;

// A little spark when the cursor pops into existence: short orange lines shoot out from the
// tip and fade. Re-keyed on each pop so it replays. One-shot per mount (no infinite loop).
const BURST_SPOKES = 6;
const CursorBurst: React.FC<{ color: string }> = ({ color }) => (
  <>
    {Array.from({ length: BURST_SPOKES }).map((_, i) => (
      <div
        key={i}
        style={{ position: 'absolute', left: 3, top: 3, transform: `rotate(${(i / BURST_SPOKES) * 360}deg)` }}
      >
        <motion.div
          initial={{ y: -1, opacity: 1, scaleY: 0.4 }}
          animate={{ y: -23, opacity: 0, scaleY: 1 }}
          transition={{ duration: 0.62, ease: 'easeOut' }}
          style={{ position: 'absolute', left: -1.5, top: 0, width: 3, height: 12, borderRadius: 2, background: color, boxShadow: `0 0 6px ${color}` }}
        />
      </div>
    ))}
  </>
);

const AgenticCursor = forwardRef<AgenticCursorHandle>((_props, ref) => {
  const c = useClaudeTokens();
  const controls = useAnimationControls();
  const storePos = useCursorPosition();
  const posRef = useRef({ x: 0, y: 0 });
  const [visible, setVisible] = useState(false);
  const [burstKey, setBurstKey] = useState(0);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [multiChoice, setMultiChoice] = useState<MultiChoiceState | null>(null);

  const trackerRef = useRef<{ stop: () => void } | null>(null);

  // Mirrored into cursorStore so popups follow without re-running through Framer's animation pipeline. `instant` controls the Windows CSS-transition fallback: true = snap (tracking), false = ease (moveTo/fadeOut). No-op on Mac.
  const writePos = (x: number, y: number, vis = true, instant = true) => {
    posRef.current = { x, y };
    cursorStore.set({ x, y, visible: vis, instant });
  };

  const stopTrackingInternal = () => {
    if (trackerRef.current) {
      trackerRef.current.stop();
      trackerRef.current = null;
    }
  };

  // Unmount cleanup: without this the rAF callback keeps pinning a dead component's `controls` every frame after Director.detach.
  useEffect(() => {
    return () => stopTrackingInternal();
  }, []);

  useImperativeHandle(ref, () => ({
    async fadeIn(from) {
      stopTrackingInternal();
      writePos(from.x, from.y, true);
      controls.set({ x: from.x, y: from.y, opacity: 0, scale: 0.3 });
      setVisible(true);
      setBurstKey((k) => k + 1); // replay the orange spark on each pop
      // An exaggerated "POP!": scale shoots way past 1 then settles back, opacity snaps in.
      await controls.start({
        opacity: 1,
        scale: [0.1, 1.45, 0.92, 1],
        transition: {
          opacity: { duration: 0.14, ease: 'easeOut' },
          scale: { duration: 0.5, ease: 'easeOut', times: [0, 0.55, 0.8, 1] },
        },
      });
    },
    async moveTo(x, y, transition) {
      // Stop prior tracker so it doesn't snap the cursor back to its old anchor mid-animation.
      stopTrackingInternal();
      if (IS_WIN) {
        // Windows has no Framer runtime (controls.start is a no-op); the visual
        // hop is the CSS transition on the wrapper, driven by cursorStore.
        // TWO-STEP so Chromium actually animates: (1) commit the eased
        // transition at the CURRENT position (cursorStore now flushes an
        // instant-change), let it paint, then (2) move. Changing transform in
        // the same recalc that flips transition none->420ms makes Chromium
        // apply the move instantly (teleport). Then HOLD for the ease so the
        // Director doesn't begin the next step mid-glide.
        writePos(posRef.current.x, posRef.current.y, true, false);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        writePos(x, y, true, false);
        await new Promise((r) => setTimeout(r, WIN_EASE_MS + 30));
        return;
      }
      // Mac path, byte-identical to the pre-Windows version: Framer's spring drives the popup via onUpdate during the animation, then writePos confirms the final position.
      await controls.start({
        x,
        y,
        transition: transition ?? SPRING,
      });
      writePos(x, y, true, false);
    },
    async fadeOut(to) {
      stopTrackingInternal();
      if (IS_WIN) {
        // Glide to the exit point via the same two-step arm as moveTo so the
        // CSS ease actually runs, then hide. The opacity fade has no Framer
        // runtime on Windows, so the cursor just disappears once it eases to `to`.
        writePos(posRef.current.x, posRef.current.y, true, false);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        writePos(to.x, to.y, true, false);
        await new Promise((r) => setTimeout(r, WIN_EASE_MS + 30));
        cursorStore.set({ visible: false });
        setVisible(false);
        return;
      }
      await controls.start({ x: to.x, y: to.y, transition: SPRING });
      writePos(to.x, to.y, true, false);
      await controls.start({
        opacity: 0,
        scale: 0.5,
        transition: { duration: 0.28, ease: 'easeIn' },
      });
      cursorStore.set({ visible: false });
      setVisible(false);
    },
    async pressClick() {
      await controls.start({ scale: 0.78, transition: { duration: 0.08 } });
      await controls.start({ scale: 1, transition: { duration: 0.14 } });
    },
    startTracking(selector, offset) {
      stopTrackingInternal();
      const offX = offset?.x ?? 0;
      const offY = offset?.y ?? 0;
      let cancelled = false;
      let rafId = 0;
      // Cache node by reference; re-querying every frame flickers between transient duplicate matches during React re-renders.
      let cachedEl: HTMLElement | null = resolveSelector(selector);
      let lastX = posRef.current.x;
      let lastY = posRef.current.y;
      let lostSinceMs: number | null = null;
      const LOST_TIMEOUT_MS = 2500;
      const EPSILON = 0.5;
      // 600px+ rect jump in one frame = stale/transient mid-commit, not a real reflow.
      const MAX_JUMP_PX = 600;
      const TITLE_BAR_BOTTOM = 38;
      // ~30fps; per-frame rect reads are wasted for "follow this rect."
      let lastTickAt = 0;
      const TICK_INTERVAL_MS = 33;
      const tick = () => {
        if (cancelled) return;
        const now = performance.now();
        if (now - lastTickAt < TICK_INTERVAL_MS) {
          rafId = requestAnimationFrame(tick);
          return;
        }
        lastTickAt = now;

        if (!cachedEl || !cachedEl.isConnected) {
          cachedEl = resolveSelector(selector);
          if (!cachedEl) {
            const now = Date.now();
            if (lostSinceMs === null) lostSinceMs = now;
            if (now - lostSinceMs > LOST_TIMEOUT_MS) {
              cancelled = true;
              cancelAnimationFrame(rafId);
              window.dispatchEvent(
                new CustomEvent('openswarm:onboarding:lost_target', {
                  detail: { selector },
                }),
              );
              return;
            }
          } else {
            lostSinceMs = null;
          }
        } else {
          lostSinceMs = null;
        }

        if (cachedEl) {
          const r = cachedEl.getBoundingClientRect();
          if (r.width > 0 || r.height > 0) {
            const cx = r.left + r.width / 2 + offX;
            const cy = r.top + r.height / 2 + offY;
            // Off-window / title-bar frames are stale-reads or hidden targets.
            const offWindow =
              cx < 0 ||
              cy < 0 ||
              cx > window.innerWidth ||
              cy > window.innerHeight;
            const inTitleBar = cy < TITLE_BAR_BOTTOM;
            if (!offWindow && !inTitleBar) {
              const dx = Math.abs(cx - lastX);
              const dy = Math.abs(cy - lastY);
              const teleport = dx > MAX_JUMP_PX || dy > MAX_JUMP_PX;
              if (!teleport && (dx > EPSILON || dy > EPSILON)) {
                controls.set({ x: cx, y: cy });
                writePos(cx, cy, true);
                lastX = cx;
                lastY = cy;
              }
            }
          }
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
      trackerRef.current = {
        stop: () => {
          cancelled = true;
          cancelAnimationFrame(rafId);
        },
      };
    },
    stopTracking() {
      stopTrackingInternal();
    },
    showPopup(text) {
      setPopup({ text });
    },
    showMultiChoice(question, options) {
      return new Promise<string>((resolve) => {
        setMultiChoice({
          question,
          options,
          resolve: (id) => {
            setMultiChoice(null);
            resolve(id);
          },
        });
      });
    },
    hidePopup() {
      setPopup(null);
      if (multiChoice) {
        // Resolve with '' on abort so the promise doesn't dangle.
        multiChoice.resolve('');
        setMultiChoice(null);
      }
    },
    getPosition() {
      return { ...posRef.current };
    },
  }));

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      {/* pointer-events:none so the cursor never blocks underlying app interaction. */}
      <motion.div
        animate={controls}
        onUpdate={(latest) => {
          const x = typeof latest.x === 'number' ? latest.x : posRef.current.x;
          const y = typeof latest.y === 'number' ? latest.y : posRef.current.y;
          // Push to external store instead of re-rendering; popups subscribe via useSyncExternalStore.
          if (visible) cursorStore.set({ x, y });
        }}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          zIndex: 10500,
          pointerEvents: 'none',
          transformOrigin: 'top left',
          ...(IS_WIN
            ? {
                transform: `translate(${storePos.x}px, ${storePos.y}px)`,
                // Closest CSS approximation of the Mac spring (stiffness 260, damping 26): a softly easing ~420ms cubic-bezier for moveTo/fadeOut. Tracking sets instant=true so the cursor snaps to its target each frame instead of perpetually lagging behind.
                transition: storePos.instant ? 'none' : 'transform 420ms cubic-bezier(0.22, 1, 0.36, 1)',
                willChange: 'transform',
              }
            : null),
        }}
      >
        {visible && (
          <>
            {/* Orange spark behind the arrow, replays each pop via burstKey. */}
            <div key={burstKey} style={{ position: 'absolute', top: 0, left: 0 }}>
              <CursorBurst color={c.accent.primary} />
            </div>
            <motion.div
              animate={{
                scale: [1, 1.04, 1],
              }}
              transition={{
                duration: 1.8,
                repeat: Infinity,
                ease: 'easeInOut',
              }}
              style={{
                transform: 'translate(-2px, -2px)',
                filter: `drop-shadow(0 0 6px ${c.accent.primary}cc) drop-shadow(0 0 14px ${c.accent.primary}55)`,
              }}
            >
              <CursorArrow color={c.accent.primary} />
            </motion.div>
          </>
        )}
      </motion.div>

      {/* Portaled separately so cursor wrapper's pointer-events:none doesn't propagate. */}
      <AnimatePresence>
        {popup && <ACPopup key="popup" text={popup.text} />}
        {multiChoice && (
          <ACMultiChoice
            key="multi-choice"
            question={multiChoice.question}
            options={multiChoice.options}
            onAnswer={multiChoice.resolve}
          />
        )}
      </AnimatePresence>
    </>,
    document.body,
  );
});

AgenticCursor.displayName = 'AgenticCursor';
export default AgenticCursor;

/** 22x22 arrow cursor, points down-right. */
const CursorArrow: React.FC<{ color: string }> = ({ color }) => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 22 22"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden
  >
    <path
      d="M3 2 L3 18 L7.5 14 L10 19.5 L13 18 L10.5 12.5 L17 12 Z"
      fill={color}
      stroke="white"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
  </svg>
);
