import type { AgentMessage } from '@/shared/state/agentsSlice';

/** The last thing a person or the agent actually said; hidden harness prompts and system notes never count. */
export function lastConversationMessage(messages: readonly AgentMessage[]): AgentMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.hidden && (m.role === 'user' || m.role === 'assistant')) return m;
  }
  return undefined;
}

/** Interrupted = stopped while still owing a reply. A system note ("the engine shut down") never answers the user, so it is skipped when finding the tail. */
export function resumeOwed(status: string, messages: readonly AgentMessage[]): boolean {
  if (status !== 'stopped') return false;
  return lastConversationMessage(messages)?.role === 'user';
}
