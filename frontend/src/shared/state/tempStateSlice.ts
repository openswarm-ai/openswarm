// store/tempStateSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface TempState {
  temp_state: string | null;
}

const initialState: TempState = {
  temp_state: null,
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
  },
});

export const { 
  setTempState,
  resetTempState,
} = tempStateSlice.actions;

export default tempStateSlice.reducer;
