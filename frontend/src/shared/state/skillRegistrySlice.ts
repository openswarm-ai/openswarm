import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

const API_BASE = `http://${window.location.hostname}:8324/api/skill-registry`;

export interface RegistrySkill {
  name: string;
  description: string;
  folder: string;
  category: string;
  repositoryUrl: string;
}

export interface RegistrySkillDetail extends RegistrySkill {
  content: string;
}

interface SkillRegistryState {
  skills: RegistrySkill[];
  total: number;
  loading: boolean;
  query: string;
  offset: number;
  stats: { total: number; categories: Record<string, number>; lastUpdated: number } | null;
  detail: RegistrySkillDetail | null;
  detailLoading: boolean;
}

const initialState: SkillRegistryState = {
  skills: [],
  total: 0,
  loading: false,
  query: '',
  offset: 0,
  stats: null,
  detail: null,
  detailLoading: false,
};

export const searchSkillRegistry = createAsyncThunk(
  'skillRegistry/search',
  async ({ q, limit = 20, offset = 0, sort = 'name', category = '' }: { q: string; limit?: number; offset?: number; sort?: string; category?: string }) => {
    const params = new URLSearchParams({ q, limit: String(limit), offset: String(offset), sort, category });
    const res = await fetch(`${API_BASE}/search?${params}`);
    return (await res.json()) as { skills: RegistrySkill[]; total: number; offset: number; limit: number };
  },
);

export const fetchSkillRegistryStats = createAsyncThunk('skillRegistry/stats', async () => {
  const res = await fetch(`${API_BASE}/stats`);
  return (await res.json()) as { total: number; categories: Record<string, number>; lastUpdated: number };
});

export const fetchAllRegistrySkills = createAsyncThunk(
  'skillRegistry/fetchAll',
  async () => {
    const params = new URLSearchParams({ q: '', limit: '100', offset: '0', sort: 'name', category: '' });
    const res = await fetch(`${API_BASE}/search?${params}`);
    return (await res.json()) as { skills: RegistrySkill[]; total: number; offset: number; limit: number };
  },
);

export const fetchSkillDetail = createAsyncThunk(
  'skillRegistry/detail',
  async (name: string) => {
    const res = await fetch(`${API_BASE}/detail/${encodeURIComponent(name)}`);
    const data = await res.json();
    return data.skill as RegistrySkillDetail;
  },
);

const skillRegistrySlice = createSlice({
  name: 'skillRegistry',
  initialState,
  reducers: {
    clearSkillDetail(state) {
      state.detail = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(searchSkillRegistry.pending, (state, action) => {
        state.loading = true;
        state.query = action.meta.arg.q;
        state.offset = action.meta.arg.offset ?? 0;
      })
      .addCase(searchSkillRegistry.fulfilled, (state, action) => {
        state.loading = false;
        if (action.meta.arg.offset && action.meta.arg.offset > 0) {
          state.skills = [...state.skills, ...action.payload.skills];
        } else {
          state.skills = action.payload.skills;
        }
        state.total = action.payload.total;
      })
      .addCase(searchSkillRegistry.rejected, (state) => {
        state.loading = false;
      })
      .addCase(fetchSkillRegistryStats.fulfilled, (state, action) => {
        state.stats = action.payload;
      })
      .addCase(fetchAllRegistrySkills.pending, (state) => {
        state.loading = true;
      })
      .addCase(fetchAllRegistrySkills.fulfilled, (state, action) => {
        state.loading = false;
        state.skills = action.payload.skills;
        state.total = action.payload.total;
      })
      .addCase(fetchAllRegistrySkills.rejected, (state) => {
        state.loading = false;
      })
      .addCase(fetchSkillDetail.pending, (state) => {
        state.detailLoading = true;
      })
      .addCase(fetchSkillDetail.fulfilled, (state, action) => {
        state.detailLoading = false;
        state.detail = action.payload;
      })
      .addCase(fetchSkillDetail.rejected, (state) => {
        state.detailLoading = false;
      });
  },
});

export const { clearSkillDetail } = skillRegistrySlice.actions;
export default skillRegistrySlice.reducer;
