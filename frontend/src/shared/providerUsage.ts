// The user's provider chat history is read offscreen in the main process (see electron/usageHarvest.js), which owns the injected script + the partition session. This module holds only the shared shape + the pure summarizer that turns the raw read into the compact profile block prep sees. The raw read is dropped after; only this summary travels.

export type UsageProvider = 'codex' | 'claude' | 'gemini';

export interface ProviderUsage {
  ok: boolean;
  total: number;
  // We stop fetching titles early (prep only needs ~150), so total is a floor when this is set.
  capped?: boolean;
  titles: string[];
  memories: string[];
  // FULL text of the most recent few conversations (their real asks + the exchange). The payload:
  // titles are the vague label, this is the substance a clustering pass turns into a real profile.
  convos?: { title: string; text: string }[];
}

// ~130K chars is ~32K tokens: a generous budget for the full-convo block, since a downstream clustering
// pass distills it before the reveal (so a couple cents, not a bloated final prompt).
const TOTAL_CONVO_CHARS = 130000;

// Turn the raw read into the profile block for prep: memory facts, the scale, recent titles for breadth,
// then the FULL recent conversations (the payload). Bounded so even a heavy user can't ship a wall of PII;
// the backend then distills it to a tight "who is this person" profile.
export function summarizeUsage(u: ProviderUsage | null): string {
  if (!u || !u.ok) return '';
  const parts: string[] = [];
  if (u.total > 0) parts.push(`They have ${u.total}${u.capped ? '+' : ''} past AI conversations.`);
  if (u.memories.length > 0) parts.push('Facts their AI remembers about them: ' + u.memories.join('; '));
  if (u.titles.length > 0) parts.push('Recent conversation titles (breadth): ' + u.titles.slice(0, 150).join('; '));
  if (u.convos && u.convos.length > 0) {
    const block: string[] = [];
    let used = 0;
    for (const cv of u.convos) {
      if (used + cv.text.length > TOTAL_CONVO_CHARS) break;
      block.push(cv.text);
      used += cv.text.length;
    }
    if (block.length) parts.push('Full text of their most recent conversations (their real asks + the exchange):\n\n' + block.join('\n\n---\n\n'));
  }
  return parts.join('\n');
}
