import { API_BASE } from '@/shared/routes/base';

const APP_BUILDER_API: string = `${API_BASE}/app_builder`;

export const APP_BUILDER_SOURCE_FILE_API: (appId: string, filepath: string) => string = (appId: string, filepath: string) => `${APP_BUILDER_API}/app/${appId}/source_dir/${filepath}`;
export const APP_BUILDER_SERVE_API: (appId: string, filepath: string) => string = (appId: string, filepath: string) => `${APP_BUILDER_API}/${appId}/serve/${filepath}`;
export const APP_BUILDER_READ_APP_API: (appId: string) => string = (appId: string) => `${APP_BUILDER_API}/app/${appId}`;
export const APP_BUILDER_SEED_API: string = `${APP_BUILDER_API}/app/seed`;
export const APP_BUILDER_FILE_API: (appId: string, filepath: string) => string = (appId: string, filepath: string) => `${APP_BUILDER_API}/app/${appId}/file/${filepath}`;
export const APP_BUILDER_LIST_API: string = `${APP_BUILDER_API}/list`;
export const APP_BUILDER_GET_API: (appId: string) => string = (appId: string) => `${APP_BUILDER_API}/${appId}`;
export const APP_BUILDER_CREATE_API: string = `${APP_BUILDER_API}/create`;
export const APP_BUILDER_UPDATE_API: (appId: string) => string = (appId: string) => `${APP_BUILDER_API}/${appId}`;
export const APP_BUILDER_DELETE_API: (appId: string) => string = (appId: string) => `${APP_BUILDER_API}/${appId}`;
export const APP_BUILDER_EXECUTE_API: string = `${APP_BUILDER_API}/execute`;
