// ENG-334: the renderer half of the CanvasCommand tool. An agent could place its card once at
// spawn and never touch the canvas again; this executes move/collapse/expand/tile/close/tidy
// against the live stores, answering over the same request/response bridge browser commands use.
import { store } from './state/store';
import {
  setCardPosition,
  setBrowserCardPosition,
  setViewCardPosition,
  setWorkflowCardPosition,
  setTiledCard,
  clearTiledCard,
  toggleMinimizeCard,
  removeCard,
  removeViewCard,
  removeWorkflowCard,
  recordClosedCard,
  tidyLayout,
  bringToFront,
  type CardType,
} from './state/dashboardLayoutSlice';
import { collapseSession, expandSession, closeSession } from './state/agentsSlice';
import { removeBrowserCardCleanly } from './browserTeardown';

type CanvasKind = Extract<CardType, 'agent' | 'browser' | 'view' | 'workflow'>;

const ZONES = new Set(['fill', 'left', 'right', 'top', 'bottom', 'tl', 'tr', 'bl', 'br', 'fullscreen', 'restore']);

function findCardKind(id: string): CanvasKind | null {
  const s = store.getState().dashboardLayout;
  if (s.cards[id]) return 'agent';
  if (s.browserCards[id]) return 'browser';
  if (s.viewCards[id]) return 'view';
  if (s.workflowCards[id]) return 'workflow';
  return null;
}

export async function handleCanvasCommand(params: Record<string, any>): Promise<Record<string, any>> {
  const action = String(params.action || '');
  if (action === 'tidy') {
    store.dispatch(tidyLayout({ expandedSessionIds: store.getState().agents.expandedSessionIds }));
    return { text: 'Canvas tidied: every card reflowed onto the grid.' };
  }
  const id = String(params.card_id || '');
  if (!id) return { error: 'card_id is required' };
  const kind = findCardKind(id);
  if (!kind) {
    return { error: `No card '${id}' is on the canvas. Agent chats use their session id, browser cards their browser id.` };
  }
  if (action === 'move') {
    const x = Number(params.x);
    const y = Number(params.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'move needs numeric x and y' };
    if (kind === 'agent') store.dispatch(setCardPosition({ sessionId: id, x, y }));
    else if (kind === 'browser') store.dispatch(setBrowserCardPosition({ browserId: id, x, y }));
    else if (kind === 'view') store.dispatch(setViewCardPosition({ outputId: id, x, y }));
    else store.dispatch(setWorkflowCardPosition({ workflowId: id, x, y }));
    store.dispatch(bringToFront({ id, type: kind }));
    return { text: `Moved ${kind} card to (${Math.round(x)}, ${Math.round(y)}).` };
  }
  if (action === 'collapse') {
    if (kind === 'agent') store.dispatch(collapseSession(id));
    else if (!store.getState().dashboardLayout.minimizedCards[id]) store.dispatch(toggleMinimizeCard({ cardId: id }));
    return { text: `Collapsed ${kind} card ${id}.` };
  }
  if (action === 'expand') {
    if (kind === 'agent') store.dispatch(expandSession(id));
    else if (store.getState().dashboardLayout.minimizedCards[id]) store.dispatch(toggleMinimizeCard({ cardId: id }));
    store.dispatch(bringToFront({ id, type: kind }));
    return { text: `Expanded ${kind} card ${id}.` };
  }
  if (action === 'tile') {
    const zone = String(params.zone || '');
    if (!ZONES.has(zone)) return { error: `zone must be one of: ${Array.from(ZONES).join(', ')}` };
    if (zone === 'restore') {
      store.dispatch(clearTiledCard(id));
      return { text: `Restored ${kind} card ${id} from its tile.` };
    }
    store.dispatch(setTiledCard({ cardId: id, zone }));
    store.dispatch(bringToFront({ id, type: kind }));
    return { text: `Tiled ${kind} card ${id} to ${zone}.` };
  }
  if (action === 'close') {
    if (kind === 'agent') {
      // Mirrors the user's own close sequence (AgentCard.handleRemove) so undo keeps working.
      store.dispatch(recordClosedCard({ kind: 'agent', id }));
      store.dispatch(collapseSession(id));
      store.dispatch(removeCard(id));
      void store.dispatch(closeSession({ sessionId: id }));
    } else if (kind === 'browser') {
      store.dispatch(recordClosedCard({ kind: 'browser', id }));
      await removeBrowserCardCleanly(id, store.dispatch);
    } else if (kind === 'view') {
      store.dispatch(recordClosedCard({ kind: 'view', id }));
      store.dispatch(removeViewCard(id));
    } else {
      store.dispatch(recordClosedCard({ kind: 'workflow', id }));
      store.dispatch(removeWorkflowCard(id));
    }
    return { text: `Closed ${kind} card ${id}.` };
  }
  return { error: `Unknown canvas action '${action}'. Use move, collapse, expand, tile, close, or tidy.` };
}
