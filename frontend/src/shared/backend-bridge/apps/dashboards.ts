import { createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/backend-bridge/base_routes';

const DASHBOARDS_API: string = `${API_BASE}/dashboards`;

export interface DashboardLayout {
  cards?: Record<string, unknown>;
  view_cards?: Record<string, unknown>;
  browser_cards?: Record<string, unknown>;
  expanded_session_ids?: string[];
}

export interface Dashboard {
  id: string;
  name: string;
  auto_named: boolean;
  created_at: string;
  updated_at: string;
  thumbnail?: string | null;
  layout?: DashboardLayout;
}

// ---------------------------------------------------------------------------
// Dashboard CRUD
// ---------------------------------------------------------------------------


const list_dashboards_endpoint: string = `${DASHBOARDS_API}/list`;
async function list_dashboards_function(): Promise<Dashboard[]> {
  const res = await fetch(list_dashboards_endpoint, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data.dashboards as Dashboard[];
}
export const LIST_DASHBOARDS = createAsyncThunk(
  list_dashboards_endpoint,
  list_dashboards_function,
);


const create_dashboard_endpoint: string = `${DASHBOARDS_API}/create`;
async function create_dashboard_function(name: string = 'Untitled Dashboard'): Promise<Dashboard> {
  const res = await fetch(create_dashboard_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  return data as Dashboard;
}
export const CREATE_DASHBOARD = createAsyncThunk(
  create_dashboard_endpoint,
  create_dashboard_function,
);


const generate_dashboard_name_endpoint: string = `${DASHBOARDS_API}/generate-name`;
async function generate_dashboard_name_function(dashboardId: string): Promise<{ id: string; name: string; auto_named: boolean }> {
  const res = await fetch(`${DASHBOARDS_API}/${dashboardId}/generate-name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return { id: dashboardId, name: data.name as string, auto_named: data.auto_named as boolean };
}
export const GENERATE_DASHBOARD_NAME = createAsyncThunk(
  generate_dashboard_name_endpoint,
  generate_dashboard_name_function,
);


const get_dashboard_endpoint: string = `${DASHBOARDS_API}/get`;
async function get_dashboard_function(dashboardId: string): Promise<Dashboard> {
  const res = await fetch(`${DASHBOARDS_API}/${dashboardId}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as Dashboard;
}
export const GET_DASHBOARD = createAsyncThunk(
  get_dashboard_endpoint,
  get_dashboard_function,
);


const update_dashboard_endpoint: string = `${DASHBOARDS_API}/update`;
async function update_dashboard_function(args: {
  dashboardId: string;
  name?: string;
  layout?: Record<string, unknown>;
  thumbnail?: string;
}): Promise<Dashboard> {
  const { dashboardId, ...updates } = args;
  const res = await fetch(`${DASHBOARDS_API}/${dashboardId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`Dashboard update failed: ${res.status}`);
  const data = await res.json();
  return data as Dashboard;
}
export const UPDATE_DASHBOARD = createAsyncThunk(
  update_dashboard_endpoint,
  update_dashboard_function,
);


const delete_dashboard_endpoint: string = `${DASHBOARDS_API}/delete`;
async function delete_dashboard_function(dashboardId: string): Promise<string> {
  const res = await fetch(`${DASHBOARDS_API}/${dashboardId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  await res.json();
  return dashboardId;
}
export const DELETE_DASHBOARD = createAsyncThunk(
  delete_dashboard_endpoint,
  delete_dashboard_function,
);


const duplicate_dashboard_endpoint: string = `${DASHBOARDS_API}/duplicate`;
async function duplicate_dashboard_function(dashboardId: string): Promise<Dashboard> {
  const res = await fetch(`${DASHBOARDS_API}/${dashboardId}/duplicate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as Dashboard;
}
export const DUPLICATE_DASHBOARD = createAsyncThunk(
  duplicate_dashboard_endpoint,
  duplicate_dashboard_function,
);
