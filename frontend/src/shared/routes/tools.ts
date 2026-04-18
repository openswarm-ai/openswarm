import { API_BASE } from '@/shared/routes/base';

const TOOLS_API: string = `${API_BASE}/tools`;

export const TOOLS_BUILTIN_API: string = `${TOOLS_API}/builtin`;
export const TOOLS_BUILTIN_PERMISSIONS_API: string = `${TOOLS_API}/builtin/permissions`;
export const TOOLS_LIST_API: string = `${TOOLS_API}/list`;
export const TOOLS_CREATE_API: string = `${TOOLS_API}/create`;
export const TOOLS_GET_API: (toolId: string) => string = (toolId: string) => `${TOOLS_API}/${toolId}`;
export const TOOLS_UPDATE_API: (toolId: string) => string = (toolId: string) => `${TOOLS_API}/${toolId}`;
export const TOOLS_DELETE_API: (toolId: string) => string = (toolId: string) => `${TOOLS_API}/${toolId}`;
export const TOOLS_DISCOVER_API: (toolId: string) => string = (toolId: string) => `${TOOLS_API}/${toolId}/discover`;
export const TOOLS_LOAD_USER_TOOLKIT_API: string = `${TOOLS_API}/load_user_toolkit`;
export const TOOLS_OAUTH_CALLBACK_API: string = `${TOOLS_API}/oauth/callback`;
export const TOOLS_OAUTH_START_API: (toolId: string) => string = (toolId: string) => `${TOOLS_API}/${toolId}/oauth/start`;
export const TOOLS_OAUTH_DISCONNECT_API: (toolId: string) => string = (toolId: string) => `${TOOLS_API}/${toolId}/oauth/disconnect`;
