import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

const AGENTS_API = `${API_BASE}/agents`;

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system' | 'thinking';
  content: any;
  timestamp: string;
  branch_id: string;
  parent_id: string | null;
  context_paths?: Array<{ path: string; type: string }>;
  attached_skills?: Array<{ id: string; name: string }>;
  forced_tools?: string[];
  images?: Array<{ data: string; media_type: string }>;
  hidden?: boolean;
  /** Round-tripped optimistic-bubble id; addMessage dedupes the echo against the placeholder. */
  client_message_id?: string;
  /** Frontend-only optimistic lifecycle; dropped on server-echoed messages. */
  optimistic_status?: 'pending' | 'failed';
  /** Server-stamped duration/token counts; today only thinking messages set these. */
  elapsed_ms?: number;
  tokens?: number;
  /** Input-side token count for the turn (fresh + cache_creation + cache_read). */
  input_tokens?: number;
  tool_count?: number;
}

export interface ApprovalRequest {
  id: string;
  session_id: string;
  tool_name: string;
  tool_input: Record<string, any>;
  created_at: string;
  sensitive_pattern?: string | null;
  sensitive_label?: string | null;
  sensitive_why?: string | null;
}

export interface MessageBranch {
  id: string;
  parent_branch_id: string | null;
  fork_point_message_id: string | null;
  created_at: string;
}

// StreamingMessage moved to streamingSlice; re-exported for back-compat.
export type { StreamingMessage } from './streamingSlice';

export interface ToolGroupMeta {
  id: string;
  name: string;
  svg: string;
  is_refined: boolean;
}

export interface AgentSession {
  id: string;
  name: string;
  status: 'draft' | 'running' | 'waiting_approval' | 'completed' | 'error' | 'stopped';
  provider: string;
  model: string;
  mode: string;
  worktree_path: string | null;
  branch_name: string | null;
  sdk_session_id: string | null;
  system_prompt: string | null;
  allowed_tools: string[];
  max_turns: number | null;
  created_at: string;
  closed_at?: string | null;
  cost_usd: number;
  tokens: { input: number; output: number };
  messages: AgentMessage[];
  pending_approvals: ApprovalRequest[];
  branches: Record<string, MessageBranch>;
  active_branch_id: string;
  // streamingMessage lives in state.streaming.bySession[id]; see streamingSlice.
  target_directory?: string | null;
  tool_group_meta: Record<string, ToolGroupMeta>;
  dashboard_id?: string;
  browser_id?: string | null;
  parent_session_id?: string | null;
  thinking_level?: 'off' | 'low' | 'medium' | 'high' | 'auto';
  active_mcps?: string[];
  ctx_used_pct?: number;
  cache_read_pct?: number;
  cache_read_tokens?: number;
  context_overflow?: { reason: string; message: string; at: string } | null;
  mcp_suggestions?: Array<{ id: string; title: string; description: string; reason?: string }>;
  mcp_suggestions_is_vague?: boolean;
  compacted_through_msg_id?: string | null;
  /** Frontend-only WS state, decoupled from session.status so reconnects don't fake terminal states. */
  connection_state?: 'live' | 'reconnecting';
  /** Aux-LLM verb-phrase for the current turn; ThinkingBubble swaps in then back when turn ends. */
  turn_label?: { label: string; turn_id: string } | null;
}

export interface AgentConfig {
  name?: string;
  provider?: string;
  model?: string;
  mode?: string;
  system_prompt?: string;
  allowed_tools?: string[];
  max_turns?: number;
  target_directory?: string;
  dashboard_id?: string;
}

export interface HistorySession {
  id: string;
  name: string;
  status: string;
  model: string;
  mode: string;
  created_at: string;
  closed_at: string | null;
  cost_usd: number;
  dashboard_id?: string;
}

interface HistorySearchState {
  results: HistorySession[];
  total: number;
  hasMore: boolean;
  query: string;
  loading: boolean;
}

interface AgentsState {
  sessions: Record<string, AgentSession>;
  history: Record<string, HistorySession>;
  activeSessionId: string | null;
  expandedSessionIds: string[];
  loading: boolean;
  historySearch: HistorySearchState;
  trackedNotificationIds: string[];
  // Draft session id => real backend id; bound components find their session without leaking activeSessionId.
  draftLaunchMap: Record<string, string>;
}

const initialState: AgentsState = {
  sessions: {},
  history: {},
  activeSessionId: null,
  expandedSessionIds: [],
  loading: false,
  historySearch: { results: [], total: 0, hasMore: false, query: '', loading: false },
  trackedNotificationIds: [],
  draftLaunchMap: {},
};

export const fetchSessions = createAsyncThunk(
  'agents/fetchSessions',
  async ({ dashboardId }: { dashboardId?: string } = {}) => {
    const params = new URLSearchParams();
    if (dashboardId) params.set('dashboard_id', dashboardId);
    const qs = params.toString();
    const res = await fetch(`${AGENTS_API}/sessions${qs ? `?${qs}` : ''}`);
    const data = await res.json();
    return data.sessions as AgentSession[];
  },
);

export const launchAgent = createAsyncThunk('agents/launchAgent', async (config: AgentConfig) => {
  const res = await fetch(`${AGENTS_API}/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const data = await res.json();
  return data.session as AgentSession;
});

export interface SendMessagePayload {
  sessionId: string;
  prompt: string;
  mode?: string;
  model?: string;
  provider?: string;
  images?: Array<{ data: string; media_type: string }>;
  contextPaths?: Array<{ path: string; type: 'file' | 'directory' }>;
  forcedTools?: string[];
  attachedSkills?: Array<{ id: string; name: string; content: string }>;
  hidden?: boolean;
  selectedBrowserIds?: string[];
}

function _genOptimisticId(): string {
  return `opt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const sendMessage = createAsyncThunk(
  'agents/sendMessage',
  async ({ sessionId, prompt, mode, model, provider, images, contextPaths, forcedTools, attachedSkills, hidden, selectedBrowserIds }: SendMessagePayload, { dispatch }) => {
    // Mint client id and dispatch optimistic bubble before awaiting the network; id round-trips for echo dedupe.
    const clientMessageId = _genOptimisticId();
    dispatch(addOptimisticMessage({
      sessionId,
      clientMessageId,
      prompt,
      contextPaths,
      forcedTools,
      attachedSkills: attachedSkills?.map((s) => ({ id: s.id, name: s.name })),
      images: images?.map((img) => ({ data: img.data, media_type: img.media_type })),
      hidden: hidden ?? false,
    }));
    try {
      const res = await fetch(`${AGENTS_API}/sessions/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, mode, model, provider, images, context_paths: contextPaths, forced_tools: forcedTools, attached_skills: attachedSkills, hidden, selected_browser_ids: selectedBrowserIds, client_message_id: clientMessageId }),
      });
      if (!res.ok) throw new Error(`send failed: ${res.status}`);
    } catch (err) {
      dispatch(markOptimisticFailed({ sessionId, clientMessageId }));
      throw err;
    }
    return { sessionId, prompt, clientMessageId };
  }
);

export const stopAgent = createAsyncThunk(
  'agents/stopAgent',
  async ({ sessionId, removeWorktree = false }: { sessionId: string; removeWorktree?: boolean }) => {
    await fetch(`${AGENTS_API}/sessions/${sessionId}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remove_worktree: removeWorktree }),
    });
    return sessionId;
  }
);

export const editMessage = createAsyncThunk(
  'agents/editMessage',
  async ({ sessionId, messageId, content }: { sessionId: string; messageId: string; content: string }) => {
    await fetch(`${AGENTS_API}/sessions/${sessionId}/edit_message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_id: messageId, content }),
    });
    return { sessionId, messageId, content };
  }
);

export const switchBranch = createAsyncThunk(
  'agents/switchBranch',
  async ({ sessionId, branchId }: { sessionId: string; branchId: string }) => {
    await fetch(`${AGENTS_API}/sessions/${sessionId}/switch_branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch_id: branchId }),
    });
    return { sessionId, branchId };
  }
);

export interface LaunchAndSendPayload {
  draftId: string;
  config: AgentConfig;
  prompt: string;
  mode: string;
  model: string;
  provider?: string;
  images?: Array<{ data: string; media_type: string }>;
  contextPaths?: Array<{ path: string; type: 'file' | 'directory' }>;
  forcedTools?: string[];
  attachedSkills?: Array<{ id: string; name: string; content: string }>;
  expand?: boolean;
  selectedBrowserIds?: string[];
}

export const fetchSession = createAsyncThunk(
  'agents/fetchSession',
  async (sessionId: string, { rejectWithValue }) => {
    const res = await fetch(`${AGENTS_API}/sessions/${sessionId}`);
    if (!res.ok) {
      // 404: rehydrating a deleted/crashed session; structured reject lets .rejected purge state.
      return rejectWithValue({ sessionId, status: res.status });
    }
    const session = await res.json();
    return session as AgentSession;
  }
);

export const launchAndSendFirstMessage = createAsyncThunk(
  'agents/launchAndSendFirstMessage',
  async ({ draftId, config, prompt, mode, model, provider, images, contextPaths, forcedTools, attachedSkills, selectedBrowserIds }: LaunchAndSendPayload) => {
    const launchRes = await fetch(`${AGENTS_API}/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    const launchData = await launchRes.json();
    const session = launchData.session as AgentSession;

    await fetch(`${AGENTS_API}/sessions/${session.id}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, mode, model, provider, images, context_paths: contextPaths, forced_tools: forcedTools, attached_skills: attachedSkills, selected_browser_ids: selectedBrowserIds }),
    });

    const refreshRes = await fetch(`${AGENTS_API}/sessions/${session.id}`);
    const updatedSession = await refreshRes.json() as AgentSession;

    return { draftId, session: updatedSession };
  }
);

export const generateTitle = createAsyncThunk(
  'agents/generateTitle',
  async ({ sessionId, prompt }: { sessionId: string; prompt: string }) => {
    const res = await fetch(`${AGENTS_API}/sessions/${sessionId}/generate-title`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    return { sessionId, title: data.title as string };
  }
);

export interface GenerateGroupMetaPayload {
  sessionId: string;
  groupId: string;
  toolCalls: Array<{ tool: string; input_summary: string }>;
  resultsSummary?: string[];
  isRefinement?: boolean;
}

export const generateGroupMeta = createAsyncThunk(
  'agents/generateGroupMeta',
  async ({ sessionId, groupId, toolCalls, resultsSummary, isRefinement }: GenerateGroupMetaPayload) => {
    const res = await fetch(`${AGENTS_API}/sessions/${sessionId}/generate-group-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group_id: groupId,
        tool_calls: toolCalls,
        results_summary: resultsSummary,
        is_refinement: isRefinement ?? false,
      }),
    });
    const data = await res.json();
    return { sessionId, groupId, name: data.name as string, svg: data.svg as string, isRefined: data.is_refined as boolean };
  }
);

export const updateSystemPrompt = createAsyncThunk(
  'agents/updateSystemPrompt',
  async ({ sessionId, systemPrompt }: { sessionId: string; systemPrompt: string }) => {
    await fetch(`${AGENTS_API}/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_prompt: systemPrompt }),
    });
    return { sessionId, systemPrompt };
  }
);

export const updateThinkingLevel = createAsyncThunk(
  'agents/updateThinkingLevel',
  async ({ sessionId, level }: { sessionId: string; level: 'off' | 'low' | 'medium' | 'high' | 'auto' }) => {
    await fetch(`${AGENTS_API}/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thinking_level: level }),
    });
    return { sessionId, level };
  }
);

export const handleApproval = createAsyncThunk(
  'agents/handleApproval',
  async ({
    requestId,
    behavior,
    message,
    updatedInput,
    trustPattern,
  }: {
    requestId: string;
    behavior: 'allow' | 'deny';
    message?: string;
    updatedInput?: Record<string, any>;
    trustPattern?: boolean;
  }) => {
    const res = await fetch(`${AGENTS_API}/approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, behavior, message, updated_input: updatedInput, trust_pattern: !!trustPattern }),
    });
    if (!res.ok) {
      throw new Error(`Approval request failed (${res.status})`);
    }
    return { requestId, behavior };
  }
);

export const closeSession = createAsyncThunk(
  'agents/closeSession',
  async ({ sessionId }: { sessionId: string }) => {
    await fetch(`${AGENTS_API}/sessions/${sessionId}/close`, { method: 'POST' });
    return sessionId;
  }
);

export const duplicateSession = createAsyncThunk(
  'agents/duplicateSession',
  async ({ sessionId, dashboardId, upToMessageId }: { sessionId: string; dashboardId?: string; upToMessageId?: string }) => {
    const res = await fetch(`${AGENTS_API}/sessions/${sessionId}/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dashboard_id: dashboardId, up_to_message_id: upToMessageId }),
    });
    if (!res.ok) throw new Error('Failed to duplicate session');
    const data = await res.json();
    return data.session as AgentSession;
  }
);

export const deleteSession = createAsyncThunk(
  'agents/deleteSession',
  async ({ sessionId }: { sessionId: string }) => {
    await fetch(`${AGENTS_API}/sessions/${sessionId}`, { method: 'DELETE' });
    return sessionId;
  }
);

export const fetchHistory = createAsyncThunk(
  'agents/fetchHistory',
  async ({ dashboardId }: { dashboardId?: string } = {}) => {
    const params = new URLSearchParams({ limit: '10000' });
    if (dashboardId) params.set('dashboard_id', dashboardId);
    const res = await fetch(`${AGENTS_API}/history?${params}`);
    const data = await res.json();
    return data.sessions as HistorySession[];
  },
);

export interface SearchHistoryParams {
  q?: string;
  limit?: number;
  offset?: number;
  dashboardId?: string;
}

export const searchHistory = createAsyncThunk(
  'agents/searchHistory',
  async ({ q = '', limit = 20, offset = 0, dashboardId }: SearchHistoryParams) => {
    const params = new URLSearchParams({ q, limit: String(limit), offset: String(offset) });
    if (dashboardId) params.set('dashboard_id', dashboardId);
    const res = await fetch(`${AGENTS_API}/history?${params}`);
    const data = await res.json();
    return {
      sessions: data.sessions as HistorySession[],
      total: data.total as number,
      hasMore: data.has_more as boolean,
      query: q,
      offset,
    };
  }
);

export const resumeSession = createAsyncThunk(
  'agents/resumeSession',
  async ({ sessionId }: { sessionId: string }) => {
    const res = await fetch(`${AGENTS_API}/sessions/${sessionId}/resume`, { method: 'POST' });
    const data = await res.json();
    return data.session as AgentSession;
  }
);

export const fetchBrowserAgentChildren = createAsyncThunk(
  'agents/fetchBrowserAgentChildren',
  async (parentSessionId: string) => {
    const res = await fetch(`${AGENTS_API}/sessions/${parentSessionId}/browser-agents`);
    const data = await res.json();
    return data.sessions as AgentSession[];
  }
);

const agentsSlice = createSlice({
  name: 'agents',
  initialState,
  reducers: {
    createDraftSession: {
      reducer(state, action: PayloadAction<{ draftId: string; mode: string; setActive: boolean; targetDirectory?: string; model?: string; provider?: string; thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'auto' }>) {
        const { draftId, mode, setActive, targetDirectory, model, provider, thinkingLevel } = action.payload;
        state.sessions[draftId] = {
          id: draftId,
          name: 'New chat',
          status: 'draft',
          provider: provider || 'anthropic',
          model: model || 'sonnet',
          mode,
          worktree_path: null,
          branch_name: null,
          sdk_session_id: null,
          system_prompt: null,
          allowed_tools: [],
          max_turns: null,
          created_at: new Date().toISOString(),
          cost_usd: 0,
          tokens: { input: 0, output: 0 },
          messages: [],
          pending_approvals: [],
          branches: { main: { id: 'main', parent_branch_id: null, fork_point_message_id: null, created_at: new Date().toISOString() } },
          active_branch_id: 'main',
          target_directory: targetDirectory || null,
          tool_group_meta: {},
          thinking_level: thinkingLevel,
        };
        if (setActive) {
          state.activeSessionId = draftId;
          if (!state.expandedSessionIds.includes(draftId)) {
            state.expandedSessionIds.push(draftId);
          }
        }
      },
      prepare(opts?: { mode?: string; setActive?: boolean; targetDirectory?: string; model?: string; provider?: string; thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'auto' }) {
        return {
          payload: {
            draftId: `draft-${Date.now().toString(36)}`,
            mode: opts?.mode || 'agent',
            setActive: opts?.setActive !== false,
            targetDirectory: opts?.targetDirectory,
            model: opts?.model,
            provider: opts?.provider,
            thinkingLevel: opts?.thinkingLevel,
          },
        };
      },
    },

    setActiveSession(state, action: PayloadAction<string | null>) {
      state.activeSessionId = action.payload;
    },

    clearSessionMessages(state, action: PayloadAction<string>) {
      const session = state.sessions[action.payload];
      if (session) {
        session.messages = [];
      }
    },

    toggleExpandSession(state, action: PayloadAction<string>) {
      const idx = state.expandedSessionIds.indexOf(action.payload);
      if (idx >= 0) {
        state.expandedSessionIds.splice(idx, 1);
      } else {
        state.expandedSessionIds.push(action.payload);
      }
    },

    expandSession(state, action: PayloadAction<string>) {
      if (!state.expandedSessionIds.includes(action.payload)) {
        state.expandedSessionIds.push(action.payload);
      }
    },

    collapseSession(state, action: PayloadAction<string>) {
      state.expandedSessionIds = state.expandedSessionIds.filter((id) => id !== action.payload);
    },

    collapseAllSessions(state) {
      state.expandedSessionIds = [];
    },

    setExpandedSessionIds(state, action: PayloadAction<string[]>) {
      state.expandedSessionIds = action.payload;
    },

    updateSessionName(state, action: PayloadAction<{ sessionId: string; name: string }>) {
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        session.name = action.payload.name;
      }
    },

    updateGroupMeta(
      state,
      action: PayloadAction<{ sessionId: string; groupId: string; name: string; svg: string; isRefined: boolean }>
    ) {
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

    setDraftSystemPrompt(state, action: PayloadAction<{ sessionId: string; systemPrompt: string }>) {
      const session = state.sessions[action.payload.sessionId];
      if (session && session.status === 'draft') {
        session.system_prompt = action.payload.systemPrompt;
      }
    },

    updateSession(state, action: PayloadAction<AgentSession>) {
      if (state.history[action.payload.id]) {
        if (action.payload.status === 'running' || action.payload.mode === 'browser-agent') {
          delete state.history[action.payload.id];
        } else {
          return;
        }
      }
      const existing = state.sessions[action.payload.id];
      // Don't let stale "running" overwrite terminal status.
      const terminal = ['stopped', 'error'] as const;
      if (existing && terminal.includes(existing.status as any) && action.payload.status === 'running') {
        return;
      }
      // Preserve local pending_approvals when server payload has none (race on removal).
      const mergedApprovals = existing?.pending_approvals?.length && !action.payload.pending_approvals?.length
        ? existing.pending_approvals
        : action.payload.pending_approvals ?? [];
      state.sessions[action.payload.id] = {
        ...action.payload,
        pending_approvals: mergedApprovals,
        tool_group_meta: { ...existing?.tool_group_meta, ...action.payload.tool_group_meta },
      };
      if (action.payload.status === 'running' && !state.trackedNotificationIds.includes(action.payload.id)) {
        state.trackedNotificationIds.push(action.payload.id);
      }
    },

    updateSessionStatus(
      state,
      action: PayloadAction<{ sessionId: string; status: AgentSession['status'] }>
    ) {
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        const terminal = ['stopped', 'error'] as const;
        if (terminal.includes(session.status as any) && action.payload.status === 'running') {
          return;
        }
        session.status = action.payload.status;
      }
      if (action.payload.status === 'running' && !state.trackedNotificationIds.includes(action.payload.sessionId)) {
        state.trackedNotificationIds.push(action.payload.sessionId);
      }
    },

    setSessionConnState(
      state,
      action: PayloadAction<{ sessionId: string; state: 'live' | 'reconnecting' }>
    ) {
      // Transient WS state, decoupled from session.status so blips don't mask the agent lifecycle.
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        session.connection_state = action.payload.state;
      }
    },

    addMessage(state, action: PayloadAction<{ sessionId: string; message: AgentMessage }>) {
      const session = state.sessions[action.payload.sessionId];
      if (!session) return;
      const incoming = action.payload.message;
      // Optimistic-bubble dedupe by client_message_id.
      if (incoming.client_message_id) {
        const optIdx = session.messages.findIndex(
          (m) => m.client_message_id === incoming.client_message_id && m.optimistic_status === 'pending',
        );
        if (optIdx >= 0) {
          session.messages[optIdx] = { ...incoming, optimistic_status: undefined };
          return;
        }
      }
      const idx = session.messages.findIndex((m) => m.id === incoming.id);
      if (idx >= 0) {
        session.messages[idx] = incoming;
      } else {
        session.messages.push(incoming);
      }
    },

    // Synchronous "you sent a message" placeholder; client_message_id round-trips for echo dedupe.
    addOptimisticMessage(
      state,
      action: PayloadAction<{
        sessionId: string;
        clientMessageId: string;
        prompt: string;
        contextPaths?: Array<{ path: string; type: 'file' | 'directory' }>;
        forcedTools?: string[];
        attachedSkills?: Array<{ id: string; name: string }>;
        images?: Array<{ data: string; media_type: string }>;
        hidden?: boolean;
      }>,
    ) {
      const { sessionId, clientMessageId, prompt, contextPaths, forcedTools, attachedSkills, images, hidden } = action.payload;
      const session = state.sessions[sessionId];
      if (!session) return;
      // Hidden messages (e.g. internal continuation prompts) skip the optimistic bubble.
      if (hidden) return;
      session.messages.push({
        id: clientMessageId,
        role: 'user',
        content: prompt,
        timestamp: new Date().toISOString(),
        branch_id: session.active_branch_id,
        parent_id: null,
        context_paths: contextPaths,
        attached_skills: attachedSkills,
        forced_tools: forcedTools,
        images,
        client_message_id: clientMessageId,
        optimistic_status: 'pending',
      });
    },

    markOptimisticFailed(
      state,
      action: PayloadAction<{ sessionId: string; clientMessageId: string }>,
    ) {
      const session = state.sessions[action.payload.sessionId];
      if (!session) return;
      const msg = session.messages.find(
        (m) => m.client_message_id === action.payload.clientMessageId && m.optimistic_status === 'pending',
      );
      if (msg) msg.optimistic_status = 'failed';
    },

    // Mirror compacted_through_msg_id from agent:context_status so the renderer can drop a chip.
    recordCompaction(
      state,
      action: PayloadAction<{ sessionId: string; throughMsgId: string | null }>,
    ) {
      const session = state.sessions[action.payload.sessionId];
      if (!session) return;
      session.compacted_through_msg_id = action.payload.throughMsgId;
    },

    // Aux-LLM turn label; pill renderer prefers this over the static "Thinking..." verb.
    setTurnLabel(
      state,
      action: PayloadAction<{ sessionId: string; turnId: string; label: string }>,
    ) {
      const session = state.sessions[action.payload.sessionId];
      if (!session) return;
      session.turn_label = { label: action.payload.label, turn_id: action.payload.turnId };
    },

    clearTurnLabel(state, action: PayloadAction<string>) {
      const session = state.sessions[action.payload];
      if (!session) return;
      session.turn_label = null;
    },

    // streamStart/Delta/End live in streamingSlice; keeps sessions dict stable during streaming.

    addApprovalRequest(
      state,
      action: PayloadAction<{ sessionId: string; request: ApprovalRequest }>
    ) {
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        const exists = session.pending_approvals.some((r) => r.id === action.payload.request.id);
        if (!exists) {
          session.pending_approvals.push(action.payload.request);
        }
        session.status = 'waiting_approval';
      }
    },

    removeApprovalRequest(
      state,
      action: PayloadAction<{ sessionId: string; requestId: string }>
    ) {
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        session.pending_approvals = session.pending_approvals.filter(
          (r) => r.id !== action.payload.requestId
        );
        if (session.pending_approvals.length === 0 && session.status === 'waiting_approval') {
          session.status = 'running';
        }
      }
    },

    updateSessionCost(
      state,
      action: PayloadAction<{ sessionId: string; costUsd: number }>
    ) {
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        session.cost_usd = action.payload.costUsd;
      }
    },

    updateSessionContext(
      state,
      action: PayloadAction<{
        sessionId: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheReadPct: number;
        ctxUsedPct: number;
        activeMcps: string[];
      }>
    ) {
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        session.tokens = {
          ...(session.tokens || {}),
          input: action.payload.inputTokens,
          output: action.payload.outputTokens,
        };
        session.cache_read_tokens = action.payload.cacheReadTokens;
        session.cache_read_pct = action.payload.cacheReadPct;
        session.ctx_used_pct = action.payload.ctxUsedPct;
        session.active_mcps = action.payload.activeMcps;
      }
    },

    setContextOverflow(
      state,
      action: PayloadAction<{
        sessionId: string;
        reason: string;
        message: string;
      }>
    ) {
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        session.context_overflow = {
          reason: action.payload.reason,
          message: action.payload.message,
          at: new Date().toISOString(),
        };
      }
    },

    clearContextOverflow(
      state,
      action: PayloadAction<{ sessionId: string }>
    ) {
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        session.context_overflow = null;
      }
    },

    setMcpSuggestions(
      state,
      action: PayloadAction<{
        sessionId: string;
        suggestions: Array<{ id: string; title: string; description: string; reason?: string }>;
        isVague: boolean;
      }>
    ) {
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        session.mcp_suggestions = action.payload.suggestions;
        session.mcp_suggestions_is_vague = action.payload.isVague;
      }
    },

    clearMcpSuggestions(
      state,
      action: PayloadAction<{ sessionId: string }>
    ) {
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        session.mcp_suggestions = [];
      }
    },

    addBranch(state, action: PayloadAction<{ sessionId: string; branch: MessageBranch }>) {
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        session.branches[action.payload.branch.id] = action.payload.branch;
      }
    },

    setActiveBranch(state, action: PayloadAction<{ sessionId: string; branchId: string }>) {
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        session.active_branch_id = action.payload.branchId;
      }
    },

    updateSessionProvider(state, action: PayloadAction<{ sessionId: string; provider: string }>) {
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        session.provider = action.payload.provider;
      }
    },

    updateSessionModel(state, action: PayloadAction<{ sessionId: string; model: string }>) {
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        session.model = action.payload.model;
      }
    },

    updateSessionMode(state, action: PayloadAction<{ sessionId: string; mode: string }>) {
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        session.mode = action.payload.mode;
      }
    },

    updateSessionThinkingLevel(state, action: PayloadAction<{ sessionId: string; level: 'off' | 'low' | 'medium' | 'high' | 'auto' }>) {
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        session.thinking_level = action.payload.level;
      }
    },

    closeSessionFromWs(state, action: PayloadAction<HistorySession>) {
      const entry = action.payload;
      state.history[entry.id] = entry;

      const session = state.sessions[entry.id];
      if (session?.mode === 'browser-agent' && session.parent_session_id) {
        session.status = (entry.status as AgentSession['status']) || 'completed';
      } else {
        delete state.sessions[entry.id];
        for (const [id, s] of Object.entries(state.sessions)) {
          if (s.mode === 'browser-agent' && s.parent_session_id === entry.id) {
            s.status = 'stopped';
          }
        }
      }

      if (state.activeSessionId === entry.id) {
        state.activeSessionId = null;
      }
      state.expandedSessionIds = state.expandedSessionIds.filter((id) => id !== entry.id);
    },

    removeDraftSession(state, action: PayloadAction<string>) {
      const id = action.payload;
      const session = state.sessions[id];
      if (session?.status === 'draft') {
        delete state.sessions[id];
        if (state.activeSessionId === id) {
          state.activeSessionId = null;
        }
        state.expandedSessionIds = state.expandedSessionIds.filter((eid) => eid !== id);
      }
    },

    clearHistorySearch(state) {
      state.historySearch = { results: [], total: 0, hasMore: false, query: '', loading: false };
    },

    trackAgentNotification(state, action: PayloadAction<string>) {
      if (!state.trackedNotificationIds.includes(action.payload)) {
        state.trackedNotificationIds.push(action.payload);
      }
    },

    dismissAgentNotification(state, action: PayloadAction<string>) {
      state.trackedNotificationIds = state.trackedNotificationIds.filter(
        (id) => id !== action.payload,
      );
    },

    dismissAllFinishedNotifications(state) {
      const finishedStatuses = new Set(['completed', 'error', 'stopped']);
      state.trackedNotificationIds = state.trackedNotificationIds.filter((id) => {
        const session = state.sessions[id];
        if (session) return !finishedStatuses.has(session.status);
        const hist = state.history[id];
        if (hist) return !finishedStatuses.has(hist.status);
        return true;
      });
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchSessions.pending, (state) => {
        state.loading = true;
      })
      .addCase(fetchSessions.fulfilled, (state, action) => {
        state.loading = false;
        const fetchedIds = new Set(action.payload.map((s) => s.id));
        const activeStatuses = new Set(['running', 'waiting_approval']);

        // Strip stale fetched sessions; keep other dashboards, drafts, tracked, and active sessions.
        for (const [id, existing] of Object.entries(state.sessions)) {
          if (fetchedIds.has(id)) continue;
          if (existing.status === 'draft') continue;
          if (state.trackedNotificationIds.includes(id)) continue;
          if (activeStatuses.has(existing.status)) continue;
          delete state.sessions[id];
        }

        // Merge fetched sessions, preserving local-only fields
        for (const s of action.payload) {
          const existing = state.sessions[s.id];
          state.sessions[s.id] = {
            ...s,
            pending_approvals: existing?.pending_approvals?.length
              ? existing.pending_approvals
              : s.pending_approvals ?? [],
            tool_group_meta: { ...existing?.tool_group_meta, ...s.tool_group_meta },
            mcp_suggestions: existing?.mcp_suggestions ?? [],
            mcp_suggestions_is_vague: existing?.mcp_suggestions_is_vague ?? false,
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
        state.sessions[action.payload.id] = { ...action.payload, tool_group_meta: action.payload.tool_group_meta ?? {} };
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
        state.sessions[session.id] = { ...session, tool_group_meta: session.tool_group_meta ?? {} };
        state.activeSessionId = session.id;
        state.draftLaunchMap[draftId] = session.id;
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
        if (session) {
          session.name = action.payload.title;
        }
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
        if (session) {
          session.system_prompt = action.payload.systemPrompt;
        }
      })
      .addCase(sendMessage.pending, (state, action) => {
        const session = state.sessions[action.meta.arg.sessionId];
        if (session) {
          session.status = 'running';
        }
      })
      .addCase(editMessage.pending, (state, action) => {
        const session = state.sessions[action.meta.arg.sessionId];
        if (session) {
          session.status = 'running';
        }
      })
      .addCase(stopAgent.fulfilled, (state, action) => {
        const session = state.sessions[action.payload];
        if (session) {
          session.status = 'stopped';
          session.pending_approvals = [];
          // streamingMessage cleanup is via clearStreamingForSession (not in streamingSlice's extraReducers).
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
        // Approval stays in state so the user can retry; request never reached the backend.
        console.error('Approval request failed:', action.error.message);
      })
      .addCase(switchBranch.fulfilled, (state, action) => {
        const session = state.sessions[action.payload.sessionId];
        if (session) {
          session.active_branch_id = action.payload.branchId;
        }
      })
      .addCase(duplicateSession.fulfilled, (state, action) => {
        const session = action.payload;
        state.sessions[session.id] = session;
      })
      .addCase(closeSession.fulfilled, (state, action) => {
        const sessionId = action.payload;
        const session = state.sessions[sessionId];
        if (session) {
          state.history[sessionId] = {
            id: session.id,
            name: session.name,
            status: session.status === 'running' || session.status === 'waiting_approval' ? 'stopped' : session.status,
            model: session.model,
            mode: session.mode,
            created_at: session.created_at,
            closed_at: new Date().toISOString(),
            cost_usd: session.cost_usd,
            dashboard_id: session.dashboard_id,
          };
        }
        delete state.sessions[sessionId];
        if (state.activeSessionId === sessionId) {
          state.activeSessionId = null;
        }
        state.expandedSessionIds = state.expandedSessionIds.filter((id) => id !== sessionId);
        state.trackedNotificationIds = state.trackedNotificationIds.filter((id) => id !== sessionId);
      })
      .addCase(closeSession.rejected, (state, action) => {
        const sessionId = action.meta.arg.sessionId;
        const session = state.sessions[sessionId];
        if (session) {
          state.history[sessionId] = {
            id: session.id,
            name: session.name,
            status: session.status === 'running' || session.status === 'waiting_approval' ? 'stopped' : session.status,
            model: session.model,
            mode: session.mode,
            created_at: session.created_at,
            closed_at: new Date().toISOString(),
            cost_usd: session.cost_usd,
            dashboard_id: session.dashboard_id,
          };
        }
        delete state.sessions[sessionId];
        if (state.activeSessionId === sessionId) {
          state.activeSessionId = null;
        }
        state.expandedSessionIds = state.expandedSessionIds.filter((id) => id !== sessionId);
        state.trackedNotificationIds = state.trackedNotificationIds.filter((id) => id !== sessionId);
      })
      .addCase(deleteSession.fulfilled, (state, action) => {
        const sessionId = action.payload;
        delete state.history[sessionId];
        delete state.sessions[sessionId];
        if (state.activeSessionId === sessionId) {
          state.activeSessionId = null;
        }
        state.expandedSessionIds = state.expandedSessionIds.filter((id) => id !== sessionId);
        state.trackedNotificationIds = state.trackedNotificationIds.filter((id) => id !== sessionId);
      })
      .addCase(fetchHistory.fulfilled, (state, action) => {
        const history: Record<string, HistorySession> = {};
        for (const s of action.payload) {
          history[s.id] = s;
        }
        state.history = history;
      })
      .addCase(resumeSession.fulfilled, (state, action) => {
        const session = action.payload;
        state.sessions[session.id] = { ...session, tool_group_meta: session.tool_group_meta ?? {} };
        delete state.history[session.id];
        state.activeSessionId = session.id;
        if (!state.expandedSessionIds.includes(session.id)) {
          state.expandedSessionIds.push(session.id);
        }
        // Pin across the next fetchSessions strip so an in-flight fetch can't drop the just-resumed session.
        if (!state.trackedNotificationIds.includes(session.id)) {
          state.trackedNotificationIds.push(session.id);
        }
      })
      .addCase(fetchSession.fulfilled, (state, action) => {
        const session = action.payload;
        const existing = state.sessions[session.id];
        state.sessions[session.id] = {
          ...session,
          pending_approvals: session.pending_approvals ?? existing?.pending_approvals ?? [],
          tool_group_meta: session.tool_group_meta ?? existing?.tool_group_meta ?? {},
          // mcp_suggestions live in client state only (the backend never
          // returns them in the session payload). Preserve them across
          // refresh so the suggestion banner stays put until the user
          // dismisses it or activates one.
          mcp_suggestions: existing?.mcp_suggestions ?? [],
          mcp_suggestions_is_vague: existing?.mcp_suggestions_is_vague ?? false,
        };
      })
      .addCase(fetchSession.rejected, (state, action) => {
        // Stale-id cleanup on 404/410: strip so AgentChat short-circuits instead of looping the dead fetch.
        const payload = action.payload as { sessionId?: string; status?: number } | undefined;
        const sessionId = payload?.sessionId;
        if (!sessionId) return;
        if (payload?.status === 404 || payload?.status === 410) {
          delete state.sessions[sessionId];
          if (state.activeSessionId === sessionId) {
            state.activeSessionId = null;
          }
          state.expandedSessionIds = state.expandedSessionIds.filter((id) => id !== sessionId);
          state.trackedNotificationIds = state.trackedNotificationIds.filter((id) => id !== sessionId);
        }
      })
      .addCase(fetchBrowserAgentChildren.fulfilled, (state, action) => {
        for (const session of action.payload) {
          if (!state.sessions[session.id]) {
            state.sessions[session.id] = {
              ...session,
              tool_group_meta: session.tool_group_meta ?? {},
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
  },
});

export const {
  createDraftSession,
  setActiveSession,
  clearSessionMessages,
  toggleExpandSession,
  expandSession,
  collapseSession,
  collapseAllSessions,
  setExpandedSessionIds,
  updateSessionName,
  updateGroupMeta,
  setDraftSystemPrompt,
  updateSession,
  updateSessionStatus,
  setSessionConnState,
  addMessage,
  addOptimisticMessage,
  markOptimisticFailed,
  recordCompaction,
  setTurnLabel,
  clearTurnLabel,
  addApprovalRequest,
  removeApprovalRequest,
  updateSessionCost,
  updateSessionContext,
  setContextOverflow,
  clearContextOverflow,
  setMcpSuggestions,
  clearMcpSuggestions,
  addBranch,
  setActiveBranch,
  updateSessionProvider,
  updateSessionModel,
  updateSessionMode,
  updateSessionThinkingLevel,
  closeSessionFromWs,
  removeDraftSession,
  clearHistorySearch,
  trackAgentNotification,
  dismissAgentNotification,
  dismissAllFinishedNotifications,
} = agentsSlice.actions;

export default agentsSlice.reducer;
