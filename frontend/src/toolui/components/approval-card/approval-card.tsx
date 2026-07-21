"use client";

import * as React from "react";
import { cn, Separator } from "./_adapter";
import type { ApprovalCardProps, ApprovalDecision } from "./schema";
import { ActionButtons } from "../shared/action-buttons";
import { type Action } from "../shared/schema";

import { icons, Check, X } from "lucide-react";

type LucideIcon = React.ComponentType<{ className?: string }>;

function getLucideIcon(name: string): LucideIcon | null {
  const pascalName = name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

  const Icon = icons[pascalName as keyof typeof icons];
  return Icon ?? null;
}

interface ApprovalCardReceiptProps {
  id: string;
  title: string;
  choice: ApprovalDecision;
  actionLabel?: string;
  className?: string;
}

function ApprovalCardReceipt({
  id,
  title,
  choice,
  actionLabel,
  className,
}: ApprovalCardReceiptProps) {
  const isApproved = choice === "approved";
  const displayLabel = actionLabel ?? (isApproved ? "Approved" : "Denied");

  return (
    <div
      className={cn(
        "flex w-full min-w-64 max-w-md flex-col",
        "text-foreground",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:blur-in-sm motion-safe:zoom-in-95 motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)] motion-safe:fill-mode-both",
        className,
      )}
      data-slot="approval-card"
      data-tool-ui-id={id}
      data-receipt="true"
      role="status"
      aria-label={displayLabel}
    >
      <div
        className={cn(
          "bg-card/60 flex w-full items-center gap-3 rounded-2xl border px-4 py-3 shadow-xs",
        )}
      >
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full bg-muted",
            isApproved ? "text-primary" : "text-muted-foreground",
          )}
        >
          {isApproved ? <Check className="size-4" /> : <X className="size-4" />}
        </span>
        <div className="flex flex-col">
          <span className="text-sm font-medium">{displayLabel}</span>
          <span className="text-muted-foreground text-sm">{title}</span>
        </div>
      </div>
    </div>
  );
}

export function ApprovalCard({
  id,
  title,
  description,
  icon,
  metadata,
  variant,
  confirmLabel,
  cancelLabel,
  className,
  choice,
  onConfirm,
  onCancel,
}: ApprovalCardProps) {
  const resolvedVariant = variant ?? "default";
  const resolvedConfirmLabel = confirmLabel ?? "Approve";
  const resolvedCancelLabel = cancelLabel ?? "Deny";
  const Icon = icon ? getLucideIcon(icon) : null;

  const handleAction = React.useCallback(
    async (actionId: string) => {
      if (actionId === "confirm") {
        await onConfirm?.();
      } else if (actionId === "cancel") {
        await onCancel?.();
      }
    },
    [onConfirm, onCancel],
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel?.();
      }
    },
    [onCancel],
  );

  const isDestructive = resolvedVariant === "destructive";

  const actions: Action[] = [
    {
      id: "cancel",
      label: resolvedCancelLabel,
      variant: "ghost",
    },
    {
      id: "confirm",
      label: resolvedConfirmLabel,
      variant: isDestructive ? "destructive" : "default",
    },
  ];

  const viewKey = choice ? `receipt-${choice}` : "interactive";

  return (
    <div key={viewKey} className="contents">
      {choice ? (
        <ApprovalCardReceipt
          id={id}
          title={title}
          choice={choice}
          className={className}
        />
      ) : (
        <article
          className={cn(
            "flex w-full min-w-64 max-w-md flex-col gap-3",
            "text-foreground",
            className,
          )}
          data-slot="approval-card"
          data-tool-ui-id={id}
          role="dialog"
          aria-labelledby={`${id}-title`}
          aria-describedby={description ? `${id}-description` : undefined}
          onKeyDown={handleKeyDown}
        >
          <div className="bg-card flex w-full flex-col gap-4 rounded-2xl border p-5 shadow-xs">
            <div className="flex items-start gap-3">
              {Icon && (
                <span
                  className={cn(
                    "flex size-10 shrink-0 items-center justify-center rounded-xl",
                    isDestructive
                      ? "bg-destructive/10 text-destructive"
                      : "bg-primary/10 text-primary",
                  )}
                >
                  <Icon className="size-5" />
                </span>
              )}
              <div className="flex flex-1 flex-col gap-1">
                <h2
                  id={`${id}-title`}
                  className="text-base font-semibold leading-tight"
                >
                  {title}
                </h2>
                {description && (
                  <p
                    id={`${id}-description`}
                    className="text-muted-foreground text-sm"
                  >
                    {description}
                  </p>
                )}
              </div>
            </div>

            {metadata && metadata.length > 0 && (
              <>
                <Separator />
                <dl className="flex flex-col gap-2 text-sm">
                  {metadata.map((item, index) => (
                    <div key={index} className="flex justify-between gap-4">
                      <dt className="text-muted-foreground shrink-0">
                        {item.key}
                      </dt>
                      <dd className="min-w-0 truncate">{item.value}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </div>
          <div className="@container/actions">
            <ActionButtons actions={actions} onAction={handleAction} />
          </div>
        </article>
      )}
    </div>
  );
}
