"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "./_adapter";
import { ToolUIContext, useToolUI } from "./tool-ui-context";
import { LocalActions } from "./local-actions";
import { DecisionActions } from "./decision-actions";

export interface ToolUIProps {
  id: string;
  children: ReactNode;
  className?: string;
}

function ToolUIRoot({ id, children, className }: ToolUIProps) {
  const [surfaceMounted, setSurfaceMounted] = useState(false);

  const value = useMemo(
    () => ({ id, surfaceMounted, setSurfaceMounted }),
    [id, surfaceMounted],
  );

  return (
    <ToolUIContext.Provider value={value}>
      <div
        className={cn("flex flex-col gap-3", className)}
        data-slot="tool-ui"
        data-tool-ui-id={id}
      >
        {children}
      </div>
    </ToolUIContext.Provider>
  );
}

export interface ToolUISurfaceProps {
  children: ReactNode;
}

function ToolUISurface({ children }: ToolUISurfaceProps) {
  const { setSurfaceMounted } = useToolUI();

  useEffect(() => {
    setSurfaceMounted(true);
    return () => setSurfaceMounted(false);
  }, [setSurfaceMounted]);

  return <>{children}</>;
}

export interface ToolUIActionsProps {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}

function ToolUIActions({ children, className, ariaLabel }: ToolUIActionsProps) {
  const { id, surfaceMounted } = useToolUI();

  if (!surfaceMounted) {
    return null;
  }

  return (
    <div
      className={cn("flex flex-col gap-2", className)}
      data-slot="tool-ui-actions"
      data-tool-ui-id={id}
      role="group"
      aria-label={ariaLabel ?? "Tool UI actions"}
    >
      {children}
    </div>
  );
}

type ToolUIComponent = typeof ToolUIRoot & {
  Surface: typeof ToolUISurface;
  Actions: typeof ToolUIActions;
  LocalActions: typeof LocalActions;
  DecisionActions: typeof DecisionActions;
};

export const ToolUI = Object.assign(ToolUIRoot, {
  Surface: ToolUISurface,
  Actions: ToolUIActions,
  LocalActions,
  DecisionActions,
}) as ToolUIComponent;
