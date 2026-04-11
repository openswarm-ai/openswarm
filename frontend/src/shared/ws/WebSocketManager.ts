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
import { addBrowserCardFromBackend, setBrowserCardPosition, setGlowingBrowserCards, GRID_GAP } from '../state/dashboardLayoutSlice';
import { incrementUnread } from '../state/schedulesSlice';

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
  private deltaBuffer: Map<string, { sessionId: string; messageId: string; accumulated: string }> = new Map();
  private flushScheduled = false;

  constructor(url: string, options?: WSManagerOptions) {
    this.url = url;
    this.skipStreamEvents = options?.skipStreamEvents ?? false;
  }

  private bufferDelta(sessionId: string, messageId: string, delta: string) {
    const existing = this.deltaBuffer.get(messageId);
    if (existing) {
      existing.accumulated += delta;
    } else {
      this.deltaBuffer.set(messageId, { sessionId, messageId, accumulated: delta });
    }
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      requestAnimationFrame(() => this.flushDeltas());
    }
  }

  private flushDeltas() {
    this.flushScheduled = false;
    for (const [, { sessionId, messageId, accumulated }] of this.deltaBuffer) {
      store.dispatch(streamDelta({ sessionId, messageId, delta: accumulated }));
    }
    this.deltaBuffer.clear();
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
        break;

      case 'agent:message':
        if (session_id && data.message) {
          if (this.deltaBuffer.size > 0) this.flushDeltas();
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
          if (this.deltaBuffer.size > 0) this.flushDeltas();
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
          store.dispatch(closeSessionFromWs({
            id: session_id,
            name: data.name ?? 'Untitled',
            status: data.status ?? 'stopped',
            model: data.model ?? '',
            mode: data.mode ?? '',
            created_at: data.created_at ?? new Date().toISOString(),
            closed_at: data.closed_at ?? new Date().toISOString(),
            cost_usd: data.cost_usd ?? 0,
            dashboard_id: data.dashboard_id,
          }));
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

      case 'schedule:run_complete':
        store.dispatch(incrementUnread());
        break;

      case 'schedule:run_failed':
        store.dispatch(incrementUnread());
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
    opts?: { mode?: string; model?: string; images?: Array<{ data: string; media_type: string }> },
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
