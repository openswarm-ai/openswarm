// Decoupled hand-off from onboarding to the dashboard: onboarding declares "launch this task", the
// dashboard executes it with its own proven spawn path. Onboarding never touches dashboard internals.

const ONBOARDING_LAUNCH_EVENT = 'openswarm:onboarding-launch';

export interface OnboardingLaunchDetail {
  prompt: string;
}

export function emitOnboardingLaunch(prompt: string): void {
  window.dispatchEvent(new CustomEvent<OnboardingLaunchDetail>(ONBOARDING_LAUNCH_EVENT, { detail: { prompt } }));
}

export function onOnboardingLaunch(handler: (prompt: string) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<OnboardingLaunchDetail>).detail;
    if (detail?.prompt) handler(detail.prompt);
  };
  window.addEventListener(ONBOARDING_LAUNCH_EVENT, listener);
  return () => window.removeEventListener(ONBOARDING_LAUNCH_EVENT, listener);
}
