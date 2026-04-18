import type { ActionReducerMapBuilder } from '@reduxjs/toolkit';
import type { AgentsState, HistorySession } from './agentsTypes';
// import {
//   fetchSessions, launchAgent, launchAndSendFirstMessage, generateTitle,
//   generateGroupMeta, updateSystemPrompt, sendMessage, editMessage,
//   stopAgent, handleApproval, switchBranch, duplicateSession,
//   closeSession, deleteSession, fetchHistory, resumeSession,
//   fetchSession, fetchBrowserAgentChildren, searchHistory,
// } from './agentsThunks';

export function buildExtraReducers(builder: ActionReducerMapBuilder<AgentsState>) {
  builder
    .addCase(fetchSessions.pending, (state) => {
      state.loading = true;
    })
    .addCase(fetchSessions.fulfilled, (state, action) => {
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
    .addCase(fetchSessions.rejected, (state) => {
      state.loading = false;
    })
    .addCase(launchAgent.fulfilled, (state, action) => {
      state.sessions[action.payload.id] = { ...action.payload, streamingMessage: null, tool_group_meta: action.payload.tool_group_meta ?? {} };
      state.activeSessionId = action.payload.id;
      if (!state.expandedSessionIds.includes(action.payload.id)) {
        state.expandedSessionIds.push(action.payload.id);
      }
      if (!state.trackedNotificationIds.includes(action.payload.id)) {
        state.trackedNotificationIds.push(action.payload.id);
      }
    })
    .addCase(launchAndSendFirstMessage.fulfilled, (state, action) => {
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
    .addCase(generateTitle.fulfilled, (state, action) => {
      const session = state.sessions[action.payload.sessionId];
      if (session) session.name = action.payload.title;
    })
    .addCase(generateGroupMeta.fulfilled, (state, action) => {
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        session.tool_group_meta[action.payload.groupId] = {
          id: action.payload.groupId,
          name: action.payload.name,
          svg: action.payload.svg,
          is_refined: action.payload.isRefined,
        };
      }
    })
    .addCase(updateSystemPrompt.fulfilled, (state, action) => {
      const session = state.sessions[action.payload.sessionId];
      if (session) session.system_prompt = action.payload.systemPrompt;
    })
    .addCase(sendMessage.pending, (state, action) => {
      const session = state.sessions[action.meta.arg.sessionId];
      if (session) session.status = 'running';
    })
    .addCase(editMessage.pending, (state, action) => {
      const session = state.sessions[action.meta.arg.sessionId];
      if (session) session.status = 'running';
    })
    .addCase(stopAgent.fulfilled, (state, action) => {
      const session = state.sessions[action.payload];
      if (session) {
        session.status = 'stopped';
        session.streamingMessage = null;
        session.pending_approvals = [];
      }
    })
    .addCase(handleApproval.fulfilled, (state, action) => {
      for (const session of Object.values(state.sessions)) {
        session.pending_approvals = session.pending_approvals.filter(
          (r) => r.id !== action.payload.requestId
        );
      }
    })
    .addCase(handleApproval.rejected, (_state, action) => {
      console.error('Approval request failed:', action.error.message);
    })
    .addCase(switchBranch.fulfilled, (state, action) => {
      const session = state.sessions[action.payload.sessionId];
      if (session) session.active_branch_id = action.payload.branchId;
    })
    .addCase(duplicateSession.fulfilled, (state, action) => {
      state.sessions[action.payload.id] = action.payload;
    })
    .addCase(closeSession.fulfilled, (state, action) => {
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
    .addCase(closeSession.rejected, (state, action) => {
      const sessionId = action.meta.arg.sessionId;
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
    .addCase(deleteSession.fulfilled, (state, action) => {
      const sessionId = action.payload;
      delete state.history[sessionId];
      delete state.sessions[sessionId];
      if (state.activeSessionId === sessionId) state.activeSessionId = null;
      state.expandedSessionIds = state.expandedSessionIds.filter((id) => id !== sessionId);
      state.trackedNotificationIds = state.trackedNotificationIds.filter((id) => id !== sessionId);
    })
    .addCase(fetchHistory.fulfilled, (state, action) => {
      const history: Record<string, HistorySession> = {};
      for (const s of action.payload) history[s.id] = s;
      state.history = history;
    })
    .addCase(resumeSession.fulfilled, (state, action) => {
      const session = action.payload;
      state.sessions[session.id] = { ...session, streamingMessage: null, tool_group_meta: session.tool_group_meta ?? {} };
      delete state.history[session.id];
      state.activeSessionId = session.id;
      if (!state.expandedSessionIds.includes(session.id)) state.expandedSessionIds.push(session.id);
    })
    .addCase(fetchSession.fulfilled, (state, action) => {
      const session = action.payload;
      const existing = state.sessions[session.id];
      state.sessions[session.id] = {
        ...session,
        pending_approvals: session.pending_approvals ?? existing?.pending_approvals ?? [],
        streamingMessage: existing?.streamingMessage ?? null,
        tool_group_meta: session.tool_group_meta ?? existing?.tool_group_meta ?? {},
      };
    })
    .addCase(fetchBrowserAgentChildren.fulfilled, (state, action) => {
      for (const session of action.payload) {
        if (!state.sessions[session.id]) {
          state.sessions[session.id] = {
            ...session, streamingMessage: null, tool_group_meta: session.tool_group_meta ?? {},
          };
        }
      }
    })
    .addCase(searchHistory.pending, (state) => {
      state.historySearch.loading = true;
    })
    .addCase(searchHistory.fulfilled, (state, action) => {
      const { sessions, total, hasMore, query, offset } = action.payload;
      if (offset === 0) {
        state.historySearch.results = sessions;
      } else {
        state.historySearch.results = [...state.historySearch.results, ...sessions];
      }
      state.historySearch.total = total;
      state.historySearch.hasMore = hasMore;
      state.historySearch.query = query;
      state.historySearch.loading = false;
    })
    .addCase(searchHistory.rejected, (state) => {
      state.historySearch.loading = false;
    });
}
