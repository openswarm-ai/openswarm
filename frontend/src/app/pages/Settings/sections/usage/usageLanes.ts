// The router's provider ids, in the words a user would recognise. `claude` is the Claude Pro/Max
// OAuth lane; `anthropic` is a pay-per-use key OR the OpenSwarm-managed node, which the router does
// not tell apart at this level, so the label says both.
export const LANE_LABELS: Record<string, string> = {
  claude: 'Claude subscription (Pro/Max)',
  anthropic: 'Anthropic API key or OpenSwarm Pro',
  codex: 'ChatGPT subscription',
  openai: 'OpenAI API key',
  'gemini-cli': 'Gemini subscription',
  antigravity: 'Gemini subscription (Antigravity)',
  gemini: 'Google API key',
  openrouter: 'OpenRouter key',
};

export function laneLabel(provider: string): string {
  return LANE_LABELS[provider] ?? provider;
}
