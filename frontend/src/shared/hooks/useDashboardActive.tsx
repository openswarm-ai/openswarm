import React, { createContext, useContext } from 'react';

/** True when Dashboard is the visible route; heavy children short-circuit when false. */
const DashboardActiveContext = createContext<boolean>(true);

export const DashboardActiveProvider = DashboardActiveContext.Provider;

export function useDashboardActive(): boolean {
  return useContext(DashboardActiveContext);
}
