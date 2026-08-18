import { store } from '../state/store';
import {
  updateSession,
  updateSessionName,
  updateGroupMeta,
  addMessage,
  addApprovalRequest,
  updateSessionStatus,
  setSessionTestState,
  updateSessionCost,
  updateSessionContext,
  setContextOverflow,
  setRateLimited,
  setContextRecovered,
  setAppDepsChanged,
  setMcpSuggestions,
  addBranch,
  setActiveBranch,
  closeSessionFromWs,
  trackAgentNotification,
  recordCompaction,
  setTurnLabel,
  setQueued,
  clearTurnLabel,
  setProviderRetrying,
} from '../state/agentsSlice';
import { clearStreamingForSession } from '../state/streamingSlice';
import { markBrowserCardEnding, fadeGlowingBrowserCards, clearGlowingBrowserCards, setGlowingBrowserCards } from '../state/dashboardLayoutSlice';
import { displaySessionName } from '../state/sessionDisplay';
import { notifyAgentCompletion } from '../notifications';
import type { WSEvent } from './types';
import type { WsEventHandlerResult } from './eventHandlerTypes';

export function handleAgentSessionEvent(msg: WSEvent): WsEventHandlerResult {
  const { event, session_id, data } = msg;

  switch (event) {
    case 'agent:test_state':
      if (data.session_id && data.state) {
        store.dispatch(setSessionTestState({ sessionId: data.session_id, state: data.state }));
      }
      return true;

    case 'agent:status':
      handleAgentStatus(session_id, data);
      return true;

    case 'agent:message':
      if (session_id && data.message) {
        store.dispatch(addMessage({ sessionId: session_id, message: data.message }));
      }
      return true;

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
            sensitive_pattern: data.sensitive_pattern ?? null,
            sensitive_label: data.sensitive_label ?? null,
            sensitive_why: data.sensitive_why ?? null,
          },
        }));
      }
      return true;

    case 'agent:cost_update':
      if (session_id) {
        store.dispatch(updateSessionCost({
          sessionId: session_id,
          costUsd: data.cost_usd,
        }));
      }
      return true;

    case 'agent:context_update':
      if (session_id) {
        store.dispatch(updateSessionContext({
          sessionId: session_id,
          inputTokens: data.input_tokens ?? 0,
          outputTokens: data.output_tokens ?? 0,
          cacheReadTokens: data.cache_read_tokens ?? 0,
          cacheReadPct: data.cache_read_pct ?? 0,
          ctxUsedPct: data.ctx_used_pct ?? 0,
          contextWindow: typeof data.context_window === 'number' ? data.context_window : undefined,
          frameworkOverheadTokens: typeof data.framework_overhead_tokens === 'number' ? data.framework_overhead_tokens : undefined,
          activeMcps: Array.isArray(data.active_mcps) ? data.active_mcps : [],
        }));
      }
      return true;

    case 'agent:context_overflow':
      if (session_id) {
        store.dispatch(setContextOverflow({
          sessionId: session_id,
          reason: data.reason ?? 'long_context_required',
          message: data.message ?? 'Context full.',
        }));
      }
      return true;

    case 'agent:rate_limited':
      if (session_id) {
        store.dispatch(setRateLimited({
          sessionId: session_id,
          retryAfterS: typeof data.retry_after_s === 'number' ? data.retry_after_s : null,
        }));
      }
      return true;

    case 'agent:context_recovered':
      if (session_id) {
        store.dispatch(setContextRecovered({ sessionId: session_id }));
      }
      return true;

    case 'agent:app_deps_changed':
      if (session_id) {
        store.dispatch(setAppDepsChanged({ sessionId: session_id }));
      }
      return true;

    case 'agent:context_status':
      if (session_id && data.reason === 'compacted') {
        store.dispatch(recordCompaction({
          sessionId: session_id,
          throughMsgId: data.compacted_through_msg_id ?? null,
        }));
      }
      return true;

    case 'agent:turn_label':
      if (session_id && data.label) {
        store.dispatch(setTurnLabel({
          sessionId: session_id,
          turnId: data.turn_id || '',
          label: data.label,
        }));
      }
      return true;

    case 'agent:queued':
      if (session_id) store.dispatch(setQueued({ sessionId: session_id, queued: true }));
      return true;

    case 'agent:admitted':
      if (session_id) store.dispatch(setQueued({ sessionId: session_id, queued: false }));
      return true;

    case 'agent:provider_retrying':
      // Mid-turn CLI backoff: the provider 500/429'd and the CLI is silently waiting; show the muted pill so the card doesn't read as dead.
      if (session_id) {
        store.dispatch(setProviderRetrying({
          sessionId: session_id,
          attempt: typeof data.attempt === 'number' ? data.attempt : null,
          delayMs: typeof data.delay_ms === 'number' ? data.delay_ms : null,
        }));
      }
      return true;

    case 'agent:auth_error':
      if (session_id) {
        store.dispatch(setContextOverflow({
          sessionId: session_id,
          reason: data.reason ?? 'auth_error',
          message: data.message ?? 'Authentication failed.',
        }));
      }
      return true;

    case 'agent:out_of_tokens':
      if (session_id) {
        store.dispatch(setContextOverflow({
          sessionId: session_id,
          reason: 'out_of_tokens',
          message: data.message ?? "You're out of tokens on this model.",
        }));
      }
      return true;

    case 'agent:mcp_suggestions':
      if (session_id) {
        store.dispatch(setMcpSuggestions({
          sessionId: session_id,
          suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
          isVague: !!data.is_vague,
        }));
      }
      return true;

    case 'agent:branch_created':
      if (session_id && data.branch) {
        store.dispatch(addBranch({ sessionId: session_id, branch: data.branch }));
        store.dispatch(setActiveBranch({ sessionId: session_id, branchId: data.active_branch_id }));
      }
      return true;

    case 'agent:branch_switched':
      if (session_id) {
        store.dispatch(setActiveBranch({ sessionId: session_id, branchId: data.active_branch_id }));
      }
      return true;

    case 'agent:name_updated':
      if (session_id && data.name) {
        store.dispatch(updateSessionName({ sessionId: session_id, name: data.name }));
      }
      return true;

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
      return true;

    case 'agent:closed':
      handleAgentClosed(session_id, data);
      return true;

    default:
      return null;
  }
}

function handleAgentStatus(sessionId: string | undefined, data: Record<string, any>): void {
  const prevSession = sessionId ? store.getState().agents.sessions[sessionId] : undefined;
  const prevStatus = prevSession?.status;

  if (data.session) {
    store.dispatch(updateSession(data.session));
  } else if (sessionId) {
    store.dispatch(updateSessionStatus({ sessionId, status: data.status }));
  }
  if (data.status === 'running' && sessionId) {
    store.dispatch(trackAgentNotification(sessionId));
  }
  // Native OS notification when an agent finishes while the user is elsewhere: workflows already had this; long chat tasks deserve the same.
  if (data.status === 'completed' && sessionId && document.hidden) {
    const p_sess2 = data.session ?? prevSession;
    if (p_sess2 && !p_sess2.parent_session_id && p_sess2.mode !== 'browser-agent') {
      void (window as any).openswarm?.notify?.({
        title: 'Agent finished',
        body: (p_sess2.name && p_sess2.name !== 'Untitled' ? p_sess2.name : 'Your task is done.').slice(0, 200),
        deepLink: `openswarm://session/${sessionId}`,
      });
    }
  }
  // An AppAgent driving an app card announces itself only via this status event (no card_added like browsers), so light the app card here.
  const p_sess = data.session;
  if (p_sess && p_sess.mode === 'browser-agent' && typeof p_sess.browser_id === 'string' && p_sess.browser_id.startsWith('app:')
      && (p_sess.status === 'running' || p_sess.status === 'waiting_approval')) {
    store.dispatch(setGlowingBrowserCards({
      browserIds: [p_sess.browser_id],
      sessionId: p_sess.parent_session_id || p_sess.id,
      label: 'Use App',
    }));
  }

  const newStatus = data.status ?? data.session?.status;
  const wasWorking = prevStatus === 'running' || prevStatus === 'waiting_approval';
  if (sessionId && wasWorking && (newStatus === 'completed' || newStatus === 'stopped' || newStatus === 'error')) {
    store.dispatch(fadeGlowingBrowserCards(sessionId));
    setTimeout(() => store.dispatch(clearGlowingBrowserCards(sessionId)), 600);
  }

  const terminal = new Set(['completed', 'error']);
  const nonTerminal = new Set(['running', 'waiting_approval', undefined, null, '']);
  if (
    sessionId &&
    terminal.has(data.status) &&
    nonTerminal.has(prevStatus as any) &&
    data.session?.mode !== 'browser-agent' &&
    data.session?.mode !== 'sub-agent' &&
    data.session?.mode !== 'invoked-agent'
  ) {
    const sess = data.session ?? prevSession;
    if (sess) {
      const lastAssistant = [...(sess.messages || [])]
        .reverse()
        .find((m: any) => m.role === 'assistant' && typeof m.content === 'string');
      notifyAgentCompletion({
        sessionId,
        sessionName: displaySessionName(sess.name),
        dashboardId: sess.dashboard_id,
        status: data.status as 'completed' | 'error',
        bodyExcerpt: lastAssistant ? String(lastAssistant.content) : undefined,
      });
    }
  }

  if (sessionId && (data.status === 'completed' || data.status === 'error' || data.status === 'stopped')) {
    store.dispatch(clearTurnLabel(sessionId));
    if (data.status === 'stopped') {
      promoteStoppedStream(sessionId);
    }
    store.dispatch(clearStreamingForSession(sessionId));
  }

  if (
    sessionId &&
    (data.status === 'completed' || data.status === 'error') &&
    data.session?.mode !== 'browser-agent'
  ) {
    markSpawnedBrowsersEnding(sessionId, data.status);
  }
}

function promoteStoppedStream(sessionId: string): void {
  const entry = store.getState().streaming.bySession[sessionId];
  if (!entry || entry.role !== 'assistant' || !entry.content) return;
  const sess = store.getState().agents.sessions[sessionId];
  if (sess?.messages?.some((m) => m.id === entry.id)) return;
  store.dispatch(addMessage({
    sessionId,
    message: {
      id: entry.id,
      role: 'assistant',
      content: entry.content,
      timestamp: new Date().toISOString(),
      branch_id: sess?.active_branch_id ?? 'main',
      parent_id: null,
    },
  }));
}

function markSpawnedBrowsersEnding(sessionId: string, status: 'completed' | 'error'): void {
  const browserCards = store.getState().dashboardLayout.browserCards;
  for (const card of Object.values(browserCards)) {
    if (card.spawned_by === sessionId && !card.keep_open) {
      store.dispatch(markBrowserCardEnding({
        browserId: card.browser_id,
        status,
      }));
    }
  }
}

function handleAgentClosed(sessionId: string | undefined, data: Record<string, any>): void {
  if (!sessionId) return;
  const closedStatus = data.status ?? 'stopped';
  const watchedSidecar = Object.values(store.getState().workflows.openCards)
    .some((oc) => oc.sidecarSessionId === sessionId);
  const monitorWorkflowId = store.getState().dashboardLayout.workflowsMonitorId;
  const watchedByMonitor = !!monitorWorkflowId
    && (store.getState().workflows.runs[monitorWorkflowId] || []).some((r) => r.session_id === sessionId);
  store.dispatch(closeSessionFromWs({
    id: sessionId,
    name: data.name ?? 'Untitled',
    status: closedStatus,
    model: data.model ?? '',
    mode: data.mode ?? '',
    created_at: data.created_at ?? new Date().toISOString(),
    closed_at: data.closed_at ?? new Date().toISOString(),
    cost_usd: data.cost_usd ?? 0,
    dashboard_id: data.dashboard_id,
    keepSession: watchedSidecar || watchedByMonitor,
  }));
  if (closedStatus === 'completed' || closedStatus === 'error') {
    markSpawnedBrowsersEnding(sessionId, closedStatus);
  }
}
