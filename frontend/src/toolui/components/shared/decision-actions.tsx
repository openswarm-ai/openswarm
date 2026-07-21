"use client";

import { useCallback } from "react";
import { ActionButtons } from "./action-buttons";
import {
  DecisionResultSchema,
  type DecisionAction,
  type DecisionResult,
} from "./schema";
import { cn } from "./_adapter";
import { useOptionalToolUI } from "./tool-ui-context";

export interface DecisionActionsProps<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  id?: string;
  actions: DecisionAction[];
  onAction: (action: {
    id: string;
    label: string;
  }) => DecisionResult<TPayload> | Promise<DecisionResult<TPayload>>;
  onCommit: (result: DecisionResult<TPayload>) => void | Promise<void>;
  onBeforeAction?: (actionId: string) => boolean | Promise<boolean>;
  confirmTimeout?: number;
  align?: "left" | "center" | "right";
  ariaLabel?: string;
  className?: string;
}

export function DecisionActions<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
>({
  id: explicitId,
  actions,
  onAction,
  onCommit,
  onBeforeAction,
  confirmTimeout,
  align = "right",
  ariaLabel,
  className,
}: DecisionActionsProps<TPayload>) {
  const context = useOptionalToolUI();
  const id = context?.id ?? explicitId;

  if (!id) {
    throw new Error(
      "DecisionActions requires a ToolUI provider or an explicit id prop.",
    );
  }

  const handleAction = useCallback(
    async (actionId: string) => {
      const action = actions.find((item) => item.id === actionId);
      if (!action) return;

      const result = await onAction({ id: action.id, label: action.label });
      const parsed = DecisionResultSchema.safeParse(result);

      if (!parsed.success) {
        throw new Error(
          `DecisionActions expected a valid DecisionResult envelope for action "${action.id}".`,
        );
      }

      await onCommit(parsed.data as DecisionResult<TPayload>);
    },
    [actions, onAction, onCommit],
  );

  return (
    <div
      className={cn("@container/actions flex flex-col gap-2", className)}
      data-slot="decision-actions"
      data-tool-ui-id={id}
      aria-label={ariaLabel ?? "Decision actions"}
    >
      <ActionButtons
        actions={actions}
        onAction={handleAction}
        onBeforeAction={onBeforeAction}
        confirmTimeout={confirmTimeout}
        align={align}
      />
    </div>
  );
}
