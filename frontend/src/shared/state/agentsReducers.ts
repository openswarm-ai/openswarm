import type { PayloadAction } from '@reduxjs/toolkit';
import type {
  AgentsState, AgentSession, AgentMessage,
  ApprovalRequest, MessageBranch, HistorySession,
} from './agentsTypes';

export const agentsReducers = {
  createDraftSession: {
    reducer(state: AgentsState, action: PayloadAction<{ draftId: string; mode: string; setActive: boolean; targetDirectory?: string }>) {
      const { draftId, mode, setActive, targetDirectory } = action.payload;
      state.sessions[draftId] = {
        session_id: draftId, name: 'New chat', status: 'draft', provider: 'anthropic', model: 'sonnet', mode,
        worktree_path: null, branch_name: null, sdk_session_id: null, system_prompt: null,
        allowed_tools: [], max_turns: null, created_at: new Date().toISOString(),
        cost_usd: 0, tokens: { input: 0, output: 0 }, messages: [], pending_approvals: [],
        branches: { main: { id: 'main', parent_branch_id: null, fork_point_message_id: null, created_at: new Date().toISOString() } },
        active_branch_id: 'main', streamingMessage: null,
        target_directory: targetDirectory || null, tool_group_meta: {},
      };
      if (setActive) {
        state.activeSessionId = draftId;
        if (!state.expandedSessionIds.includes(draftId)) {
          state.expandedSessionIds.push(draftId);
        }
      }
    },
    prepare(opts?: { mode?: string; setActive?: boolean; targetDirectory?: string }) {
      return {
        payload: {
          draftId: `draft-${Date.now().toString(36)}`,
          mode: opts?.mode || 'agent',
          setActive: opts?.setActive !== false,
          targetDirectory: opts?.targetDirectory,
        },
      };
    },
  },

  setActiveSession(state: AgentsState, action: PayloadAction<string | null>) {
    state.activeSessionId = action.payload;
  },
  toggleExpandSession(state: AgentsState, action: PayloadAction<string>) {
    const idx = state.expandedSessionIds.indexOf(action.payload);
    if (idx >= 0) {
      state.expandedSessionIds.splice(idx, 1);
    } else {
      state.expandedSessionIds.push(action.payload);
    }
  },
  expandSession(state: AgentsState, action: PayloadAction<string>) {
    if (!state.expandedSessionIds.includes(action.payload)) {
      state.expandedSessionIds.push(action.payload);
    }
  },
  collapseSession(state: AgentsState, action: PayloadAction<string>) {
    state.expandedSessionIds = state.expandedSessionIds.filter((id) => id !== action.payload);
  },
  collapseAllSessions(state: AgentsState) { state.expandedSessionIds = []; },
  setExpandedSessionIds(state: AgentsState, action: PayloadAction<string[]>) {
    state.expandedSessionIds = action.payload;
  },

  updateSessionName(state: AgentsState, action: PayloadAction<{ sessionId: string; name: string }>) {
    const session = state.sessions[action.payload.sessionId];
    if (session) session.name = action.payload.name;
  },
  updateGroupMeta(state: AgentsState, action: PayloadAction<{ sessionId: string; groupId: string; name: string; svg: string; isRefined: boolean }>) {
    const session = state.sessions[action.payload.sessionId];
    if (session) {
      session.tool_group_meta[action.payload.groupId] = {
        id: action.payload.groupId,
        name: action.payload.name,
        svg: action.payload.svg,
        is_refined: action.payload.isRefined,
      };
    }
  },
  setDraftSystemPrompt(state: AgentsState, action: PayloadAction<{ sessionId: string; systemPrompt: string }>) {
    const session = state.sessions[action.payload.sessionId];
    if (session && session.status === 'draft') session.system_prompt = action.payload.systemPrompt;
  },

  updateSession(state: AgentsState, action: PayloadAction<AgentSession>) {
    const inHistory = !!state.history[action.payload.session_id];
    const existsInSessions = !!state.sessions[action.payload.session_id];
    console.log(`[FRONTEND] updateSession: id=${action.payload.session_id} status=${action.payload.status} inHistory=${inHistory} existsInSessions=${existsInSessions} dashboard_id=${action.payload.dashboard_id ?? 'NONE'}`);
    if (state.history[action.payload.session_id]) {
      if (action.payload.status === 'running' || action.payload.mode === 'browser-agent') {
        delete state.history[action.payload.session_id];
      } else {
        console.log(`[FRONTEND] updateSession: SKIPPED — session in history and not running/browser-agent`);
        return;
      }
    }
    const existing = state.sessions[action.payload.session_id];
    const mergedApprovals = existing?.pending_approvals?.length && !action.payload.pending_approvals?.length
      ? existing.pending_approvals
      : action.payload.pending_approvals ?? [];
    const msgs = action.payload.messages;
    state.sessions[action.payload.session_id] = {
      ...action.payload,
      messages: Array.isArray(msgs) ? msgs : ((msgs as unknown as { messages?: AgentMessage[] })?.messages ?? []),
      pending_approvals: mergedApprovals,
      streamingMessage: existing?.streamingMessage ?? action.payload.streamingMessage ?? null,
      tool_group_meta: { ...existing?.tool_group_meta, ...action.payload.tool_group_meta },
    };
    if (action.payload.status === 'running' && !state.trackedNotificationIds.includes(action.payload.session_id)) {
      state.trackedNotificationIds.push(action.payload.session_id);
    }
  },
  updateSessionStatus(state: AgentsState, action: PayloadAction<{ sessionId: string; status: AgentSession['status'] }>) {
    const session = state.sessions[action.payload.sessionId];
    if (session) session.status = action.payload.status;
    if (action.payload.status === 'running' && !state.trackedNotificationIds.includes(action.payload.sessionId)) {
      state.trackedNotificationIds.push(action.payload.sessionId);
    }
  },

  addMessage(state: AgentsState, action: PayloadAction<{ sessionId: string; message: AgentMessage }>) {
    const session = state.sessions[action.payload.sessionId];
    if (session) {
      const idx = session.messages.findIndex((m) => m.id === action.payload.message.id);
      if (idx >= 0) {
        session.messages[idx] = action.payload.message;
      } else {
        session.messages.push(action.payload.message);
      }
      if (session.streamingMessage?.id === action.payload.message.id) {
        session.streamingMessage = null;
      }
    }
  },
  streamStart(state: AgentsState, action: PayloadAction<{ sessionId: string; messageId: string; role: 'assistant' | 'tool_call'; toolName?: string }>) {
    const session = state.sessions[action.payload.sessionId];
    if (session) {
      session.streamingMessage = {
        id: action.payload.messageId,
        role: action.payload.role,
        content: '',
        tool_name: action.payload.toolName,
      };
    }
  },
  streamDelta(state: AgentsState, action: PayloadAction<{ sessionId: string; messageId: string; delta: string }>) {
    const session = state.sessions[action.payload.sessionId];
    if (session?.streamingMessage?.id === action.payload.messageId) {
      session.streamingMessage.content += action.payload.delta;
    }
  },
  streamEnd(state: AgentsState, action: PayloadAction<{ sessionId: string; messageId: string }>) {
    const session = state.sessions[action.payload.sessionId];
    if (session?.streamingMessage?.id === action.payload.messageId) session.streamingMessage = null;
  },

  addApprovalRequest(state: AgentsState, action: PayloadAction<{ sessionId: string; request: ApprovalRequest }>) {
    const session = state.sessions[action.payload.sessionId];
    if (session) {
      const exists = session.pending_approvals.some((r) => r.id === action.payload.request.id);
      if (!exists) session.pending_approvals.push(action.payload.request);
      session.status = 'waiting_approval';
    }
  },
  removeApprovalRequest(state: AgentsState, action: PayloadAction<{ sessionId: string; requestId: string }>) {
    const session = state.sessions[action.payload.sessionId];
    if (session) {
      session.pending_approvals = session.pending_approvals.filter((r) => r.id !== action.payload.requestId);
      if (session.pending_approvals.length === 0 && session.status === 'waiting_approval') {
        session.status = 'running';
      }
    }
  },
  updateSessionCost(state: AgentsState, action: PayloadAction<{ sessionId: string; costUsd: number }>) {
    const session = state.sessions[action.payload.sessionId];
    if (session) session.cost_usd = action.payload.costUsd;
  },

  addBranch(state: AgentsState, action: PayloadAction<{ sessionId: string; branch: MessageBranch }>) {
    const session = state.sessions[action.payload.sessionId];
    if (session) session.branches[action.payload.branch.id] = action.payload.branch;
  },
  setActiveBranch(state: AgentsState, action: PayloadAction<{ sessionId: string; branchId: string }>) {
    const session = state.sessions[action.payload.sessionId];
    if (session) session.active_branch_id = action.payload.branchId;
  },
  updateSessionProvider(state: AgentsState, action: PayloadAction<{ sessionId: string; provider: string }>) {
    const session = state.sessions[action.payload.sessionId];
    if (session) session.provider = action.payload.provider;
  },
  updateSessionModel(state: AgentsState, action: PayloadAction<{ sessionId: string; model: string }>) {
    const session = state.sessions[action.payload.sessionId];
    if (session) session.model = action.payload.model;
  },
  updateSessionMode(state: AgentsState, action: PayloadAction<{ sessionId: string; mode: string }>) {
    const session = state.sessions[action.payload.sessionId];
    if (session) session.mode = action.payload.mode;
  },

  closeSessionFromWs(state: AgentsState, action: PayloadAction<HistorySession>) {
    const entry = action.payload;
    state.history[entry.id] = entry;
    const session = state.sessions[entry.id];
    if (session?.mode === 'browser-agent' && session.parent_session_id) {
      session.status = (entry.status as AgentSession['status']) || 'completed';
    } else {
      delete state.sessions[entry.id];
      for (const [, s] of Object.entries(state.sessions)) {
        if (s.mode === 'browser-agent' && s.parent_session_id === entry.id) s.status = 'stopped';
      }
    }
    if (state.activeSessionId === entry.id) state.activeSessionId = null;
    state.expandedSessionIds = state.expandedSessionIds.filter((id) => id !== entry.id);
  },
  removeDraftSession(state: AgentsState, action: PayloadAction<string>) {
    const id = action.payload;
    const session = state.sessions[id];
    if (session?.status === 'draft') {
      delete state.sessions[id];
      if (state.activeSessionId === id) state.activeSessionId = null;
      state.expandedSessionIds = state.expandedSessionIds.filter((eid) => eid !== id);
    }
  },

  clearHistorySearch(state: AgentsState) {
    state.historySearch = { results: [], total: 0, hasMore: false, query: '', loading: false };
  },
  trackAgentNotification(state: AgentsState, action: PayloadAction<string>) {
    if (!state.trackedNotificationIds.includes(action.payload)) {
      state.trackedNotificationIds.push(action.payload);
    }
  },
  dismissAgentNotification(state: AgentsState, action: PayloadAction<string>) {
    state.trackedNotificationIds = state.trackedNotificationIds.filter((id) => id !== action.payload);
  },
  dismissAllFinishedNotifications(state: AgentsState) {
    const finishedStatuses = new Set(['completed', 'error', 'stopped']);
    state.trackedNotificationIds = state.trackedNotificationIds.filter((id) => {
      const session = state.sessions[id];
      if (session) return !finishedStatuses.has(session.status);
      const hist = state.history[id];
      if (hist) return !finishedStatuses.has(hist.status);
      return true;
    });
  },
};
