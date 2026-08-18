// Run: node --test (via scripts/run-tests.mjs)
import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, mock, test } from 'node:test';
import WebSocketManager from './WebSocketManager';
import { refreshAuthToken } from '../config';
import { store } from '../state/store';
import { updateSession } from '../state/agentsSlice';

// The manager reads the auth token from shared/config; under node there is no preload, so seed the
// token the way the preload would (window.openswarm.getAuthToken) and let config cache it.
const realGlobals = {
  WebSocket: (globalThis as any).WebSocket,
  fetch: globalThis.fetch,
  requestAnimationFrame: (globalThis as any).requestAnimationFrame,
};
before(async () => {
  (globalThis as any).window = { openswarm: { getAuthToken: async () => 'unit-token' }, dispatchEvent: () => true };
  // The incoming-message flush checks for a live card drag on document.body; there is none here.
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
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(payload: string): void {
    this.sent.push(payload);
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

function sentEvents(socket: FakeWebSocket): Array<{ event: string; data: Record<string, unknown> }> {
  return socket.sent.map((payload) => JSON.parse(payload));
}

let fetchSpy = mock.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as any).WebSocket = FakeWebSocket;
  fetchSpy = mock.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  (globalThis as any).requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };
});

afterEach(() => {
  (globalThis as any).WebSocket = realGlobals.WebSocket;
  globalThis.fetch = realGlobals.fetch;
  (globalThis as any).requestAnimationFrame = realGlobals.requestAnimationFrame;
  mock.restoreAll();
});

test('session socket sends tokenized hello and flushes queued frames after server hello', () => {
  const manager = new WebSocketManager('ws://unit/ws/agents/session-one', { sessionId: 'session-one' });
  manager.send('agent:stop', { session_id: 'session-one' });

  manager.connect();
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, 'ws://unit/ws/agents/session-one?token=unit-token');
  assert.deepEqual(socket.sent, []);

  socket.open();
  assert.equal(fetchSpy.mock.calls.length, 0);
  let events = sentEvents(socket);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'client:hello');
  assert.equal(events[0].data.session_id, 'session-one');
  assert.equal(events[0].data.last_seq, 0);
  assert.equal(typeof events[0].data.connection_uuid, 'string');

  socket.receive({ event: 'server:hello', session_id: 'session-one', data: {} });
  events = sentEvents(socket);
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], {
    event: 'agent:stop',
    data: { session_id: 'session-one' },
  });

  manager.disconnect();
});

test('dashboard socket skips resume and emits reconnect notification after first open', () => {
  const manager = new WebSocketManager('ws://unit/ws/dashboard', { skipStreamEvents: true });
  let reconnects = 0;
  manager.on('dashboard:reconnected', () => { reconnects += 1; });
  manager.send('dashboard:refresh', { reason: 'test' });

  manager.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  assert.equal(fetchSpy.mock.calls.length, 0);

  let events = sentEvents(socket);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    event: 'dashboard:refresh',
    data: { reason: 'test' },
  });

  socket.open();
  assert.equal(fetchSpy.mock.calls.length, 0);
  events = sentEvents(socket);
  assert.equal(events.length, 1);
  assert.equal(reconnects, 1);

  manager.disconnect();
});

test('dashboard socket suppresses skipped stream events before custom listeners', () => {
  const manager = new WebSocketManager('ws://unit/ws/dashboard', { skipStreamEvents: true });
  const seen: unknown[] = [];
  manager.on('agent:stream_delta', (payload) => seen.push(payload));

  manager.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive({
    event: 'agent:stream_delta',
    session_id: 'session-hidden',
    data: { message_id: 'message-hidden', delta: 'ignored' },
  });

  assert.deepEqual(seen, []);

  manager.disconnect();
});

test('custom listeners receive event payloads after built-ins and can unsubscribe', () => {
  const manager = new WebSocketManager('ws://unit/ws/agents/session-two', { sessionId: 'session-two' });
  const seen: unknown[] = [];
  const unsubscribe = manager.on('custom:event', (payload) => seen.push(payload));

  manager.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive({ event: 'server:hello', session_id: 'session-two', data: {} });
  socket.receive({ event: 'custom:event', session_id: 'session-two', data: { value: 42 } });

  assert.deepEqual(seen, [{ session_id: 'session-two', value: 42 }]);

  unsubscribe();
  socket.receive({ event: 'custom:event', session_id: 'session-two', data: { value: 99 } });
  assert.deepEqual(seen, [{ session_id: 'session-two', value: 42 }]);

  manager.disconnect();
});

test('session socket drops replayed stream events until resume ack', () => {
  const sessionId = 'session-stream-guard';
  const manager = new WebSocketManager(`ws://unit/ws/agents/${sessionId}`, { sessionId });

  manager.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();

  socket.receive({
    event: 'agent:stream_start',
    session_id: sessionId,
    data: { message_id: 'replayed-message', role: 'assistant' },
  });
  assert.equal(store.getState().streaming.bySession[sessionId], undefined);

  socket.receive({ event: 'server:hello', session_id: sessionId, data: {} });
  socket.receive({
    event: 'agent:stream_start',
    session_id: sessionId,
    data: { message_id: 'live-message', role: 'assistant' },
  });
  socket.receive({
    event: 'agent:stream_delta',
    session_id: sessionId,
    data: { message_id: 'live-message', delta: 'hello' },
  });
  assert.equal(store.getState().streaming.bySession[sessionId]?.content, 'hello');

  socket.receive({
    event: 'agent:stream_end',
    session_id: sessionId,
    data: { message_id: 'live-message' },
  });
  assert.equal(store.getState().streaming.bySession[sessionId], undefined);

  manager.disconnect();
});

test('agent message events append to an existing session', () => {
  const sessionId = 'session-message-event';
  store.dispatch(updateSession({
    id: sessionId,
    name: 'Unit Session',
    status: 'running',
    provider: 'anthropic',
    model: 'sonnet',
    mode: 'agent',
    created_at: '2026-07-10T00:00:00.000Z',
    cost_usd: 0,
    tokens: { input: 0, output: 0 },
    messages: [],
    pending_approvals: [],
    branches: { main: { id: 'main', parent_branch_id: null, fork_point_message_id: null, created_at: '2026-07-10T00:00:00.000Z' } },
    active_branch_id: 'main',
    allowed_tools: [],
    tool_group_meta: {},
  } as any));
  const manager = new WebSocketManager(`ws://unit/ws/agents/${sessionId}`, { sessionId });

  manager.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive({ event: 'server:hello', session_id: sessionId, data: {} });
  socket.receive({
    event: 'agent:message',
    session_id: sessionId,
    data: {
      message: {
        id: 'message-one',
        role: 'assistant',
        content: 'done',
        timestamp: '2026-07-10T00:00:01.000Z',
        branch_id: 'main',
        parent_id: null,
      },
    },
  });

  const session = store.getState().agents.sessions[sessionId];
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0].content, 'done');

  manager.disconnect();
});
