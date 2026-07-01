// Orchestrates the onboarding flow: a step machine (help -> name -> consent -> connect -> the 3
// payoff beats: greet -> task -> more). Writes name + persona to settings. The payoff content is
// LLM-generated (profile > suggest > static floor); the floor is a last-resort fallback only.

import React, { useMemo, useState } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { updateSettingsPatch } from '@/shared/state/settingsSlice';
import { OnboardingShell } from './OnboardingShell';
import { WhereDoYouWantHelp } from './steps/WhereDoYouWantHelp';
import { WhatShouldICallYou } from './steps/WhatShouldICallYou';
import { PersonalizeConsent } from './steps/PersonalizeConsent';
import { ConnectApps } from './steps/ConnectApps';
import { PayoffHello } from './steps/PayoffHello';
import { PayoffTask } from './steps/PayoffTask';
import { PayoffMore } from './steps/PayoffMore';
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
  const dispatch = useAppDispatch();
  const [step, setStep] = useState<FlowStepId>('help');
  const [persona, setPersona] = useState<PersonaId | null>(null);
  const [useCase, setUseCase] = useState('');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);

  const onPayoff = step === 'greet' || step === 'task' || step === 'more';
  const floor = useMemo(() => demoPayoff(persona), [persona]);
  // Personalized payoff from the persona (cheap LLM); swaps in over the floor when ready.
  const suggest = useOnboardingSuggest(useCase, name, onPayoff);
  // Deeper: background read-only profiling (only if they consented); trumps the persona suggestion.
  const profile = useOnboardingProfile(name, consent, onPayoff);

  // Merge into { insight, hero, more[] }. Priority: real-data profile > persona-generated > floor.
  const content = useMemo(() => {
    if (profile && profile.observation.trim() && profile.options.length > 0) {
      const opts = profile.options.map((o, i) => ({ id: `p${i}`, icon: IDEA_ICONS[i % IDEA_ICONS.length], label: o.label, prompt: o.prompt }));
      return { insight: profile.observation, hero: opts[0], more: opts.slice(1) };
    }
    if (suggest && suggest.insight.trim() && suggest.task.trim() && suggest.options.length > 0) {
      const opts = suggest.options.map((o, i) => ({ id: `s${i}`, icon: IDEA_ICONS[i % IDEA_ICONS.length], label: o.label, prompt: o.prompt }));
      const hero: PayoffIdea = { id: 'hero', icon: 'sun', label: opts[0].label, prompt: suggest.task };
      return { insight: suggest.insight, hero, more: opts };
    }
    return floor;
  }, [profile, suggest, floor]);

  // Tapping a task launches the first agent. Real launch (createDraftSession + launchAndSendFirstMessage)
  // wires in a follow step; for now finishing exits the flow.
  const launch = (unusedPrompt: string) => onExit();

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
            onSkip={() => { setPersona(null); setStep('greet'); }}
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
