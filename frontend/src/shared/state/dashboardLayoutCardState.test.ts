import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialDashboardLayoutState, type DashboardLayoutState } from './dashboardLayoutModel';
import {
  dashboardCardStateEntries,
  dashboardCardStateRegistry,
  getDashboardCardState,
  maxDashboardCardZOrder,
} from './dashboardLayoutCardState';
import { canvasReducers } from './dashboardLayoutCanvasReducers';

function layoutWithEveryCardType(): DashboardLayoutState {
  return {
    ...initialDashboardLayoutState,
    cards: {
      agent: { session_id: 'agent', x: 1, y: 2, width: 480, height: 280, zOrder: 1 },
    },
    viewCards: {
      'view#2': { output_id: 'view', instance: 2, x: 3, y: 4, width: 1280, height: 800, zOrder: 2 },
    },
    browserCards: {
      browser: {
        browser_id: 'browser', url: 'https://example.test',
        tabs: [{ id: 'tab', url: 'https://example.test', title: 'Example' }], activeTabId: 'tab',
        x: 5, y: 6, width: 1280, height: 800, zOrder: 3,
      },
    },
    workflowCards: {
      workflow: { workflow_id: 'workflow', x: 11, y: 12, width: 480, height: 520, zOrder: 6 },
    },
    workflowsHub: { x: 13, y: 14, width: 1280, height: 800, zOrder: 7 },
    settingsCard: { x: 17, y: 18, width: 1280, height: 800, zOrder: 9 },
    marketplaceCard: { x: 19, y: 20, width: 1280, height: 800, zOrder: 10 },
    workflowsMonitorCard: { x: 15, y: 16, width: 520, height: 560, zOrder: 8 },
  };
}

test('card-state registry owns one canonical accessor for every CardType', () => {
  const state = layoutWithEveryCardType();
  const expectedTypes = ['agent', 'view', 'browser', 'workflow', 'workflows-hub', 'settings', 'marketplace', 'workflows-monitor'];
  const expectedIds = ['agent', 'view#2', 'browser', 'workflow', 'workflows-hub', 'settings', 'marketplace', 'workflows-monitor'];
  const entries = dashboardCardStateEntries(state);

  assert.deepEqual(Object.keys(dashboardCardStateRegistry), expectedTypes);
  assert.deepEqual(entries.map(({ id }) => id), expectedIds);
  assert.deepEqual(entries.map(({ type }) => type), expectedTypes);

  for (const entry of entries) {
    assert.equal(getDashboardCardState(state, entry.id, entry.type), entry.data);
  }
  assert.equal(getDashboardCardState(state, 'view', 'view'), undefined);
  assert.equal(getDashboardCardState(state, 'missing', 'agent'), undefined);
});

test('unknown card kinds are ignored without mutating opaque legacy data', () => {
  const legacy = { future_cards: { future: { payload: 'recoverable' } } };
  const state = Object.assign(layoutWithEveryCardType(), legacy);

  assert.equal(getDashboardCardState(state, 'future', 'future-card'), undefined);
  assert.equal(maxDashboardCardZOrder(state), 10);
  assert.equal(state.future_cards, legacy.future_cards);
});

test('bring-to-front raises every registered card kind through the override map, never the card dict', () => {
  const base = layoutWithEveryCardType();

  for (const target of dashboardCardStateEntries(base)) {
    const state = structuredClone(base);
    for (const entry of dashboardCardStateEntries(state)) entry.data.zOrder = 100;
    getDashboardCardState(state, target.id, target.type)!.zOrder = 1;
    const before = { ...getDashboardCardState(state, target.id, target.type)! };
    state.nextZOrder = 2;

    canvasReducers.bringToFront(state, {
      type: 'dashboardLayout/bringToFront',
      payload: { id: target.id, type: target.type },
    });

    // Focus writes ONLY zOrders: the card dict keeps its identity and geometry (no re-render storm, no layout PUT), and a stale counter is repaired past the persisted maximum first.
    assert.deepEqual(getDashboardCardState(state, target.id, target.type), before);
    assert.equal(state.zOrders[target.id], 101);
    assert.equal(state.nextZOrder, 102);
  }
});
