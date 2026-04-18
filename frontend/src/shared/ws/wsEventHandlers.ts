import { store } from '../state/store';
import {
  updateSession,
  updateSessionName,
  updateGroupMeta,
  addMessage,
  streamStart,
  streamEnd,
  addApprovalRequest,
  updateSessionStatus,
  updateSessionCost,
  addBranch,
  setActiveBranch,
  closeSessionFromWs,
  trackAgentNotification,
} from '../state/agentsSlice';
import { addBrowserCardFromBackend, setBrowserCardPosition, setGlowingBrowserCards, GRID_GAP } from '../state/dashboardLayoutSlice';

export type WSEvent = {
  event: string;
  session_id?: string;
  data: Record<string, any>;
};

interface WsDeltaCallbacks {
  bufferDelta: (sessionId: string, messageId: string, delta: string) => void;
  flushDeltas: () => void;
  hasPendingDeltas: () => boolean;
}

export function dispatchWsEvent(msg: WSEvent, delta: WsDeltaCallbacks): void {
  const { event, session_id, data } = msg;

  if (event !== 'agent:stream_delta') {
    console.log(`[FRONTEND] WS event: ${event} | session=${session_id ?? 'none'} | dataKeys=${Object.keys(data).join(',')}`);
  }

  switch (event) {
    case 'agent:status':
      if (data.session) {
        const s = data.session;
        console.log(`[FRONTEND] WS agent:status full session | id=${s.session_id} status=${s.status} dashboard_id=${s.dashboard_id ?? 'NONE'}`);
        if (s.messages && !Array.isArray(s.messages)) s.messages = s.messages.messages ?? [];
        store.dispatch(updateSession(s));
      } else if (session_id) {
        console.log(`[FRONTEND] WS agent:status update | id=${session_id} status=${data.status}`);
        store.dispatch(updateSessionStatus({ sessionId: session_id, status: data.status }));
      }
      if (data.status === 'running' && session_id) {
        store.dispatch(trackAgentNotification(session_id));
      }
      break;

    case 'agent:message':
      if (session_id && data.message) {
        if (delta.hasPendingDeltas()) delta.flushDeltas();
        store.dispatch(addMessage({ sessionId: session_id, message: data.message }));
      }
      break;

    case 'agent:stream_start':
      if (session_id && data.message_id) {
        store.dispatch(streamStart({
          sessionId: session_id,
          messageId: data.message_id,
          role: data.role,
          toolName: data.tool_name,
        }));
      }
      break;

    case 'agent:stream_delta':
      if (session_id && data.message_id) {
        delta.bufferDelta(session_id, data.message_id, data.delta);
      }
      break;

    case 'agent:stream_end':
      if (session_id && data.message_id) {
        if (delta.hasPendingDeltas()) delta.flushDeltas();
        store.dispatch(streamEnd({
          sessionId: session_id,
          messageId: data.message_id,
        }));
      }
      break;

    case 'agent:approval_request':
      if (session_id) {
        store.dispatch(addApprovalRequest({
          sessionId: session_id,
          request: {
            id: data.request_id,
            session_id: session_id,
            tool_name: data.tool_name,
            tool_input: data.tool_input,
            created_at: new Date().toISOString(),
          },
        }));
      }
      break;

    case 'agent:cost_update':
      if (session_id) {
        store.dispatch(updateSessionCost({
          sessionId: session_id,
          costUsd: data.cost_usd,
        }));
      }
      break;

    case 'agent:branch_created':
      if (session_id && data.branch) {
        store.dispatch(addBranch({ sessionId: session_id, branch: data.branch }));
        store.dispatch(setActiveBranch({ sessionId: session_id, branchId: data.active_branch_id }));
      }
      break;

    case 'agent:branch_switched':
      if (session_id) {
        store.dispatch(setActiveBranch({ sessionId: session_id, branchId: data.active_branch_id }));
      }
      break;

    case 'agent:name_updated':
      if (session_id && data.name) {
        store.dispatch(updateSessionName({ sessionId: session_id, name: data.name }));
      }
      break;

    case 'agent:group_meta_updated':
      if (session_id && data.group_id) {
        store.dispatch(updateGroupMeta({
          sessionId: session_id,
          groupId: data.group_id,
          name: data.name ?? '',
          svg: data.svg ?? '',
          isRefined: data.is_refined ?? false,
        }));
      }
      break;

    case 'agent:closed':
      if (session_id) {
        store.dispatch(closeSessionFromWs({
          id: session_id,
          name: data.name ?? 'Untitled',
          status: data.status ?? 'stopped',
          model: data.model ?? '',
          mode: data.mode ?? '',
          created_at: data.created_at ?? new Date().toISOString(),
          closed_at: data.closed_at ?? new Date().toISOString(),
          cost_usd: data.cost_usd ?? 0,
          dashboard_id: data.dashboard_id,
        }));
      }
      break;

    case 'dashboard:browser_card_added':
      if (data.browser_card) {
        store.dispatch(addBrowserCardFromBackend(data.browser_card));
        const parentId = data.parent_session_id;
        if (parentId) {
          const layoutState = store.getState().dashboardLayout;
          const parentCard = layoutState.cards[parentId];
          if (parentCard) {
            const targetX = parentCard.x + parentCard.width + GRID_GAP * 12;
            let targetY = parentCard.y;
            const columnCards = Object.values(layoutState.browserCards).filter(
              (c) => Math.abs(c.x - targetX) < 50 && c.browser_id !== data.browser_card.browser_id,
            );
            if (columnCards.length > 0) {
              const lowestBottom = Math.max(...columnCards.map((c) => c.y + c.height));
              targetY = lowestBottom + GRID_GAP;
            }
            store.dispatch(setBrowserCardPosition({
              browserId: data.browser_card.browser_id,
              x: targetX,
              y: targetY,
            }));
            store.dispatch(setGlowingBrowserCards({
              browserIds: [data.browser_card.browser_id],
              sessionId: parentId,
              label: 'Use Browser',
            }));
          }
        }
      }
      break;
  }
}
