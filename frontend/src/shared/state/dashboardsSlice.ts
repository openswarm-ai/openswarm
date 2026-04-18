import { createSlice } from '@reduxjs/toolkit';
import {
  LIST_DASHBOARDS,
  CREATE_DASHBOARD,
  UPDATE_DASHBOARD,
  DELETE_DASHBOARD,
  DUPLICATE_DASHBOARD,
  GENERATE_DASHBOARD_NAME,
} from '@/shared/backend-bridge/apps/dashboards';
import type { Dashboard } from '@/shared/backend-bridge/apps/dashboards';

export type { Dashboard };

interface DashboardsState {
  items: Record<string, Dashboard>;
  loading: boolean;
}

const initialState: DashboardsState = {
  items: {},
  loading: false,
};

const dashboardsSlice = createSlice({
  name: 'dashboards',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(LIST_DASHBOARDS.pending, (state) => {
        state.loading = true;
      })
      .addCase(LIST_DASHBOARDS.fulfilled, (state, action) => {
        state.loading = false;
        const items: Record<string, Dashboard> = {};
        for (const d of action.payload) {
          items[d.id] = d;
        }
        state.items = items;
      })
      .addCase(LIST_DASHBOARDS.rejected, (state) => {
        state.loading = false;
      })
      .addCase(CREATE_DASHBOARD.fulfilled, (state, action) => {
        state.items[action.payload.id] = action.payload;
      })
      .addCase(UPDATE_DASHBOARD.fulfilled, (state, action) => {
        const d = action.payload;
        if (state.items[d.id]) {
          state.items[d.id] = { ...state.items[d.id], ...d };
        }
      })
      .addCase(DELETE_DASHBOARD.fulfilled, (state, action) => {
        delete state.items[action.payload];
      })
      .addCase(DUPLICATE_DASHBOARD.fulfilled, (state, action) => {
        state.items[action.payload.id] = action.payload;
      })
      .addCase(GENERATE_DASHBOARD_NAME.fulfilled, (state, action) => {
        const { id, name, auto_named } = action.payload;
        if (state.items[id]) {
          state.items[id].name = name;
          state.items[id].auto_named = auto_named;
        }
      });
  },
});

export default dashboardsSlice.reducer;
