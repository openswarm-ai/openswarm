import { API_BASE, WS_BASE } from '@/shared/routes/base';

const AGENTS_API: string = `${API_BASE}/agents`;

export const AGENTS_WS: string = `${WS_BASE}/api/agents/ws/dashboard`;

export const AGENTS_SESSIONS_API: string = `${AGENTS_API}/SESSIONS`;
export const AGENTS_SESSION_API: (sessionId: string) => string = (sessionId: string) => `${AGENTS_API}/sessions/${sessionId}`;
export const AGENTS_LAUNCH_API: string = `${AGENTS_API}/launch`;
export const AGENTS_UPDATE_SESSION_API: (sessionId: string) => string = (sessionId: string) => `${AGENTS_API}/SESSIONS/${sessionId}`;
export const AGENTS_MESSAGE_API: (sessionId: string) => string = (sessionId: string) => `${AGENTS_API}/SESSIONS/${sessionId}/message`;
export const AGENTS_STOP_API: (sessionId: string) => string = (sessionId: string) => `${AGENTS_API}/sessions/${sessionId}/stop`;
export const AGENTS_APPROVAL_API: string = `${AGENTS_API}/approval`;
export const AGENTS_EDIT_MESSAGE_API: (sessionId: string) => string = (sessionId: string) => `${AGENTS_API}/sessions/${sessionId}/edit_message`;
export const AGENTS_SWITCH_BRANCH_API: (sessionId: string) => string = (sessionId: string) => `${AGENTS_API}/SESSIONS/${sessionId}/switch_branch`;
export const AGENTS_CLOSE_API: (sessionId: string) => string = (sessionId: string) => `${AGENTS_API}/sessions/${sessionId}/close`;
export const AGENTS_RESUME_API: (sessionId: string) => string = (sessionId: string) => `${AGENTS_API}/SESSIONS/${sessionId}/resume`;
export const AGENTS_DUPLICATE_API: (sessionId: string) => string = (sessionId: string) => `${AGENTS_API}/SESSIONS/${sessionId}/duplicate`;
export const AGENTS_HISTORY_API: string = `${AGENTS_API}/history`;
