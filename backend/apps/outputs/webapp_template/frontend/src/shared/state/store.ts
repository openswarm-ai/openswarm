import { configureStore } from '@reduxjs/toolkit';
import tempStateReducer from './tempStateSlice';

export const store = configureStore({
  reducer: {
    tempState: tempStateReducer,
  },
});

console.log('[Store] Redux store created with slices:', Object.keys(store.getState()));

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
