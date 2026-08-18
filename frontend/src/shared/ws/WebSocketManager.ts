import { store } from '../state/store';
import { unstable_batchedUpdates } from 'react-dom';
import { setSessionConnState, fetchSession } from '../state/agentsSlice';
import { streamDelta } from '../state/streamingSlice';
import { openWorkflowsApp } from '../state/dashboardLayoutSlice';
import { ackRun, runWorkflowNow } from '../state/workflowsSlice';
import { stepsSignature } from '@/app/pages/Workflows/scheduleUtils';
import { getAuthToken } from '../config';
import { handleWsEvent } from './eventHandlers';
import { genUuid } from './ids';
import { clearSessionLastSeq, getSessionLastSeq, seedSessionSeq, setSessionLastSeq } from './resumeState';
export { seedSessionSeq };
import type { QueuedFrame, WSEvent, WSManagerOptions } from './types';

// (session_id:seq) -> arrival time; entries older than the window are prunable. Bounded by event rate x window, not session count.
const FRAME_DEDUPE_WINDOW_MS = 5_000;
const _recentFrameTimes: Map<string, number> = new Map();

// Phase 0 boot instrumentation: one-shot flag so we report the first streamed agent token to Electron main exactly once per app launch. Module scope (not instance) because multiple WebSocketManagers exist (one per session WS).
let firstAgentResponseMarked = false;

// Thin wrapper around getAuthToken so the connect() call site stays synchronous. If the token isn't cached yet, returns '' and the WS handshake will 4401, onclose catches that and refreshes the token before the next reconnect.
const _getAuthTokenSafe = (): string => {
  try { return getAuthToken() || ''; } catch { return ''; }
};

// Heartbeat tuning. 25s is below typical aggressive NAT idle timeouts (some enterprise firewalls drop after 30s of silence), and well below browser-tab background throttling thresholds. 10s pong timeout is a balance: long enough to tolerate flaky cellular RTT spikes, short enough that a real dead socket reconnects fast.
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

class WebSocketManager {
  private ws: WebSocket | null = null;
  private url: string;
  private skipStreamEvents: boolean;
  private sessionId: string | null;

  // Resume state. lastSeq is the highest server-assigned seq this client has applied; it's sent on every (re)connect so the server can replay missed events. Persists for the lifetime of this WebSocketManager instance, when the user navigates away and a new createSessionWs() is constructed, lastSeq starts at 0 and we get a full replay.
  private connectionUuid: string;
  private lastSeq: number = 0;
  private resumeAcked: boolean = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  // Set to true by `disconnect()` so we don't reconnect after an explicit close (component unmount / user clicks Close).
  private explicitlyClosed: boolean = false;
  private hasConnectedOnce: boolean = false;

  // Heartbeat. We send a ping on a fixed cadence and arm a timeout for the pong; if the timeout fires, we force-close the socket so `onclose` triggers reconnect. Detects laptop-sleep / NAT-drop silent failures that wouldn't otherwise surface until the next outbound send.
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  // Outbound queue. Frames the user enqueues while the WS isn't OPEN, or while OPEN but pre-resume-ack, wait here and flush after the resume handshake completes. Queue is in-memory only: surviving a full app restart isn't worth the localStorage complexity given how rare that case is for a transient drop.
  private outboundQueue: QueuedFrame[] = [];

  private listeners: Map<string, Set<(data: any) => void>> = new Map();
  // Frame-aligned message coalescer. Buffers incoming WS messages from all WebSocketManager instances and flushes them in ONE batched React render per animation frame. Without this, N concurrent agents each cause their own renders on every WS message, dozens of full app re-renders per second, fanning out to every useSelector. With it: max one render per frame regardless of message volume.
  private static _messageQueue: Array<{ mgr: WebSocketManager; msg: WSEvent }> = [];
  private static _flushScheduled = false;
  // rAF never fires when the window paints no frames (minimized, on another Space, occluded). Without a fallback, WS-delivered dashboard mutations (a spawned browser card, an evict) buffer forever and the UI silently desyncs, agent browser cards just never mount. A timer flushes the queue when rAF won't; whichever fires first wins and cancels the other, so a visible window is unchanged (rAF beats a 250ms timer every frame).
  private static _flushTimer: ReturnType<typeof setTimeout> | null = null;

  private static _enqueueMessage(mgr: WebSocketManager, msg: WSEvent) {
    WebSocketManager._messageQueue.push({ mgr, msg });
    if (WebSocketManager._flushScheduled) return;
    WebSocketManager._flushScheduled = true;
    requestAnimationFrame(WebSocketManager._flushMessages);
    WebSocketManager._flushTimer = setTimeout(WebSocketManager._flushMessages, 250);
  }

  // First moment a flush was deferred for a live drag; bounds the damming so a stuck drag class can't buffer forever.
  private static _dragDeferredAt = 0;

  private static _flushMessages = () => {
    if (!WebSocketManager._flushScheduled) return; // the other trigger already drained this batch
    WebSocketManager._flushScheduled = false;
    if (WebSocketManager._flushTimer !== null) {
      clearTimeout(WebSocketManager._flushTimer);
      WebSocketManager._flushTimer = null;
    }
    if (WebSocketManager._messageQueue.length === 0) return;
    // A live card drag owns the main thread: WS-driven renders mid-drag are what made dragging a
    // working agent feel laggy, and nobody reads streaming tokens while holding a card. Buffer until
    // the pointer settles, hard-capped by time and queue depth.
    if (document.body.classList.contains('dashboard-marquee-active')) {
      if (!WebSocketManager._dragDeferredAt) WebSocketManager._dragDeferredAt = Date.now();
      if (Date.now() - WebSocketManager._dragDeferredAt < 2000 && WebSocketManager._messageQueue.length < 500) {
        WebSocketManager._flushScheduled = true;
        WebSocketManager._flushTimer = setTimeout(WebSocketManager._flushMessages, 100);
        return;
      }
    }
    WebSocketManager._dragDeferredAt = 0;
    const batch = WebSocketManager._messageQueue;
    WebSocketManager._messageQueue = [];
    // unstable_batchedUpdates collapses all dispatches inside the callback into a single React render. Available in React 17; React 18's automatic batching covers this too, but explicit wrap remains correct in both and protects against future batching-context changes.
    unstable_batchedUpdates(() => {
      for (const { mgr, msg } of batch) {
        try {
          mgr.handleMessage(msg);
        } catch (e) {
          console.warn('[ws] message handler threw', e);
        }
      }
    });
  };

  constructor(url: string, options?: WSManagerOptions) {
    this.url = url;
    this.skipStreamEvents = options?.skipStreamEvents ?? false;
    this.sessionId = options?.sessionId ?? null;
    this.connectionUuid = genUuid();
    // Seed lastSeq from the cross-mount persistent map so a fresh manager (created on every AgentChat remount via key={session.id}) doesn't ask the server to replay events the previous manager already saw. This is the architectural fix for "completed chats re-type themselves on reopen": the server's resume protocol now sees a real high-water mark and has nothing to replay.
    if (this.sessionId) {
      this.lastSeq = getSessionLastSeq(this.sessionId);
    }
  }

  // Tokens render as they arrive (claude.ai feel). Per-frame WS batching in _enqueueMessage still coalesces N concurrent agents' messages into ONE React render per animation frame, so removing the pacing layer doesn't reintroduce the parallel-agent re-render storm.
  private dispatchDelta(sessionId: string, messageId: string, delta: string) {
    // Phase 0 boot instrumentation: the first streamed agent token is the "app is actually useful" milestone. Report it once to the Electron main process, which owns the timing log. Guarded by a module-level flag so this is a single no-op branch on every subsequent token.
    if (!firstAgentResponseMarked) {
      firstAgentResponseMarked = true;
      try { (window as any).openswarm?.markFirstAgentResponse?.(); } catch { /* not in Electron */ }
    }
    store.dispatch(streamDelta({ sessionId, messageId, delta }));
  }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.explicitlyClosed = false;

    // Append our per-install auth token to the URL. The backend's WS handshake validates this before accepting; without it, any webpage loaded on the same machine could open a WS and read agent traffic. See backend/auth.py + main.py:_ws_auth_ok.
    const token = _getAuthTokenSafe();
    const sep = this.url.includes('?') ? '&' : '?';
    const urlWithToken = token ? `${this.url}${sep}token=${encodeURIComponent(token)}` : this.url;
    this.ws = new WebSocket(urlWithToken);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.resumeAcked = false;
      this.startHeartbeat();
      // Send hello immediately so the server can replay anything the server sent that we never applied. On a fresh session, last_seq=0 → server replays from buffer start (empty) and we proceed normally.
      if (this.sessionId) {
        this.sendRaw('client:hello', {
          session_id: this.sessionId,
          connection_uuid: this.connectionUuid,
          last_seq: this.lastSeq,
        });
      } else {
        // Dashboard / global WS: no resume, queue can flush right away.
        this.resumeAcked = true;
        this.flushQueue();
        // Global broadcasts skip the replay log, so anything missed during a socket gap only reappears if subscribers refetch on reconnect.
        if (this.hasConnectedOnce) {
          this.listeners.get('dashboard:reconnected')?.forEach((fn) => fn({}));
        }
      }
      this.hasConnectedOnce = true;
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: WSEvent = JSON.parse(event.data);
        // Pong bypasses the rAF coalescer: rAF stalls when the window gets no frames (minimized, display asleep) while ping timers keep firing, so a buffered pong read as silence and a healthy socket got killed.
        if (msg.event === 'server:pong') {
          this.clearPongTimeout();
          return;
        }
        // Buffer incoming messages and flush them per animation frame in a single React batch. With N concurrent agents/browsers streaming, each WS instance used to trigger its own React render, dozens per frame, fanning out to every useSelector subscriber, starving the main thread. Coalescing flips that to ONE batched render per frame regardless of how many messages arrived. Stream deltas dispatch directly into Redux (no client-side pacing), so the typed-text rate matches what the server sends, the same way claude.ai feels.
        WebSocketManager._enqueueMessage(this, msg);
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = (ev) => {
      this.stopHeartbeat();
      // 4401 = our backend's auth-failure code. Happens on stale token after backend restart (dev hot-reload). Re-fetch from Electron IPC before retrying.
      if (ev && ev.code === 4401) {
        import('@/shared/config').then(mod => mod.refreshAuthToken().catch(() => {}));
      }
      // Mark UI as reconnecting so the run card shows a clear "trying to reconnect" state rather than implying the run died. Skipped on an explicit disconnect (user navigated away) since there's no run to surface state for.
      if (this.sessionId && !this.explicitlyClosed) {
        store.dispatch(setSessionConnState({
          sessionId: this.sessionId,
          state: 'reconnecting',
        }));
      }
      if (!this.explicitlyClosed) this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // Force the close path to run, onclose will mark state reconnecting and schedule a retry.
      this.ws?.close();
    };
  }

  disconnect() {
    this.explicitlyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    // No retry cap. Long-horizon agent runs may outlast a multi-hour network outage (overnight laptop sleep, captive portal limbo); giving up would silently desync the UI. Backoff is bounded at 30s so the user-visible "Reconnecting…" loop never hammers the network, and a small jitter prevents thundering-herd if many session WSes reconnect at once after a backend restart.
    const jitter = 0.8 + Math.random() * 0.4; // ±20%
    const delay = Math.min(this.reconnectDelay, this.maxReconnectDelay) * jitter;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connect();
    }, delay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendPing();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer != null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimeoutTimer != null) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }
  }

  private sendPing() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const nonce = genUuid();
    try {
      this.ws.send(JSON.stringify({ event: 'client:ping', data: { nonce } }));
    } catch {
      // socket dying, let the close handler take over
      return;
    }
    if (this.pongTimeoutTimer != null) clearTimeout(this.pongTimeoutTimer);
    this.pongTimeoutTimer = setTimeout(() => {
      // Silent death: no pong arrived in time. Force a close so the browser's onclose path (and our reconnect) runs immediately instead of waiting for the OS TCP keepalive (~75s).
      try { this.ws?.close(); } catch { /* nothing */ }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private clearPongTimeout() {
    if (this.pongTimeoutTimer != null) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }
  }

  private flushQueue() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (!this.resumeAcked) return;
    const queue = this.outboundQueue;
    this.outboundQueue = [];
    for (const frame of queue) {
      try {
        this.ws.send(JSON.stringify({ event: frame.event, data: frame.data }));
      } catch {
        // Re-queue and bail; reconnect will retry.
        this.outboundQueue.unshift(frame);
        break;
      }
    }
  }

  // Direct send that bypasses the queue. Used for hello/ping which must NOT be queued (they're connection-scoped, not session-data).
  private sendRaw(event: string, data: Record<string, any>) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify({ event, data })); } catch { /* nothing */ }
  }

  private handleMessage(msg: WSEvent) {
    const { event, session_id, data } = msg;

    // Update lastSeq for events that carry one. seq is monotonic per session, so this is the high-water mark we send back on resume.
    if (typeof msg.seq === 'number' && msg.seq > this.lastSeq) {
      this.lastSeq = msg.seq;
      // Mirror to the module-scope persistent map so the next fresh manager (next AgentChat remount) starts here, not at zero.
      if (this.sessionId) {
        setSessionLastSeq(this.sessionId, this.lastSeq);
      }
    }

    // Cross-socket dedupe: the backend fans every session frame out to BOTH the dashboard socket and the chat's own socket (same stamped seq), so an expanded chat parsed and reduced everything twice, and whichever copy landed second could be a replayed stale one. Time-windowed rather than a high-water mark so a deliberate later replay (gap recovery resets lastSeq to 0) is never starved.
    if (typeof msg.seq === 'number' && session_id) {
      const key = `${session_id}:${msg.seq}`;
      const now = Date.now();
      const seen = _recentFrameTimes.get(key);
      if (seen !== undefined && now - seen < FRAME_DEDUPE_WINDOW_MS) return;
      _recentFrameTimes.set(key, now);
      if (_recentFrameTimes.size > 4000) {
        for (const [k, t] of _recentFrameTimes) {
          if (now - t >= FRAME_DEDUPE_WINDOW_MS) _recentFrameTimes.delete(k);
        }
      }
    }

    // ----- Connection-scoped frames (no business-logic side effects) -----

    if (event === 'server:pong') {
      this.clearPongTimeout();
      return;
    }

    if (event === 'server:hello') {
      // Resume handshake completed. The server has either replayed missed events (which arrived as separate frames before this ack), surfaced a gap, or signalled "you're caught up." Mark ourselves live and flush any queued outbound frames.
      this.resumeAcked = true;
      if (this.sessionId) {
        store.dispatch(setSessionConnState({
          sessionId: this.sessionId,
          state: 'live',
        }));
      }
      this.flushQueue();
      return;
    }

    if (event === 'agent:gap_detected') {
      // We were offline long enough that the server's ring buffer rolled past our lastSeq. Re-fetch authoritative state via REST so the slice's view doesn't have a silent gap.
      if (session_id) {
        store.dispatch(fetchSession(session_id));
        // Reset lastSeq, the REST refetch is the new authoritative baseline; subsequent server events with seq numbers will re-establish the high-water mark. Also wipe the cross-mount persistent map so a remount during this gap window doesn't resurrect the stale value.
        this.lastSeq = 0;
        clearSessionLastSeq(session_id);
        // The recovery replay re-delivers seqs possibly seen moments ago; drop them from the dedupe window so it's never starved.
        for (const k of _recentFrameTimes.keys()) {
          if (k.startsWith(`${session_id}:`)) _recentFrameTimes.delete(k);
        }
      }
      return;
    }

    const notifyListeners = handleWsEvent(msg, {
      resumeAcked: this.resumeAcked,
      skipStreamEvents: this.skipStreamEvents,
      dispatchDelta: (sessionId, messageId, delta) => this.dispatchDelta(sessionId, messageId, delta),
    });
    if (!notifyListeners) return;

    // Notify any custom listeners
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach((fn) => fn({ session_id, ...data }));
    }
  }

  send(event: string, data: Record<string, any>) {
    // Queue if the socket isn't open OR resume hasn't been ack'd yet. The pre-ack gate prevents an outbound user message from racing the resume replay, the server might process the message before the replay finishes, leaving the slice's view of history incomplete.
    const open = this.ws?.readyState === WebSocket.OPEN;
    if (!open || !this.resumeAcked) {
      this.outboundQueue.push({ event, data, client_msg_id: genUuid() });
      return;
    }
    try {
      this.ws!.send(JSON.stringify({ event, data }));
    } catch {
      this.outboundQueue.push({ event, data, client_msg_id: genUuid() });
    }
  }

  sendMessage(
    sessionId: string,
    prompt: string,
    opts?: { mode?: string; model?: string; provider?: string; images?: Array<{ data: string; media_type: string }> },
  ) {
    this.send('agent:send_message', {
      session_id: sessionId,
      prompt,
      idempotency_key: genUuid(),
      ...opts,
    });
  }

  sendApproval(requestId: string, behavior: 'allow' | 'deny', message?: string) {
    this.send('agent:approval_response', {
      request_id: requestId,
      behavior,
      message,
    });
  }

  stopAgent(sessionId: string) {
    this.send('agent:stop', { session_id: sessionId });
  }

  on(event: string, handler: (data: any) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => this.listeners.get(event)?.delete(handler);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

import { WS_BASE } from '@/shared/config';

// Bridge native-notification button actions to workflow actions. Subscribe at module import time so we never miss an early callback fired before any component mounts.
(() => {
  try {
    const w: any = (typeof window !== 'undefined') ? (window as any).openswarm : null;
    if (!w?.onNotificationAction) return;
    w.onNotificationAction(({ outcome, runId, workflowId }: { outcome: string; runId?: string; workflowId?: string }) => {
      if (!workflowId) return;
      if (outcome === 'ack' && runId) {
        store.dispatch(ackRun(runId));
        return;
      }
      if (outcome === 'rerun') {
        const wf = store.getState().workflows.items[workflowId];
        store.dispatch(wf ? runWorkflowNow({ id: workflowId, signature: stepsSignature(wf.steps) }) : runWorkflowNow(workflowId));
        return;
      }
      if (outcome === 'edit' || outcome === 'open') {
        store.dispatch(openWorkflowsApp({ workflowId }));
        return;
      }
    });
  } catch { /* native notifications optional */ }
})();

export const dashboardWs = new WebSocketManager(`${WS_BASE}/ws/dashboard`, { skipStreamEvents: true });

export function createSessionWs(sessionId: string): WebSocketManager {
  return new WebSocketManager(`${WS_BASE}/ws/agents/${sessionId}`, { sessionId });
}

// One backgrounded session socket, kept alive across a hop so an active agent's stream doesn't pay a reconnect+resume handshake on reopen (the "Locking-in" lag). Bounded to ONE: opening any other chat tears the previous one down, so at most a single detached socket lingers, still pumping events into Redux.
let _backgroundedSessionWs: { sessionId: string; ws: WebSocketManager } | null = null;

export function acquireSessionWs(sessionId: string): WebSocketManager {
  if (_backgroundedSessionWs?.sessionId === sessionId) {
    const ws = _backgroundedSessionWs.ws;
    _backgroundedSessionWs = null;
    return ws;
  }
  return new WebSocketManager(`${WS_BASE}/ws/agents/${sessionId}`, { sessionId });
}

export function releaseSessionWs(sessionId: string, ws: WebSocketManager, keepAlive: boolean): void {
  // Never keep more than one detached socket around.
  if (_backgroundedSessionWs && _backgroundedSessionWs.sessionId !== sessionId) {
    _backgroundedSessionWs.ws.disconnect();
    _backgroundedSessionWs = null;
  }
  if (keepAlive) {
    _backgroundedSessionWs = { sessionId, ws };
  } else {
    ws.disconnect();
    if (_backgroundedSessionWs?.sessionId === sessionId) _backgroundedSessionWs = null;
  }
}

export default WebSocketManager;
