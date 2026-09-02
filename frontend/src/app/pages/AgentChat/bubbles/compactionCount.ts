import type { AgentMessage } from '@/shared/state/agentsSlice';

/** How many of the user's own turns the compaction folded away: user messages at or before the anchor, hidden prompts excluded. 0 when the anchor is unknown, so the marker falls back to wording without a number. */
export function countSummarizedUserTurns(messages: readonly AgentMessage[], anchorId: string | null | undefined): number {
  if (!anchorId) return 0;
  const end = messages.findIndex((m) => m.id === anchorId);
  if (end < 0) return 0;
  let count = 0;
  for (let i = 0; i <= end; i++) {
    const m = messages[i];
    if (m.role === 'user' && !m.hidden) count++;
  }
  return count;
}
