import { createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/backend/base_routes';
import type {
  AgentSession, AgentConfig, HistorySession,
} from '@/shared/state/agentsTypes';

const AGENTS_API: string = `${API_BASE}/agents`;

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------


const get_all_sessions_endpoint: string = `${AGENTS_API}/get_all_sessions`;
async function get_all_sessions_function(dashboardId?: string): Promise<AgentSession[]> {
  const params = new URLSearchParams();
  if (dashboardId) params.set('dashboard_id', dashboardId);
  const res = await fetch(get_all_sessions_endpoint, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ params }),
  });
  const data = await res.json();
  return data.sessions as AgentSession[];
}
export const GET_ALL_SESSIONS = createAsyncThunk(
  get_all_sessions_endpoint,
  get_all_sessions_function,
);



const get_session_endpoint: string = `${AGENTS_API}/get_session`;
async function get_session_function(sessionId: string): Promise<AgentSession> {
  const res = await fetch(get_session_endpoint, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
  const data = await res.json();
  return data.session as AgentSession;
}
export const GET_SESSION = createAsyncThunk(
  get_session_endpoint,
  get_session_function,
);



const launch_agent_endpoint: string = `${AGENTS_API}/launch_agent`;
async function launch_agent_function(config: AgentConfig): Promise<AgentSession> {
  const res = await fetch(launch_agent_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const data = await res.json();
  return data.session as AgentSession;
}
export const LAUNCH_AGENT = createAsyncThunk(
  launch_agent_endpoint, 
  launch_agent_function,
);



const update_system_prompt_endpoint: string = `${AGENTS_API}/update_system_prompt`;
async function update_system_prompt_function(payload: {
  sessionId: string;
  systemPrompt: string;
}): Promise<string> {
  const res = await fetch(update_system_prompt_endpoint, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: payload.sessionId, system_prompt: payload.systemPrompt }),
  });
  const data = await res.json();
  return data.ok as string;
}
export const UPDATE_SYSTEM_PROMPT = createAsyncThunk(
  update_system_prompt_endpoint,
  update_system_prompt_function,
);



const delete_session_endpoint: string = `${AGENTS_API}/delete_session`;
async function delete_session_function(sessionId: string): Promise<string> {
  const res = await fetch(delete_session_endpoint, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
  const data = await res.json();
  return data.sessionId as string;
}
export const DELETE_SESSION = createAsyncThunk(
  delete_session_endpoint,
  delete_session_function
);



// ---------------------------------------------------------------------------
// Agent lifecycle
// ---------------------------------------------------------------------------



const send_message_endpoint: string = `${AGENTS_API}/send_message`;
async function send_message_function(payload: {
  sessionId: string;
  prompt: string;
  mode: string;
  model: string;
  provider: string;
  images: string[];
  contextPaths: string[];
  forcedTools: string[];
  attachedSkills: string[];
  hidden: boolean;
  selectedBrowserIds: string[];
}): Promise<AgentSession> {
  const res = await fetch(send_message_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      session_id: payload.sessionId,
      prompt: payload.prompt,
      mode: payload.mode,
      model: payload.model,
      provider: payload.provider,
      images: payload.images,
      context_paths: payload.contextPaths,
      forced_tools: payload.forcedTools,
      attached_skills: payload.attachedSkills,
      hidden: payload.hidden,
      selected_browser_ids: payload.selectedBrowserIds,
    }),
  });
  const data = await res.json();
  return data.session as AgentSession;
}
export const SEND_MESSAGE = createAsyncThunk(
  send_message_endpoint,
  send_message_function,
);



const stop_agent_endpoint: string = `${AGENTS_API}/stop_agent`;
async function stop_agent_function(sessionId: string): Promise<string> {
  const res = await fetch(stop_agent_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
  const data = await res.json();
  return data.sessionId as string;
}
export const STOP_AGENT = createAsyncThunk(
  stop_agent_endpoint,
  stop_agent_function,
);



const handle_approval_endpoint: string = `${AGENTS_API}/handle_approval`;
async function handle_approval_function(payload: {
  requestId: string;
  behavior: 'allow' | 'deny';
  message?: string;
  updatedInput?: Record<string, unknown>;
}): Promise<{ requestId: string; behavior: 'allow' | 'deny' }> {
  const res = await fetch(handle_approval_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      request_id: payload.requestId, 
      behavior: payload.behavior, 
      message: payload.message, 
      updated_input: payload.updatedInput,
    }),
  });
  if (!res.ok) throw new Error(`Approval request failed (${res.status})`);
  return { requestId: payload.requestId, behavior: payload.behavior };
}
export const HANDLE_APPROVAL = createAsyncThunk(
  handle_approval_endpoint,
  handle_approval_function
);



// ---------------------------------------------------------------------------
// Branching
// ---------------------------------------------------------------------------




const edit_message_endpoint: string = `${AGENTS_API}/edit_message`;
async function edit_message_function(payload: {
  sessionId: string;
  messageId: string;
  content: string;
}): Promise<AgentSession> {
  const res = await fetch(edit_message_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      session_id: payload.sessionId, 
      message_id: payload.messageId, 
      content: payload.content,
    }),
  });
  const data = await res.json();
  return data.session as AgentSession;
}
export const EDIT_MESSAGE = createAsyncThunk(
  edit_message_endpoint,
  edit_message_function,
);


const switch_branch_endpoint: string = `${AGENTS_API}/switch_branch`;
async function switch_branch_function(payload: {
  sessionId: string;
  branchId: string;
}): Promise<AgentSession> {
  const res = await fetch(switch_branch_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: payload.sessionId, branch_id: payload.branchId }),
  });
  const data = await res.json();
  return data.session as AgentSession;
}
export const SWITCH_BRANCH = createAsyncThunk(
  switch_branch_endpoint,
  switch_branch_function,
);



// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------



const close_session_endpoint: string = `${AGENTS_API}/close_session`;
async function close_session_function(sessionId: string): Promise<string> {
  const res = await fetch(close_session_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
  const data = await res.json();
  return data.sessionId as string;
}
export const CLOSE_SESSION = createAsyncThunk(
  close_session_endpoint,
  close_session_function
);



const resume_session_endpoint: string = `${AGENTS_API}/resume_session`;
async function resume_session_function(sessionId: string): Promise<AgentSession> {
  const res = await fetch(resume_session_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
  const data = await res.json();
  return data.session as AgentSession;
}
export const RESUME_SESSION = createAsyncThunk(
  resume_session_endpoint,
  resume_session_function
);



const duplicate_session_endpoint: string = `${AGENTS_API}/duplicate_session`;
async function duplicate_session_function(payload: {
  sessionId: string;
  dashboardId: string;
  upToMessageId: string;
}): Promise<AgentSession> {
  const res = await fetch(duplicate_session_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      session_id: payload.sessionId, 
      dashboard_id: payload.dashboardId, 
      up_to_message_id: payload.upToMessageId,
    }),
  });
  const data = await res.json();
  return data.session as AgentSession;
}
export const DUPLICATE_SESSION = createAsyncThunk(
  duplicate_session_endpoint,
  duplicate_session_function
);



const get_history_endpoint: string = `${AGENTS_API}/get_history`;
async function get_history_function(payload: {
  q: string;
  limit: number;
  offset: number;
}): Promise<HistorySession[]> {
  const res = await fetch(get_history_endpoint, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: payload.q, limit: payload.limit, offset: payload.offset }),
  });
  const data = await res.json();
  return data.sessions as HistorySession[];
}
export const GET_HISTORY = createAsyncThunk(
  get_history_endpoint,
  get_history_function,
);