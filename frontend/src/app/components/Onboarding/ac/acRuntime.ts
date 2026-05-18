/** AC runtime: sequentially awaits a step's ACOp[] via the AgenticCursor handle; aborts on AbortSignal. */

import type { Store } from '@reduxjs/toolkit';
import type { RootState } from '@/shared/state/store';
import {
  recordMultiChoice,
  markStepCompleted,
  clearJustCompleted,
  setRunning,
  setCurrentStep,
} from '../OnboardingProgressSlice';
import { report, markStepStarted, clearStepTiming } from '../telemetry';
import { onboardingBus, type OnboardingEvent } from '../eventBus';
import { waitForSelector, resolveSelector } from '../selectors';
import {
  spawnGlowRect,
  clickRipple,
  animateDragSelect,
  sleep,
} from './ACGestures';
import { typeInto } from './ACTypewriter';
import type {
  ACOp,
  AdvanceCondition,
  OnboardingStep,
} from '../steps/types';
import type { AgenticCursorHandle } from './AgenticCursor';

interface RunContext {
  ac: AgenticCursorHandle;
  store: Store<RootState>;
  spawnPoint: { x: number; y: number };
  accentColor: string;
  signal: AbortSignal;
  silent: boolean; // suppress popups during dependency re-walks
  stepId: string;
  findStep: (id: string) => OnboardingStep | undefined;
  highlightCleanup: { current: (() => void) | null };
  popupShownAt: { current: number | null };
}

// 6s = streaming typewriter cadence + ~3s post-stream read time; floor for popups that auto-transition without an explicit user action.
const MIN_POPUP_DWELL_MS = 6000;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function ensurePopupDwell(ctx: RunContext): Promise<void> {
  const shownAt = ctx.popupShownAt.current;
  if (shownAt == null) return;
  const elapsed = performance.now() - shownAt;
  const remaining = MIN_POPUP_DWELL_MS - elapsed;
  if (remaining > 0) await abortableSleep(remaining, ctx.signal);
}

export interface RunStepArgs {
  step: OnboardingStep;
  spawnPoint: { x: number; y: number };
  ac: AgenticCursorHandle;
  store: Store<RootState>;
  accentColor: string;
  signal: AbortSignal;
  findStep: (id: string) => OnboardingStep | undefined;
  isDependencySatisfied?: (depId: string) => boolean;
}

export async function runStep(args: RunStepArgs): Promise<void> {
  const { step, spawnPoint, ac, store, accentColor, signal, findStep } = args;

  store.dispatch(setRunning(true));
  store.dispatch(setCurrentStep(step.id));
  markStepStarted();
  // Bump bus replay gate so cached emits from prior steps can't satisfy this step's wait_user gates.
  onboardingBus.resetReplayGate();
  report('step_started', { step_id: step.id, stage: step.stage });

  const highlightCleanup: { current: (() => void) | null } = { current: null };
  const popupShownAt: { current: number | null } = { current: null };
  const ctx: RunContext = {
    ac,
    store,
    spawnPoint,
    accentColor,
    signal,
    silent: false,
    stepId: step.id,
    findStep,
    highlightCleanup,
    popupShownAt,
  };

  try {
    await ac.fadeIn(spawnPoint);

    // Walk user into a dashboard first when step needs one; otherwise the first move_to hits a missing target on /actions, /skills, etc.
    if (step.requiresDashboard && !isInDashboardRoute()) {
      await runOps(buildOpenDashboardOps(), ctx);
    }

    if (step.dependsOn?.length) {
      for (const dep of step.dependsOn) {
        if (args.isDependencySatisfied?.(dep.stepId)) continue;
        const depStep = findStep(dep.stepId);
        if (!depStep) continue;
        if (dep.reopen === 'walk_again') {
          report('dependency_walk', { step_id: step.id, dep_id: dep.stepId });
          ac.showPopup('Quick setup before we continue.');
          ctx.popupShownAt.current = performance.now();
          await sleep(700);
          // Non-silent dep-walk so each move_to has a label; telemetry stays per-step to avoid double-count.
          await runOps(depStep.ops, { ...ctx, silent: false, stepId: depStep.id });
        }
      }
    }

    await runOps(step.ops, ctx);
    report('step_completed', { step_id: step.id });
    store.dispatch(markStepCompleted(step.id));
    window.setTimeout(() => {
      const cur = store.getState().onboardingProgress;
      if (cur?.justCompletedStepId === step.id) {
        store.dispatch(clearJustCompleted());
      }
    }, 950);
  } catch (err) {
    const isAbort =
      (err as DOMException)?.name === 'AbortError' || signal.aborted;
    const msg = (err as Error)?.message ?? String(err);
    const isSelectorTimeout = /^waitForSelector:/.test(msg);

    if (isAbort) {
      report('step_aborted', { step_id: step.id });
    } else if (isSelectorTimeout) {
      report('step_selector_timeout', { step_id: step.id, error: msg });
    } else {
      console.error('[onboarding] step failed', step.id, err);
      report('step_error', { step_id: step.id, error: msg });
    }

    // Re-show panel immediately; otherwise it stays hidden through the 1.8s recovery popup + fadeOut, looking like a crash.
    store.dispatch(setRunning(false));

    try {
      ac.hidePopup();
      ac.stopTracking();
      if (highlightCleanup.current) {
        highlightCleanup.current();
        highlightCleanup.current = null;
      }
      const showMessage = !signal.reason || signal.reason !== 'user-cancel';
      if (showMessage) {
        // Surface short error in recovery popup; 180-char cap keeps it readable.
        const isAbortErr =
          (err as DOMException)?.name === 'AbortError' || signal.aborted;
        const errSnippet = isAbortErr
          ? ''
          : ((err as Error)?.message ?? String(err)).slice(0, 180);
        const debugSuffix = errSnippet
          ? `\n\n[debug] ${errSnippet}`
          : '';
        // Stash full untruncated error + stack on window for DevTools; popup only shows the 180-char snippet.
        try {
          (window as any).__OPENSWARM_LAST_ONBOARDING_ERR__ = {
            step_id: step.id,
            message: (err as Error)?.message ?? String(err),
            stack: (err as Error)?.stack,
            at: new Date().toISOString(),
          };
          // eslint-disable-next-line no-console
          console.error(
            '[onboarding] step bailed:',
            step.id,
            (err as Error)?.message ?? err,
            err,
          );
        } catch {
          /* defensive; never let diagnostics throw */
        }
        ac.showPopup(
          "No worries, feel free to explore. Tap Show me whenever you're ready." +
            debugSuffix,
        );
        // 14s: ACPopup streams at ~30ms/char + ~210ms/punct, so a 240-char popup takes ~10s to finish streaming; needs time for streamer + read.
        await new Promise<void>((r) => window.setTimeout(r, 14000));
      }
    } catch {
      /* defensive; never let cleanup throw */
    }

    // Retreat to original spawnPoint; re-reading the live icon rect here yields transient coords mid-slide-animation (sometimes (0,0)).
    try {
      await ac.fadeOut(spawnPoint);
    } catch {
      /* swallow */
    }
  } finally {
    if (highlightCleanup.current) {
      highlightCleanup.current();
      highlightCleanup.current = null;
    }
    store.dispatch(setRunning(false));
    clearStepTiming();
  }
}

async function runOps(ops: ACOp[], ctx: RunContext): Promise<void> {
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (ctx.signal.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    if (!ctx.silent) {
      report('op_started', {
        step_id: ctx.stepId,
        op_index: i,
        op_kind: op.kind,
      });
    }
    const opStart = Date.now();
    try {
      await runOp(op, ctx);
      if (!ctx.silent) {
        report('op_completed', {
          step_id: ctx.stepId,
          op_index: i,
          op_kind: op.kind,
          duration_ms: Date.now() - opStart,
        });
      }
    } catch (err) {
      if (!ctx.silent && (err as DOMException)?.name !== 'AbortError') {
        report('op_failed', {
          step_id: ctx.stepId,
          op_index: i,
          op_kind: op.kind,
          duration_ms: Date.now() - opStart,
          error: String(err),
        });
        // eslint-disable-next-line no-console
        console.error(
          `[onboarding] op failed: step=${ctx.stepId} op#${i}=${op.kind} ` +
            `duration=${Date.now() - opStart}ms`,
          { op, error: err },
        );
      }
      throw err;
    }
  }
}

async function runOp(op: ACOp, ctx: RunContext): Promise<void> {
  const { ac, store, signal, accentColor } = ctx;

  // Physically-moving ops clear popup/tracker/glow; wait_user/delay/popup/highlight_section/multi_choice keep them.
  const clearsTransients =
    op.kind === 'move_to' ||
    op.kind === 'click' ||
    op.kind === 'type_into' ||
    op.kind === 'drag_select' ||
    op.kind === 'outro';
  if (clearsTransients) {
    // Hold previous popup for MIN_POPUP_DWELL_MS before next auto-transition clears it; otherwise fast popup -> delay -> move_to sequences would yank the bubble before the user can read it.
    await ensurePopupDwell(ctx);
    ac.hidePopup();
    ctx.popupShownAt.current = null;
    ac.stopTracking();
    if (ctx.highlightCleanup.current) {
      ctx.highlightCleanup.current();
      ctx.highlightCleanup.current = null;
    }
  }

  switch (op.kind) {
    case 'move_to': {
      // Order matters: open the whole sidebar first (sub-section markers must exist in DOM), THEN expand Customization, THEN target.
      const expandSidebarOps = maybeBuildExpandSidebarOps(op.target);
      if (expandSidebarOps) {
        await runOps(expandSidebarOps, ctx);
      }
      const expandOps = maybeBuildExpandCustomizationOps(op.target);
      if (expandOps) {
        await runOps(expandOps, ctx);
      }
      const el = await waitForSelector(op.target);
      const scrolled = scrollIntoViewIfNeeded(el);
      const offX = op.offset?.x ?? 0;
      const offY = op.offset?.y ?? 0;
      const TITLE_BAR_BOTTOM = 38;
      // Broken = zero size or pinned in title bar; off-viewport just means smooth-scroll is mid-flight (don't treat as broken).
      const isBroken = (rr: DOMRect, y: number): boolean =>
        y < TITLE_BAR_BOTTOM ||
        rr.width === 0 ||
        rr.height === 0;
      const isOffViewport = (y: number): boolean =>
        y > window.innerHeight || y < 0;
      let r = el.getBoundingClientRect();
      let cx = r.left + r.width / 2 + offX;
      let cy = r.top + r.height / 2 + offY;
      // Poll scroll-settle every 60ms up to 1s (smooth-scrolls take 250-500ms); bail early when in viewport with non-broken rect.
      const SCROLL_SETTLE_MAX_MS = 1000;
      const POLL_MS = 60;
      const startedAt = performance.now();
      const needsSettle = scrolled || isBroken(r, cy) || isOffViewport(cy);
      if (needsSettle) {
        while (performance.now() - startedAt < SCROLL_SETTLE_MAX_MS) {
          await sleep(POLL_MS);
          r = el.getBoundingClientRect();
          cx = r.left + r.width / 2 + offX;
          cy = r.top + r.height / 2 + offY;
          if (!isBroken(r, cy) && !isOffViewport(cy)) break;
        }
      }
      if (isBroken(r, cy)) {
        throw new Error(`waitForSelector: "${op.target}" rect did not settle`);
      }
      // Wait 2 stable frames before reading final rect; targets like the dock chat input nudge into position over a few frames after mount, and a stale-rect spring lands ~10-30px off and visibly jumps.
      const STABILITY_MAX_MS = 200;
      const STABILITY_THRESHOLD_PX = 1.5;
      const stabilityStart = performance.now();
      let prevCx = cx;
      let prevCy = cy;
      let stableFrames = 0;
      while (
        stableFrames < 2 &&
        performance.now() - stabilityStart < STABILITY_MAX_MS
      ) {
        await new Promise<void>((res) => requestAnimationFrame(() => res()));
        r = el.getBoundingClientRect();
        cx = r.left + r.width / 2 + offX;
        cy = r.top + r.height / 2 + offY;
        if (
          Math.abs(cx - prevCx) <= STABILITY_THRESHOLD_PX &&
          Math.abs(cy - prevCy) <= STABILITY_THRESHOLD_PX
        ) {
          stableFrames += 1;
        } else {
          stableFrames = 0;
        }
        prevCx = cx;
        prevCy = cy;
      }
      await ac.moveTo(cx, cy);
      // rAF yield lets Framer's spring resolve before tracker's controls.set() cancels it mid-overshoot; otherwise cursor "teleports" into destination.
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      ac.startTracking(op.target, op.offset);
      return;
    }
    case 'popup': {
      if (ctx.silent) return;
      await ensurePopupDwell(ctx);
      ac.showPopup(op.text);
      ctx.popupShownAt.current = performance.now();
      return;
    }
    case 'multi_choice': {
      if (ctx.silent) return;
      await ensurePopupDwell(ctx);
      ctx.popupShownAt.current = null;
      const id = await ac.showMultiChoice(op.question, op.options);
      if (id) {
        store.dispatch(
          recordMultiChoice({ stepId: ctx.stepId, opId: op.opId, answerId: id }),
        );
        report('multi_choice_answered', {
          step_id: ctx.stepId,
          op_id: op.opId,
          answer_id: id,
        });
      }
      const choice = op.options.find((o) => o.id === id);
      if (choice?.thenOps?.length) {
        await runOps(choice.thenOps, ctx);
      }
      return;
    }
    case 'highlight_section': {
      const el = await waitForSelector(op.target);
      if (ctx.highlightCleanup.current) {
        ctx.highlightCleanup.current();
        ctx.highlightCleanup.current = null;
      }
      const cleanup = spawnGlowRect(el, accentColor);
      ctx.highlightCleanup.current = cleanup;
      if (op.popup && !ctx.silent) {
        await ensurePopupDwell(ctx);
        ac.showPopup(op.popup);
        ctx.popupShownAt.current = performance.now();
      }
      await sleep(op.durationMs ?? 600);
      return;
    }
    case 'type_into': {
      const resolvedText =
        typeof op.text === 'function' ? op.text(ctx.store.getState()) : op.text;
      const targetTrimmed = resolvedText.trim();

      const readText = (e: HTMLElement): string => {
        if (e.isContentEditable) return (e.textContent ?? '').trim();
        if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement)
          return (e.value ?? '').trim();
        return (e.textContent ?? '').trim();
      };

      // Retry loop: App Builder's ViewEditor remounts can detach the chat input mid-type; re-fetch selector and retype.
      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const el = await waitForSelector(op.target);
        if (scrollIntoViewIfNeeded(el)) {
          await sleep(180);
        }
        const r = el.getBoundingClientRect();
        await ac.moveTo(
          Math.min(r.right - 14, r.left + r.width / 2),
          r.top + r.height / 2,
        );
        ac.startTracking(op.target, { x: 0, y: 0 });
        await typeInto(el, resolvedText, { speedMs: op.speedMs });

        // 80ms lets React's onInput commit land in the warm path.
        await sleep(80);

        if (!targetTrimmed) return;
        // Re-fetch in case original `el` was detached by remount.
        const currentEl = resolveSelector(op.target);
        const verifyEl = currentEl ?? el;
        const landed = readText(verifyEl);
        if (landed.length >= Math.floor(targetTrimmed.length * 0.8)) {
          return;
        }

        if (attempt < MAX_ATTEMPTS) {
          // eslint-disable-next-line no-console
          console.warn(
            `[onboarding] type_into verify-miss for "${op.target}" attempt ${attempt}/${MAX_ATTEMPTS}; typed=${landed.length}/${targetTrimmed.length}, retrying`,
          );
          // 600ms > the ~500ms stability window wait_for_dom uses, so DOM is in steady state by retry.
          await sleep(600);
          continue;
        }

        if (verifyEl.isContentEditable) {
          verifyEl.focus();
          const range = document.createRange();
          range.selectNodeContents(verifyEl);
          const sel = window.getSelection();
          if (sel) {
            sel.removeAllRanges();
            sel.addRange(range);
          }
          try {
            document.execCommand('delete', false);
            const ok = document.execCommand('insertText', false, resolvedText);
            if (!ok) {
              verifyEl.textContent = resolvedText;
              verifyEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
          } catch {
            verifyEl.textContent = resolvedText;
            verifyEl.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
        // Throw descriptive error so wizard's catch shows diagnostic instead of letting next op burn 15s on a button that never renders (hasContent=false).
        await sleep(120);
        const finalLanded = readText(resolveSelector(op.target) ?? verifyEl);
        if (finalLanded.length < Math.floor(targetTrimmed.length * 0.5)) {
          throw new Error(
            `type_into: text never landed in "${op.target}" after ` +
              `${MAX_ATTEMPTS} attempts (final length=${finalLanded.length}/${targetTrimmed.length}). ` +
              `The chat input was probably detached by an in-flight remount; ` +
              `check whether ViewEditor's seed-then-navigate is firing twice ` +
              `or whether AgentChat's session key is swapping mid-stream.`,
          );
        }
      }
      return;
    }
    case 'click': {
      const el = await waitForSelector(op.target);
      if (scrollIntoViewIfNeeded(el)) {
        await sleep(180);
      }
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      await ac.moveTo(x, y);
      await ac.pressClick();
      clickRipple(x, y, accentColor);
      if (op.simulate !== false) {
        // Disabled-button guard: synthetic click on disabled wrapper is silent no-op (step 6 "send does nothing"); wait one frame in case state lands late.
        const isDisabled = (n: HTMLElement | null): boolean => {
          while (n) {
            if (n.hasAttribute('disabled')) return true;
            if (n.getAttribute('aria-disabled') === 'true') return true;
            n = n.parentElement;
          }
          return false;
        };
        if (isDisabled(el)) {
          await new Promise<void>((res) =>
            requestAnimationFrame(() => res()),
          );
          await sleep(120);
        }
        try {
          el.click();
        } catch {
          /* swallow; degrade to visual-only */
        }
      }
      // Do NOT startTracking after a click: many targets are ephemeral (send button -> stop button, modal trigger unmounts), and tracking a vanishing element trips lost-target -> step abort -> markStepCompleted never fires.
      return;
    }
    case 'drag_select': {
      const el = await waitForSelector(op.target);
      if (scrollIntoViewIfNeeded(el)) {
        await sleep(180);
      }
      // Wait 2 stable frames before reading final rect; e.g. step 6's fit-to-view mid-pan changes target rect frame-to-frame and yields a misaligned selection box.
      let r = el.getBoundingClientRect();
      const stableStart = performance.now();
      let prevLeft = r.left;
      let prevTop = r.top;
      let stableFrames = 0;
      while (stableFrames < 2 && performance.now() - stableStart < 500) {
        await new Promise<void>((res) => requestAnimationFrame(() => res()));
        r = el.getBoundingClientRect();
        if (Math.abs(r.left - prevLeft) <= 1.5 && Math.abs(r.top - prevTop) <= 1.5) {
          stableFrames += 1;
        } else {
          stableFrames = 0;
        }
        prevLeft = r.left;
        prevTop = r.top;
      }
      const fromX = r.left - 12;
      const fromY = r.top - 12;
      const toX = r.right + 12;
      const toY = r.bottom + 12;
      await ac.moveTo(fromX, fromY);
      // Cursor + rect animate in parallel with matching cubic-bezier (ACGestures.ts) so they stay in lock-step; spring physics would overshoot and desync.
      const RECT_DURATION_MS = 600;
      await Promise.all([
        animateDragSelect(
          { fromX, fromY, toX, toY },
          accentColor,
          RECT_DURATION_MS,
        ),
        ac.moveTo(toX, toY, {
          duration: RECT_DURATION_MS / 1000,
          ease: [0.4, 0, 0.2, 1],
        }),
      ]);
      return;
    }
    case 'wait_user': {
      const first = await waitForCondition(
        op.condition,
        signal,
        store,
        op.timeoutMs,
      );
      // Retry on event_bus timeout only: those fire on real user actions, so silent soft-success would leave them in a half-broken state. click_target + redux_predicate keep soft-success (listener may have just missed).
      if (first.timedOut && op.condition.kind === 'event_bus') {
        report('wait_user_retry_prompted', {
          step_id: ctx.stepId,
          event: op.condition.event,
        });
        ac.showPopup("Didn't seem to go through. Try again?");
        ctx.popupShownAt.current = performance.now();
        await waitForCondition(
          op.condition,
          signal,
          store,
          op.timeoutMs,
        );
      }
      ac.hidePopup();
      // CRITICAL: stop tracking previous target; many wait_user click_target's are ephemeral (App Builder's "+ New app" unmounts on click) and the 2.5s lost-target watchdog would abort the step before the next op runs.
      ac.stopTracking();
      // Clear dwell: user already engaged with popup, so next op can move immediately. Without this, a quick follow-up click was dropped while the next listener was still being registered.
      ctx.popupShownAt.current = null;
      await sleep(16);
      return;
    }
    case 'delay': {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, op.ms);
        const onAbort = () => {
          window.clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          reject(new DOMException('aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort);
      });
      return;
    }
    case 'wait_for_dom': {
      const timeoutMs = op.timeoutMs ?? 8000;
      const POLL_MS = 100;
      // Stability gate: same node identity for STABILITY_POLLS consecutive polls (~500ms) walls off AgentChat's runtime/start->stop->start remount; otherwise typing lands in a detached node and silently no-ops.
      const STABILITY_POLLS = 5;
      const startedAt = performance.now();
      let stableEl: Element | null = null;
      let stableCount = 0;
      while (performance.now() - startedAt < timeoutMs) {
        if (signal.aborted) {
          throw new DOMException('aborted', 'AbortError');
        }
        const hit = document.querySelector(op.css);
        if (hit) {
          if (hit === stableEl) {
            stableCount += 1;
            if (stableCount >= STABILITY_POLLS) return;
          } else {
            stableEl = hit;
            stableCount = 1;
          }
        } else {
          stableEl = null;
          stableCount = 0;
        }
        await sleep(POLL_MS);
      }
      // Timeout error includes scope diagnostics: selector-mismatch vs. wrong-scope vs. nothing-in-DOM are three different bugs that "step failed" can't distinguish.
      const scopeEls = Array.from(
        document.querySelectorAll('[data-onboarding-scope]'),
      ).map((e) => (e as HTMLElement).getAttribute('data-onboarding-scope'));
      const chatInputEls = Array.from(
        document.querySelectorAll('[data-onboarding="chat-input"]'),
      );
      const chatInputScopes = chatInputEls.map((el) => {
        let p: HTMLElement | null = el.parentElement;
        while (p) {
          const s = p.getAttribute('data-onboarding-scope');
          if (s) return s;
          p = p.parentElement;
        }
        return '<no-scope>';
      });
      const msg =
        `wait_for_dom: "${op.css}" did not appear within ${timeoutMs}ms ` +
        `[scopes=${JSON.stringify(scopeEls)}; chatInputs=${chatInputEls.length}; ` +
        `chatInputScopes=${JSON.stringify(chatInputScopes)}]`;
      console.error('[onboarding]', msg);
      throw new Error(msg);
    }
    case 'outro': {
      await ac.fadeOut(ctx.spawnPoint);
      return;
    }
  }
}

/** Returns true if a scroll was triggered; runtime uses this to skip the smooth-scroll-settle wait on already-visible targets (~10s saved across the tour). */
function scrollIntoViewIfNeeded(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const PAD = 24;
  const offTop = r.top < PAD;
  const offBottom = r.bottom > vh - PAD;
  const offLeft = r.left < PAD;
  const offRight = r.right > vw - PAD;
  if (!offTop && !offBottom && !offLeft && !offRight) return false;
  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  } catch {
    try {
      el.scrollIntoView();
    } catch {
      /* tracker will still try to pin once visible */
    }
  }
  return true;
}

// HashRouter path is singular `/dashboard/`, not `/dashboards/`; mismatch previously had runtime always-in-dashboard.
function isInDashboardRoute(): boolean {
  const h = window.location.hash || '';
  return /^#\/dashboard\/[^/?#]+/.test(h);
}

// State-aware: skips section-click when Dashboards is already expanded so we don't collapse it.
function buildOpenDashboardOps(): ACOp[] {
  const sectionEl = document.querySelector<HTMLElement>(
    '[data-onboarding="sidebar-dashboards"]',
  );
  const sectionExpanded =
    sectionEl?.dataset.expanded === 'true' ||
    sectionEl?.getAttribute('aria-expanded') === 'true';

  const ops: ACOp[] = [];
  if (!sectionExpanded) {
    ops.push(
      { kind: 'move_to', target: 'sidebar-dashboards' },
      { kind: 'popup', text: 'Open the Dashboards list.' },
      {
        kind: 'wait_user',
        condition: { kind: 'click_target', target: 'sidebar-dashboards' },
        timeoutMs: 60000,
      },
    );
  }
  ops.push(
    { kind: 'move_to', target: 'dashboard-row-first' },
    { kind: 'popup', text: 'Click into a dashboard to continue.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: 'dashboard-row-first' },
      timeoutMs: 60000,
    },
  );
  return ops;
}

const CUSTOMIZATION_AREA_TARGETS = new Set<string>([
  'sidebar-actions',
  'sidebar-skills',
  'sidebar-modes',
]);

// `sidebar-toggle` excluded: it lives in the top bar (we click it to expand). Recursing would loop.
const SIDEBAR_AREA_TARGETS = new Set<string>([
  'sidebar-settings-button',
  'sidebar-dashboards',
  'sidebar-customization',
  'sidebar-skills',
  'sidebar-actions',
  'sidebar-modes',
  'sidebar-apps',
  'dashboard-row-first',
]);

/** MUST run before maybeBuildExpandCustomizationOps: Customization header is inside the collapsible panel, so expand-check on hidden panel queues an impossible click. */
function maybeBuildExpandSidebarOps(target: string): ACOp[] | null {
  if (!SIDEBAR_AREA_TARGETS.has(target)) return null;
  const toggle = document.querySelector<HTMLElement>(
    '[data-onboarding="sidebar-toggle"]',
  );
  // Missing toggle: assume visible and let waitForSelector handle the unlikely real failure.
  const expanded =
    toggle?.getAttribute('aria-expanded') === 'true' || toggle === null;
  if (expanded) return null;
  return [
    { kind: 'click', target: 'sidebar-toggle', simulate: true },
    { kind: 'delay', ms: 260 },
  ];
}

function maybeBuildExpandCustomizationOps(target: string): ACOp[] | null {
  if (!CUSTOMIZATION_AREA_TARGETS.has(target)) return null;
  const header = document.querySelector<HTMLElement>(
    '[data-onboarding="sidebar-customization"]',
  );
  const expanded =
    header?.dataset.expanded === 'true' ||
    header?.getAttribute('aria-expanded') === 'true';
  if (expanded) return null;
  return [
    { kind: 'move_to', target: 'sidebar-customization' },
    { kind: 'popup', text: 'Open Customization.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: 'sidebar-customization' },
      timeoutMs: 60000,
    },
  ];
}

interface WaitResult {
  timedOut: boolean;
}

function waitForCondition(
  cond: AdvanceCondition,
  signal: AbortSignal,
  store: Store<RootState>,
  timeoutMs?: number,
): Promise<WaitResult> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('aborted', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    let cleanup: () => void = () => {};
    let timer: number | null = null;

    const finish = (timedOut: boolean) => {
      cleanup();
      if (timer !== null) window.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ timedOut });
    };

    const onAbort = () => {
      cleanup();
      if (timer !== null) window.clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort);

    if (timeoutMs && timeoutMs > 0) {
      timer = window.setTimeout(() => {
        finish(true);
      }, timeoutMs);
    }

    switch (cond.kind) {
      case 'click_target': {
        const handler = (e: Event) => {
          const el = e.target as HTMLElement | null;
          if (
            el?.closest(
              `[data-onboarding="${cond.target}"], [data-select-type="${cond.target}"]`,
            )
          ) {
            finish(false);
          }
        };
        document.addEventListener('click', handler, true);
        cleanup = () => document.removeEventListener('click', handler, true);
        return;
      }
      case 'redux_predicate': {
        const check = () => {
          const value = cond.selector(store.getState());
          const ok =
            cond.equals !== undefined
              ? value === cond.equals
              : cond.truthy
                ? Boolean(value)
                : Boolean(value);
          if (ok) finish(false);
        };
        check();
        const unsub = store.subscribe(check);
        cleanup = unsub;
        return;
      }
      case 'event_bus': {
        const off = onboardingBus.once(cond.event as OnboardingEvent, () =>
          finish(false),
        );
        cleanup = off;
        return;
      }
    }
  });
}
