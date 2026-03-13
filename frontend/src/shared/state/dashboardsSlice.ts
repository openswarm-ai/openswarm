import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';

const API_BASE = `http://${window.location.hostname}:8324/api/dashboards`;

export interface Dashboard {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface DashboardsState {
  items: Record<string, Dashboard>;
  loading: boolean;
}

const initialState: DashboardsState = {
  items: {},
  loading: false,
};

export const fetchDashboards = createAsyncThunk('dashboards/fetchAll', async () => {
  const res = await fetch(`${API_BASE}/list`);
  const data = await res.json();
  return data.dashboards as Dashboard[];
});

export const createDashboard = createAsyncThunk(
  'dashboards/create',
  async (name: string) => {
    const res = await fetch(`${API_BASE}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return (await res.json()) as Dashboard;
  },
);

export const renameDashboard = createAsyncThunk(
  'dashboards/rename',
  async ({ id, name }: { id: string; name: string }) => {
    const res = await fetch(`${API_BASE}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return (await res.json()) as Dashboard;
  },
);

export const deleteDashboard = createAsyncThunk(
  'dashboards/delete',
  async (id: string) => {
    await fetch(`${API_BASE}/${id}`, { method: 'DELETE' });
    return id;
  },
);

export const duplicateDashboard = createAsyncThunk(
  'dashboards/duplicate',
  async (id: string) => {
    const res = await fetch(`${API_BASE}/${id}/duplicate`, { method: 'POST' });
    return (await res.json()) as Dashboard;
  },
);

const dashboardsSlice = createSlice({
  name: 'dashboards',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchDashboards.pending, (state) => {
        state.loading = true;
      })
      .addCase(fetchDashboards.fulfilled, (state, action) => {
        state.loading = false;
        const items: Record<string, Dashboard> = {};
        for (const d of action.payload) {
          items[d.id] = d;
        }
        state.items = items;
      })
      .addCase(fetchDashboards.rejected, (state) => {
        state.loading = false;
      })
      .addCase(createDashboard.fulfilled, (state, action) => {
        state.items[action.payload.id] = action.payload;
      })
      .addCase(renameDashboard.fulfilled, (state, action) => {
        const d = action.payload;
        if (state.items[d.id]) {
          state.items[d.id] = { ...state.items[d.id], name: d.name, updated_at: d.updated_at };
        }
      })
      .addCase(deleteDashboard.fulfilled, (state, action) => {
        delete state.items[action.payload];
      })
      .addCase(duplicateDashboard.fulfilled, (state, action) => {
        state.items[action.payload.id] = action.payload;
      });
  },
});

export default dashboardsSlice.reducer;
