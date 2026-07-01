// Shared types for the onboarding flow. Bad states unrepresentable: step + persona are unions.

export type IconName =
  | 'work' | 'home' | 'build'
  | 'mail' | 'doc' | 'chat'
  | 'sun' | 'tray' | 'globe';

export type PersonaId = 'work' | 'personal' | 'build';

export interface PersonaOption {
  id: PersonaId;
  title: string;
  description: string;
  icon: IconName;
  /** Written to settings.user_use_case; seeds the payoff generator. */
  useCase: string;
}

export type FlowStepId = 'help' | 'name' | 'consent' | 'connect' | 'payoff';

export interface ConnectorOption {
  id: string;
  name: string;
  description: string;
  icon: IconName;
}

export interface PayoffIdea {
  id: string;
  icon: IconName;
  label: string;
  /** The full runnable prompt this idea launches. */
  prompt: string;
}

/** Shape returned by POST /api/agents/onboarding-profile (the read-only profiling agent). */
export interface ProfileResultDto {
  observation: string;
  options: { label: string; prompt: string }[];
}
