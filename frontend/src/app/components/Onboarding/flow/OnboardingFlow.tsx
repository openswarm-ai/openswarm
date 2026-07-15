// Orchestrates the onboarding flow: a step machine (help -> name -> consent -> connect -> the 3
// payoff beats: greet -> task -> more). Writes name + persona to settings. The payoff content is
// LLM-generated (profile > suggest > static floor); the floor is a last-resort fallback only.

import React, { useMemo, useState } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { updateSettingsPatch } from '@/shared/state/settingsSlice';
import { emitOnboardingLaunch } from '@/shared/onboardingLaunch';
import { OnboardingShell } from './OnboardingShell';
import { WhereDoYouWantHelp } from './steps/WhereDoYouWantHelp';
import { WhatShouldICallYou } from './steps/WhatShouldICallYou';
import { PersonalizeConsent } from './steps/PersonalizeConsent';
import { ConnectApps } from './steps/ConnectApps';
import { PayoffHello } from './steps/PayoffHello';
import { PayoffTask } from './steps/PayoffTask';
import { PayoffMore } from './steps/PayoffMore';
import { PayoffDiscovering } from './steps/PayoffDiscovering';
import { demoPayoff } from './payoffDemoContent';
import { useOnboardingProfile } from './useOnboardingProfile';
import { useOnboardingSuggest } from './useOnboardingSuggest';
import type { FlowStepId, PersonaId, PayoffIdea, IconName } from './onboardingFlowTypes';

// Icons for LLM-generated ideas (the model returns text, not icons); rotated for variety.
const IDEA_ICONS: IconName[] = ['sun', 'tray', 'build', 'globe'];

function greetingFor(name: string): string {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}.` : `${part}.`;
}

export const OnboardingFlow: React.FC<{ onExit: () => void }> = ({ onExit }) => {
  // Flow always starts at 'help'; editing this file Fast-Refreshes it back to the first screen.
  const dispatch = useAppDispatch();
  const [step, setStep] = useState<FlowStepId>('help');
  const [persona, setPersona] = useState<PersonaId | null>(null);
  const [useCase, setUseCase] = useState('');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);

  const onPayoff = step === 'discovering' || step === 'greet' || step === 'task' || step === 'more';
  const floor = useMemo(() => demoPayoff(persona), [persona]);
  // Persona generation fires the MOMENT a persona is picked, so it runs in the background through
  // name/consent/connect and is already there (instant, no wait) by the time they hit the payoff.
  const { result: suggest, status: suggestStatus } = useOnboardingSuggest(useCase);
  // Deeper read-only profiling needs connected data, so it can only start after connect (onPayoff).
  const profile = useOnboardingProfile(name, consent, onPayoff);
  const profileReady = !!(profile && profile.observation.trim() && profile.options.length > 0);

  // Merge into { insight, hero, more[] }. Priority: real-data profile > persona-generated > floor.
  const content = useMemo(() => {
    if (profile && profileReady) {
      const opts = profile.options.map((o, i) => ({ id: `p${i}`, icon: IDEA_ICONS[i % IDEA_ICONS.length], label: o.label, prompt: o.prompt }));
      return { insight: profile.observation, hero: opts[0], more: opts.slice(1) };
    }
    if (suggest && suggestStatus === 'ready') {
      const opts = suggest.options.map((o, i) => ({ id: `s${i}`, icon: IDEA_ICONS[i % IDEA_ICONS.length], label: o.label, prompt: o.prompt }));
      const hero: PayoffIdea = { id: 'hero', icon: opts[0].icon, label: opts[0].label, prompt: suggest.task };
      return { insight: suggest.insight, hero, more: opts };
    }
    return floor;
  }, [profile, profileReady, suggest, suggestStatus, floor]);

  // Still generating (no result yet): the task beat shows a brief "thinking" instead of the floor.
  const generating = onPayoff && !profileReady && suggestStatus === 'loading';

  // Tapping a task ends onboarding by DOING it: hand the prompt to the dashboard (it spawns the agent
  // with its own proven path), then close the overlay so the user watches it run.
  const launch = (prompt: string) => { emitOnboardingLaunch(prompt); onExit(); };

  const body = () => {
    switch (step) {
      case 'help':
        return (
          <WhereDoYouWantHelp
            onPick={(p) => {
              dispatch(updateSettingsPatch({ user_use_case: p.useCase }));
              setPersona(p.id);
              setUseCase(p.useCase);
              setStep('name');
            }}
            onSkip={() => {
              // "just show me": no persona, but seed a broad use-case so generation still fires, then
              // run the honest discovering transition while it works.
              setPersona(null);
              setUseCase('someone new who wants to see the most impressive, genuinely useful things an AI agent can do for them');
              setStep('discovering');
            }}
          />
        );
      case 'name':
        return (
          <WhatShouldICallYou
            initialName={name}
            onContinue={(n) => {
              if (n) { setName(n); dispatch(updateSettingsPatch({ user_name: n })); }
              setStep('consent');
            }}
            onSkip={() => setStep('consent')}
          />
        );
      case 'consent':
        return <PersonalizeConsent onConsent={(yes) => { setConsent(yes); setStep(yes ? 'connect' : 'greet'); }} />;
      case 'connect':
        return <ConnectApps onContinue={() => setStep('greet')} onSkip={() => setStep('greet')} />;
      case 'discovering':
        return (
          <PayoffDiscovering
            ready={profileReady || suggestStatus === 'ready' || suggestStatus === 'failed'}
            onDone={() => setStep('task')}
          />
        );
      case 'greet':
        return (
          <PayoffHello
            greeting={greetingFor(name)}
            remark={persona ? "(someone's been busy, huh)" : undefined}
            onContinue={() => setStep('task')}
          />
        );
      case 'task':
        return (
          <PayoffTask
            insight={content.insight}
            hero={content.hero}
            generating={generating}
            onRun={(prompt: string) => launch(prompt)}
            onMore={() => setStep('more')}
          />
        );
      case 'more':
        return <PayoffMore ideas={content.more} onPick={(prompt: string) => launch(prompt)} />;
    }
  };

  return <OnboardingShell stepKey={step}>{body()}</OnboardingShell>;
};
