// Run: node --test (via scripts/run-tests.mjs)
import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, mock, test } from 'node:test';
import WebSocketManager from '../WebSocketManager';
import { refreshAuthToken } from '../../config';

// Seed the auth token the way the preload would, and stand in for the DOM bits the manager touches.
const realGlobals = {
  WebSocket: (globalThis as any).WebSocket,
  requestAnimationFrame: (globalThis as any).requestAnimationFrame,
};
before(async () => {
  (globalThis as any).window = { openswarm: { getAuthToken: async () => 'unit-token' }, dispatchEvent: () => true };
  (globalThis as any).document = { body: { classList: { contains: () => false } } };
  await refreshAuthToken();
});

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  failNextSend = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(payload: string): void {
    this.sent.push(payload);
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('simulated transport failure');
    }
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

type SentFrame = { event: string; data: Record<string, unknown> };

function sentEvents(socket: FakeWebSocket): SentFrame[] {
  return socket.sent.map((payload) => JSON.parse(payload));
}

function connectSession(sessionId: string): { manager: WebSocketManager; socket: FakeWebSocket } {
  const manager = new WebSocketManager(`ws://unit/ws/agents/${sessionId}`, { sessionId });
  manager.connect();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  socket.receive({ event: 'server:hello', session_id: sessionId, data: {} });
  return { manager, socket };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as any).WebSocket = FakeWebSocket;
  (globalThis as any).requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };
});

afterEach(() => {
  (globalThis as any).WebSocket = realGlobals.WebSocket;
  (globalThis as any).requestAnimationFrame = realGlobals.requestAnimationFrame;
  mock.restoreAll();
});

test('logical WebSocket prompts receive distinct idempotency keys', () => {
  const { manager, socket } = connectSession('session-idempotency-distinct');

  manager.sendMessage('session-idempotency-distinct', 'first prompt');
  manager.sendMessage('session-idempotency-distinct', 'second prompt');

  const prompts = sentEvents(socket).filter((frame) => frame.event === 'agent:send_message');
  assert.equal(prompts.length, 2);
  assert.equal(typeof prompts[0].data.idempotency_key, 'string');
  assert.equal(typeof prompts[1].data.idempotency_key, 'string');
  assert.notEqual(prompts[0].data.idempotency_key, prompts[1].data.idempotency_key);

  manager.disconnect();
});

test('WebSocket transport retry preserves the logical prompt idempotency key', () => {
  const sessionId = 'session-idempotency-retry';
  const { manager, socket: firstSocket } = connectSession(sessionId);
  firstSocket.failNextSend = true;

  manager.sendMessage(sessionId, 'retry this transport');
  const attempted = sentEvents(firstSocket).find((frame) => frame.event === 'agent:send_message');
  assert.ok(attempted);

  firstSocket.close();
  manager.connect();
  const retrySocket = FakeWebSocket.instances.at(-1)!;
  retrySocket.open();
  retrySocket.receive({ event: 'server:hello', session_id: sessionId, data: {} });

  const retried = sentEvents(retrySocket).find((frame) => frame.event === 'agent:send_message');
  assert.ok(retried);
  assert.equal(retried.data.idempotency_key, attempted.data.idempotency_key);
  assert.equal(retried.data.prompt, 'retry this transport');

  manager.disconnect();
});
