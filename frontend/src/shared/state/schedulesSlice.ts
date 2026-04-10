import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

const SCHEDULES_API = `${API_BASE}/schedules`;

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  dashboard_id: string;
  trigger_type: 'cron' | 'interval' | 'once';
  cron_expression: string | null;
  interval_seconds: number | null;
  run_at: string | null;
  action_type: 'new_session' | 'message_existing';
  prompt: string;
  target_session_id: string | null;
  template_id: string | null;
  model: string | null;
  mode: string | null;
  system_prompt: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  run_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface SchedulesState {
  items: Record<string, Schedule>;
  loading: boolean;
  unreadCount: number;
}

const initialState: SchedulesState = {
  items: {},
  loading: false,
  unreadCount: 0,
};

export const fetchSchedules = createAsyncThunk(
  'schedules/fetchAll',
  async (dashboardId?: string) => {
    const url = dashboardId
      ? `${SCHEDULES_API}/list?dashboard_id=${dashboardId}`
      : `${SCHEDULES_API}/list`;
    const res = await fetch(url);
    const data = await res.json();
    return data.schedules as Schedule[];
  },
);

export const createSchedule = createAsyncThunk(
  'schedules/create',
  async (body: Omit<Schedule, 'id' | 'last_run_at' | 'next_run_at' | 'run_count' | 'last_error' | 'created_at' | 'updated_at' | 'enabled'> & { name?: string }) => {
    const res = await fetch(`${SCHEDULES_API}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Schedule;
  },
);

export const updateSchedule = createAsyncThunk(
  'schedules/update',
  async ({ id, ...body }: { id: string } & Partial<Schedule>) => {
    const res = await fetch(`${SCHEDULES_API}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Schedule;
  },
);

export const deleteSchedule = createAsyncThunk(
  'schedules/delete',
  async (id: string) => {
    await fetch(`${SCHEDULES_API}/${id}`, { method: 'DELETE' });
    return id;
  },
);

export const toggleSchedule = createAsyncThunk(
  'schedules/toggle',
  async (id: string) => {
    const res = await fetch(`${SCHEDULES_API}/${id}/toggle`, { method: 'POST' });
    return (await res.json()) as Schedule;
  },
);

const schedulesSlice = createSlice({
  name: 'schedules',
  initialState,
  reducers: {
    incrementUnread(state) {
      state.unreadCount += 1;
    },
    clearUnread(state) {
      state.unreadCount = 0;
    },
    scheduleUpdatedFromWs(state, action: PayloadAction<{ schedule_id: string }>) {
      state.unreadCount += 1;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchSchedules.pending, (state) => {
        state.loading = true;
      })
      .addCase(fetchSchedules.fulfilled, (state, action) => {
        state.loading = false;
        const items: Record<string, Schedule> = {};
        for (const s of action.payload) {
          items[s.id] = s;
        }
        state.items = items;
      })
      .addCase(fetchSchedules.rejected, (state) => {
        state.loading = false;
      })
      .addCase(createSchedule.fulfilled, (state, action) => {
        state.items[action.payload.id] = action.payload;
      })
      .addCase(updateSchedule.fulfilled, (state, action) => {
        state.items[action.payload.id] = action.payload;
      })
      .addCase(deleteSchedule.fulfilled, (state, action) => {
        delete state.items[action.payload];
      })
      .addCase(toggleSchedule.fulfilled, (state, action) => {
        state.items[action.payload.id] = action.payload;
      });
  },
});

export const { incrementUnread, clearUnread, scheduleUpdatedFromWs } = schedulesSlice.actions;
export default schedulesSlice.reducer;
