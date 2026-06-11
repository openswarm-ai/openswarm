import { store } from '../state/store';
import { unstable_batchedUpdates } from 'react-dom';
import {
  updateSession,
  updateSessionName,
  updateGroupMeta,
  addMessage,
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
import { streamStart, streamDelta, streamEnd, clearStreamingForSession } from '../state/streamingSlice';
import { addBrowserCardFromBackend, removeBrowserCard, setBrowserCardPosition, setGlowingBrowserCards, GRID_GAP } from '../state/dashboardLayoutSlice';
import { upsertOutput } from '../state/outputsSlice';
import { getAuthToken } from '../config';
import { notifyAgentCompletion } from '../notifications';

// Phase 0 boot instrumentation: one-shot flag so we report the first streamed
// agent token to Electron main exactly once per app launch. Module scope (not
// instance) because multiple WebSocketManagers exist (one per session WS).
let firstAgentResponseMarked = false;

// Thin wrapper around getAuthToken so the connect() call site stays
// synchronous. If the token isn't cached yet, returns '' and the WS
// handshake will 4401 , onclose catches that and refreshes the token
// before the next reconnect.
const _getAuthTokenSafe = (): string => {
  try { return getAuthToken() || ''; } catch { return ''; }
};


const _genUuid = (): string => {
  // Avoid pulling in `crypto.randomUUID` for compat , this is a
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
  // WebSocketManager instance , when the user navigates away and a
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
  private hasConnectedOnce: boolean = false;

  // Heartbeat. We send a ping on a fixed cadence and arm a timeout
  // for the pong; if the timeout fires, we force-close the socket so
  // `onclose` triggers reconnect. Detects laptop-sleep / NAT-drop
  // silent failures that wouldn't otherwise surface until the next
  // outbound send.
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  // Outbound queue. Frames the user enqueues while the WS isn't
  // OPEN , or while OPEN but pre-resume-ack , wait here and flush
  // after the resume handshake completes. Queue is in-memory only:
  // surviving a full app restart isn't worth the localStorage
  // complexity given how rare that case is for a transient drop.
  private outboundQueue: QueuedFrame[] = [];

  private listeners: Map<string, Set<(data: any) => void>> = new Map();
  // Frame-aligned message coalescer. Buffers incoming WS messages from
  // all WebSocketManager instances and flushes them in ONE batched
  // React render per animation frame. Without this, N concurrent agents
  // each cause their own renders on every WS message , dozens of full
  // app re-renders per second, fanning out to every useSelector. With
  // it: max one render per frame regardless of message volume.
  private static _messageQueue: Array<{ mgr: WebSocketManager; msg: WSEvent }> = [];
  private static _flushScheduled = false;

  private static _enqueueMessage(mgr: WebSocketManager, msg: WSEvent) {
    WebSocketManager._messageQueue.push({ mgr, msg });
    if (WebSocketManager._flushScheduled) return;
    WebSocketManager._flushScheduled = true;
    requestAnimationFrame(WebSocketManager._flushMessages);
  }

  private static _flushMessages = () => {
    WebSocketManager._flushScheduled = false;
    if (WebSocketManager._messageQueue.length === 0) return;
    const batch = WebSocketManager._messageQueue;
    WebSocketManager._messageQueue = [];
    // unstable_batchedUpdates collapses all dispatches inside the
    // callback into a single React render. Available in React 17;
    // React 18's automatic batching covers this too, but explicit
    // wrap remains correct in both and protects against future
    // batching-context changes.
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

  // Tokens render as they arrive (claude.ai feel). Per-frame WS batching
  // in _enqueueMessage still coalesces N concurrent agents' messages into
  // ONE React render per animation frame, so removing the pacing layer
  // doesn't reintroduce the parallel-agent re-render storm.
  private dispatchDelta(sessionId: string, messageId: string, delta: string) {
    // Phase 0 boot instrumentation: the first streamed agent token is the
    // "app is actually useful" milestone. Report it once to the Electron main
    // process, which owns the timing log. Guarded by a module-level flag so
    // this is a single no-op branch on every subsequent token.
    if (!firstAgentResponseMarked) {
      firstAgentResponseMarked = true;
      try { (window as any).openswarm?.markFirstAgentResponse?.(); } catch { /* not in Electron */ }
    }
    store.dispatch(streamDelta({ sessionId, messageId, delta }));
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
        // Global broadcasts skip the replay log, so anything missed during
        // a socket gap only reappears if subscribers refetch on reconnect.
        if (this.hasConnectedOnce) {
          this.listeners.get('dashboard:reconnected')?.forEach((fn) => fn({}));
        }
      }
      this.hasConnectedOnce = true;
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: WSEvent = JSON.parse(event.data);
        // Pong bypasses the rAF coalescer: rAF stalls when the window gets no
        // frames (minimized, display asleep) while ping timers keep firing, so
        // a buffered pong read as silence and a healthy socket got killed.
        if (msg.event === 'server:pong') {
          this.clearPongTimeout();
          return;
        }
        // Buffer incoming messages and flush them per animation frame
        // in a single React batch. With N concurrent agents/browsers
        // streaming, each WS instance used to trigger its own React
        // render , dozens per frame, fanning out to every useSelector
        // subscriber, starving the main thread. Coalescing flips that
        // to ONE batched render per frame regardless of how many
        // messages arrived. Stream deltas dispatch directly into Redux
        // (no client-side pacing), so the typed-text rate matches what
        // the server sends, the same way claude.ai feels.
        WebSocketManager._enqueueMessage(this, msg);
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
      // Force the close path to run , onclose will mark state
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
      // socket dying , let the close handler take over
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
        // Reset lastSeq , the REST refetch is the new authoritative
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
            store.dispatch(clearStreamingForSession(session_id));
          }
        }
        // Clean spawned browser cards when the PARENT finishes, never per
        // sub-agent: the parent reuses the same browser_id for its next step,
        // so deleting on sub-agent completion strands BrowserAgent(browser_id)
        // on a dead card. 'stopped' skipped to allow inspect-after-manual-stop.
        if (
          session_id &&
          (data.status === 'completed' || data.status === 'error') &&
          data.session?.mode !== 'browser-agent'
        ) {
          const browserCards = store.getState().dashboardLayout.browserCards;
          for (const card of Object.values(browserCards)) {
            if (card.spawned_by === session_id) {
              store.dispatch(removeBrowserCard(card.browser_id));
            }
          }
        }
        break;

      case 'agent:message':
        if (session_id && data.message) {
          store.dispatch(addMessage({ sessionId: session_id, message: data.message }));
        }
        break;

      case 'agent:output_upserted':
        // Emitted by the backend when an Output row is created (canvas-launched
        // App Builder seed) or updated (post-session meta.json sync). The
        // upsert reducer merges over an existing row so a UI that already
        // loaded the row doesn't lose locally-applied fields.
        if (data.output && data.output.id) {
          store.dispatch(upsertOutput(data.output));
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
        // turns would replay every buffered delta as a live stream
        // event, re-triggering the streaming UI on every reopen.
        //
        // The discriminator is `resumeAcked`: it flips to true when
        // server:hello arrives, which the server sends AFTER the replay
        // completes. Any stream_* event arriving while !resumeAcked is
        // replay-from-buffer (historical) and can be dropped , the REST
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
            this.dispatchDelta(session_id, data.message_id, data.delta);
          }
        } else if (event === 'agent:stream_end') {
          if (session_id && data.message_id) {
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
              sensitive_pattern: data.sensitive_pattern ?? null,
              sensitive_label: data.sensitive_label ?? null,
              sensitive_why: data.sensitive_why ?? null,
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
            contextWindow: typeof data.context_window === 'number' ? data.context_window : undefined,
            frameworkOverheadTokens: typeof data.framework_overhead_tokens === 'number' ? data.framework_overhead_tokens : undefined,
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
        // don't currently need a chip , ignore them for now.
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
        // Re-uses the context_overflow card slot , both are "this session is
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
          // normally or errors out. We intentionally skip 'stopped' , the
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
          // Tag with origin dashboard so the card renders only on the dashboard
          // that spawned it , without this, a browser spawned by an agent on
          // dashboard A leaks into whatever dashboard the user is currently
          // viewing (the global browserCards dict + unfiltered render).
          store.dispatch(addBrowserCardFromBackend({
            ...data.browser_card,
            dashboard_id: data.dashboard_id,
          }));
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
    // the resume replay , the server might process the message
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
// on full app reload (intentional , that should re-hydrate from REST).
// On backend restart the buffers are wiped anyway, so a stale
// lastSeq pointing past the buffer top falls into the "fresh client"
// path on the server (last_seq>0 but no buffer) which short-circuits
// to a no-op replay. Safe.
const _sessionLastSeq: Map<string, number> = new Map();

export function createSessionWs(sessionId: string): WebSocketManager {
  return new WebSocketManager(`${WS_BASE}/ws/agents/${sessionId}`, { sessionId });
}

// One backgrounded session socket, kept alive across a hop so an active agent's
// stream doesn't pay a reconnect+resume handshake on reopen (the "Locking-in"
// lag). Bounded to ONE: opening any other chat tears the previous one down, so
// at most a single detached socket lingers, still pumping events into Redux.
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
