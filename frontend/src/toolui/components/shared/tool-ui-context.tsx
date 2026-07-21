"use client";

import { createContext, useContext } from "react";

export interface ToolUIContextValue {
  id: string;
  surfaceMounted: boolean;
  setSurfaceMounted: (mounted: boolean) => void;
}

export const ToolUIContext = createContext<ToolUIContextValue | null>(null);

export function useOptionalToolUI(): ToolUIContextValue | null {
  return useContext(ToolUIContext);
}

export function useToolUI(): ToolUIContextValue {
  const context = useOptionalToolUI();

  if (!context) {
    throw new Error(
      "ToolUI context is missing. Wrap LocalActions/DecisionActions with <ToolUI>.",
    );
  }

  return context;
}
