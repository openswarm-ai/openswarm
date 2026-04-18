import { API_BASE } from '@/shared/routes/base';

const MODES_API: string = `${API_BASE}/modes`;

export const MODES_LIST_API: string = `${MODES_API}/list`;
export const MODES_GET_API: (modeId: string) => string = (modeId: string) => `${MODES_API}/${modeId}`;
export const MODES_CREATE_API: string = `${MODES_API}/create`;
export const MODES_UPDATE_API: (modeId: string) => string = (modeId: string) => `${MODES_API}/${modeId}`;
export const MODES_RESET_API: (modeId: string) => string = (modeId: string) => `${MODES_API}/${modeId}/reset`;
export const MODES_DELETE_API: (modeId: string) => string = (modeId: string) => `${MODES_API}/${modeId}`;
export const MODES_GET_BY_ID_API: string = `${MODES_API}/get_mode_by_id`;
