import { createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/backend/base_routes';

const SKILLS_API: string = `${API_BASE}/skills`;

// ---------------------------------------------------------------------------
// Local skill CRUD
// ---------------------------------------------------------------------------


const list_skills_endpoint: string = `${SKILLS_API}/list`;
async function list_skills_function(): Promise<Record<string, unknown>[]> {
  const res = await fetch(list_skills_endpoint, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data.skills as Record<string, unknown>[];
}
export const LIST_SKILLS = createAsyncThunk(
  list_skills_endpoint,
  list_skills_function,
);


const read_skill_workspace_endpoint: string = `${SKILLS_API}/workspace`;
async function read_skill_workspace_function(workspaceId: string): Promise<{ skill_content: string | null; meta: Record<string, unknown> | null; frontmatter: Record<string, unknown> }> {
  const res = await fetch(`${SKILLS_API}/workspace/${workspaceId}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { skill_content: string | null; meta: Record<string, unknown> | null; frontmatter: Record<string, unknown> };
}
export const READ_SKILL_WORKSPACE = createAsyncThunk(
  read_skill_workspace_endpoint,
  read_skill_workspace_function,
);


const seed_skill_workspace_endpoint: string = `${SKILLS_API}/workspace/seed`;
async function seed_skill_workspace_function(body: {
  workspace_id: string;
  skill_content?: string | null;
  meta?: Record<string, unknown> | null;
}): Promise<{ path: string }> {
  const res = await fetch(seed_skill_workspace_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data as { path: string };
}
export const SEED_SKILL_WORKSPACE = createAsyncThunk(
  seed_skill_workspace_endpoint,
  seed_skill_workspace_function,
);


const get_skill_endpoint: string = `${SKILLS_API}/detail`;
async function get_skill_function(skillId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${SKILLS_API}/detail/${skillId}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as Record<string, unknown>;
}
export const GET_SKILL = createAsyncThunk(
  get_skill_endpoint,
  get_skill_function,
);


const create_skill_endpoint: string = `${SKILLS_API}/create`;
async function create_skill_function(body: {
  name: string;
  description?: string;
  content: string;
  command?: string;
}): Promise<{ ok: boolean; skill: Record<string, unknown> }> {
  const res = await fetch(create_skill_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data as { ok: boolean; skill: Record<string, unknown> };
}
export const CREATE_SKILL = createAsyncThunk(
  create_skill_endpoint,
  create_skill_function,
);


const update_skill_endpoint: string = `${SKILLS_API}/update`;
async function update_skill_function(args: {
  skillId: string;
  name?: string;
  description?: string;
  content?: string;
  command?: string;
}): Promise<{ ok: boolean; skill: Record<string, unknown> }> {
  const { skillId, ...updates } = args;
  const res = await fetch(`${SKILLS_API}/${skillId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  const data = await res.json();
  return data as { ok: boolean; skill: Record<string, unknown> };
}
export const UPDATE_SKILL = createAsyncThunk(
  update_skill_endpoint,
  update_skill_function,
);


const delete_skill_endpoint: string = `${SKILLS_API}/delete`;
async function delete_skill_function(skillId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${SKILLS_API}/${skillId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { ok: boolean };
}
export const DELETE_SKILL = createAsyncThunk(
  delete_skill_endpoint,
  delete_skill_function,
);


// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------


const registry_stats_endpoint: string = `${SKILLS_API}/registry/stats`;
async function registry_stats_function(): Promise<{ total: number; categories: Record<string, number>; lastUpdated: string | null }> {
  const res = await fetch(registry_stats_endpoint, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { total: number; categories: Record<string, number>; lastUpdated: string | null };
}
export const REGISTRY_STATS = createAsyncThunk(
  registry_stats_endpoint,
  registry_stats_function,
);


const registry_search_endpoint: string = `${SKILLS_API}/registry/search`;
async function registry_search_function(params: {
  q?: string;
  limit?: number;
  offset?: number;
  sort?: string;
  category?: string;
}): Promise<{ skills: Record<string, unknown>[]; total: number; offset: number; limit: number }> {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));
  if (params.sort) query.set('sort', params.sort);
  if (params.category) query.set('category', params.category);
  const res = await fetch(`${registry_search_endpoint}?${query.toString()}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { skills: Record<string, unknown>[]; total: number; offset: number; limit: number };
}
export const REGISTRY_SEARCH = createAsyncThunk(
  registry_search_endpoint,
  registry_search_function,
);


const registry_detail_endpoint: string = `${SKILLS_API}/registry/detail`;
async function registry_detail_function(skillName: string): Promise<{ skill: Record<string, unknown> }> {
  const res = await fetch(`${SKILLS_API}/registry/detail/${skillName}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { skill: Record<string, unknown> };
}
export const REGISTRY_DETAIL = createAsyncThunk(
  registry_detail_endpoint,
  registry_detail_function,
);
