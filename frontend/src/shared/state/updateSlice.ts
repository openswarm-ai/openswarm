import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

interface UpdateState {
  status: UpdateStatus;
  appVersion: string | null;
  availableVersion: string | null;
  downloadPercent: number;
  error: string | null;
}

const initialState: UpdateState = {
  status: 'idle',
  appVersion: null,
  availableVersion: null,
  downloadPercent: 0,
  error: null,
};

const updateSlice = createSlice({
  name: 'update',
  initialState,
  reducers: {
    setAppVersion(state, action: PayloadAction<string>) {
      state.appVersion = action.payload;
    },
    setChecking(state) {
      state.status = 'checking';
      state.error = null;
    },
    setUpdateAvailable(state, action: PayloadAction<string>) {
      state.status = 'available';
      state.availableVersion = action.payload;
      state.error = null;
    },
    setUpdateNotAvailable(state) {
      state.status = 'not-available';
      state.error = null;
    },
    setDownloading(state, action: PayloadAction<number>) {
      state.status = 'downloading';
      state.downloadPercent = action.payload;
    },
    setUpdateDownloaded(state) {
      state.status = 'downloaded';
      state.downloadPercent = 100;
    },
    setUpdateError(state, action: PayloadAction<string>) {
      state.status = 'error';
      state.error = action.payload;
    },
  },
});

export const {
  setAppVersion,
  setChecking,
  setUpdateAvailable,
  setUpdateNotAvailable,
  setDownloading,
  setUpdateDownloaded,
  setUpdateError,
} = updateSlice.actions;

export default updateSlice.reducer;
