// Everyone gets an account, upgraders included.
//
// A fresh install signs in inside onboarding (BeatSignIn's Continue is disabled until it lands).
// A veteran never saw that: OnboardingV3Root writes `onboarding_v3: 'skipped'` the moment it finds
// v2 history, so the whole flow, sign-in included, is skipped and the user runs unsigned forever.
// That is the hole this closes, and it is why the gate lives here rather than inside onboarding.
import React from 'react';

import SignInDialog from '@/app/components/overlays/SignInDialog';
import { shouldRequireSignIn } from '@/app/components/overlays/shouldRequireSignIn';
import { useAppSelector } from '@/shared/hooks';

export default function SignInRequiredGate(): JSX.Element | null {
  const settingsLoaded = useAppSelector((s) => s.settings.loaded);
  const userId = useAppSelector((s) => s.settings.data.user_id ?? null);
  const onboardingActive = useAppSelector((s) => s.onboardingV3.flowActive);

  if (!shouldRequireSignIn({ settingsLoaded, userId, onboardingActive })) return null;

  return <SignInDialog mandatory onClose={() => undefined} />;
}
