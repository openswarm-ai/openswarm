import { createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/backend/base_routes';

const HEALTH_API: string = `${API_BASE}/health`;

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------


const check_health_endpoint: string = `${HEALTH_API}/check`;
async function check_health_function(): Promise<string> {
  const res = await fetch(check_health_endpoint, {
    method: 'GET',
  });
  const text = await res.text();
  return text;
}
export const CHECK_HEALTH = createAsyncThunk(
  check_health_endpoint,
  check_health_function,
);
