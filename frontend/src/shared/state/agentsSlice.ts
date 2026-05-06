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
  // Client-generated id used for optimistic-bubble dedupe. Set on the
  // optimistic message we synthesize in `sendMessage.pending` and on the
  // server echo (round-tripped via the POST body); the addMessage reducer
  // uses it to find and replace the optimistic placeholder.
  client_message_id?: string;
  // Frontend-only lifecycle marker for optimistic messages. 'pending' until
  // the server echo lands; 'failed' if the POST rejected. Confirmed messages
  // (i.e. ones echoed back from the server) drop this field entirely.
  optimistic_status?: 'pending' | 'failed';
  // Server-stamped duration (ms) and approximate token count for the
  // message's content. Today only thinking messages set these — the
  // persisted ThinkingBubble reads them so "Thought for Ns · M tokens"
  // survives reload instead of decaying to "Thoughts".
  elapsed_ms?: number;
  tokens?: number;
  // Server-stamped input-side token count for the turn (fresh
  // input + cache_creation + cache_read). Populated on thinking
  // messages so the pill can show "Thought for Ns · M in / K out"
  // — which is the only honest answer to "how big was this turn".
  input_tokens?: number;
  // tool count drives the "3 tools used" segment on the thinking pill.
  tool_count?: number;
}

export interface ApprovalRequest {
  id: string;
  session_id: string;
  tool_name: string;
  tool_input: Record<string, any>;
  created_at: string;
}

export interface MessageBranch {
  id: string;
  parent_branch_id: string | null;
  fork_point_message_id: string | null;
  created_at: string;
}

export interface StreamingMessage {
  id: string;
  role: 'assistant' | 'tool_call' | 'thinking';
  content: string;
  tool_name?: string;
}

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
  streamingMessage: StreamingMessage | null;
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
  active_outputs?: string[];
  compacted_through_msg_id?: string | null;
  // Transient frontend-only WS connection state. Independent of
  // `status` (which describes the agent run itself). When the WS
  // drops we set this to 'reconnecting' so the UI can render a
  // subtle indicator without faking a terminal status. Cleared back
  // to 'live' on resume_ack. Never persisted to the backend.
  connection_state?: 'live' | 'reconnecting';
  // Aux-LLM-generated verb-phrase describing what the model is doing
  // on the current turn ("Auditing the pull request", "Drafting your
  // email"). Set by agent:turn_label, scoped to the turn that produced
  // it via turn_id. ThinkingBubble swaps in this label as soon as it
  // arrives, then back to the heuristic when the turn ends.
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
}

const initialState: AgentsState = {
  sessions: {},
  history: {},
  activeSessionId: null,
  expandedSessionIds: [],
  loading: false,
  historySearch: { results: [], total: 0, hasMore: false, query: '', loading: false },
  trackedNotificationIds: [],
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
    // Generate an optimistic id up-front and dispatch the synchronous
    // bubble *before* awaiting the network. The reducer below
    // (sendMessage.pending) handles the same path, but doing it here
    // gives us access to the id we'll round-trip to the server for
    // dedupe on echo.
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
  async (sessionId: string) => {
    const res = await fetch(`${AGENTS_API}/sessions/${sessionId}`);
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
  }: {
    requestId: string;
    behavior: 'allow' | 'deny';
    message?: string;
    updatedInput?: Record<string, any>;
  }) => {
    const res = await fetch(`${AGENTS_API}/approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, behavior, message, updated_input: updatedInput }),
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
          streamingMessage: null,
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
      // Don't let a stale "running" message overwrite a terminal status
      const terminal = ['stopped', 'error'] as const;
      if (existing && terminal.includes(existing.status as any) && action.payload.status === 'running') {
        return;
      }
      // Preserve local pending_approvals if the server payload has none but
      // the frontend has some (avoids race where backend clears approvals
      // before the frontend processes the removal).
      const mergedApprovals = existing?.pending_approvals?.length && !action.payload.pending_approvals?.length
        ? existing.pending_approvals
        : action.payload.pending_approvals ?? [];
      state.sessions[action.payload.id] = {
        ...action.payload,
        pending_approvals: mergedApprovals,
        streamingMessage: existing?.streamingMessage ?? action.payload.streamingMessage ?? null,
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
      // Transient WS-layer indicator. Decoupled from session.status
      // so a network blip never masquerades as a run terminating —
      // status keeps reflecting the agent's actual lifecycle.
      const session = state.sessions[action.payload.sessionId];
      if (session) {
        session.connection_state = action.payload.state;
      }
    },

    addMessage(state, action: PayloadAction<{ sessionId: string; message: AgentMessage }>) {
      const session = state.sessions[action.payload.sessionId];
      if (!session) return;
      const incoming = action.payload.message;
      // Optimistic-bubble dedupe: if this echo carries a client_message_id
      // and we have an optimistic placeholder with the same id, replace it
      // with the server version (preserving server's id, dropping the
      // optimistic_status marker so the bubble renders as confirmed).
      if (incoming.client_message_id) {
        const optIdx = session.messages.findIndex(
          (m) => m.client_message_id === incoming.client_message_id && m.optimistic_status === 'pending',
        );
        if (optIdx >= 0) {
          session.messages[optIdx] = { ...incoming, optimistic_status: undefined };
          if (session.streamingMessage?.id === incoming.id) {
            session.streamingMessage = null;
          }
          return;
        }
      }
      const idx = session.messages.findIndex((m) => m.id === incoming.id);
      if (idx >= 0) {
        session.messages[idx] = incoming;
      } else {
        session.messages.push(incoming);
      }
      if (session.streamingMessage?.id === incoming.id) {
        session.streamingMessage = null;
      }
    },

    // Synchronous "you sent a message" bubble dispatched from the
    // sendMessage thunk before the network round-trip. The placeholder
    // carries a client_message_id which the server echo (agent:message)
    // will round-trip back; addMessage dedupes against it.
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
      // Hidden messages (e.g. continuation prompts the model fires
      // internally) shouldn't render an optimistic bubble.
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

    // Backend emits agent:context_status with reason="compacted" when the
    // auto-compaction routine collapses older turns into a summary. We
    // mirror compacted_through_msg_id locally so the renderer can drop a
    // chip in the transcript right after that message.
    recordCompaction(
      state,
      action: PayloadAction<{ sessionId: string; throughMsgId: string | null }>,
    ) {
      const session = state.sessions[action.payload.sessionId];
      if (!session) return;
      session.compacted_through_msg_id = action.payload.throughMsgId;
    },

    // Aux-LLM-generated turn label. The pill renderer prefers this over
    // the static "Thinking…" verb when present.
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

    streamStart(
      state,
      action: PayloadAction<{ sessionId: string; messageId: string; role: 'assistant' | 'tool_call' | 'thinking'; toolName?: string }>
    ) {
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

    streamDelta(
      state,
      action: PayloadAction<{ sessionId: string; messageId: string; delta: string }>
    ) {
      const session = state.sessions[action.payload.sessionId];
      if (session?.streamingMessage?.id === action.payload.messageId) {
        session.streamingMessage.content += action.payload.delta;
      }
    },

    streamEnd(
      state,
      action: PayloadAction<{ sessionId: string; messageId: string }>
    ) {
      const session = state.sessions[action.payload.sessionId];
      if (session?.streamingMessage?.id === action.payload.messageId) {
        session.streamingMessage = null;
      }
    },

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

        // Remove stale sessions that belong to this dashboard fetch but
        // are no longer returned by the server — keep sessions from other
        // dashboards, drafts, tracked notifications, and active sessions.
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
        // Approval stays in state so the user can retry.
        // The request was never delivered to the backend.
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
        state.sessions[session.id] = { ...session, streamingMessage: null, tool_group_meta: session.tool_group_meta ?? {} };
        delete state.history[session.id];
        state.activeSessionId = session.id;
        if (!state.expandedSessionIds.includes(session.id)) {
          state.expandedSessionIds.push(session.id);
        }
        // Keep this session pinned across the next fetchSessions strip.
        // Without this, an in-flight fetchSessions that returned before the
        // resume races with the resume reducer and removes the just-resumed
        // session (since closed/stopped sessions don't survive the strip
        // unless they're in trackedNotificationIds, drafts, or active).
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
          streamingMessage: existing?.streamingMessage ?? null,
          tool_group_meta: session.tool_group_meta ?? existing?.tool_group_meta ?? {},
        };
      })
      .addCase(fetchBrowserAgentChildren.fulfilled, (state, action) => {
        for (const session of action.payload) {
          if (!state.sessions[session.id]) {
            state.sessions[session.id] = {
              ...session,
              streamingMessage: null,
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
  streamStart,
  streamDelta,
  streamEnd,
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
