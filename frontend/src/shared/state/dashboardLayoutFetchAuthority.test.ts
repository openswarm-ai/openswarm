import assert from 'node:assert/strict';
import { configureStore } from '@reduxjs/toolkit';
import { afterEach, mock, test } from 'node:test';
import dashboardLayoutReducer, {
  fetchLayout,
  saveLayout,
  type DashboardLayoutState,
} from './dashboardLayoutSlice';
import { API_BASE } from '@/shared/config';

// node:test has no fluent response queue; this stand-in gives the fetch stub the same
// mockResolvedValue / mockResolvedValueOnce / mockImplementationOnce shape the cases read with.
function fetchMock() {
  const once: Array<() => Promise<Response>> = [];
  let fallback: (() => Promise<Response>) | null = null;
  const fn = mock.fn((..._args: unknown[]) => {
    const next = once.shift() ?? fallback;
    if (!next) throw new Error('fetchMock: no response queued');
    return next();
  });
  const api = Object.assign(fn, {
    mockResolvedValue(response: Response) { fallback = () => Promise.resolve(response); return api; },
    mockResolvedValueOnce(response: Response) { once.push(() => Promise.resolve(response)); return api; },
    mockImplementationOnce(impl: () => Promise<Response>) { once.push(impl); return api; },
  });
  return api;
}
const realFetch = globalThis.fetch;

function savePayload(dashboardId: string, state: DashboardLayoutState) {
  return {
    dashboardId,
    saveAuthority: state.unknownPersistedLayoutFieldsByDashboard[dashboardId],
    cards: state.cards,
    viewCards: state.viewCards,
    browserCards: state.browserCards,
    workflowCards: state.workflowCards,
    workflowsHub: state.workflowsHub,
    expandedSessionIds: state.persistedExpandedSessionIds,
  };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function layoutResponse(layout: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(status === 200 ? { layout } : layout), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = realFetch;
});

test('a late dashboard fetch cannot replace the active dashboard or be saved under its id', async () => {
  const dashboardAResponse = deferredResponse();
  const dashboardBResponse = deferredResponse();
  const fetchSpy = fetchMock()
    .mockImplementationOnce(() => dashboardAResponse.promise)
    .mockImplementationOnce(() => dashboardBResponse.promise)
    .mockResolvedValue(new Response('{}', { status: 200 }));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  const testStore = configureStore({ reducer: { dashboardLayout: dashboardLayoutReducer } });

  const dashboardARequest = testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-a' }));
  const dashboardBRequest = testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-b' }));
  dashboardBResponse.resolve(layoutResponse({
    cards: {
      'dashboard-b-card': {
        session_id: 'dashboard-b-card', x: 20, y: 30, width: 480, height: 280, zOrder: 1,
      },
    },
    future_cards: { b: { dashboard: 'B' } },
  }));
  await dashboardBRequest;
  dashboardAResponse.resolve(layoutResponse({
    cards: {
      'dashboard-a-card': {
        session_id: 'dashboard-a-card', x: 40, y: 50, width: 480, height: 280, zOrder: 1,
      },
    },
    future_cards: { a: { dashboard: 'A' } },
  }));
  await dashboardARequest;

  const activeDashboard = testStore.getState().dashboardLayout;
  assert.deepEqual(Object.keys(activeDashboard.cards), ['dashboard-b-card']);
  await testStore.dispatch(saveLayout(savePayload('dashboard-b', activeDashboard)));
  assert.equal(fetchSpy.mock.calls.length, 3);
  assert.equal(fetchSpy.mock.calls[2].arguments[0], `${API_BASE}/dashboards/dashboard-b`);
  const saved = JSON.parse(String((fetchSpy.mock.calls[2].arguments[1] as RequestInit).body)).layout;
  assert.deepEqual(Object.keys(saved.cards), ['dashboard-b-card']);
  assert.deepEqual(saved.future_cards, { b: { dashboard: 'B' } });
});

test('a late rejected request cannot revoke a superseded dashboard baseline', async () => {
  const staleDashboardAResponse = deferredResponse();
  const dashboardBResponse = deferredResponse();
  const fetchSpy = fetchMock()
    .mockResolvedValueOnce(layoutResponse({ future_cards: { a: { dashboard: 'A' } } }))
    .mockImplementationOnce(() => staleDashboardAResponse.promise)
    .mockImplementationOnce(() => dashboardBResponse.promise)
    .mockResolvedValue(new Response('{}', { status: 200 }));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  const testStore = configureStore({ reducer: { dashboardLayout: dashboardLayoutReducer } });

  await testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-a' }));
  const dashboardAAuthority = testStore.getState().dashboardLayout
    .unknownPersistedLayoutFieldsByDashboard['dashboard-a'];
  const staleDashboardARequest = testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-a' }));
  const dashboardBRequest = testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-b' }));
  dashboardBResponse.resolve(layoutResponse({ future_cards: { b: { dashboard: 'B' } } }));
  await dashboardBRequest;
  staleDashboardAResponse.resolve(layoutResponse({ detail: 'dashboard A unavailable' }, 503));
  await staleDashboardARequest;

  const activeDashboard = testStore.getState().dashboardLayout;
  assert.strictEqual(
    activeDashboard.unknownPersistedLayoutFieldsByDashboard['dashboard-a'],
    dashboardAAuthority,
  );
  await testStore.dispatch(saveLayout(savePayload('dashboard-b', activeDashboard)));
  assert.equal(fetchSpy.mock.calls.length, 4);
  assert.equal(fetchSpy.mock.calls[3].arguments[0], `${API_BASE}/dashboards/dashboard-b`);
});

test('only the latest request generation may fulfill for the active dashboard', async () => {
  const olderResponse = deferredResponse();
  const latestResponse = deferredResponse();
  const fetchSpy = fetchMock()
    .mockImplementationOnce(() => olderResponse.promise)
    .mockImplementationOnce(() => latestResponse.promise);
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  const testStore = configureStore({ reducer: { dashboardLayout: dashboardLayoutReducer } });

  const olderRequest = testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-a' }));
  const latestRequest = testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-a' }));
  latestResponse.resolve(layoutResponse({
    cards: {
      latest: { session_id: 'latest', x: 20, y: 30, width: 480, height: 280, zOrder: 1 },
    },
    future_cards: { version: 2 },
  }));
  await latestRequest;
  olderResponse.resolve(layoutResponse({
    cards: {
      older: { session_id: 'older', x: 40, y: 50, width: 480, height: 280, zOrder: 1 },
    },
    future_cards: { version: 1 },
  }));
  await olderRequest;

  const current = testStore.getState().dashboardLayout;
  assert.deepEqual(Object.keys(current.cards), ['latest']);
  assert.deepEqual(
    current.unknownPersistedLayoutFieldsByDashboard['dashboard-a'].future_cards,
    { version: 2 },
  );
});

test('an older rejected generation cannot revoke the latest active baseline', async () => {
  const olderResponse = deferredResponse();
  const latestResponse = deferredResponse();
  const fetchSpy = fetchMock()
    .mockImplementationOnce(() => olderResponse.promise)
    .mockImplementationOnce(() => latestResponse.promise);
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  const testStore = configureStore({ reducer: { dashboardLayout: dashboardLayoutReducer } });

  const olderRequest = testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-a' }));
  const latestRequest = testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-a' }));
  latestResponse.resolve(layoutResponse({ future_cards: { version: 2 } }));
  await latestRequest;
  const latestAuthority = testStore.getState().dashboardLayout
    .unknownPersistedLayoutFieldsByDashboard['dashboard-a'];
  olderResponse.resolve(layoutResponse({ detail: 'older request failed' }, 503));
  await olderRequest;

  const current = testStore.getState().dashboardLayout;
  assert.strictEqual(
    current.unknownPersistedLayoutFieldsByDashboard['dashboard-a'],
    latestAuthority,
  );
});
