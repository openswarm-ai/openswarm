import type { ActionReducerMapBuilder } from '@reduxjs/toolkit';
import type { AgentsState, HistorySession } from './agentsTypes';
import {
  GET_ALL_SESSIONS,
  LAUNCH_AGENT,
  UPDATE_SYSTEM_PROMPT,
  SEND_MESSAGE,
  EDIT_MESSAGE,
  STOP_AGENT,
  HANDLE_APPROVAL,
  SWITCH_BRANCH,
  DUPLICATE_SESSION,
  CLOSE_SESSION,
  DELETE_SESSION,
  GET_HISTORY,
  RESUME_SESSION,
  GET_SESSION,
  META_LAUNCH_AND_SEND,
} from '@/shared/backend-bridge/apps/agents';

export function buildExtraReducers(builder: ActionReducerMapBuilder<AgentsState>) {
  builder
    .addCase(GET_ALL_SESSIONS.pending, (state) => {
      state.loading = true;
    })
    .addCase(GET_ALL_SESSIONS.fulfilled, (state, action) => {
      state.loading = false;
      const fetchedIds = new Set(action.payload.map((s) => s.id));
      const activeStatuses = new Set(['running', 'waiting_approval']);
      for (const [id, existing] of Object.entries(state.sessions)) {
        if (fetchedIds.has(id)) continue;
        if (existing.status === 'draft') continue;
        if (state.trackedNotificationIds.includes(id)) continue;
        if (activeStatuses.has(existing.status)) continue;
        delete state.sessions[id];
      }
      for (const s of action.payload) {
        const existing = state.sessions[s.id];
        state.sessions[s.id] = {
          ...s,
          pending_approvals: existing?.pending_approvals?.length
            ? existing.pending_approvals
            : s.pending_approvals ?? [],
          streamingMessage: existing?.streamingMessage ?? s.streamingMessage ?? null,
          tool_group_meta: { ...existing?.tool_group_meta, ...s.tool_group_meta },
        };
        if (activeStatuses.has(s.status) && !state.trackedNotificationIds.includes(s.id)) {
          state.trackedNotificationIds.push(s.id);
        }
      }
    })
    .addCase(GET_ALL_SESSIONS.rejected, (state) => {
      state.loading = false;
    })
    .addCase(LAUNCH_AGENT.fulfilled, (state, action) => {
      const session = action.payload.session;
      state.sessions[session.id] = { ...session, streamingMessage: null, tool_group_meta: session.tool_group_meta ?? {} };
      state.activeSessionId = session.id;
      if (!state.expandedSessionIds.includes(session.id)) {
        state.expandedSessionIds.push(session.id);
      }
      if (!state.trackedNotificationIds.includes(session.id)) {
        state.trackedNotificationIds.push(session.id);
      }
    })
    // TODO: Re-implement this???
    .addCase(META_LAUNCH_AND_SEND.fulfilled, (state, action) => {
      const { draftId, session } = action.payload;
      const shouldExpand = action.meta.arg.expand !== false;
      delete state.sessions[draftId];
      state.sessions[session.id] = { ...session, streamingMessage: null, tool_group_meta: session.tool_group_meta ?? {} };
      state.activeSessionId = session.id;
      state.expandedSessionIds = state.expandedSessionIds.map((id) => (id === draftId ? session.id : id));
      if (shouldExpand && !state.expandedSessionIds.includes(session.id)) {
        state.expandedSessionIds.push(session.id);
      }
      if (!state.trackedNotificationIds.includes(session.id)) {
        state.trackedNotificationIds.push(session.id);
      }
    })
    // TODO: Re-implement this???
    // .addCase(generateTitle.fulfilled, (state, action) => {
    //   const session = state.sessions[action.payload.sessionId];
    //   if (session) session.name = action.payload.title;
    // })
    // TODO: Re-implement this???
    // .addCase(generateGroupMeta.fulfilled, (state, action) => {
    //   const session = state.sessions[action.payload.sessionId];
    //   if (session) {
    //     session.tool_group_meta[action.payload.groupId] = {
    //       id: action.payload.groupId,
    //       name: action.payload.name,
    //       svg: action.payload.svg,
    //       is_refined: action.payload.isRefined,
    //     };
    //   }
    // })
    .addCase(UPDATE_SYSTEM_PROMPT.fulfilled, (state, action) => {
      const session = state.sessions[action.payload.sessionId];
      if (session) session.system_prompt = action.payload.systemPrompt;
    })
    .addCase(SEND_MESSAGE.pending, (state, action) => {
      const session = state.sessions[action.meta.arg.sessionId];
      if (session) session.status = 'running';
    })
    .addCase(EDIT_MESSAGE.pending, (state, action) => {
      const session = state.sessions[action.meta.arg.sessionId];
      if (session) session.status = 'running';
    })
    .addCase(STOP_AGENT.fulfilled, (state, action) => {
      const session = state.sessions[action.payload];
      if (session) {
        session.status = 'stopped';
        session.streamingMessage = null;
        session.pending_approvals = [];
      }
    })
    .addCase(HANDLE_APPROVAL.fulfilled, (state, action) => {
      for (const session of Object.values(state.sessions)) {
        session.pending_approvals = session.pending_approvals.filter(
          (r) => r.id !== action.payload.requestId
        );
      }
    })
    .addCase(HANDLE_APPROVAL.rejected, (_state, action) => {
      console.error('Approval request failed:', action.error.message);
    })
    .addCase(SWITCH_BRANCH.fulfilled, (state, action) => {
      const session = state.sessions[action.payload.sessionId];
      if (session) session.active_branch_id = action.payload.branchId;
    })
    .addCase(DUPLICATE_SESSION.fulfilled, (state, action) => {
      const session = action.payload.session;
      state.sessions[session.id] = session;
    })
    .addCase(CLOSE_SESSION.fulfilled, (state, action) => {
      const sessionId = action.payload;
      const session = state.sessions[sessionId];
      if (session) {
        state.history[sessionId] = {
          id: session.id, name: session.name,
          status: session.status === 'running' || session.status === 'waiting_approval' ? 'stopped' : session.status,
          model: session.model, mode: session.mode, created_at: session.created_at,
          closed_at: new Date().toISOString(), cost_usd: session.cost_usd, dashboard_id: session.dashboard_id,
        };
      }
      delete state.sessions[sessionId];
      if (state.activeSessionId === sessionId) state.activeSessionId = null;
      state.expandedSessionIds = state.expandedSessionIds.filter((id) => id !== sessionId);
      state.trackedNotificationIds = state.trackedNotificationIds.filter((id) => id !== sessionId);
    })
    .addCase(CLOSE_SESSION.rejected, (state, action) => {
      const sessionId = action.meta.arg;
      const session = state.sessions[sessionId];
      if (session) {
        state.history[sessionId] = {
          id: session.id, name: session.name,
          status: session.status === 'running' || session.status === 'waiting_approval' ? 'stopped' : session.status,
          model: session.model, mode: session.mode, created_at: session.created_at,
          closed_at: new Date().toISOString(), cost_usd: session.cost_usd, dashboard_id: session.dashboard_id,
        };
      }
      delete state.sessions[sessionId];
      if (state.activeSessionId === sessionId) state.activeSessionId = null;
      state.expandedSessionIds = state.expandedSessionIds.filter((id) => id !== sessionId);
      state.trackedNotificationIds = state.trackedNotificationIds.filter((id) => id !== sessionId);
    })
    .addCase(DELETE_SESSION.fulfilled, (state, action) => {
      const sessionId = action.payload;
      delete state.history[sessionId];
      delete state.sessions[sessionId];
      if (state.activeSessionId === sessionId) state.activeSessionId = null;
      state.expandedSessionIds = state.expandedSessionIds.filter((id) => id !== sessionId);
      state.trackedNotificationIds = state.trackedNotificationIds.filter((id) => id !== sessionId);
    })
    .addCase(GET_HISTORY.fulfilled, (state, action) => {
      const history: Record<string, HistorySession> = {};
      for (const s of action.payload.sessions) history[s.id] = s;
      state.history = history;
    })
    .addCase(RESUME_SESSION.fulfilled, (state, action) => {
      const session = action.payload;
      state.sessions[session.id] = { ...session, streamingMessage: null, tool_group_meta: session.tool_group_meta ?? {} };
      delete state.history[session.id];
      state.activeSessionId = session.id;
      if (!state.expandedSessionIds.includes(session.id)) state.expandedSessionIds.push(session.id);
    })
    .addCase(GET_SESSION.fulfilled, (state, action) => {
      const session = action.payload;
      const existing = state.sessions[session.id];
      state.sessions[session.id] = {
        ...session,
        pending_approvals: session.pending_approvals ?? existing?.pending_approvals ?? [],
        streamingMessage: existing?.streamingMessage ?? null,
        tool_group_meta: session.tool_group_meta ?? existing?.tool_group_meta ?? {},
      };
    })
    .addCase(GET_HISTORY.pending, (state) => {
      state.historySearch.loading = true;
    })
    .addCase(GET_HISTORY.fulfilled, (state, action) => {
      const { sessions, total, has_more } = action.payload;
      const offset = action.meta.arg.offset ?? 0;
      if (offset === 0) {
        state.historySearch.results = sessions;
      } else {
        state.historySearch.results = [...state.historySearch.results, ...sessions];
      }
      state.historySearch.total = total;
      state.historySearch.hasMore = has_more;
      state.historySearch.query = action.meta.arg.q ?? '';
      state.historySearch.loading = false;
    
      const history: Record<string, HistorySession> = {};
      for (const s of sessions) history[s.id] = s;
      state.history = offset === 0 ? history : { ...state.history, ...history };
    })
    .addCase(GET_HISTORY.rejected, (state) => {
      state.historySearch.loading = false;
    })
}
