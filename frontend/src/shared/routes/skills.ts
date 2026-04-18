import { API_BASE } from '@/shared/routes/base';

const SKILLS_API: string = `${API_BASE}/skills`;

export const SKILLS_LIST_API: string = `${SKILLS_API}/list`;
export const SKILLS_WORKSPACE_API: (workspaceId: string) => string = (workspaceId: string) => `${SKILLS_API}/workspace/${workspaceId}`;
export const SKILLS_WORKSPACE_SEED_API: string = `${SKILLS_API}/workspace/seed`;
export const SKILLS_DETAIL_API: (skillId: string) => string = (skillId: string) => `${SKILLS_API}/detail/${skillId}`;
export const SKILLS_CREATE_API: string = `${SKILLS_API}/create`;
export const SKILLS_UPDATE_API: (skillId: string) => string = (skillId: string) => `${SKILLS_API}/${skillId}`;
export const SKILLS_DELETE_API: (skillId: string) => string = (skillId: string) => `${SKILLS_API}/${skillId}`;

export const SKILLS_REGISTRY_STATS_API: string = `${SKILLS_API}/registry/stats`;
export const SKILLS_REGISTRY_SEARCH_API: string = `${SKILLS_API}/registry/search`;
export const SKILLS_REGISTRY_DETAIL_API: (skillName: string) => string = (skillName: string) => `${SKILLS_API}/registry/detail/${skillName}`;
