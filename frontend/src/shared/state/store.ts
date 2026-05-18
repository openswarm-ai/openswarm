import { configureStore } from '@reduxjs/toolkit';
import tempStateReducer from './tempStateSlice';
import agentsReducer from './agentsSlice';
import streamingReducer from './streamingSlice';
import skillsReducer from './skillsSlice';
import toolsReducer from './toolsSlice';
import modesReducer from './modesSlice';
import settingsReducer from './settingsSlice';
import mcpRegistryReducer from './mcpRegistrySlice';
import skillRegistryReducer from './skillRegistrySlice';
import outputsReducer from './outputsSlice';
import dashboardLayoutReducer from './dashboardLayoutSlice';
import dashboardsReducer from './dashboardsSlice';
import updateReducer from './updateSlice';
import modelsReducer from './modelsSlice';
import interactionReducer from './interactionSlice';
import subscriptionsReducer from './subscriptionsSlice';
import workflowsReducer from './workflowsSlice';
import onboardingProgressReducer from '@/app/components/Onboarding/OnboardingProgressSlice';

export const store = configureStore({
  reducer: {
    tempState: tempStateReducer,
    agents: agentsReducer,
    streaming: streamingReducer,
    skills: skillsReducer,
    tools: toolsReducer,
    modes: modesReducer,
    settings: settingsReducer,
    mcpRegistry: mcpRegistryReducer,
    skillRegistry: skillRegistryReducer,
    outputs: outputsReducer,
    dashboardLayout: dashboardLayoutReducer,
    dashboards: dashboardsReducer,
    update: updateReducer,
    models: modelsReducer,
    interaction: interactionReducer,
    subscriptions: subscriptionsReducer,
    workflows: workflowsReducer,
    onboardingProgress: onboardingProgressReducer,
  },
  // Disable RTK dev invariant middleware; deep state-walk caused 30-50ms pauses on hot paths.
  middleware: (getDefault) =>
    getDefault({
      serializableCheck: false,
      immutableCheck: false,
    }),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
