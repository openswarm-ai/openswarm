import type { CardType, DashboardLayoutState } from './dashboardLayoutModel';

export interface DashboardCardStateData {
  x: number;
  y: number;
  width: number;
  height: number;
  zOrder: number;
}

export interface DashboardCardStateInstance<TType extends string = CardType> {
  id: string;
  type: TType;
  data: DashboardCardStateData;
}

export interface DashboardCardStateContract<TType extends string = CardType> {
  readonly type: TType;
  entries: (state: DashboardLayoutState) => readonly DashboardCardStateInstance<TType>[];
  get: (state: DashboardLayoutState, id: string) => DashboardCardStateData | undefined;
}

function recordEntries<TType extends CardType>(
  type: TType,
  cards: Record<string, DashboardCardStateData>,
): DashboardCardStateInstance<TType>[] {
  return Object.entries(cards).map(([id, data]) => ({ id, type, data }));
}

function singletonEntries<TType extends CardType>(
  type: TType,
  id: string,
  data: DashboardCardStateData | null,
): DashboardCardStateInstance<TType>[] {
  return data ? [{ id, type, data }] : [];
}

export const dashboardCardStateRegistry = {
  agent: {
    type: 'agent',
    entries: (state) => recordEntries('agent', state.cards),
    get: (state, id) => state.cards[id],
  },
  view: {
    type: 'view',
    entries: (state) => recordEntries('view', state.viewCards),
    get: (state, id) => state.viewCards[id],
  },
  browser: {
    type: 'browser',
    entries: (state) => recordEntries('browser', state.browserCards),
    get: (state, id) => state.browserCards[id],
  },
  workflow: {
    type: 'workflow',
    entries: (state) => recordEntries('workflow', state.workflowCards),
    get: (state, id) => state.workflowCards[id],
  },
  'workflows-hub': {
    type: 'workflows-hub',
    entries: (state) => singletonEntries('workflows-hub', 'workflows-hub', state.workflowsHub),
    get: (state, id) => id === 'workflows-hub' ? state.workflowsHub ?? undefined : undefined,
  },
  settings: {
    type: 'settings',
    entries: (state) => singletonEntries('settings', 'settings', state.settingsCard),
    get: (state, id) => id === 'settings' ? state.settingsCard ?? undefined : undefined,
  },
  marketplace: {
    type: 'marketplace',
    entries: (state) => singletonEntries('marketplace', 'marketplace', state.marketplaceCard),
    get: (state, id) => id === 'marketplace' ? state.marketplaceCard ?? undefined : undefined,
  },
  'workflows-monitor': {
    type: 'workflows-monitor',
    entries: (state) => singletonEntries('workflows-monitor', 'workflows-monitor', state.workflowsMonitorCard),
    get: (state, id) => id === 'workflows-monitor' ? state.workflowsMonitorCard ?? undefined : undefined,
  },
} satisfies { [TType in CardType]: DashboardCardStateContract<TType> };

export function getDashboardCardStateContract(type: string): DashboardCardStateContract | undefined {
  return (dashboardCardStateRegistry as Partial<Record<string, DashboardCardStateContract>>)[type];
}

export function getDashboardCardState(
  state: DashboardLayoutState,
  id: string,
  type: string,
): DashboardCardStateData | undefined {
  return getDashboardCardStateContract(type)?.get(state, id);
}

export function dashboardCardStateEntries(state: DashboardLayoutState): DashboardCardStateInstance[] {
  const entries: DashboardCardStateInstance[] = [];
  for (const contract of Object.values(dashboardCardStateRegistry) as DashboardCardStateContract[]) {
    entries.push(...contract.entries(state));
  }
  return entries;
}

export function maxDashboardCardZOrder(state: DashboardLayoutState): number {
  let maxZ = 0;
  for (const { data } of dashboardCardStateEntries(state)) {
    if (typeof data.zOrder === 'number' && data.zOrder > maxZ) maxZ = data.zOrder;
  }
  // Focus overrides live outside the card dicts; a fresh card must still land above them.
  for (const z of Object.values(state.zOrders)) { if (z > maxZ) maxZ = z; }
  return maxZ;
}

export function reconcileDashboardCardZOrder(state: DashboardLayoutState): void {
  for (const { data } of dashboardCardStateEntries(state)) {
    if (!data.zOrder) data.zOrder = 0;
  }
  state.nextZOrder = maxDashboardCardZOrder(state) + 1;
}

// creationOrder ledger: card ids in creation order, persisted so the dock/rail can order without timestamps. Idempotent adds; rekey keeps the slot.
export function ledgerAdd(ledger: string[], id: string): void {
  if (!ledger.includes(id)) ledger.push(id);
}
export function ledgerRemove(ledger: string[], id: string): void {
  const i = ledger.indexOf(id);
  if (i !== -1) ledger.splice(i, 1);
}
export function ledgerRekey(ledger: string[], oldId: string, newId: string): void {
  const i = ledger.indexOf(oldId);
  if (i !== -1) ledger[i] = newId;
  else ledgerAdd(ledger, newId);
}
