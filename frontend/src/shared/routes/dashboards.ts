import { API_BASE } from '@/shared/routes/base';

const DASHBOARDS_API: string = `${API_BASE}/dashboards`;

export const DASHBOARDS_LIST_API: string = `${DASHBOARDS_API}/list`;
export const DASHBOARDS_CREATE_API: string = `${DASHBOARDS_API}/create`;
export const DASHBOARDS_GET_API: (dashboardId: string) => string = (dashboardId: string) => `${DASHBOARDS_API}/${dashboardId}`;
export const DASHBOARDS_UPDATE_API: (dashboardId: string) => string = (dashboardId: string) => `${DASHBOARDS_API}/${dashboardId}`;
export const DASHBOARDS_DELETE_API: (dashboardId: string) => string = (dashboardId: string) => `${DASHBOARDS_API}/${dashboardId}`;
export const DASHBOARDS_DUPLICATE_API: (dashboardId: string) => string = (dashboardId: string) => `${DASHBOARDS_API}/${dashboardId}/duplicate`;
export const DASHBOARDS_GENERATE_NAME_API: (dashboardId: string) => string = (dashboardId: string) => `${DASHBOARDS_API}/${dashboardId}/generate-name`;
