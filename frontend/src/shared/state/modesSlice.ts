import { createSlice } from '@reduxjs/toolkit';
import {
  LIST_MODES,
  CREATE_MODE,
  UPDATE_MODE,
  RESET_MODE,
  DELETE_MODE,
} from '@/shared/backend-bridge/apps/modes';
import type { Mode } from '@/shared/backend-bridge/apps/modes';

export type { Mode };
export { LIST_MODES, CREATE_MODE, UPDATE_MODE, RESET_MODE, DELETE_MODE };

interface ModesState {
  items: Record<string, Mode>;
  builtinDefaults: Record<string, Mode>;
  loading: boolean;
  loaded: boolean;
}

const initialState: ModesState = { items: {}, builtinDefaults: {}, loading: false, loaded: false };

const modesSlice = createSlice({
  name: 'modes',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(LIST_MODES.pending, (state) => { state.loading = true; })
      .addCase(LIST_MODES.fulfilled, (state, action) => {
        state.loading = false;
        state.loaded = true;
        state.items = {};
        for (const m of action.payload.modes) state.items[m.id] = m;
        state.builtinDefaults = action.payload.builtin_defaults;
      })
      .addCase(LIST_MODES.rejected, (state) => { state.loading = false; state.loaded = true; })
      .addCase(CREATE_MODE.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(UPDATE_MODE.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(RESET_MODE.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(DELETE_MODE.fulfilled, (state, action) => { delete state.items[action.payload]; });
  },
});

export default modesSlice.reducer;
