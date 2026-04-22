import React, { createContext, useContext } from 'react';

/**
 * React context that signals whether the Dashboard is currently the active
 * route (i.e. visible to the user) vs hidden in the background.
 *
 * Defaults to `true` so any standalone usage of dashboard children outside
 * the DashboardHost wrapper just behaves normally.
 *
 * Heavy/expensive Dashboard children read this via `useDashboardActive()`
 * and short-circuit their work when the dashboard is hidden — that's how
 * we keep CPU usage near-zero while the user is on /actions or /settings
 * with the Dashboard mounted but invisible.
 */
const DashboardActiveContext = createContext<boolean>(true);

export const DashboardActiveProvider = DashboardActiveContext.Provider;

export function useDashboardActive(): boolean {
  return useContext(DashboardActiveContext);
}
