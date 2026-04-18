import { API_BASE } from '@/shared/routes/base';

const SETTINGS_API: string = `${API_BASE}/settings`;

export const SETTINGS_GET_API: string = SETTINGS_API;
export const SETTINGS_UPDATE_API: string = SETTINGS_API;
export const SETTINGS_RESET_SYSTEM_PROMPT_API: string = `${SETTINGS_API}/reset-system-prompt`;
