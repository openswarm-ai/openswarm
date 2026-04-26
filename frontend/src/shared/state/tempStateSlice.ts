// store/tempStateSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface TempState {
  temp_state: string | null;
  pendingBrowserUrl: string | null;
  pendingFocusAgentId: string | null;
  lastDashboardId: string | null;
}

const initialState: TempState = {
  temp_state: null,
  pendingBrowserUrl: null,
  pendingFocusAgentId: null,
  lastDashboardId: null,
};

const tempStateSlice = createSlice({
  name: 'tempState',
  initialState,
  reducers: {
    setTempState(state, action: PayloadAction<string | null>) {
      state.temp_state = action.payload;
    },
    resetTempState(state) {
      state.temp_state = null;
    },
    setPendingBrowserUrl(state, action: PayloadAction<string>) {
      state.pendingBrowserUrl = action.payload;
    },
    clearPendingBrowserUrl(state) {
      state.pendingBrowserUrl = null;
    },
    setLastDashboardId(state, action: PayloadAction<string>) {
      state.lastDashboardId = action.payload;
    },
    setPendingFocusAgentId(state, action: PayloadAction<string>) {
      state.pendingFocusAgentId = action.payload;
    },
    clearPendingFocusAgentId(state) {
      state.pendingFocusAgentId = null;
    },
  },
});

export const { 
  setTempState,
  resetTempState,
  setPendingBrowserUrl,
  clearPendingBrowserUrl,
  setLastDashboardId,
  setPendingFocusAgentId,
  clearPendingFocusAgentId,
} = tempStateSlice.actions;

export default tempStateSlice.reducer;
