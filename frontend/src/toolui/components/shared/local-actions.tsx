"use client";

import { ActionButtons } from "./action-buttons";
import type { LocalAction } from "./schema";
import { cn } from "./_adapter";
import { useOptionalToolUI } from "./tool-ui-context";

export interface LocalActionsProps {
  id?: string;
  actions: LocalAction[];
  onAction: (actionId: string) => void | Promise<void>;
  onBeforeAction?: (actionId: string) => boolean | Promise<boolean>;
  confirmTimeout?: number;
  align?: "left" | "center" | "right";
  ariaLabel?: string;
  className?: string;
}

export function LocalActions({
  id: explicitId,
  actions,
  onAction,
  onBeforeAction,
  confirmTimeout,
  align = "right",
  ariaLabel,
  className,
}: LocalActionsProps) {
  const context = useOptionalToolUI();
  const id = context?.id ?? explicitId;

  if (!id) {
    throw new Error(
      "LocalActions requires a ToolUI provider or an explicit id prop.",
    );
  }

  return (
    <div
      className={cn("@container/actions flex flex-col gap-2", className)}
      data-slot="local-actions"
      data-tool-ui-id={id}
      aria-label={ariaLabel ?? "Local actions"}
    >
      <ActionButtons
        actions={actions}
        onAction={onAction}
        onBeforeAction={onBeforeAction}
        confirmTimeout={confirmTimeout}
        align={align}
      />
    </div>
  );
}
