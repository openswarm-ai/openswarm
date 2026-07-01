// Orchestrates the onboarding flow: a small step machine (help -> name -> consent -> connect ->
// payoff) that writes name + persona to settings and hands the payoff its content. The real launch,
// consent persistence, and background profiling wire in as follow steps.

import React, { useMemo, useState } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { updateSettingsPatch } from '@/shared/state/settingsSlice';
import { OnboardingShell } from './OnboardingShell';
import { WhereDoYouWantHelp } from './steps/WhereDoYouWantHelp';
import { WhatShouldICallYou } from './steps/WhatShouldICallYou';
import { PersonalizeConsent } from './steps/PersonalizeConsent';
import { ConnectApps } from './steps/ConnectApps';
import { Payoff } from './Payoff';
import { demoPayoff } from './payoffDemoContent';
import { useOnboardingProfile } from './useOnboardingProfile';
import type { FlowStepId, PersonaId, PayoffIdea, IconName } from './onboardingFlowTypes';

// Icons for profile-generated ideas (the agent returns text, not icons); rotated for variety.
const IDEA_ICONS: IconName[] = ['sun', 'tray', 'build', 'globe'];

function greetingFor(name: string): string {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}.` : `${part}.`;
}

export const OnboardingFlow: React.FC<{ onExit: () => void }> = ({ onExit }) => {
  const dispatch = useAppDispatch();
  const [step, setStep] = useState<FlowStepId>('help');
  const [persona, setPersona] = useState<PersonaId | null>(null);
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [connectedIds, setConnectedIds] = useState<string[]>([]);

  const floor = useMemo(() => demoPayoff(persona), [persona]);
  // Background read-only profiling (only if they consented); upgrades the payoff in place when it lands.
  const profile = useOnboardingProfile(name, consent, step === 'payoff');
  const payoff = useMemo(() => {
    if (profile && profile.observation.trim() && profile.options.length > 0) {
      return {
        insight: profile.observation,
        prefilledPrompt: profile.options[0].prompt,
        ideas: profile.options.map((o, i) => ({ id: `p${i}`, icon: IDEA_ICONS[i % IDEA_ICONS.length], label: o.label, prompt: o.prompt })),
      };
    }
    return floor;
  }, [profile, floor]);

  // The prefilled task / an idea is what actually launches the first agent. Real launch (createDraftSession
  // + prefillPrompt + launchAndSendFirstMessage) wires in a follow step; for now finishing exits the flow.
  const launch = (unusedPrompt: string) => onExit();

  const body = () => {
    switch (step) {
      case 'help':
        return (
          <WhereDoYouWantHelp
            onPick={(p) => {
              dispatch(updateSettingsPatch({ user_use_case: p.useCase }));
              setPersona(p.id);
              setStep('name');
            }}
            onSkip={() => { setPersona(null); setStep('payoff'); }}
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
        return <PersonalizeConsent onConsent={(yes) => { setConsent(yes); setStep(yes ? 'connect' : 'payoff'); }} />;
      case 'connect':
        return (
          <ConnectApps
            connectedIds={connectedIds}
            onConnect={(id) => setConnectedIds((ids) => (ids.includes(id) ? ids : [...ids, id]))}
            onContinue={() => setStep('payoff')}
            onSkip={() => setStep('payoff')}
          />
        );
      case 'payoff':
        return (
          <Payoff
            greeting={greetingFor(name)}
            remark={persona ? "(someone's been busy, huh)" : undefined}
            insight={payoff.insight}
            prefilledPrompt={payoff.prefilledPrompt}
            ideas={payoff.ideas}
            onRun={() => launch(payoff.prefilledPrompt)}
            onPickIdea={(idea: PayoffIdea) => launch(idea.prompt)}
          />
        );
    }
  };

  return <OnboardingShell stepKey={step}>{body()}</OnboardingShell>;
};
