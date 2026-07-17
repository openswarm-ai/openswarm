import type { AgentMessage } from './agentsSlice';

/** Merge a server snapshot's message list over the store's, so a stale or partial snapshot can
 * never wipe the transcript: WS status frames replay from seq 0 on every (re)connect (the
 * launch-time zero-message frame included), and whichever socket lands last used to blind-replace
 * newer local state, which is how first messages and edited histories vanished.
 *
 * allowDeletes: only the settled-session REST fetch may honor a server-side delete; WS frames and
 * the draft rekey never drop a local message the snapshot lacks. Optimistic messages always survive. */
export function mergeSessionMessages(
  existing: AgentMessage[] | undefined,
  incoming: AgentMessage[] | undefined,
  allowDeletes: boolean,
): AgentMessage[] {
  const incomingMsgs = incoming ?? [];
  const existingMsgs = existing ?? [];
  const incomingIds = new Set(incomingMsgs.map((m) => m.id));
  const incomingClientIds = new Set(
    incomingMsgs.map((m) => m.client_message_id).filter(Boolean),
  );
  const surviving = existingMsgs.filter(
    (m) =>
      (!allowDeletes || m.optimistic_status) &&
      !incomingIds.has(m.id) &&
      !(m.client_message_id && incomingClientIds.has(m.client_message_id)),
  );
  // Place survivors by timestamp, not blindly at the end: when the snapshot already carries the agent's reply, appending the just-sent user bubble rendered the OUTPUT above the INPUT.
  const merged = surviving.length ? [...incomingMsgs] : incomingMsgs;
  for (const m of surviving) {
    const at = merged.findIndex((x) => (x.timestamp || '') > (m.timestamp || ''));
    if (at === -1) merged.push(m);
    else merged.splice(at, 0, m);
  }
  // Keep the EXISTING object for any message the snapshot didn't change: fresh JSON clones of identical messages break every bubble's React.memo (a whole-transcript re-render hitch per frame).
  const prevById = new Map(existingMsgs.map((m) => [m.id, m]));
  const contentUnchanged = (a: AgentMessage, b: AgentMessage): boolean =>
    typeof a.content === 'string' && typeof b.content === 'string'
      ? a.content === b.content
      : Array.isArray(a.content) && Array.isArray(b.content) && a.content.length === b.content.length;
  return merged.map((m) => {
    const prev = prevById.get(m.id);
    return prev && prev.timestamp === m.timestamp && prev.role === m.role && contentUnchanged(prev, m) ? prev : m;
  });
}
