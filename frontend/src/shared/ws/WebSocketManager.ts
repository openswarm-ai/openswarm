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
  addBranch,
  setActiveBranch,
  closeSessionFromWs,
  trackAgentNotification,
} from '../state/agentsSlice';
import { addBrowserCardFromBackend, removeBrowserCard, setBrowserCardPosition, setGlowingBrowserCards, GRID_GAP } from '../state/dashboardLayoutSlice';

type WSEvent = {
  event: string;
  session_id?: string;
  data: Record<string, any>;
};

interface WSManagerOptions {
  skipStreamEvents?: boolean;
}

class WebSocketManager {
  private ws: WebSocket | null = null;
  private url: string;
  private skipStreamEvents: boolean;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private listeners: Map<string, Set<(data: any) => void>> = new Map();
  private interpolatorState: Map<string, { sessionId: string; messageId: string; targetText: string; displayedLength: number }> = new Map();
  private interpolatorRafId: number | null = null;

  constructor(url: string, options?: WSManagerOptions) {
    this.url = url;
    this.skipStreamEvents = options?.skipStreamEvents ?? false;
  }

  private bufferDelta(sessionId: string, messageId: string, delta: string) {
    const existing = this.interpolatorState.get(messageId);
    if (existing) {
      existing.targetText += delta;
    } else {
      this.interpolatorState.set(messageId, { sessionId, messageId, targetText: delta, displayedLength: 0 });
    }
    this.scheduleInterpolator();
  }

  private scheduleInterpolator() {
    if (this.interpolatorRafId != null) return;
    this.interpolatorRafId = requestAnimationFrame(() => this.tickInterpolator());
  }

  // Drain each message's pending text at a paced, roughly-uniform rate so
  // bursty server emissions paint as a smooth stream of characters instead of
  // visible chunks. Rate adapts to backlog: small backlog → ~2 chars/frame
  // (~120cps, typewriter feel); large backlog → up to 40 chars/frame so we
  // catch up fast without pinning the main thread.
  private tickInterpolator() {
    this.interpolatorRafId = null;
    let workRemaining = false;
    for (const state of this.interpolatorState.values()) {
      const remaining = state.targetText.length - state.displayedLength;
      if (remaining <= 0) continue;
      const step = Math.min(Math.max(Math.ceil(remaining / 6), 2), 40);
      const nextLength = Math.min(state.displayedLength + step, state.targetText.length);
      const deltaSlice = state.targetText.slice(state.displayedLength, nextLength);
      state.displayedLength = nextLength;
      store.dispatch(streamDelta({ sessionId: state.sessionId, messageId: state.messageId, delta: deltaSlice }));
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

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: WSEvent = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  }

  private handleMessage(msg: WSEvent) {
    const { event, session_id, data } = msg;

    if (this.skipStreamEvents) {
      if (event === 'agent:stream_start' || event === 'agent:stream_delta' || event === 'agent:stream_end') {
        return;
      }
    }

    switch (event) {
      case 'agent:status':
        if (data.session) {
          store.dispatch(updateSession(data.session));
        } else if (session_id) {
          store.dispatch(updateSessionStatus({ sessionId: session_id, status: data.status }));
        }
        if (data.status === 'running' && session_id) {
          store.dispatch(trackAgentNotification(session_id));
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
        if (session_id && data.message_id) {
          store.dispatch(streamStart({
            sessionId: session_id,
            messageId: data.message_id,
            role: data.role,
            toolName: data.tool_name,
          }));
        }
        break;

      case 'agent:stream_delta':
        if (session_id && data.message_id) {
          this.bufferDelta(session_id, data.message_id, data.delta);
        }
        break;

      case 'agent:stream_end':
        if (session_id && data.message_id) {
          this.flushInterpolator(data.message_id);
          store.dispatch(streamEnd({
            sessionId: session_id,
            messageId: data.message_id,
          }));
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
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ event, data }));
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

export function createSessionWs(sessionId: string): WebSocketManager {
  return new WebSocketManager(`${WS_BASE}/ws/agents/${sessionId}`);
}

export default WebSocketManager;
