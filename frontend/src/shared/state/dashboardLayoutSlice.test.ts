import assert from 'node:assert/strict';
import { configureStore } from '@reduxjs/toolkit';
import { afterEach, mock, test } from 'node:test';
import dashboardLayoutReducer, {
  addViewCard,
  bringToFront,
  DEFAULT_BROWSER_CARD_H,
  DEFAULT_BROWSER_CARD_W,
  DEFAULT_CARD_H,
  DEFAULT_CARD_W,
  fetchLayout,
  GRID_GAP,
  computeSpawnPosition,
  findOpenGridCell,
  placeCard,
  popClosedCard,
  recordClosedCard,
  removeBrowserCard,
  resetLayout,
  restoreClosedCard,
  saveLayout,
  type BrowserCardPosition,
  type DashboardLayoutState,
} from './dashboardLayoutSlice';

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

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = realFetch;
  delete (globalThis as { window?: unknown }).window;
});

// The geometry helpers size the grid from the renderer viewport; under node there is no window, so
// the cases that depend on the column count install a minimal one.
function stubViewport(innerWidth: number) {
  (globalThis as { window?: unknown }).window = { innerWidth, innerHeight: 900 };
}

test('findOpenGridCell scans left-to-right then down from the legacy origin', () => {
  stubViewport(1600);
  const firstCell = { x: 40, y: 100, w: DEFAULT_CARD_W, h: DEFAULT_CARD_H };

  assert.deepEqual(
    findOpenGridCell([firstCell], DEFAULT_CARD_W, DEFAULT_CARD_H),
    { x: 40 + DEFAULT_CARD_W + GRID_GAP, y: 100 },
  );
});

test('computeSpawnPosition keeps viewport-centered spawns exact', () => {
  const state = initialState();

  assert.deepEqual(
    computeSpawnPosition(state, 200, 120, { viewportCenter: { x: 700, y: 460 } }),
    { x: 600, y: 400 },
  );
});

test('placeCard collision-dodges unless the caller requests exact placement', () => {
  stubViewport(1600);
  let state = initialState();

  state = dashboardLayoutReducer(state, placeCard({
    sessionId: 'alpha',
    x: 40,
    y: 100,
    width: DEFAULT_CARD_W,
    height: DEFAULT_CARD_H,
  }));
  state = dashboardLayoutReducer(state, placeCard({
    sessionId: 'beta',
    x: 40,
    y: 100,
    width: DEFAULT_CARD_W,
    height: DEFAULT_CARD_H,
  }));
  state = dashboardLayoutReducer(state, placeCard({
    sessionId: 'gamma',
    x: 40,
    y: 100,
    width: DEFAULT_CARD_W,
    height: DEFAULT_CARD_H,
    exact: true,
  }));

  assert.deepEqual(
    { x: state.cards.alpha.x, y: state.cards.alpha.y },
    { x: 40, y: 100 },
  );
  assert.deepEqual(
    { x: state.cards.beta.x, y: state.cards.beta.y },
    { x: 40 + DEFAULT_CARD_W + GRID_GAP, y: 100 },
  );
  assert.deepEqual(
    { x: state.cards.gamma.x, y: state.cards.gamma.y },
    { x: 40, y: 100 },
  );
});

test('addViewCard refocuses and brings an existing app card forward', () => {
  let state = dashboardLayoutReducer(initialState(), addViewCard({
    outputId: 'app-one',
    x: 80,
    y: 120,
  }));
  state = {
    ...state,
    pendingFocusViewCardId: null,
    nextZOrder: 9,
  };

  state = dashboardLayoutReducer(state, addViewCard({ outputId: 'app-one' }));

  assert.deepEqual(Object.keys(state.viewCards), ['app-one']);
  assert.equal(state.viewCards['app-one'].zOrder, 9);
  assert.equal(state.nextZOrder, 10);
  assert.equal(state.pendingFocusViewCardId, 'app-one');
});

test('browser reopen stack records, restores, and pops a dashboard-scoped browser card', () => {
  mock.method(Date, 'now', () => 123456);
  const card: BrowserCardPosition = {
    browser_id: 'browser-one',
    url: 'https://example.test',
    tabs: [{ id: 'tab-one', url: 'https://example.test', title: 'Example' }],
    activeTabId: 'tab-one',
    x: 80,
    y: 120,
    width: DEFAULT_BROWSER_CARD_W,
    height: DEFAULT_BROWSER_CARD_H,
    zOrder: 7,
    dashboard_id: 'dash-old',
  };
  let state: DashboardLayoutState = {
    ...initialState(),
    browserCards: { [card.browser_id]: card },
    nextZOrder: 20,
  };

  state = dashboardLayoutReducer(state, recordClosedCard({ kind: 'browser', id: card.browser_id }));
  const entry = state.recentlyClosed[0];
  assert.equal(entry.kind, 'browser');
  assert.equal(entry.uid, 'browser-browser-one-123456');

  state = dashboardLayoutReducer(state, removeBrowserCard(card.browser_id));
  assert.equal(state.browserCards[card.browser_id], undefined);

  state = dashboardLayoutReducer(state, restoreClosedCard({ entry, dashboardId: 'dash-new' }));
  assert.equal(state.browserCards[card.browser_id].dashboard_id, 'dash-new');
  assert.equal(state.browserCards[card.browser_id].zOrder, 20);

  state = dashboardLayoutReducer(state, popClosedCard(entry.uid));
  assert.equal(state.recentlyClosed.length, 0);
});

test('layout rehydration advances z-order past a persisted workflows hub', () => {
  const requestId = 'fetch-layout';
  const requestArg = { dashboardId: 'dashboard-one' };
  let state = dashboardLayoutReducer(initialState(), fetchLayout.pending(requestId, requestArg));
  state = dashboardLayoutReducer(state, fetchLayout.fulfilled({
    cards: {},
    viewCards: {},
    browserCards: {},
    workflowCards: {},
    workflowsHub: { x: 10, y: 20, width: 1280, height: 800, zOrder: 100 },
    expandedSessionIds: [],
    creationOrder: [],
    zOrders: {},
    unknownPersistedLayoutFields: {},
  }, requestId, requestArg));

  assert.equal(state.nextZOrder, 101);
});

test('bringToFront repairs a stale counter before raising a card', () => {
  const state: DashboardLayoutState = {
    ...initialState(),
    cards: {
      agent: { session_id: 'agent', x: 10, y: 20, width: 480, height: 280, zOrder: 1 },
    },
    workflowsHub: { x: 30, y: 40, width: 1280, height: 800, zOrder: 100 },
    workflowsMonitorCard: { x: 50, y: 60, width: 520, height: 560, zOrder: 90 },
    nextZOrder: 2,
  };

  const raised = dashboardLayoutReducer(state, bringToFront({ id: 'agent', type: 'agent' }));

  // The raise lands in the focus override map above the persisted maximum; the card dict is untouched.
  assert.equal(raised.zOrders.agent, 101);
  assert.equal(raised.cards.agent.zOrder, 1);
  assert.equal(raised.nextZOrder, 102);
});

test('bringToFront repairs a stale counter when the card is already topmost', () => {
  const state: DashboardLayoutState = {
    ...initialState(),
    cards: {
      agent: { session_id: 'agent', x: 10, y: 20, width: 480, height: 280, zOrder: 1 },
    },
    workflowsHub: { x: 30, y: 40, width: 1280, height: 800, zOrder: 100 },
    nextZOrder: 2,
  };

  const raised = dashboardLayoutReducer(state, bringToFront({ id: 'workflows-hub', type: 'workflows-hub' }));

  // Already on top after the repair: no override written, counter parked just above the maximum.
  assert.equal(raised.workflowsHub?.zOrder, 100);
  assert.equal(raised.zOrders['workflows-hub'], undefined);
  assert.equal(raised.nextZOrder, 101);
});

test('fetch and save preserve unknown card partitions and legacy card fields', async () => {
  const futureCards = {
    future: { card_id: 'future', payload: { recoverable: true }, zOrder: 42 },
  };
  const legacyCard = {
    session_id: 'legacy-agent', x: 10, y: 20, width: 480, height: 280,
    legacy_payload: { recoverable: true },
  };
  const fetchSpy = fetchMock()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      layout: { cards: { 'legacy-agent': legacyCard }, future_cards: futureCards },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    .mockResolvedValueOnce(new Response('{}', { status: 200 }));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  const testStore = configureStore({
    reducer: { dashboardLayout: dashboardLayoutReducer },
  });

  await testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-one' }));
  const loaded = testStore.getState().dashboardLayout;
  assert.equal(loaded.cards['legacy-agent'].zOrder, 0);
  assert.deepEqual(
    (loaded.cards['legacy-agent'] as typeof loaded.cards[string] & { legacy_payload: unknown }).legacy_payload,
    legacyCard.legacy_payload,
  );

  await testStore.dispatch(saveLayout({
    dashboardId: 'dashboard-one',
    saveAuthority: loaded.unknownPersistedLayoutFieldsByDashboard['dashboard-one'],
    cards: loaded.cards,
    viewCards: loaded.viewCards,
    browserCards: loaded.browserCards,
    workflowCards: loaded.workflowCards,
    workflowsHub: loaded.workflowsHub,
    expandedSessionIds: loaded.persistedExpandedSessionIds,
  }));

  const saved = JSON.parse(String((fetchSpy.mock.calls[1].arguments[1] as RequestInit).body)).layout;
  assert.deepEqual(saved.future_cards, futureCards);
  assert.deepEqual(saved.cards['legacy-agent'].legacy_payload, legacyCard.legacy_payload);
});

test('a delayed save retains its own unknown fields after a reset and dashboard switch', async () => {
  const futureCards = { future: { card_id: 'future', payload: { dashboard: 'A' } } };
  const fetchSpy = fetchMock()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      layout: { future_cards: futureCards },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      layout: { future_cards: { other: { card_id: 'other', payload: { dashboard: 'B' } } } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    .mockResolvedValueOnce(new Response('{}', { status: 200 }));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  const testStore = configureStore({
    reducer: { dashboardLayout: dashboardLayoutReducer },
  });

  await testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-a' }));
  const dashboardA = testStore.getState().dashboardLayout;
  const delayedSave = {
    dashboardId: 'dashboard-a',
    saveAuthority: dashboardA.unknownPersistedLayoutFieldsByDashboard['dashboard-a'],
    cards: dashboardA.cards,
    viewCards: dashboardA.viewCards,
    browserCards: dashboardA.browserCards,
    workflowCards: dashboardA.workflowCards,
    workflowsHub: dashboardA.workflowsHub,
    expandedSessionIds: dashboardA.persistedExpandedSessionIds,
  };

  testStore.dispatch(resetLayout());
  await testStore.dispatch(fetchLayout({ dashboardId: 'dashboard-b' }));
  await testStore.dispatch(saveLayout(delayedSave));

  const saved = JSON.parse(String((fetchSpy.mock.calls[2].arguments[1] as RequestInit).body)).layout;
  assert.deepEqual(saved.future_cards, futureCards);
});
