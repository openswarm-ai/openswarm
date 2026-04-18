export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system';
  content: any;
  timestamp: string;
  branch_id: string;
  parent_id: string | null;
  context_paths?: Array<{ path: string; type: string }>;
  attached_skills?: Array<{ id: string; name: string }>;
  forced_tools?: string[];
  images?: Array<{ data: string; media_type: string }>;
  hidden?: boolean;
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
  role: 'assistant' | 'tool_call';
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

export interface ContextPath {
  path: string;
  type: 'file' | 'directory';
}

export interface SendMessagePayload {
  sessionId: string;
  prompt: string;
  mode?: string;
  model?: string;
  provider?: string;
  images?: Array<{ data: string; media_type: string }>;
  contextPaths?: Array<ContextPath>;
  forcedTools?: string[];
  attachedSkills?: Array<{ id: string; name: string; content: string }>;
  hidden?: boolean;
  selectedBrowserIds?: string[];
}

export interface LaunchAndSendPayload {
  draftId: string;
  config: AgentConfig;
  prompt: string;
  mode: string;
  model: string;
  provider?: string;
  images?: Array<{ data: string; media_type: string }>;
  contextPaths?: Array<ContextPath>;
  forcedTools?: string[];
  attachedSkills?: Array<{ id: string; name: string; content: string }>;
  expand?: boolean;
  selectedBrowserIds?: string[];
}

export interface GenerateGroupMetaPayload {
  sessionId: string;
  groupId: string;
  toolCalls: Array<{ tool: string; input_summary: string }>;
  resultsSummary?: string[];
  isRefinement?: boolean;
}

export interface SearchHistoryParams {
  q?: string;
  limit?: number;
  offset?: number;
  dashboardId?: string;
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

export interface HistorySearchState {
  results: HistorySession[];
  total: number;
  hasMore: boolean;
  query: string;
  loading: boolean;
}

export interface AgentsState {
  sessions: Record<string, AgentSession>;
  history: Record<string, HistorySession>;
  activeSessionId: string | null;
  expandedSessionIds: string[];
  loading: boolean;
  historySearch: HistorySearchState;
  trackedNotificationIds: string[];
}

export const initialState: AgentsState = {
  sessions: {},
  history: {},
  activeSessionId: null,
  expandedSessionIds: [],
  loading: false,
  historySearch: { results: [], total: 0, hasMore: false, query: '', loading: false },
  trackedNotificationIds: [],
};
