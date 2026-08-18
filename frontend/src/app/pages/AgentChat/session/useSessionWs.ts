import { useEffect, useRef } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { fetchSession } from '@/shared/state/agentsSlice';
import { store } from '@/shared/state/store';
import { createSessionWs, acquireSessionWs, releaseSessionWs, seedSessionSeq } from '@/shared/ws/WebSocketManager';

// The session's transport lifecycle (AGENTCHAT_SPLIT_PLAN follow-up): REST-hydrate-then-WS-connect on
// mount/id change, active-aware release on unmount, and the idle reconcile poll. Lifted verbatim from
// AgentChat.
export function useSessionWs(
  id: string | undefined,
  isDraft: boolean,
  status: string | undefined,
  activity: { messageCount: number; hasStreaming: boolean },
) {
  const dispatch = useAppDispatch();
  const wsRef = useRef<ReturnType<typeof createSessionWs> | null>(null);
  // Current status for the WS-cleanup closure (effect deps can't include it). Written every render so
  // it is fresh at cleanup time — same timing as the previous inline render-scope write.
  const statusRef = useRef<string | undefined>(undefined);
  statusRef.current = status;

  useEffect(() => {
    if (!id || isDraft) return;
    let cancelled = false;
    let ws: ReturnType<typeof createSessionWs> | null = null;
    // Order matters: hydrate the persisted message list from REST FIRST, THEN connect the WS. The WS resume protocol replays buffered events starting at last_seq=0, which includes every stream_* event for messages that finished before the disconnect. The replay-skip guard in WebSocketManager._messageAlreadyComplete checks `session.messages` to decide whether to drop deltas, so if we connect first, the slice is empty when the replay arrives, the guard returns false, and the user sees the chat type itself out again. Awaiting fetchSession before connect makes the slice authoritative before any replay event lands.
    (async () => {
      // The await exists so the slice isn't EMPTY at replay time. A warm store (remount after a hop) already satisfies that, so connect immediately and let the fetch reconcile in the background; awaiting serialized a slow round trip in front of the live stream on every reopen.
      const warm = !!store.getState().agents.sessions[id]?.messages?.length;
      if (warm) {
        dispatch(fetchSession(id));
      } else {
        try {
          const action = await dispatch(fetchSession(id));
          // Seed the resume cursor from the snapshot's seq so the connect below doesn't replay the whole ring buffer we just hydrated over REST.
          if (fetchSession.fulfilled.match(action)) {
            const seq = (action.payload as { event_seq?: number }).event_seq;
            if (typeof seq === 'number') seedSessionSeq(id, seq);
          }
        } catch {
          // Even if the REST hydrate fails, still connect, the WS resume protocol can hydrate from buffered events as a fallback.
        }
      }
      if (cancelled) return;
      // acquireSessionWs reuses a still-open socket kept alive from the last hop, so an active agent's stream resumes with no reconnect handshake. connect() is a no-op when the reused socket is already open.
      ws = acquireSessionWs(id);
      ws.connect();
      wsRef.current = ws;
    })();
    return () => {
      cancelled = true;
      if (ws) {
        const st = statusRef.current;
        const active = st === 'running' || st === 'waiting_approval';
        releaseSessionWs(id, ws, active);
      }
      wsRef.current = null;
    };
  }, [id, isDraft, dispatch]);

  // Idle reconcile: if the session has been 'running' for 5s with no WebSocket activity (no new messages, no streaming updates), do a single GET to fetch the real status from the backend. Catches the case where the completion WebSocket event was dropped (network blip, sleep/wake, SDK subprocess dying). Resets on every activity signal so it never fires during normal streaming.
  const reconcileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (reconcileTimer.current) {
      clearTimeout(reconcileTimer.current);
      reconcileTimer.current = null;
    }

    if (!id || status !== 'running') return;

    reconcileTimer.current = setTimeout(() => {
      reconcileTimer.current = null;
      dispatch(fetchSession(id));
    }, 5000);

    return () => {
      if (reconcileTimer.current) {
        clearTimeout(reconcileTimer.current);
        reconcileTimer.current = null;
      }
    };
  }, [id, status, activity.messageCount, activity.hasStreaming, dispatch]);
}
