import { createSlice } from '@reduxjs/toolkit';
import {
  REGISTRY_SEARCH,
  REGISTRY_STATS,
  REGISTRY_DETAIL,
  FETCH_ALL_REGISTRY_SKILLS,
} from '@/shared/backend-bridge/apps/skills';
import type { RegistrySkill, RegistrySkillDetail } from '@/shared/backend-bridge/apps/skills';


interface SkillRegistryState {
  skills: RegistrySkill[];
  total: number;
  loading: boolean;
  query: string;
  offset: number;
  stats: { total: number; categories: Record<string, number>; lastUpdated: string | null } | null;
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
      .addCase(REGISTRY_SEARCH.pending, (state, action) => {
        state.loading = true;
        state.query = action.meta.arg.q ?? '';
        state.offset = action.meta.arg.offset ?? 0;
      })
      .addCase(REGISTRY_SEARCH.fulfilled, (state, action) => {
        state.loading = false;
        if (action.meta.arg.offset && action.meta.arg.offset > 0) {
          state.skills = [...state.skills, ...action.payload.skills];
        } else {
          state.skills = action.payload.skills;
        }
        state.total = action.payload.total;
      })
      .addCase(REGISTRY_SEARCH.rejected, (state) => {
        state.loading = false;
      })
      .addCase(REGISTRY_STATS.fulfilled, (state, action) => {
        state.stats = action.payload;
      })
      .addCase(FETCH_ALL_REGISTRY_SKILLS.pending, (state) => {
        state.loading = true;
      })
      .addCase(FETCH_ALL_REGISTRY_SKILLS.fulfilled, (state, action) => {
        state.loading = false;
        state.skills = action.payload.skills;
        state.total = action.payload.total;
      })
      .addCase(FETCH_ALL_REGISTRY_SKILLS.rejected, (state) => {
        state.loading = false;
      })
      .addCase(REGISTRY_DETAIL.pending, (state) => {
        state.detailLoading = true;
      })
      .addCase(REGISTRY_DETAIL.fulfilled, (state, action) => {
        state.detailLoading = false;
        state.detail = action.payload.skill;
      })
      .addCase(REGISTRY_DETAIL.rejected, (state) => {
        state.detailLoading = false;
      });
  },
});

export default skillRegistrySlice.reducer;
