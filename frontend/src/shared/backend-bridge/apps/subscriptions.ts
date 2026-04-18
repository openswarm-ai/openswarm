import { createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/backend-bridge/base_routes';

const SUBSCRIPTIONS_API: string = `${API_BASE}/subscriptions`;

// ---------------------------------------------------------------------------
// Subscription management
// ---------------------------------------------------------------------------


const subscriptions_status_endpoint: string = `${SUBSCRIPTIONS_API}/status`;
async function subscriptions_status_function(): Promise<{ running: boolean; providers: unknown[]; models: unknown[] }> {
  const res = await fetch(subscriptions_status_endpoint, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { running: boolean; providers: unknown[]; models: unknown[] };
}
export const SUBSCRIPTIONS_STATUS = createAsyncThunk(
  subscriptions_status_endpoint,
  subscriptions_status_function,
);


const subscriptions_connect_endpoint: string = `${SUBSCRIPTIONS_API}/connect`;
async function subscriptions_connect_function(provider: string): Promise<Record<string, unknown>> {
  const res = await fetch(subscriptions_connect_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  });
  const data = await res.json();
  return data as Record<string, unknown>;
}
export const SUBSCRIPTIONS_CONNECT = createAsyncThunk(
  subscriptions_connect_endpoint,
  subscriptions_connect_function,
);


const subscriptions_poll_endpoint: string = `${SUBSCRIPTIONS_API}/poll`;
async function subscriptions_poll_function(body: {
  provider: string;
  device_code: string;
  code_verifier?: string;
  extra_data?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const res = await fetch(subscriptions_poll_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data as Record<string, unknown>;
}
export const SUBSCRIPTIONS_POLL = createAsyncThunk(
  subscriptions_poll_endpoint,
  subscriptions_poll_function,
);


const subscriptions_disconnect_endpoint: string = `${SUBSCRIPTIONS_API}/disconnect`;
async function subscriptions_disconnect_function(provider: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(subscriptions_disconnect_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  });
  const data = await res.json();
  return data as { ok: boolean; error?: string };
}
export const SUBSCRIPTIONS_DISCONNECT = createAsyncThunk(
  subscriptions_disconnect_endpoint,
  subscriptions_disconnect_function,
);


const subscriptions_pending_endpoint: string = `${SUBSCRIPTIONS_API}/pending`;
async function subscriptions_pending_function(state: string): Promise<{ provider: string; code_verifier: string; redirect_uri: string }> {
  const res = await fetch(`${SUBSCRIPTIONS_API}/pending/${state}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { provider: string; code_verifier: string; redirect_uri: string };
}
export const SUBSCRIPTIONS_PENDING = createAsyncThunk(
  subscriptions_pending_endpoint,
  subscriptions_pending_function,
);


const subscriptions_callback_endpoint: string = `${SUBSCRIPTIONS_API}/callback`;
async function subscriptions_callback_function(params: {
  code?: string;
  state?: string;
  error?: string;
}): Promise<string> {
  const query = new URLSearchParams();
  if (params.code) query.set('code', params.code);
  if (params.state) query.set('state', params.state);
  if (params.error) query.set('error', params.error);
  const res = await fetch(`${subscriptions_callback_endpoint}?${query.toString()}`, {
    method: 'GET',
  });
  const html = await res.text();
  return html;
}
export const SUBSCRIPTIONS_CALLBACK = createAsyncThunk(
  subscriptions_callback_endpoint,
  subscriptions_callback_function,
);
