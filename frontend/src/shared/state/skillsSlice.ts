import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

const API_BASE = `http://${window.location.hostname}:8324/api/skills`;

export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  file_path: string;
  command: string;
}

interface SkillsState {
  items: Record<string, Skill>;
  loading: boolean;
  loaded: boolean;
}

const initialState: SkillsState = { items: {}, loading: false, loaded: false };

export const fetchSkills = createAsyncThunk(
  'skills/fetch',
  async () => {
    const res = await fetch(`${API_BASE}/list`);
    const data = await res.json();
    return data.skills as Skill[];
  },
  { condition: (_, { getState }) => !(getState() as { skills: SkillsState }).skills.loading },
);

export const createSkill = createAsyncThunk(
  'skills/create',
  async (body: { name: string; description?: string; content: string; command?: string }) => {
    const res = await fetch(`${API_BASE}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data.skill as Skill;
  }
);

export const updateSkill = createAsyncThunk(
  'skills/update',
  async ({ id, ...updates }: Partial<Skill> & { id: string }) => {
    const res = await fetch(`${API_BASE}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    const data = await res.json();
    return data.skill as Skill;
  }
);

export const deleteSkill = createAsyncThunk('skills/delete', async (id: string) => {
  await fetch(`${API_BASE}/${id}`, { method: 'DELETE' });
  return id;
});

const skillsSlice = createSlice({
  name: 'skills',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchSkills.pending, (state) => { state.loading = true; })
      .addCase(fetchSkills.fulfilled, (state, action) => {
        state.loading = false;
        state.loaded = true;
        state.items = {};
        for (const s of action.payload) state.items[s.id] = s;
      })
      .addCase(fetchSkills.rejected, (state) => { state.loading = false; state.loaded = true; })
      .addCase(createSkill.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(updateSkill.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(deleteSkill.fulfilled, (state, action) => { delete state.items[action.payload]; });
  },
});

export default skillsSlice.reducer;
