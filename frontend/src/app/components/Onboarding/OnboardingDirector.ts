// Glue between the Onboarding panel and the AC runtime; thin policy layer over acRuntime.runStep.

import type { Store } from '@reduxjs/toolkit';
import type { RootState } from '@/shared/state/store';
import type { RefObject } from 'react';
import { runStep } from './ac/acRuntime';
import type { AgenticCursorHandle } from './ac/AgenticCursor';
import type { OnboardingStep } from './steps/types';
import { STEPS, findStepById } from './steps';
import { report } from './telemetry';

interface AttachArgs {
  acRef: RefObject<AgenticCursorHandle | null>;
  store: Store<RootState>;
  getAccentColor: () => string;
  /** True if a dep is still satisfied; if so walk_again skips its flow. */
  isDependencySatisfied: (depId: string) => boolean;
}

class OnboardingDirector {
  private acRef: RefObject<AgenticCursorHandle | null> | null = null;
  private store: Store<RootState> | null = null;
  private getAccentColor: () => string = () => '#E8927A';
  private isDependencySatisfied: (depId: string) => boolean = () => false;
  private currentAbort: AbortController | null = null;

  attach(args: AttachArgs) {
    this.acRef = args.acRef;
    this.store = args.store;
    this.getAccentColor = args.getAccentColor;
    this.isDependencySatisfied = args.isDependencySatisfied;
  }

  detach() {
    this.cancelStep();
    this.acRef = null;
    this.store = null;
  }

  isRunning(): boolean {
    return this.currentAbort !== null;
  }

  cancelStep(): void {
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
  }

  async startStep(
    stepId: string,
    spawnPoint: { x: number; y: number },
  ): Promise<void> {
    if (!this.acRef || !this.store) {
      console.warn('[onboarding] Director not attached');
      return;
    }
    const ac = this.acRef.current;
    if (!ac) {
      console.warn('[onboarding] AC ref not yet mounted');
      return;
    }
    const step = findStepById(stepId);
    if (!step) {
      console.warn('[onboarding] step not found', stepId);
      return;
    }

    this.cancelStep();
    const controller = new AbortController();
    this.currentAbort = controller;

    // Abort hooks: lost-target (cached element disconnected >2.5s) and hash-route change.
    const startHash = window.location.hash;
    // Console breadcrumbs distinguish lost-target vs hashchange aborts without the Analytics panel.
    const onLost = (e: Event) => {
      const detail = (e as CustomEvent)?.detail;
      // eslint-disable-next-line no-console
      console.warn(
        `[onboarding] step ${stepId} aborted: lost-target`,
        detail,
      );
      report('step_aborted_lost_target', { step_id: stepId });
      controller.abort();
    };
    const onRouteChange = () => {
      if (window.location.hash !== startHash) {
        // eslint-disable-next-line no-console
        console.warn(
          `[onboarding] step ${stepId} aborted: hash changed ${startHash} -> ${window.location.hash}`,
        );
        report('step_aborted_route_change', {
          step_id: stepId,
          from: startHash,
          to: window.location.hash,
        });
        controller.abort();
      }
    };
    window.addEventListener('openswarm:onboarding:lost_target', onLost);
    window.addEventListener('hashchange', onRouteChange);

    try {
      await runStep({
        step,
        spawnPoint,
        ac,
        store: this.store,
        accentColor: this.getAccentColor(),
        signal: controller.signal,
        findStep: findStepById,
        isDependencySatisfied: this.isDependencySatisfied,
      });
    } finally {
      window.removeEventListener('openswarm:onboarding:lost_target', onLost);
      window.removeEventListener('hashchange', onRouteChange);
      if (this.currentAbort === controller) {
        this.currentAbort = null;
      }
    }
  }

}

export const onboardingDirector = new OnboardingDirector();

/** Ordered roadmap (1..10); STEPS is the source of truth. */
export function getRoadmap(): OnboardingStep[] {
  return STEPS;
}
