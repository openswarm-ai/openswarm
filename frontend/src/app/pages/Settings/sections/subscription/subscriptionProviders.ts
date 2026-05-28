export const SUBSCRIPTION_PROVIDERS = [
  { id: 'claude', name: 'Claude Pro / Max', desc: 'Sonnet 4.6, Opus 4.6, Haiku 4.5', color: '#E8927A', preview: false },
  // "Gemini" routes through Antigravity OAuth (same Google sign-in, higher quota than Gemini CLI's free tier).
  { id: 'antigravity', name: 'Gemini Advanced', desc: 'Gemini 3 Pro, 3 Flash, 2.5 Pro, 2.5 Flash', color: '#4285F4', preview: false },
  { id: 'codex', name: 'ChatGPT Plus / Pro', desc: 'GPT-5.4, GPT-5.4 Mini, GPT-5.3 Codex', color: '#74AA9C', preview: false },
];

export type SubscriptionProvider = typeof SUBSCRIPTION_PROVIDERS[0];
