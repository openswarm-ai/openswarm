import { store } from '../state/store';
import {
  updateSession,
  updateSessionName,
  updateGroupMeta,
  addMessage,
  streamStart,
  streamDelta,
  streamEnd,
  addApprovalRequest,
  removeApprovalRequest,
  updateSessionStatus,
  updateSessionCost,
  updateSessionContext,
  setContextOverflow,
  setMcpSuggestions,
  addBranch,
  setActiveBranch,
  closeSessionFromWs,
  trackAgentNotification,
  setSessionConnState,
  fetchSession,
  recordCompaction,
  setTurnLabel,
  clearTurnLabel,
} from '../state/agentsSlice';
import { addBrowserCardFromBackend, removeBrowserCard, setBrowserCardPosition, setGlowingBrowserCards, GRID_GAP } from '../state/dashboardLayoutSlice';
import { getAuthToken } from '../config';
import { notifyAgentCompletion } from '../notifications';

// Thin wrapper around getAuthToken so the connect() call site stays
// synchronous. If the token isn't cached yet, returns '' and the WS
// handshake will 4401 — onclose catches that and refreshes the token
// before the next reconnect.
const _getAuthTokenSafe = (): string => {
  try { return getAuthToken() || ''; } catch { return ''; }
};


const _genUuid = (): string => {
  // Avoid pulling in `crypto.randomUUID` for compat — this is a
  // disambiguator, not a security boundary, so a 96-bit hex string is
  // plenty.
  const a = Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, '0');
  const b = Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, '0');
  const c = Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, '0');
  return `${a}${b}${c}`;
};

type WSEvent = {
  event: string;
  session_id?: string;
  data: Record<string, any>;
  seq?: number;
};

interface WSManagerOptions {
  skipStreamEvents?: boolean;
  // Session-scoped WSes opt into resume + connection-state dispatches
  // by passing this. Dashboard WS doesn't.
  sessionId?: string;
}

// Heartbeat tuning. 25s is below typical aggressive NAT idle timeouts
// (some enterprise firewalls drop after 30s of silence), and well
// below browser-tab background throttling thresholds. 10s pong
// timeout is a balance: long enough to tolerate flaky cellular RTT
// spikes, short enough that a real dead socket reconnects fast.
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

interface QueuedFrame {
  event: string;
  data: Record<string, any>;
  // Lets the future server-side dedup index match retries to
  // originals. Today the server treats most events idempotently
  // anyway (stop on stopped is a no-op), but the client sends this
  // forward-compatibly so a future server upgrade is safe without a
  // protocol bump.
  client_msg_id: string;
}

class WebSocketManager {
  private ws: WebSocket | null = null;
  private url: string;
  private skipStreamEvents: boolean;
  private sessionId: string | null;

  // Resume state. lastSeq is the highest server-assigned seq this
  // client has applied; it's sent on every (re)connect so the server
  // can replay missed events. Persists for the lifetime of this
  // WebSocketManager instance — when the user navigates away and a
  // new createSessionWs() is constructed, lastSeq starts at 0 and we
  // get a full replay.
  private connectionUuid: string;
  private lastSeq: number = 0;
  private resumeAcked: boolean = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  // Set to true by `disconnect()` so we don't reconnect after an
  // explicit close (component unmount / user clicks Close).
  private explicitlyClosed: boolean = false;

  // Heartbeat. We send a ping on a fixed cadence and arm a timeout
  // for the pong; if the timeout fires, we force-close the socket so
  // `onclose` triggers reconnect. Detects laptop-sleep / NAT-drop
  // silent failures that wouldn't otherwise surface until the next
  // outbound send.
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  // Outbound queue. Frames the user enqueues while the WS isn't
  // OPEN — or while OPEN but pre-resume-ack — wait here and flush
  // after the resume handshake completes. Queue is in-memory only:
  // surviving a full app restart isn't worth the localStorage
  // complexity given how rare that case is for a transient drop.
  private outboundQueue: QueuedFrame[] = [];

  private listeners: Map<string, Set<(data: any) => void>> = new Map();
  // Per-message streaming state. Rate-based pacing tracks measured
  // throughput so paint output is smooth even when the server emits in
  // bursts (which Anthropic / 9Router / OS TCP all do). Each frame we
  // paint a small uniform chunk sized so that we'd drain the backlog
  // over the next ~burstWindowMs — when the next burst arrives, we
  // adjust without ever going dry between bursts.
  //
  // Fields:
  //   firstDeltaAt: timestamp of the very first delta. Used to compute
  //     average chars/sec over the lifetime of the stream.
  //   lastPaintAt: when we last actually dispatched. Frame loop reads
  //     this to enforce minimum step-time even when RAF fires faster
  //     than we want.
  //   measuredCps: rolling chars-per-second estimate. Decays on idle so
  //     a fast burst doesn't permanently inflate the rate.
  //   underrunMs: how long we've been "caught up" (no backlog) since
  //     the last paint. Used to detect we're rate-limited by the
  //     server, not by our cadence — when this gets large, we slow
  //     down to leave headroom for the next burst.
  private interpolatorState: Map<string, {
    sessionId: string;
    messageId: string;
    targetText: string;
    displayedLength: number;
    firstDeltaAt: number;
    lastDeltaAt: number;
    lastPaintAt: number;
    measuredCps: number;
  }> = new Map();
  private interpolatorRafId: number | null = null;
  // Initial paint delay (ms). We hold the first delta briefly so
  // an inter-burst gap can land before painting starts. Without it
  // the very first frame paints aggressively, then idles waiting
  // for the next server burst — visible as a tiny boom-pause at
  // the start of every stream. Imperceptible to humans (saccades
  // run at ~250ms, well above this).
  private static INITIAL_HOLD_MS = 150;
  // Paint cadence in ms. ~30Hz — well above perceptual flicker,
  // light enough on React reconciliation that it stays smooth on
  // long messages.
  private static PAINT_INTERVAL_MS = 33;
  // Target painting throughput. 10 chars per 33ms = ~300 cps —
  // the "fast comfortable typing" visual rate (20% slower than the
  // previous 400 cps default). Still well above natural reading
  // speed (~200 cps comfort threshold), still hides bursty upstream
  // cadence, just feels less frantic. Tuned for legibility at speed.
  private static TARGET_CHARS_PER_PAINT = 10;
  // When a backlog accumulates, allow up to this many chars/paint to
  // drain it. ~1.6× the target keeps catch-up imperceptible — the
  // eye can't tell 10 from 16 in a fluid stream. Caps the worst-case
  // visual jump on a giant burst.
  private static MAX_CHARS_PER_PAINT = 16;
  // Headroom buffer in ms. We try to keep at least this much "future
  // paintable" content on hand at all times, so the next upstream
  // burst can be coalesced into the visible stream without a pause.
  // Adds a fixed latency budget — humans don't notice anything below
  // ~250ms in continuous text, so 200ms is well-tuned.
  private static HEADROOM_MS = 200;

  constructor(url: string, options?: WSManagerOptions) {
    this.url = url;
    this.skipStreamEvents = options?.skipStreamEvents ?? false;
    this.sessionId = options?.sessionId ?? null;
    this.connectionUuid = _genUuid();
    // Seed lastSeq from the cross-mount persistent map so a fresh
    // manager (created on every AgentChat remount via key={session.id})
    // doesn't ask the server to replay events the previous manager
    // already saw. This is the architectural fix for "completed chats
    // re-type themselves on reopen": the server's resume protocol now
    // sees a real high-water mark and has nothing to replay.
    if (this.sessionId) {
      this.lastSeq = _sessionLastSeq.get(this.sessionId) ?? 0;
    }
  }

  private bufferDelta(sessionId: string, messageId: string, delta: string) {
    const now = performance.now();
    const existing = this.interpolatorState.get(messageId);
    if (existing) {
      existing.targetText += delta;
      existing.lastDeltaAt = now;
    } else {
      this.interpolatorState.set(messageId, {
        sessionId,
        messageId,
        targetText: delta,
        displayedLength: 0,
        firstDeltaAt: now,
        lastDeltaAt: now,
        // Seed lastPaintAt INITIAL_HOLD_MS in the future so the first
        // tick won't paint until that delay has passed — gives the
        // upstream a chance to land more bytes before we start, so
        // we don't underrun on the very first frame.
        lastPaintAt: now + WebSocketManager.INITIAL_HOLD_MS,
        measuredCps: 0,
      });
    }
    this.scheduleInterpolator();
  }

  private scheduleInterpolator() {
    if (this.interpolatorRafId != null) return;
    // Schedule on every frame — the time-throttle inside tickInterpolator
    // decides whether this frame actually paints. RAF gives us frame-
    // synced timing without the overhead of setInterval drift, and the
    // throttle ensures we only dispatch once per PAINT_INTERVAL_MS even
    // if RAF fires more often (which it does on 120Hz displays).
    this.interpolatorRafId = requestAnimationFrame(() => this.tickInterpolator());
  }

  // Fixed-rate "extremely fast typing" pacing. Paints at a constant
  // ~400 cps target regardless of upstream burstiness. The buffer
  // grows when bursts land above target and drains during gaps —
  // because most models stream below 400 cps on average, we keep up
  // easily and the user sees smooth, uniform high-speed typing. No
  // more boom-pause-boom: the buffer absorbs bursts and the constant
  // paint rate hides them.
  //
  // Three behaviors:
  //   1. Healthy backlog (>= TARGET): paint exactly TARGET chars.
  //   2. Big backlog (more than HEADROOM_MS-worth queued): paint up
  //      to MAX to slowly catch up. Capped low enough that the
  //      acceleration is invisible.
  //   3. Underflow (less than TARGET remaining, stream still active):
  //      paint everything we have at the cadence and pause. Better
  //      than artificially trickling — the natural pause is short
  //      because the next burst from the server fills the buffer
  //      again.
  //
  // Latency cost: HEADROOM_MS (~200ms) behind real time. Imperceptible.
  private tickInterpolator() {
    this.interpolatorRafId = null;
    const now = performance.now();
    let workRemaining = false;
    for (const state of this.interpolatorState.values()) {
      const remaining = state.targetText.length - state.displayedLength;
      if (remaining <= 0) continue;
      // Time-throttle: paint once per PAINT_INTERVAL_MS regardless of
      // display refresh rate. The lastPaintAt was seeded with
      // `now + INITIAL_HOLD_MS` in bufferDelta on first delta, so the
      // first frame is naturally delayed.
      const sincePaint = now - state.lastPaintAt;
      if (sincePaint < WebSocketManager.PAINT_INTERVAL_MS) {
        workRemaining = true;
        continue;
      }
      // Headroom in ms = remaining / TARGET_CPS. If we have more than
      // HEADROOM_MS of paintable content queued, drain slightly faster
      // to bound visible latency. Otherwise paint at the steady target
      // rate.
      const targetCps = WebSocketManager.TARGET_CHARS_PER_PAINT * (1000 / WebSocketManager.PAINT_INTERVAL_MS);
      const headroomMs = (remaining / targetCps) * 1000;
      let step: number;
      if (headroomMs > WebSocketManager.HEADROOM_MS * 2) {
        // Big buffer — accelerate slightly to catch up. Bounded so
        // the visible flow doesn't become unstably variable.
        step = WebSocketManager.MAX_CHARS_PER_PAINT;
      } else {
        // Steady-state: paint exactly TARGET. This is the "fast
        // typing" cadence that hides upstream bursts.
        step = WebSocketManager.TARGET_CHARS_PER_PAINT;
      }
      // Don't paint past the end of the buffered text. When this
      // shrinks the step, we're underflowing — the natural pause that
      // follows is exactly what we want (better than trickling fake-
      // slow chars). The next upstream burst will land and we'll
      // resume painting at TARGET.
      step = Math.min(step, remaining);
      const nextLength = state.displayedLength + step;
      const deltaSlice = state.targetText.slice(state.displayedLength, nextLength);
      state.displayedLength = nextLength;
      state.lastPaintAt = now;
      store.dispatch(streamDelta({
        sessionId: state.sessionId,
        messageId: state.messageId,
        delta: deltaSlice,
      }));
      if (state.displayedLength < state.targetText.length) workRemaining = true;
    }
    if (workRemaining) this.scheduleInterpolator();
  }

  // Flush remaining pending text synchronously. Pass a messageId to flush
  // only that stream (used on stream_end so the tail isn't paced).
  private flushInterpolator(messageId?: string) {
    const drain = (state: { sessionId: string; messageId: string; targetText: string; displayedLength: number }) => {
      if (state.displayedLength >= state.targetText.length) return;
      const tail = state.targetText.slice(state.displayedLength);
      state.displayedLength = state.targetText.length;
      store.dispatch(streamDelta({ sessionId: state.sessionId, messageId: state.messageId, delta: tail }));
    };
    if (messageId) {
      const state = this.interpolatorState.get(messageId);
      if (state) {
        drain(state);
        this.interpolatorState.delete(messageId);
      }
    } else {
      for (const state of this.interpolatorState.values()) drain(state);
      this.interpolatorState.clear();
    }
  }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.explicitlyClosed = false;

    // Append our per-install auth token to the URL. The backend's WS
    // handshake validates this before accepting; without it, any
    // webpage loaded on the same machine could open a WS and read
    // agent traffic. See backend/auth.py + main.py:_ws_auth_ok.
    const token = _getAuthTokenSafe();
    const sep = this.url.includes('?') ? '&' : '?';
    const urlWithToken = token ? `${this.url}${sep}token=${encodeURIComponent(token)}` : this.url;
    this.ws = new WebSocket(urlWithToken);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.resumeAcked = false;
      this.startHeartbeat();
      // Send hello immediately so the server can replay anything the
      // server sent that we never applied. On a fresh session,
      // last_seq=0 → server replays from buffer start (empty) and
      // we proceed normally.
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
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: WSEvent = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = (ev) => {
      this.stopHeartbeat();
      // 4401 = our backend's auth-failure code. Happens on stale token
      // after backend restart (dev hot-reload). Re-fetch from Electron
      // IPC before retrying.
      if (ev && ev.code === 4401) {
        import('@/shared/config').then(mod => mod.refreshAuthToken().catch(() => {}));
      }
      // Mark UI as reconnecting so the run card shows a clear
      // "trying to reconnect" state rather than implying the run
      // died. Skipped on an explicit disconnect (user navigated
      // away) since there's no run to surface state for.
      if (this.sessionId && !this.explicitlyClosed) {
        store.dispatch(setSessionConnState({
          sessionId: this.sessionId,
          state: 'reconnecting',
        }));
      }
      if (!this.explicitlyClosed) this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // Force the close path to run — onclose will mark state
      // reconnecting and schedule a retry.
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
    if (this.interpolatorRafId != null) {
      cancelAnimationFrame(this.interpolatorRafId);
      this.interpolatorRafId = null;
    }
    this.flushInterpolator();
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    // No retry cap. Long-horizon agent runs may outlast a multi-hour
    // network outage (overnight laptop sleep, captive portal limbo);
    // giving up would silently desync the UI. Backoff is bounded at
    // 30s so the user-visible "Reconnecting…" loop never hammers the
    // network, and a small jitter prevents thundering-herd if many
    // session WSes reconnect at once after a backend restart.
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
    const nonce = _genUuid();
    try {
      this.ws.send(JSON.stringify({ event: 'client:ping', data: { nonce } }));
    } catch {
      // socket dying — let the close handler take over
      return;
    }
    if (this.pongTimeoutTimer != null) clearTimeout(this.pongTimeoutTimer);
    this.pongTimeoutTimer = setTimeout(() => {
      // Silent death: no pong arrived in time. Force a close so the
      // browser's onclose path (and our reconnect) runs immediately
      // instead of waiting for the OS TCP keepalive (~75s).
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

  // Direct send that bypasses the queue. Used for hello/ping which
  // must NOT be queued (they're connection-scoped, not session-data).
  private sendRaw(event: string, data: Record<string, any>) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify({ event, data })); } catch { /* nothing */ }
  }

  private handleMessage(msg: WSEvent) {
    const { event, session_id, data } = msg;

    // Update lastSeq for events that carry one. seq is monotonic per
    // session, so this is the high-water mark we send back on resume.
    if (typeof msg.seq === 'number' && msg.seq > this.lastSeq) {
      this.lastSeq = msg.seq;
      // Mirror to the module-scope persistent map so the next fresh
      // manager (next AgentChat remount) starts here, not at zero.
      if (this.sessionId) {
        _sessionLastSeq.set(this.sessionId, this.lastSeq);
      }
    }

    // ----- Connection-scoped frames (no business-logic side effects) -----

    if (event === 'server:pong') {
      this.clearPongTimeout();
      return;
    }

    if (event === 'server:hello') {
      // Resume handshake completed. The server has either replayed
      // missed events (which arrived as separate frames before this
      // ack), surfaced a gap, or signalled "you're caught up." Mark
      // ourselves live and flush any queued outbound frames.
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
      // We were offline long enough that the server's ring buffer
      // rolled past our lastSeq. Re-fetch authoritative state via
      // REST so the slice's view doesn't have a silent gap.
      if (session_id) {
        store.dispatch(fetchSession(session_id));
        // Reset lastSeq — the REST refetch is the new authoritative
        // baseline; subsequent server events with seq numbers will
        // re-establish the high-water mark. Also wipe the cross-mount
        // persistent map so a remount during this gap window doesn't
        // resurrect the stale value.
        this.lastSeq = 0;
        _sessionLastSeq.delete(session_id);
      }
      return;
    }

    if (this.skipStreamEvents) {
      if (event === 'agent:stream_start' || event === 'agent:stream_delta' || event === 'agent:stream_end') {
        return;
      }
    }

    switch (event) {
      case 'agent:status':
        // Capture pre-transition status so we only fire a system notification
        // on a real running→terminal transition. Otherwise a session that
        // was already 'completed' on disk and got refetched would re-toast.
        {
          const prevSession = session_id ? store.getState().agents.sessions[session_id] : undefined;
          const prevStatus = prevSession?.status;

          if (data.session) {
            store.dispatch(updateSession(data.session));
          } else if (session_id) {
            store.dispatch(updateSessionStatus({ sessionId: session_id, status: data.status }));
          }
          if (data.status === 'running' && session_id) {
            store.dispatch(trackAgentNotification(session_id));
          }

          // Fire a native notification when an agent terminates while the
          // window is hidden. Skips sub-agents and browser-agents (the
          // parent's own completion is what the user cares about) and only
          // fires on a real transition from a non-terminal state.
          const TERMINAL = new Set(['completed', 'error']);
          const NON_TERMINAL = new Set(['running', 'waiting_approval', undefined, null, '']);
          if (
            session_id &&
            TERMINAL.has(data.status) &&
            NON_TERMINAL.has(prevStatus as any) &&
            data.session?.mode !== 'browser-agent' &&
            data.session?.mode !== 'sub-agent' &&
            data.session?.mode !== 'invoked-agent'
          ) {
            const sess = data.session ?? prevSession;
            if (sess) {
              const lastAssistant = [...(sess.messages || [])]
                .reverse()
                .find((m: any) => m.role === 'assistant' && typeof m.content === 'string');
              notifyAgentCompletion({
                sessionId: session_id,
                sessionName: sess.name || 'Agent',
                dashboardId: sess.dashboard_id,
                status: data.status as 'completed' | 'error',
                bodyExcerpt: lastAssistant ? String(lastAssistant.content) : undefined,
              });
            }
          }

          // Clear any leftover turn label when the agent reaches a
          // terminal state so the next turn doesn't show a stale label
          // before its own aux call lands.
          if (session_id && (data.status === 'completed' || data.status === 'error' || data.status === 'stopped')) {
            store.dispatch(clearTurnLabel(session_id));
          }
        }
        // Per-sub-agent close via browser_id; skip user-created cards (no spawned_by).
        if (
          (data.status === 'completed' || data.status === 'error') &&
          data.session?.mode === 'browser-agent'
        ) {
          const browserId = data.session.browser_id;
          if (browserId) {
            const card = store.getState().dashboardLayout.browserCards[browserId];
            if (card && card.spawned_by) {
              store.dispatch(removeBrowserCard(browserId));
            }
          }
        }
        break;

      case 'agent:message':
        if (session_id && data.message) {
          if (this.interpolatorState.size > 0) this.flushInterpolator();
          store.dispatch(addMessage({ sessionId: session_id, message: data.message }));
        }
        break;

      case 'agent:stream_start':
      case 'agent:stream_delta':
      case 'agent:stream_end':
        // Replay-skip guard. The WS resume protocol replays buffered
        // events from the ring buffer with seq > last_seq. When this
        // manager is freshly constructed (every AgentChat mount,
        // because of `key={session.id}`), last_seq is 0, so the server
        // replays EVERY buffered stream_* event for the session.
        // Without this guard, opening any chat with prior streaming
        // turns animates the entire history through the typewriter
        // interpolator on every reopen.
        //
        // The discriminator is `resumeAcked`: it flips to true when
        // server:hello arrives, which the server sends AFTER the replay
        // completes. Any stream_* event arriving while !resumeAcked is
        // replay-from-buffer (historical) and can be dropped — the REST
        // snapshot we awaited before connect is authoritative for any
        // already-finalized message, and any genuinely live turn the
        // server is pushing will continue emitting events after the ack.
        if (!this.resumeAcked) break;
        if (event === 'agent:stream_start') {
          if (session_id && data.message_id) {
            store.dispatch(streamStart({
              sessionId: session_id,
              messageId: data.message_id,
              role: data.role,
              toolName: data.tool_name,
            }));
          }
        } else if (event === 'agent:stream_delta') {
          if (session_id && data.message_id) {
            this.bufferDelta(session_id, data.message_id, data.delta);
          }
        } else if (event === 'agent:stream_end') {
          if (session_id && data.message_id) {
            this.flushInterpolator(data.message_id);
            store.dispatch(streamEnd({
              sessionId: session_id,
              messageId: data.message_id,
            }));
          }
        }
        break;

      case 'agent:approval_request':
        if (session_id) {
          store.dispatch(addApprovalRequest({
            sessionId: session_id,
            request: {
              id: data.request_id,
              session_id: session_id,
              tool_name: data.tool_name,
              tool_input: data.tool_input,
              created_at: new Date().toISOString(),
            },
          }));
        }
        break;

      case 'agent:cost_update':
        if (session_id) {
          store.dispatch(updateSessionCost({
            sessionId: session_id,
            costUsd: data.cost_usd,
          }));
        }
        break;

      case 'agent:context_update':
        if (session_id) {
          store.dispatch(updateSessionContext({
            sessionId: session_id,
            inputTokens: data.input_tokens ?? 0,
            outputTokens: data.output_tokens ?? 0,
            cacheReadTokens: data.cache_read_tokens ?? 0,
            cacheReadPct: data.cache_read_pct ?? 0,
            ctxUsedPct: data.ctx_used_pct ?? 0,
            activeMcps: Array.isArray(data.active_mcps) ? data.active_mcps : [],
          }));
        }
        break;

      case 'agent:context_overflow':
        if (session_id) {
          store.dispatch(setContextOverflow({
            sessionId: session_id,
            reason: data.reason ?? 'long_context_required',
            message: data.message ?? 'Context full.',
          }));
        }
        break;

      case 'agent:context_status':
        // Auto-compaction collapsed older turns into a summary. Mirror
        // compacted_through_msg_id locally so the renderer can drop a
        // visible "N earlier turns summarized" chip into the transcript.
        // Other reasons (cleared, etc.) flow through this same event but
        // don't currently need a chip — ignore them for now.
        if (session_id && data.reason === 'compacted') {
          store.dispatch(recordCompaction({
            sessionId: session_id,
            throughMsgId: data.compacted_through_msg_id ?? null,
          }));
        }
        break;

      case 'agent:turn_label':
        // Aux-LLM-generated verb-phrase for the current turn. Replaces
        // the static "Thinking…" label until the turn ends, then the
        // ThinkingBubble freezes to "Thought for Ns · M tokens".
        if (session_id && data.label) {
          store.dispatch(setTurnLabel({
            sessionId: session_id,
            turnId: data.turn_id || '',
            label: data.label,
          }));
        }
        break;

      case 'agent:auth_error':
        // Re-uses the context_overflow card slot — both are "this session is
        // blocked, here's what to do" cards. Reason field disambiguates.
        if (session_id) {
          store.dispatch(setContextOverflow({
            sessionId: session_id,
            reason: data.reason ?? 'auth_error',
            message: data.message ?? 'Authentication failed.',
          }));
        }
        break;

      case 'agent:mcp_suggestions':
        if (session_id) {
          store.dispatch(setMcpSuggestions({
            sessionId: session_id,
            suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
            isVague: !!data.is_vague,
          }));
        }
        break;

      case 'agent:branch_created':
        if (session_id && data.branch) {
          store.dispatch(addBranch({ sessionId: session_id, branch: data.branch }));
          store.dispatch(setActiveBranch({ sessionId: session_id, branchId: data.active_branch_id }));
        }
        break;

      case 'agent:branch_switched':
        if (session_id) {
          store.dispatch(setActiveBranch({ sessionId: session_id, branchId: data.active_branch_id }));
        }
        break;

      case 'agent:name_updated':
        if (session_id && data.name) {
          store.dispatch(updateSessionName({ sessionId: session_id, name: data.name }));
        }
        break;

      case 'agent:group_meta_updated':
        if (session_id && data.group_id) {
          store.dispatch(updateGroupMeta({
            sessionId: session_id,
            groupId: data.group_id,
            name: data.name ?? '',
            svg: data.svg ?? '',
            isRefined: data.is_refined ?? false,
          }));
        }
        break;

      case 'agent:closed':
        if (session_id) {
          const closedStatus = data.status ?? 'stopped';
          store.dispatch(closeSessionFromWs({
            id: session_id,
            name: data.name ?? 'Untitled',
            status: closedStatus,
            model: data.model ?? '',
            mode: data.mode ?? '',
            created_at: data.created_at ?? new Date().toISOString(),
            closed_at: data.closed_at ?? new Date().toISOString(),
            cost_usd: data.cost_usd ?? 0,
            dashboard_id: data.dashboard_id,
          }));
          // Auto-delete browsers spawned by this agent when it finishes
          // normally or errors out. We intentionally skip 'stopped' — the
          // user may want to inspect the browser after manually stopping.
          if (closedStatus === 'completed' || closedStatus === 'error') {
            const browserCards = store.getState().dashboardLayout.browserCards;
            for (const card of Object.values(browserCards)) {
              if (card.spawned_by === session_id) {
                store.dispatch(removeBrowserCard(card.browser_id));
              }
            }
          }
        }
        break;

      case 'dashboard:browser_card_added':
        if (data.browser_card) {
          store.dispatch(addBrowserCardFromBackend(data.browser_card));
          const parentId = data.parent_session_id;
          if (parentId) {
            const layoutState = store.getState().dashboardLayout;
            const parentCard = layoutState.cards[parentId];
            if (parentCard) {
              const targetX = parentCard.x + parentCard.width + GRID_GAP * 12;
              let targetY = parentCard.y;
              const columnCards = Object.values(layoutState.browserCards).filter(
                (c) => Math.abs(c.x - targetX) < 50 && c.browser_id !== data.browser_card.browser_id,
              );
              if (columnCards.length > 0) {
                const lowestBottom = Math.max(...columnCards.map((c) => c.y + c.height));
                targetY = lowestBottom + GRID_GAP;
              }
              store.dispatch(setBrowserCardPosition({
                browserId: data.browser_card.browser_id,
                x: targetX,
                y: targetY,
              }));
              store.dispatch(setGlowingBrowserCards({
                browserIds: [data.browser_card.browser_id],
                sessionId: parentId,
                label: 'Use Browser',
              }));
            }
          }
        }
        break;
    }

    // Notify any custom listeners
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach((fn) => fn({ session_id, ...data }));
    }
  }

  send(event: string, data: Record<string, any>) {
    // Queue if the socket isn't open OR resume hasn't been ack'd yet.
    // The pre-ack gate prevents an outbound user message from racing
    // the resume replay — the server might process the message
    // before the replay finishes, leaving the slice's view of
    // history incomplete.
    const open = this.ws?.readyState === WebSocket.OPEN;
    if (!open || !this.resumeAcked) {
      this.outboundQueue.push({ event, data, client_msg_id: _genUuid() });
      return;
    }
    try {
      this.ws!.send(JSON.stringify({ event, data }));
    } catch {
      this.outboundQueue.push({ event, data, client_msg_id: _genUuid() });
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

export const dashboardWs = new WebSocketManager(`${WS_BASE}/ws/dashboard`, { skipStreamEvents: true });

// Per-session high-water mark for the resume protocol. Survives across
// AgentChat mounts/unmounts so reopening a chat doesn't re-trigger a
// full replay from the server's ring buffer.
//
// Why this exists: AgentChat uses `key={session.id}` on the embedded
// instance inside AgentCard, so every expand/collapse remounts the
// component, which constructs a fresh WebSocketManager. Without this
// persistent map, each fresh manager starts at last_seq=0 and asks the
// server for the entire buffered history. The server faithfully
// replays it, the client renders the typewriter animation again, and
// the user sees their completed chat "type itself out" on every reopen.
//
// Lifetime: tied to the JS module load, which means the page tab. Lost
// on full app reload (intentional — that should re-hydrate from REST).
// On backend restart the buffers are wiped anyway, so a stale
// lastSeq pointing past the buffer top falls into the "fresh client"
// path on the server (last_seq>0 but no buffer) which short-circuits
// to a no-op replay. Safe.
const _sessionLastSeq: Map<string, number> = new Map();

export function createSessionWs(sessionId: string): WebSocketManager {
  return new WebSocketManager(`${WS_BASE}/ws/agents/${sessionId}`, { sessionId });
}

export default WebSocketManager;
