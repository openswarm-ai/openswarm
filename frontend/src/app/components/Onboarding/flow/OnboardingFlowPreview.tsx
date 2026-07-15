// Preview-only gate for the new onboarding flow while we iterate. It does NOT replace the live
// onboarding yet (that's a follow step). Renders the flow overlay only when a localStorage flag is
// set, so real users never see it. Toggle in the console (or over CDP):
//   localStorage.setItem('openswarm.onboarding.flowPreview','1'); location.reload();

import React, { useState, useEffect } from 'react';
import { OnboardingFlow } from './OnboardingFlow';

const FLAG = 'openswarm.onboarding.flowPreview';

export const OnboardingFlowPreview: React.FC = () => {
  const [on, setOn] = useState(false);

  useEffect(() => {
    // TEMP (live test): force-show so it appears on load. Revert to the flag read below when done.
    setOn(true);
    // try { setOn(window.localStorage.getItem(FLAG) === '1'); } catch { /* no localStorage */ }
  }, []);

  if (!on) return null;

  return (
    <OnboardingFlow
      onExit={() => {
        try { window.localStorage.removeItem(FLAG); } catch { /* no localStorage */ }
        setOn(false);
      }}
    />
  );
};
