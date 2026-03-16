import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

const DASHBOARDS_API = `${API_BASE}/dashboards`;

export interface Dashboard {
  id: string;
  name: string;
  auto_named: boolean;
  created_at: string;
  updated_at: string;
  thumbnail?: string | null;
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
  const res = await fetch(`${DASHBOARDS_API}/list`);
  const data = await res.json();
  return data.dashboards as Dashboard[];
});

export const createDashboard = createAsyncThunk(
  'dashboards/create',
  async (name: string) => {
    const res = await fetch(`${DASHBOARDS_API}/create`, {
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
    const res = await fetch(`${DASHBOARDS_API}/${id}`, {
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
    await fetch(`${DASHBOARDS_API}/${id}`, { method: 'DELETE' });
    return id;
  },
);

export const duplicateDashboard = createAsyncThunk(
  'dashboards/duplicate',
  async (id: string) => {
    const res = await fetch(`${DASHBOARDS_API}/${id}/duplicate`, { method: 'POST' });
    return (await res.json()) as Dashboard;
  },
);

export const updateDashboardThumbnail = createAsyncThunk(
  'dashboards/updateThumbnail',
  async ({ id, thumbnail }: { id: string; thumbnail: string }) => {
    const res = await fetch(`${DASHBOARDS_API}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thumbnail }),
    });
    if (!res.ok) throw new Error(`Thumbnail update failed: ${res.status}`);
    const data = await res.json();
    return { id, thumbnail: data.thumbnail as string | null, updated_at: data.updated_at as string };
  },
);

export const generateDashboardName = createAsyncThunk(
  'dashboards/generateName',
  async (dashboardId: string) => {
    const res = await fetch(`${DASHBOARDS_API}/${dashboardId}/generate-name`, {
      method: 'POST',
    });
    const data = await res.json();
    return { id: dashboardId, name: data.name as string, auto_named: data.auto_named as boolean };
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
          state.items[d.id] = {
            ...state.items[d.id],
            name: d.name,
            auto_named: d.auto_named ?? false,
            updated_at: d.updated_at,
          };
        }
      })
      .addCase(deleteDashboard.fulfilled, (state, action) => {
        delete state.items[action.payload];
      })
      .addCase(duplicateDashboard.fulfilled, (state, action) => {
        state.items[action.payload.id] = action.payload;
      })
      .addCase(generateDashboardName.fulfilled, (state, action) => {
        const { id, name, auto_named } = action.payload;
        if (state.items[id]) {
          state.items[id].name = name;
          state.items[id].auto_named = auto_named;
        }
      })
      .addCase(updateDashboardThumbnail.fulfilled, (state, action) => {
        const { id, thumbnail, updated_at } = action.payload;
        if (state.items[id]) {
          state.items[id].thumbnail = thumbnail;
          state.items[id].updated_at = updated_at;
        }
      });
  },
});

export default dashboardsSlice.reducer;
