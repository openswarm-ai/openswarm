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
import onboardingProgressReducer from '@/shared/state/onboardingProgressSlice';

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
    onboardingProgress: onboardingProgressReducer,
  },
  // Disable Redux Toolkit's dev-mode invariant middleware (serializable +
  // immutable checks). These deep-walk the entire state on every dispatch,
  // and our state is large enough to trigger 30-50ms pauses on hot paths
  // (agent streaming, websocket heartbeats, settings sync). Console warns
  // "SerializableStateInvariantMiddleware took 41ms" repeatedly under load.
  //
  // Production builds skip these middlewares anyway, so disabling them in
  // dev makes dev behavior match prod , no surprises at packaging time.
  // Trade-off: serializability bugs (e.g. accidentally putting a Map or
  // Date directly into state) won't be caught at dev time. We've shipped
  // many versions with stable slice shapes; that risk is now low.
  middleware: (getDefault) =>
    getDefault({
      serializableCheck: false,
      immutableCheck: false,
    }),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// Expose the store on window in dev. In production it stays hidden UNLESS the
// renderer was launched with __OPENSWARM_E2E__ pre-set by a Playwright init
// script, which is the only way the e2e visibility recorder can subscribe to
// state diffs against the packaged build. Normal user runs never set the flag.
if (typeof window !== 'undefined' && (process.env.NODE_ENV !== 'production' || (window as unknown as { __OPENSWARM_E2E__?: boolean }).__OPENSWARM_E2E__ === true)) {
  (window as unknown as { __OPENSWARM_STORE__?: typeof store }).__OPENSWARM_STORE__ = store;
}
