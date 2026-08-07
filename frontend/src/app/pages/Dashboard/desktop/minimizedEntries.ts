import { MARKETPLACE_CARD_ID, SETTINGS_CARD_ID, WORKFLOWS_HUB_ID } from '@/shared/state/dashboardLayoutSlice';
import type { BrowserCardPosition, ViewCardPosition, WorkflowsHubPosition } from '@/shared/state/dashboardLayoutSlice';
import type { Output } from '@/shared/state/outputsSlice';

export interface MinimizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MinimizedKind = 'browser' | 'view' | 'workflows' | 'settings' | 'marketplace';

export interface MinimizedEntry {
  id: string;
  kind: MinimizedKind;
  label: string;
  /** Geometry the card is restored to, so the camera can fly back to exactly where it was. */
  rect: MinimizedRect;
  faviconUrl?: string;
  /** Stored still for the window; the fresh minimize-time shot wins over this when there is one. */
  thumbnail?: string | null;
}

export interface MinimizedSlices {
  browserCards: Record<string, BrowserCardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  outputs: Record<string, Output>;
  workflowsHub: WorkflowsHubPosition | null;
  settingsCard: WorkflowsHubPosition | null;
  marketplaceCard: WorkflowsHubPosition | null;
  minimizedCards: Record<string, boolean>;
}

/** Every window parked in the minimized rail, browsers, apps and the singleton windows in one list so they all share a small state. */
export function buildMinimizedEntries({
  browserCards,
  viewCards,
  outputs,
  workflowsHub,
  settingsCard,
  marketplaceCard,
  minimizedCards,
}: MinimizedSlices): MinimizedEntry[] {
  const list: MinimizedEntry[] = [];
  for (const bc of Object.values(browserCards)) {
    if (!minimizedCards[bc.browser_id]) continue;
    const activeTab = bc.tabs.find((t) => t.id === bc.activeTabId) || bc.tabs[0];
    list.push({
      id: bc.browser_id,
      kind: 'browser',
      label: activeTab?.title || 'Browser',
      rect: bc,
      faviconUrl: activeTab?.favicon,
    });
  }
  for (const [cardKey, vc] of Object.entries(viewCards)) {
    if (!minimizedCards[cardKey]) continue;
    const name = outputs[vc.output_id]?.name || 'App';
    const instance = vc.instance ?? 1;
    list.push({
      id: cardKey,
      kind: 'view',
      label: instance > 1 ? `${name} #${instance}` : name,
      rect: vc,
      thumbnail: outputs[vc.output_id]?.thumbnail,
    });
  }
  if (workflowsHub && minimizedCards[WORKFLOWS_HUB_ID]) {
    list.push({ id: WORKFLOWS_HUB_ID, kind: 'workflows', label: 'Workflows', rect: workflowsHub });
  }
  if (settingsCard && minimizedCards[SETTINGS_CARD_ID]) {
    list.push({ id: SETTINGS_CARD_ID, kind: 'settings', label: 'Settings', rect: settingsCard });
  }
  if (marketplaceCard && minimizedCards[MARKETPLACE_CARD_ID]) {
    list.push({ id: MARKETPLACE_CARD_ID, kind: 'marketplace', label: 'Marketplace', rect: marketplaceCard });
  }
  return list;
}
