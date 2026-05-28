// Mitt-style bus for onboarding-v2 advance conditions without a clean Redux signal.

export type OnboardingEvent =
  | 'browser:spawned'
  | 'browser:navigated'
  | 'settings:closed'
  | 'chat:message_sent'
  | 'app:generation_started'
  | 'app:generation_done'
  | 'skill:installed'
  | 'action:toggled'
  | 'mode:created'
  | 'note:created'
  | 'element_selection:toggled'
  | 'agent:spawned'
  | 'agent:completed'
  | 'agent:attached_to_browser';

type Handler = (...args: unknown[]) => void;

// Tight replay window; the gate below is the stronger guarantee against cross-step contamination.
const REPLAY_WINDOW_MS = 500;

class OnboardingBus {
  private handlers = new Map<OnboardingEvent, Set<Handler>>();
  /** Most-recent-emit ts per event; lets once() satisfy a subscription racing a sync emit. */
  private recentEmits = new Map<OnboardingEvent, number>();
  /** Monotonic gate bumped per new step; once() ignores emits older than the gate. */
  private gateId = 0;
  private gateTs = 0;

  /** Bump gate so subsequent once() subscribers only match emits after this point. */
  resetReplayGate(): void {
    this.gateId += 1;
    this.gateTs = Date.now();
    this.recentEmits.clear();
  }

  on(event: OnboardingEvent, handler: Handler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  emit(event: OnboardingEvent, ...args: unknown[]): void {
    this.recentEmits.set(event, Date.now());
    const set = this.handlers.get(event);
    if (!set) return;
    [...set].forEach((h) => {
      try {
        h(...args);
      } catch (err) {
        console.warn('[onboarding] bus handler threw', event, err);
      }
    });
  }

  once(event: OnboardingEvent, handler: Handler): () => void {
    // Replay: recent emit within window AND after the gate bump => fire now, skip registering.
    const last = this.recentEmits.get(event);
    if (
      last !== undefined &&
      last > this.gateTs &&
      Date.now() - last <= REPLAY_WINDOW_MS
    ) {
      queueMicrotask(() => {
        try {
          handler();
        } catch (err) {
          console.warn('[onboarding] bus replay handler threw', event, err);
        }
      });
      return () => {};
    }
    const off = this.on(event, (...args) => {
      off();
      handler(...args);
    });
    return off;
  }
}

export const onboardingBus = new OnboardingBus();

// Window-exposed for console debugging: __OPENSWARM_ONBOARDING_BUS__.emit('browser:spawned').
if (typeof window !== 'undefined') {
  (window as any).__OPENSWARM_ONBOARDING_BUS__ = onboardingBus;
}
