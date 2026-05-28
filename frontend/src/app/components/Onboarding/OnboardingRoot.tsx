// Top-level mount for onboarding-v2: hydrate state, attach Director, mount Panel + AC.

import React, { useEffect, useRef } from 'react';
import { useStore } from 'react-redux';
import type { Store } from '@reduxjs/toolkit';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { RootState } from '@/shared/state/store';
import {
  hydrate,
  init,
  loadFromStorage,
  persistToStorage,
  markStepCompleted,
} from '@/shared/state/onboardingProgressSlice';
import AgenticCursor, { type AgenticCursorHandle } from './ac/AgenticCursor';
import { onboardingDirector } from './OnboardingDirector';
import { STEPS } from './steps';
import OnboardingPanel from './OnboardingPanel';
import OnboardingDockedTab from './OnboardingDockedTab';
import { onboardingBus } from './eventBus';
import { report } from './telemetry';

const PERSIST_DEBOUNCE_MS = 200;

const OnboardingRoot: React.FC = () => {
  const acRef = useRef<AgenticCursorHandle | null>(null);
  const dispatch = useAppDispatch();
  const store = useStore<RootState>() as Store<RootState>;
  const tokens = useClaudeTokens();
  const progress = useAppSelector((s) => s.onboardingProgress);
  const userId = useAppSelector((s) => s.settings.data.user_id ?? null);
  const settingsLoaded = useAppSelector((s) => s.settings.loaded);

  useEffect(() => {
    if (progress.initialized) return;
    if (!settingsLoaded) return;

    const persisted = loadFromStorage();
    if (persisted) {
      dispatch(hydrate(persisted));
      return;
    }

    // Start with no pre-completed steps; live subscriber handles skipIf after baseline capture.
    dispatch(
      init({
        currentStepId: STEPS[0]?.id ?? null,
        preCompleted: [],
        disableSkipIf: false,
      }),
    );
  }, [progress.initialized, settingsLoaded, dispatch, store]);

  // Bridge Redux signals to bus + auto-mark on skipIf. Coalesces microtask-bursts of dispatches.
  useEffect(() => {
    let last = new Set(progress.completedSteps);
    let lastBrowserCount = Object.keys(
      store.getState().dashboardLayout?.browserCards ?? {},
    ).length;
    let lastSessionCount = Object.keys(
      (store.getState() as any).agents?.sessions ?? {},
    ).length;
    let lastOutputCount = Object.keys(
      (store.getState() as any).outputs?.items ?? {},
    ).length;

    // Snapshot pre-satisfied skipIf predicates after a 2s settle; those steps need real user action to mark.
    let baselinePredicateMet: Set<string> | null = null;
    const baselineCaptureAt = Date.now() + 2000;
    let lastStatuses: Record<string, string> = {};
    const seedStatuses = () => {
      const sessions = (store.getState() as any).agents?.sessions ?? {};
      const out: Record<string, string> = {};
      for (const [id, s] of Object.entries(sessions)) {
        const st = (s as any)?.status;
        if (typeof st === 'string') out[id] = st;
      }
      lastStatuses = out;
    };
    seedStatuses();

    let pending = false;
    // Slice-ref identity check; Immer mutates only on write so this 5-pointer compare is sound and free.
    let prevAgents: unknown = null;
    let prevDashboardLayout: unknown = null;
    let prevOutputs: unknown = null;
    let prevSkills: unknown = null;
    let prevSettings: unknown = null;

    const runCheck = () => {
      pending = false;
      const state = store.getState();
      // Early-out if no relevant slice reference moved; skips ~95% of microtask wakeups.
      const sAgents = (state as any).agents;
      const sLayout = state.dashboardLayout;
      const sOutputs = (state as any).outputs;
      const sSkills = (state as any).skills;
      const sSettings = (state as any).settings;
      const anyChanged =
        sAgents !== prevAgents ||
        sLayout !== prevDashboardLayout ||
        sOutputs !== prevOutputs ||
        sSkills !== prevSkills ||
        sSettings !== prevSettings;
      prevAgents = sAgents;
      prevDashboardLayout = sLayout;
      prevOutputs = sOutputs;
      prevSkills = sSkills;
      prevSettings = sSettings;
      if (!anyChanged) return;
      const suppressSkipIf = state.onboardingProgress?.disableSkipIf === true;

      // Capture pre-satisfied predicates after the fetch settle; sticky for the run.
      if (baselinePredicateMet === null && Date.now() >= baselineCaptureAt) {
        baselinePredicateMet = new Set();
        for (const s of STEPS) {
          if (s.skipIf?.(state)) baselinePredicateMet.add(s.id);
        }
      }

      const allSkippablesDone = STEPS.every(
        (s) => !s.skipIf || last.has(s.id),
      );
      // Skip evaluation if suppressed, pre-baseline, or every skippable is already marked.
      if (
        !suppressSkipIf &&
        !allSkippablesDone &&
        baselinePredicateMet !== null
      ) {
        for (const s of STEPS) {
          if (last.has(s.id)) continue;
          if (!s.skipIf) continue;
          // Baseline-met predicates require real user action (bus events or outro) to mark.
          if (baselinePredicateMet.has(s.id)) continue;
          if (s.skipIf(state)) {
            last = new Set([...Array.from(last), s.id]);
            dispatch(markStepCompleted(s.id));
            report('step_skipped_via_skipif', { step_id: s.id, stage: s.stage });
          }
        }
      }
      const bc = Object.keys(state.dashboardLayout?.browserCards ?? {}).length;
      if (bc > lastBrowserCount) {
        onboardingBus.emit('browser:spawned');
      }
      lastBrowserCount = bc;

      const sessions = (state as any).agents?.sessions ?? {};
      const sc = Object.keys(sessions).length;
      if (sc > lastSessionCount) {
        onboardingBus.emit('agent:spawned');
      }
      lastSessionCount = sc;

      const outputs = (state as any).outputs?.items ?? {};
      const oc = Object.keys(outputs).length;
      if (oc > lastOutputCount) {
        onboardingBus.emit('app:generation_done');
      }
      lastOutputCount = oc;

      let nextStatuses: Record<string, string> | null = null;
      for (const [id, s] of Object.entries(sessions)) {
        const status = (s as any)?.status;
        if (typeof status !== 'string') continue;
        const prev = lastStatuses[id];
        if (prev !== status) {
          if (status === 'completed' && prev !== 'completed') {
            onboardingBus.emit('agent:completed');
          }
          nextStatuses ??= { ...lastStatuses };
          nextStatuses[id] = status;
        }
      }
      if (nextStatuses) lastStatuses = nextStatuses;
    };

    return store.subscribe(() => {
      // Coalesce N dispatches in the same microtask into 1 check.
      if (pending) return;
      pending = true;
      queueMicrotask(runCheck);
    });
  }, [progress.completedSteps, dispatch, store]);

  // Persist Redux progress to localStorage, debounced.
  useEffect(() => {
    if (!progress.initialized) return;
    const t = window.setTimeout(() => {
      persistToStorage(store.getState().onboardingProgress);
    }, PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [progress, store]);

  useEffect(() => {
    onboardingDirector.attach({
      acRef,
      store,
      getAccentColor: () => tokens.accent.primary,
      isDependencySatisfied: (depId) => {
        // Step 4: browser card currently on canvas.
        if (depId === 'use_browser') {
          const cards = store.getState().dashboardLayout?.browserCards ?? {};
          return Object.keys(cards).length > 0;
        }
        return false;
      },
    });
    return () => onboardingDirector.detach();
  }, [store, tokens.accent.primary]);

  // Wait for sign-in state so we don't render under the SignInGate's z-index.
  if (!settingsLoaded || !userId) return null;
  if (!progress.initialized) return null;

  return (
    <>
      <AgenticCursor ref={acRef} />
      <OnboardingPanel />
      <OnboardingDockedTab />
    </>
  );
};

export default OnboardingRoot;
