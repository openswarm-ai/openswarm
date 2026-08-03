// Whether the mandatory sign-in wall should be up right now.
//
// Split out of the component so the branch that can lock every user out of the app is testable
// without a React harness. See SignInRequiredGate.tsx for why the wall exists at all.
export interface SignInGateState {
  settingsLoaded: boolean;
  userId: string | null;
  onboardingActive: boolean;
}

export function shouldRequireSignIn({ settingsLoaded, userId, onboardingActive }: SignInGateState): boolean {
  // Fails OPEN until settings are read: a backend that never answers must not brick a local-first
  // app behind a wall the user's own saved account would have taken down.
  if (!settingsLoaded) return false;
  // Onboarding carries its own sign-in beat and its own curtain; stacking a second one hides both.
  if (onboardingActive) return false;
  return !userId;
}
