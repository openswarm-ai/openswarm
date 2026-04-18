import { createSlice } from '@reduxjs/toolkit';
import {
  LIST_APPS,
  CREATE_APP,
  UPDATE_APP,
  DELETE_APP,
  GET_APP,
} from '@/shared/backend-bridge/apps/app_builder';
import type { App } from '@/shared/backend-bridge/apps/app_builder';

interface AppsState {
  items: Record<string, App>;
  loading: boolean;
  loaded: boolean;
}

const initialState: AppsState = {
  items: {},
  loading: false,
  loaded: false,
};

const appsSlice = createSlice({
  name: 'apps',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(LIST_APPS.pending, (state) => {
        state.loading = true;
      })
      .addCase(LIST_APPS.fulfilled, (state, action) => {
        state.loading = false;
        state.loaded = true;
        const items: Record<string, App> = {};
        for (const a of action.payload.apps) {
          items[a.id] = a;
        }
        state.items = items;
      })
      .addCase(LIST_APPS.rejected, (state) => {
        state.loading = false;
        state.loaded = true;
      })
      .addCase(CREATE_APP.fulfilled, (state, action) => {
        state.items[action.payload.id] = action.payload;
      })
      .addCase(UPDATE_APP.fulfilled, (state, action) => {
        const a = action.payload;
        if (a?.id) {
          state.items[a.id] = { ...state.items[a.id], ...a };
        }
      })
      .addCase(DELETE_APP.fulfilled, (state, action) => {
        delete state.items[action.payload];
      })
      .addCase(GET_APP.fulfilled, (state, action) => {
        const a = action.payload;
        if (a?.id) {
          state.items[a.id] = a;
        }
      });
  },
});

export default appsSlice.reducer;
