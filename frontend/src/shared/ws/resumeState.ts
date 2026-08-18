const sessionLastSeq: Map<string, number> = new Map();

export function getSessionLastSeq(sessionId: string): number {
  return sessionLastSeq.get(sessionId) ?? 0;
}

export function setSessionLastSeq(sessionId: string, seq: number): void {
  sessionLastSeq.set(sessionId, seq);
}

export function clearSessionLastSeq(sessionId: string): void {
  sessionLastSeq.delete(sessionId);
}

/** Seed the resume cursor from a REST hydrate (GET /sessions returns event_seq), so the follow-up WS connect replays only what happened AFTER the snapshot instead of the whole ring buffer. */
export function seedSessionSeq(sessionId: string, seq: number): void {
  if (seq > getSessionLastSeq(sessionId)) sessionLastSeq.set(sessionId, seq);
}
