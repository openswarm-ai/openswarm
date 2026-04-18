import { createSlice } from '@reduxjs/toolkit';
import {
  LIST_SKILLS,
  CREATE_SKILL,
  UPDATE_SKILL,
  DELETE_SKILL,
} from '@/shared/backend-bridge/apps/skills';
import type { Skill } from '@/shared/backend-bridge/apps/skills';

interface SkillsState {
  items: Record<string, Skill>;
  loading: boolean;
  loaded: boolean;
}

const initialState: SkillsState = { items: {}, loading: false, loaded: false };

const skillsSlice = createSlice({
  name: 'skills',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(LIST_SKILLS.pending, (state) => { state.loading = true; })
      .addCase(LIST_SKILLS.fulfilled, (state, action) => {
        state.loading = false;
        state.loaded = true;
        state.items = {};
        for (const s of action.payload) state.items[s.id] = s;
      })
      .addCase(LIST_SKILLS.rejected, (state) => { state.loading = false; state.loaded = true; })
      .addCase(CREATE_SKILL.fulfilled, (state, action) => { state.items[action.payload.skill.id] = action.payload.skill; })
      .addCase(UPDATE_SKILL.fulfilled, (state, action) => { state.items[action.payload.skill.id] = action.payload.skill; })
      .addCase(DELETE_SKILL.fulfilled, (state, action) => { delete state.items[action.meta.arg]; });
  },
});

export default skillsSlice.reducer;
