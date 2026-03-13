import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

const API_BASE = `http://${window.location.hostname}:8324/api/modes`;

export interface Mode {
  id: string;
  name: string;
  description: string;
  system_prompt: string | null;
  tools: string[] | null;
  default_next_mode: string | null;
  is_builtin: boolean;
  icon: string;
  color: string;
  default_folder: string | null;
}

interface ModesState {
  items: Record<string, Mode>;
  loading: boolean;
  loaded: boolean;
}

const initialState: ModesState = { items: {}, loading: false, loaded: false };

export const fetchModes = createAsyncThunk(
  'modes/fetch',
  async () => {
    const res = await fetch(`${API_BASE}/list`);
    const data = await res.json();
    return data.modes as Mode[];
  },
  { condition: (_, { getState }) => !(getState() as { modes: ModesState }).modes.loading },
);

export const createMode = createAsyncThunk(
  'modes/create',
  async (body: Omit<Mode, 'id' | 'is_builtin'>) => {
    const res = await fetch(`${API_BASE}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data.mode as Mode;
  }
);

export const updateMode = createAsyncThunk(
  'modes/update',
  async ({ id, ...updates }: Partial<Mode> & { id: string }) => {
    const res = await fetch(`${API_BASE}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    const data = await res.json();
    return data.mode as Mode;
  }
);

export const deleteMode = createAsyncThunk('modes/delete', async (id: string) => {
  await fetch(`${API_BASE}/${id}`, { method: 'DELETE' });
  return id;
});

const modesSlice = createSlice({
  name: 'modes',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchModes.pending, (state) => { state.loading = true; })
      .addCase(fetchModes.fulfilled, (state, action) => {
        state.loading = false;
        state.loaded = true;
        state.items = {};
        for (const m of action.payload) state.items[m.id] = m;
      })
      .addCase(fetchModes.rejected, (state) => { state.loading = false; state.loaded = true; })
      .addCase(createMode.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(updateMode.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(deleteMode.fulfilled, (state, action) => { delete state.items[action.payload]; });
  },
});

export default modesSlice.reducer;
