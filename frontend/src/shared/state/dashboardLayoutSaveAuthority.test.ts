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

function initialState(): DashboardLayoutState {
  return dashboardLayoutReducer(undefined, { type: '@@dashboardLayout/test-init' });
}

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

function layoutResponse(layout: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(status === 200 ? { layout } : layout), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = realFetch;
});

test('a rejected fetch blocks delayed and unmount saves from erasing server layout state', async () => {
  const fetchSpy = fetchMock()
    .mockResolvedValue(new Response(JSON.stringify({ detail: 'temporarily unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  const testStore = configureStore({
    reducer: { dashboardLayout: dashboardLayoutReducer },
  });

  await testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-one' }));
  const emptyLayout = testStore.getState().dashboardLayout;
  const delayedOrUnmountSave = savePayload('dashboard-one', emptyLayout);

  await testStore.dispatch(saveLayout(delayedOrUnmountSave));
  await testStore.dispatch(saveLayout(delayedOrUnmountSave));

  assert.equal(fetchSpy.mock.calls.length, 1);
  assert.equal(fetchSpy.mock.calls[0].arguments[1], undefined);
});

test('a rejected fetch blocks only that dashboard from saving', async () => {
  const dashboardBFutureCards = { future: { card_id: 'future-b', payload: { dashboard: 'B' } } };
  const fetchSpy = fetchMock()
    .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'dashboard A unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      layout: { future_cards: dashboardBFutureCards },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    .mockResolvedValue(new Response('{}', { status: 200 }));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  const testStore = configureStore({
    reducer: { dashboardLayout: dashboardLayoutReducer },
  });

  await testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-a' }));
  await testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-b' }));
  const loadedDashboardB = testStore.getState().dashboardLayout;

  await testStore.dispatch(saveLayout(savePayload('dashboard-a', initialState())));
  await testStore.dispatch(saveLayout(savePayload('dashboard-b', loadedDashboardB)));

  assert.equal(fetchSpy.mock.calls.length, 3);
  assert.equal(fetchSpy.mock.calls[2].arguments[0], `${API_BASE}/dashboards/dashboard-b`);
  const saved = JSON.parse(String((fetchSpy.mock.calls[2].arguments[1] as RequestInit).body)).layout;
  assert.deepEqual(saved.future_cards, dashboardBFutureCards);
});

test('a successful refetch restores save authority after a rejection', async () => {
  const futureCards = { future: { card_id: 'future-a', payload: { recoverable: true } } };
  const fetchSpy = fetchMock()
    .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'temporarily unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      layout: { future_cards: futureCards },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    .mockResolvedValueOnce(new Response('{}', { status: 200 }));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  const testStore = configureStore({
    reducer: { dashboardLayout: dashboardLayoutReducer },
  });

  await testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-a' }));
  await testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-a' }));
  const recovered = testStore.getState().dashboardLayout;
  await testStore.dispatch(saveLayout(savePayload('dashboard-a', recovered)));

  assert.equal(fetchSpy.mock.calls.length, 3);
  const saved = JSON.parse(String((fetchSpy.mock.calls[2].arguments[1] as RequestInit).body)).layout;
  assert.deepEqual(saved.future_cards, futureCards);
});

test('a save captured before a successful refetch remains blocked after recovery', async () => {
  const futureCards = { future: { card_id: 'future-a', payload: { recoverable: true } } };
  const fetchSpy = fetchMock()
    .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'temporarily unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      layout: { future_cards: futureCards },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    .mockResolvedValue(new Response('{}', { status: 200 }));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  const testStore = configureStore({
    reducer: { dashboardLayout: dashboardLayoutReducer },
  });

  await testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-a' }));
  const staleUnmountSave = savePayload('dashboard-a', testStore.getState().dashboardLayout);
  await testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-a' }));
  const recovered = testStore.getState().dashboardLayout;

  await testStore.dispatch(saveLayout(staleUnmountSave));
  await testStore.dispatch(saveLayout(savePayload('dashboard-a', recovered)));

  assert.equal(fetchSpy.mock.calls.length, 3);
  const saved = JSON.parse(String((fetchSpy.mock.calls[2].arguments[1] as RequestInit).body)).layout;
  assert.deepEqual(saved.future_cards, futureCards);
});

test('a defined but superseded successful baseline cannot authorize a stale save', async () => {
  const fetchSpy = fetchMock()
    .mockResolvedValueOnce(layoutResponse({ future_cards: { version: 1 } }))
    .mockResolvedValueOnce(layoutResponse({ future_cards: { version: 2 } }))
    .mockResolvedValue(new Response('{}', { status: 200 }));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  const testStore = configureStore({
    reducer: { dashboardLayout: dashboardLayoutReducer },
  });

  await testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-a' }));
  const staleSave = savePayload('dashboard-a', testStore.getState().dashboardLayout);
  assert.notEqual(staleSave.saveAuthority, undefined);
  await testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-a' }));
  const currentSave = savePayload('dashboard-a', testStore.getState().dashboardLayout);
  assert.notStrictEqual(staleSave.saveAuthority, currentSave.saveAuthority);

  await testStore.dispatch(saveLayout(staleSave));
  await testStore.dispatch(saveLayout(currentSave));

  assert.equal(fetchSpy.mock.calls.length, 3);
  const saved = JSON.parse(String((fetchSpy.mock.calls[2].arguments[1] as RequestInit).body)).layout;
  assert.deepEqual(saved.future_cards, { version: 2 });
});

test('a pending refetch revokes the old baseline before another save can use it', async () => {
  const pendingRefetch = deferredResponse();
  const fetchSpy = fetchMock()
    .mockResolvedValueOnce(layoutResponse({ future_cards: { version: 1 } }))
    .mockImplementationOnce(() => pendingRefetch.promise)
    .mockResolvedValue(new Response('{}', { status: 200 }));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  const testStore = configureStore({
    reducer: { dashboardLayout: dashboardLayoutReducer },
  });

  await testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-a' }));
  const staleSave = savePayload('dashboard-a', testStore.getState().dashboardLayout);
  const newerRequest = testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-a' }));

  await testStore.dispatch(saveLayout(staleSave));

  assert.equal(fetchSpy.mock.calls.length, 2);
  pendingRefetch.resolve(layoutResponse({ future_cards: { version: 2 } }));
  await newerRequest;
});

test('rejecting one of two loaded dashboards preserves the other dashboard authority', async () => {
  const fetchSpy = fetchMock()
    .mockResolvedValueOnce(layoutResponse({ future_cards: { a: { dashboard: 'A' } } }))
    .mockResolvedValueOnce(layoutResponse({ future_cards: { b: { dashboard: 'B' } } }))
    .mockResolvedValueOnce(layoutResponse({ detail: 'dashboard B unavailable' }, 503))
    .mockResolvedValue(new Response('{}', { status: 200 }));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  const testStore = configureStore({
    reducer: { dashboardLayout: dashboardLayoutReducer },
  });

  await testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-a' }));
  const dashboardA = testStore.getState().dashboardLayout;
  const dashboardASave = savePayload('dashboard-a', dashboardA);
  await testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-b' }));
  await testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-b' }));

  const rejectedDashboardB = testStore.getState().dashboardLayout;
  assert.strictEqual(
    rejectedDashboardB.unknownPersistedLayoutFieldsByDashboard['dashboard-a'],
    dashboardASave.saveAuthority,
  );
  assert.equal(rejectedDashboardB.unknownPersistedLayoutFieldsByDashboard['dashboard-b'], undefined);
  await testStore.dispatch(saveLayout(dashboardASave));

  assert.equal(fetchSpy.mock.calls.length, 4);
  assert.equal(fetchSpy.mock.calls[3].arguments[0], `${API_BASE}/dashboards/dashboard-a`);
});
