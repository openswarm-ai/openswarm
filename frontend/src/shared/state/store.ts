import { configureStore } from '@reduxjs/toolkit';
import tempStateReducer from './tempStateSlice';
import agentsReducer from './agentsSlice';
import skillsReducer from './skillsSlice';
import toolsReducer from './toolsSlice';
import modesReducer from './modesSlice';
import settingsReducer from './settingsSlice';
import mcpRegistryReducer from './mcpRegistrySlice';
import skillRegistryReducer from './skillRegistrySlice';
import dashboardLayoutReducer from './dashboardLayoutSlice';
import dashboardsReducer from './dashboardsSlice';
import updateReducer from './updateSlice';
import modelsReducer from './modelsSlice';

export const store = configureStore({
  reducer: {
    tempState: tempStateReducer,
    agents: agentsReducer,
    skills: skillsReducer,
    tools: toolsReducer,
    modes: modesReducer,
    settings: settingsReducer,
    mcpRegistry: mcpRegistryReducer,
    skillRegistry: skillRegistryReducer,
    dashboardLayout: dashboardLayoutReducer,
    dashboards: dashboardsReducer,
    update: updateReducer,
    models: modelsReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
