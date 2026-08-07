import { store } from '@/shared/state/store';

/** Copy the chat's latest assistant answer to the clipboard; true when something was copied.
 * Menu rows (card context menu, dock tiles) call this statelessly. */
export function copySessionResponse(sessionId: string): boolean {
  const session = store.getState().agents.sessions[sessionId];
  const last = [...(session?.messages ?? [])]
    .reverse()
    .find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
  if (!last) return false;
  void navigator.clipboard.writeText(last.content as string);
  return true;
}
