import { createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/backend-bridge/base_routes';
import type {
  AgentSession, HistorySession, LaunchAndSendPayload
} from '@/shared/state/agentsTypes';

const AGENTS_API: string = `${API_BASE}/agents`;

export const AGENTS_WS_API: string = `${API_BASE}/agents/ws`;

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------


const get_all_sessions_endpoint: string = `${AGENTS_API}/get_all_sessions`;
async function get_all_sessions_function(dashboardId?: string): Promise<AgentSession[]> {
  const url = dashboardId
    ? `${get_all_sessions_endpoint}?dashboard_id=${encodeURIComponent(dashboardId)}`
    : get_all_sessions_endpoint;
  const res = await fetch(url);
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
  return data as AgentSession;
}
export const GET_SESSION = createAsyncThunk(
  get_session_endpoint,
  get_session_function,
);



const launch_agent_endpoint: string = `${AGENTS_API}/launch_agent`;
async function launch_agent_function(config: {
  model: string;
  mode: string;
  system_prompt: string;
  max_turns: number;
  dashboard_id?: string;
}): Promise<{ session_id: string; session: AgentSession }> {
  const res = await fetch(launch_agent_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      mode: config.mode,
      system_prompt: config.system_prompt,
      max_turns: config.max_turns,
      dashboard_id: config.dashboard_id,
    }),
  });
  const data = await res.json();
  return data as { session_id: string; session: AgentSession };
}
export const LAUNCH_AGENT = createAsyncThunk(
  launch_agent_endpoint, 
  launch_agent_function,
);



const update_system_prompt_endpoint: string = `${AGENTS_API}/update_system_prompt`;
async function update_system_prompt_function(payload: {
  sessionId: string;
  systemPrompt: string;
}): Promise<{ sessionId: string; systemPrompt: string }> {
  const res = await fetch(update_system_prompt_endpoint, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: payload.sessionId, system_prompt: payload.systemPrompt }),
  });
  await res.json();
  return { sessionId: payload.sessionId, systemPrompt: payload.systemPrompt };
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
  await res.json();
  return sessionId;
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
  mode?: string;
  model?: string;
  images?: string[];
  imageMediaTypes?: string[];
  contextPaths?: Record<string, unknown>[];
  forcedTools?: string[];
  attachedSkills?: Record<string, unknown>[];
  hidden?: boolean;
}): Promise<{ ok: boolean }> {
  const res = await fetch(send_message_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      session_id: payload.sessionId,
      prompt: payload.prompt,
      mode: payload.mode ?? null,
      model: payload.model ?? null,
      images: payload.images ?? null,
      image_media_types: payload.imageMediaTypes ?? null,
      context_paths: payload.contextPaths ?? null,
      forced_tools: payload.forcedTools ?? null,
      attached_skills: payload.attachedSkills ?? null,
      hidden: payload.hidden ?? false,
    }),
  });
  const data = await res.json();
  return data as { ok: boolean };
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
  await res.json();
  return sessionId;
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
}): Promise<{ ok: boolean; branch_id: string; session_id: string }> {
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
  return data as { ok: boolean; branch_id: string; session_id: string };
}
export const EDIT_MESSAGE = createAsyncThunk(
  edit_message_endpoint,
  edit_message_function,
);


const switch_branch_endpoint: string = `${AGENTS_API}/switch_branch`;
async function switch_branch_function(payload: {
  sessionId: string;
  branchId: string;
}): Promise<{ sessionId: string; branchId: string }> {
  const res = await fetch(switch_branch_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: payload.sessionId, branch_id: payload.branchId }),
  });
  await res.json();
  return { sessionId: payload.sessionId, branchId: payload.branchId };
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
  await res.json();
  return sessionId;
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


// NOTE: is a duplicate endpoint even needed? Can't we just do this via branch?
const duplicate_session_endpoint: string = `${AGENTS_API}/duplicate_session`;
async function duplicate_session_function(sessionId: string): Promise<{ session: AgentSession }> {
  const res = await fetch(duplicate_session_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
  const data = await res.json();
  return data as { session: AgentSession };
}
export const DUPLICATE_SESSION = createAsyncThunk(
  duplicate_session_endpoint,
  duplicate_session_function
);



const get_history_endpoint: string = `${AGENTS_API}/get_history`;
async function get_history_function(payload: {
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<{ sessions: HistorySession[]; total: number; has_more: boolean }> {
  const res = await fetch(get_history_endpoint, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: payload.q ?? '',
      limit: payload.limit ?? 20,
      offset: payload.offset ?? 0,
    }),
  });
  const data = await res.json();
  return data as { sessions: HistorySession[]; total: number; has_more: boolean };
}
export const GET_HISTORY = createAsyncThunk(
  get_history_endpoint,
  get_history_function,
);



// ---------------------------------------------------------------------------
// Meta Functions (Not actual endpoints in the backend)
// ---------------------------------------------------------------------------



const meta_launch_and_send_endpoint: string = 'agents/meta_launch_and_send';
async function meta_launch_and_send_function(
  payload: LaunchAndSendPayload,
): Promise<{ draftId: string; session: AgentSession }> {
  console.log(`[FRONTEND] meta_launch_and_send: starting | draftId=${payload.draftId} model=${payload.model} mode=${payload.mode} dashboard_id=${payload.config.dashboard_id}`);
  const { session } = await launch_agent_function({
    model: payload.model,
    mode: payload.mode,
    system_prompt: payload.config.system_prompt ?? '',
    max_turns: payload.config.max_turns ?? 100,
    dashboard_id: payload.config.dashboard_id,
  });
  console.log(`[FRONTEND] meta_launch_and_send: launched | draftId=${payload.draftId} → realId=${session.session_id} status=${session.status} dashboard_id=${session.dashboard_id ?? 'NONE'}`);

  await send_message_function({
    sessionId: session.session_id,
    prompt: payload.prompt,
    mode: payload.mode,
    model: payload.model,
    images: payload.images?.map((img) => img.data),
    imageMediaTypes: payload.images?.map((img) => img.media_type),
    contextPaths: payload.contextPaths,
    forcedTools: payload.forcedTools,
    attachedSkills: payload.attachedSkills,
  });
  console.log(`[FRONTEND] meta_launch_and_send: message sent | session=${session.session_id}`);

  return { draftId: payload.draftId, session };
}
export const META_LAUNCH_AND_SEND = createAsyncThunk(
  meta_launch_and_send_endpoint,
  meta_launch_and_send_function,
);