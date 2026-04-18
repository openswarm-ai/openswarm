import { store } from '../state/store';
import { streamDelta } from '../state/agentsSlice';
import { type WSEvent, dispatchWsEvent } from './wsEventHandlers';
import { AGENTS_WS_API } from '@/shared/backend-bridge/apps/agents';

class WebSocketManager {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private listeners: Map<string, Set<(data: any) => void>> = new Map();
  private deltaBuffer: Map<string, { sessionId: string; messageId: string; accumulated: string }> = new Map();
  private flushScheduled = false;

  constructor(url: string) {
    this.url = url;
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

    dispatchWsEvent(msg, {
      bufferDelta: (sid, mid, d) => this.bufferDelta(sid, mid, d),
      flushDeltas: () => this.flushDeltas(),
      hasPendingDeltas: () => this.deltaBuffer.size > 0,
    });

    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach((fn) => fn({ session_id, ...data }));
    }
  }

  send(event: string, data: Record<string, any>) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ event, data }));
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


export const agentsWs = new WebSocketManager(AGENTS_WS_API);