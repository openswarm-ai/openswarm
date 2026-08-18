import { store } from '../state/store';
import {
  addBrowserCardFromBackend,
  keepBrowserCardOpen,
  placeBesideCard,
  placeBelowCard,
  placeBrowserBesideChat,
  setBrowserCardPosition,
  setGlowingBrowserCards,
  WORKFLOW_CARD_GAP,
  removeBrowserCard,
  setBrowserDocked,
} from '../state/dashboardLayoutSlice';
import type { WSEvent } from './types';
import type { WsEventHandlerResult } from './eventHandlerTypes';

export function handleDashboardBrowserEvent(msg: WSEvent): WsEventHandlerResult {
  const { event, data } = msg;

  switch (event) {
    case 'dashboard:browser_card_keep':
      if (data.browser_id) {
        store.dispatch(keepBrowserCardOpen(data.browser_id));
      }
      return true;

    case 'dashboard:browser_card_added':
      if (data.browser_card) {
        // Add first, then re-read layout so the collision-resolved placement sees the canonical card.
        store.dispatch(addBrowserCardFromBackend({
          ...data.browser_card,
          dashboard_id: data.dashboard_id,
        }));
        const parentId = data.parent_session_id;
        if (parentId) {
          const layoutState = store.getState().dashboardLayout;
          const browserCard = layoutState.browserCards[data.browser_card.browser_id];
          if (browserCard) {
            const exclude = { type: 'browser' as const, id: browserCard.browser_id };
            const parentCard = layoutState.cards[parentId];
            const sess = store.getState().agents.sessions[parentId];
            let pos: { x: number; y: number } | null = null;
            let glowLabel = 'Use Browser';
            if (parentCard) {
              pos = placeBrowserBesideChat(layoutState, parentCard, parentId, browserCard.width, browserCard.height, browserCard.browser_id);
              // A replacement browser buries its predecessor: the agent spins a fresh card when a tab dies, and the displaced spawned sibling must go, not linger.
              for (const old of Object.values(layoutState.browserCards)) {
                if (old.browser_id !== browserCard.browser_id && old.spawned_by === parentId && !old.keep_open) {
                  void import('@/shared/browserTeardown').then(({ removeBrowserCardCleanly }) => removeBrowserCardCleanly(old.browser_id, store.dispatch));
                }
              }
              // Default home is INSIDE the chat: the card overlays the chat's dock slot while the chat is expanded; the beside-chat spot stays the undock/collapse fallback.
              store.dispatch(setBrowserDocked({ browserId: browserCard.browser_id, dockedTo: parentId }));
            } else if (sess?.workflow_run_id && layoutState.workflowsMonitorCard) {
              pos = placeBesideCard(layoutState, layoutState.workflowsMonitorCard, browserCard.width, browserCard.height, undefined, exclude, WORKFLOW_CARD_GAP, true);
            } else if (sess?.workflow_edit_id && layoutState.workflowsHub) {
              pos = placeBelowCard(layoutState, layoutState.workflowsHub, browserCard.width, browserCard.height, undefined, exclude);
              glowLabel = 'Browser';
            }
            if (pos) {
              store.dispatch(setBrowserCardPosition({
                browserId: data.browser_card.browser_id,
                x: pos.x,
                y: pos.y,
              }));
              store.dispatch(setGlowingBrowserCards({
                browserIds: [data.browser_card.browser_id],
                sessionId: parentId,
                label: glowLabel,
              }));
            }
          }
        }
      }
      return true;

    case 'dashboard:browser_card_evict':
      // A wedged card the backend is tearing down BEFORE it spawns a recovery card. Remove it now (no fade, no Keep pill) so its <webview> unmounts first.
      if (data.browser_id) {
        store.dispatch(removeBrowserCard(data.browser_id));
      }
      return true;

    default:
      return null;
  }
}
