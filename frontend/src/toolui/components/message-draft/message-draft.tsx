"use client";

import * as React from "react";
import { cn, Button } from "./_adapter";
import type {
  MessageDraftProps,
  SerializableEmailDraft,
  SerializableSlackDraft,
} from "./schema";
import { ActionButtons } from "../shared/action-buttons";
import type { Action } from "../shared/schema";
import { Check, ChevronDown } from "lucide-react";

type DraftState = "review" | "sending" | "sent" | "cancelled";
type DraftOutcome = MessageDraftProps["outcome"];

const DEFAULT_GRACE_PERIOD = 5000;
const COLLAPSED_BODY_HEIGHT = 280;

interface RecipientRowProps {
  label: string;
  recipients: string[];
  maxVisible?: number;
  muted?: boolean;
}

function RecipientRow({
  label,
  recipients,
  maxVisible = 3,
  muted = false,
}: RecipientRowProps) {
  const visibleRecipients = recipients.slice(0, maxVisible);
  const overflowCount = recipients.length - maxVisible;

  return (
    <tr className="text-sm">
      <td className="text-muted-foreground w-0 pr-4 pb-1 text-right align-top font-medium whitespace-nowrap">
        {label}
      </td>
      <td className={cn("pb-1 align-top", muted && "text-muted-foreground")}>
        {visibleRecipients.join(", ")}
        {overflowCount > 0 && (
          <span className="text-muted-foreground"> +{overflowCount} more</span>
        )}
      </td>
    </tr>
  );
}

interface SingleFieldRowProps {
  label: string;
  value: string;
}

function SingleFieldRow({ label, value }: SingleFieldRowProps) {
  return (
    <tr className="text-sm">
      <td className="text-muted-foreground w-0 pr-4 pb-1 text-right align-top font-medium whitespace-nowrap">
        {label}
      </td>
      <td className="pb-1 align-top">{value}</td>
    </tr>
  );
}

interface ExpandableBodyProps {
  body: string;
  isExpanded: boolean;
  onNeedsExpansionChange?: (needsExpansion: boolean) => void;
}

function ExpandableBody({
  body,
  isExpanded,
  onNeedsExpansionChange,
}: ExpandableBodyProps) {
  const [needsExpansion, setNeedsExpansion] = React.useState<boolean | null>(
    null,
  );
  const contentRef = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    if (contentRef.current) {
      const needs = contentRef.current.scrollHeight > COLLAPSED_BODY_HEIGHT;
      setNeedsExpansion(needs);
      onNeedsExpansionChange?.(needs);
    }
  }, [body, onNeedsExpansionChange]);

  return (
    <div className="relative">
      <div
        ref={contentRef}
        className={cn(
          "overflow-hidden text-sm leading-relaxed",
          needsExpansion !== null &&
            "transition-[max-height] duration-300 ease-in-out",
        )}
        style={{
          maxHeight:
            needsExpansion === null
              ? `${COLLAPSED_BODY_HEIGHT}px`
              : isExpanded || !needsExpansion
                ? `${contentRef.current?.scrollHeight ?? 1000}px`
                : `${COLLAPSED_BODY_HEIGHT}px`,
        }}
      >
        <p className="pt-1 whitespace-pre-wrap">{body}</p>
      </div>
      {needsExpansion && (
        <div
          className={cn(
            "from-card pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t to-transparent transition-[height] duration-300 ease-in-out",
            isExpanded ? "h-0" : "h-12",
          )}
        />
      )}
    </div>
  );
}

interface EmailDraftContentProps {
  draft: SerializableEmailDraft;
  titleId: string;
  isExpanded: boolean;
  onNeedsExpansionChange?: (needsExpansion: boolean) => void;
}

function EmailDraftContent({
  draft,
  titleId,
  isExpanded,
  onNeedsExpansionChange,
}: EmailDraftContentProps) {
  return (
    <>
      <h2 id={titleId} className="pt-2 text-base leading-tight font-semibold">
        {draft.subject}
      </h2>

      <table className="w-full">
        <tbody>
          {draft.from && <SingleFieldRow label="From" value={draft.from} />}
          <RecipientRow label="To" recipients={draft.to} />
          {draft.cc && draft.cc.length > 0 && (
            <RecipientRow label="Cc" recipients={draft.cc} />
          )}
          {draft.bcc && draft.bcc.length > 0 && (
            <RecipientRow label="Bcc" recipients={draft.bcc} muted />
          )}
        </tbody>
      </table>

      <div className="bg-border -mx-5 h-px" role="separator" />

      <ExpandableBody
        body={draft.body}
        isExpanded={isExpanded}
        onNeedsExpansionChange={onNeedsExpansionChange}
      />
    </>
  );
}

interface SlackDraftContentProps {
  draft: SerializableSlackDraft;
  titleId: string;
  isExpanded: boolean;
  onNeedsExpansionChange?: (needsExpansion: boolean) => void;
}

function SlackLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#E01E5A"
        d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z"
      />
      <path
        fill="#36C5F0"
        d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z"
      />
      <path
        fill="#2EB67D"
        d="M18.958 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.52 2.521h-2.522V8.834zm-1.271 0a2.528 2.528 0 0 1-2.521 2.521 2.528 2.528 0 0 1-2.521-2.521V2.522A2.528 2.528 0 0 1 15.165 0a2.528 2.528 0 0 1 2.522 2.522v6.312z"
      />
      <path
        fill="#ECB22E"
        d="M15.165 18.958a2.528 2.528 0 0 1 2.522 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.521-2.52v-2.522h2.521zm0-1.271a2.527 2.527 0 0 1-2.521-2.521 2.526 2.526 0 0 1 2.521-2.521h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.521h-6.313z"
      />
    </svg>
  );
}

function SlackDraftContent({
  draft,
  titleId,
  isExpanded,
  onNeedsExpansionChange,
}: SlackDraftContentProps) {
  const { target } = draft;
  const isChannel = target.type === "channel";
  const targetDisplay = isChannel
    ? `#${target.name}`
    : `Message to @${target.name}`;
  const memberCount = isChannel ? target.memberCount : undefined;

  return (
    <>
      <div
        id={titleId}
        className="flex items-center gap-1.5 text-sm font-medium"
      >
        <SlackLogo className="size-4" />
        <span>{targetDisplay}</span>
        {memberCount !== undefined && (
          <span className="text-muted-foreground ml-auto text-sm font-normal">
            {memberCount.toLocaleString()} members
          </span>
        )}
      </div>

      <div className="bg-border -mx-5 h-px" role="separator" />

      <ExpandableBody
        body={draft.body}
        isExpanded={isExpanded}
        onNeedsExpansionChange={onNeedsExpansionChange}
      />
    </>
  );
}

function formatSentTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function resolveStateFromOutcome(outcome: DraftOutcome): DraftState {
  if (outcome === "sent") return "sent";
  if (outcome === "cancelled") return "cancelled";
  return "review";
}

export function resolveOutcomeTransition(
  previousOutcome: DraftOutcome,
  nextOutcome: DraftOutcome,
): DraftState | null {
  if (previousOutcome === nextOutcome) {
    return null;
  }

  return resolveStateFromOutcome(nextOutcome);
}

interface SentConfirmationProps {
  sentAt: Date;
}

function SentConfirmation({ sentAt }: SentConfirmationProps) {
  return (
    <div
      className="flex items-center justify-end gap-2 text-sm"
      role="status"
      aria-label="Message sent"
    >
      <span className="text-muted-foreground">
        Sent at {formatSentTime(sentAt)}
      </span>
      <span className="bg-primary/10 text-primary flex size-6 shrink-0 items-center justify-center rounded-full">
        <Check className="size-3.5" />
      </span>
    </div>
  );
}

export function MessageDraft(props: MessageDraftProps) {
  const {
    id,
    className,
    outcome,
    undoGracePeriod = DEFAULT_GRACE_PERIOD,
    onSend,
    onUndo,
    onCancel,
  } = props;

  const [state, setState] = React.useState<DraftState>(() =>
    resolveStateFromOutcome(outcome),
  );
  const [countdown, setCountdown] = React.useState(
    Math.ceil(undoGracePeriod / 1000),
  );
  const [sentAt, setSentAt] = React.useState<Date | null>(() =>
    outcome === "sent" ? new Date() : null,
  );
  const [isExpanded, setIsExpanded] = React.useState(false);
  const [needsExpansion, setNeedsExpansion] = React.useState(false);
  const undoButtonRef = React.useRef<HTMLButtonElement>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = React.useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const previousOutcomeRef = React.useRef<DraftOutcome>(outcome);

  const clearTimers = React.useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    return clearTimers;
  }, [clearTimers]);

  React.useEffect(() => {
    const nextState = resolveOutcomeTransition(
      previousOutcomeRef.current,
      outcome,
    );

    previousOutcomeRef.current = outcome;

    if (nextState === null) {
      return;
    }

    clearTimers();
    setState(nextState);
    setCountdown(Math.ceil(undoGracePeriod / 1000));
    setSentAt(nextState === "sent" ? new Date() : null);
  }, [outcome, undoGracePeriod, clearTimers]);

  React.useEffect(() => {
    if (state === "sending") {
      undoButtonRef.current?.focus();

      setCountdown(Math.ceil(undoGracePeriod / 1000));

      countdownRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            if (countdownRef.current) {
              clearInterval(countdownRef.current);
              countdownRef.current = null;
            }
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      timerRef.current = setTimeout(async () => {
        clearTimers();
        await onSend?.();
        setSentAt(new Date());
        setState("sent");
      }, undoGracePeriod);
    }
  }, [state, undoGracePeriod, onSend, clearTimers]);

  const handleSend = React.useCallback(() => {
    setState("sending");
  }, []);

  const handleUndo = React.useCallback(() => {
    clearTimers();
    setState("review");
    onUndo?.();
  }, [clearTimers, onUndo]);

  const handleCancel = React.useCallback(() => {
    clearTimers();
    setState("cancelled");
    onCancel?.();
  }, [clearTimers, onCancel]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape" && state === "review") {
        event.preventDefault();
        handleCancel();
      }
    },
    [state, handleCancel],
  );

  const handleNeedsExpansionChange = React.useCallback((needs: boolean) => {
    setNeedsExpansion(needs);
  }, []);

  const handleToggleExpand = React.useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const handleAction = React.useCallback(
    async (actionId: string) => {
      if (actionId === "send") {
        handleSend();
      } else if (actionId === "cancel") {
        handleCancel();
      }
    },
    [handleSend, handleCancel],
  );

  const actions: Action[] = [
    {
      id: "cancel",
      label: "Cancel",
      variant: "ghost",
    },
    {
      id: "send",
      label: "Send",
      variant: "default",
    },
  ];

  const expandButton = needsExpansion ? (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleToggleExpand}
      className="h-7 gap-1 px-2 text-sm"
    >
      {isExpanded ? "Show less" : "Read more"}
      <ChevronDown className={cn("size-3", isExpanded && "rotate-180")} />
    </Button>
  ) : null;

  const renderActions = () => {
    switch (state) {
      case "sending":
        return (
          <div
            className="flex items-center justify-end gap-3"
            aria-live="polite"
          >
            <span className="text-muted-foreground text-sm">
              Sending in {countdown}s
            </span>
            <Button
              ref={undoButtonRef}
              variant="outline"
              size="sm"
              onClick={handleUndo}
              className="rounded-full"
            >
              Undo
            </Button>
          </div>
        );
      case "sent":
        return <SentConfirmation sentAt={sentAt ?? new Date()} />;
      case "cancelled":
        return null;
      default:
        return <ActionButtons actions={actions} onAction={handleAction} />;
    }
  };

  if (state === "cancelled") {
    return null;
  }

  return (
    <article
      className={cn(
        "flex w-full max-w-lg min-w-64 flex-col gap-3",
        "text-foreground",
        className,
      )}
      data-slot="message-draft"
      data-tool-ui-id={id}
      data-state={state}
      aria-labelledby={`${id}-title`}
      onKeyDown={handleKeyDown}
    >
      <div className="bg-card flex w-full flex-col gap-3 rounded-2xl border px-5 pt-3 pb-5 shadow-xs transition-none">
        {props.channel === "email" ? (
          <EmailDraftContent
            draft={props}
            titleId={`${id}-title`}
            isExpanded={isExpanded}
            onNeedsExpansionChange={handleNeedsExpansionChange}
          />
        ) : (
          <SlackDraftContent
            draft={props}
            titleId={`${id}-title`}
            isExpanded={isExpanded}
            onNeedsExpansionChange={handleNeedsExpansionChange}
          />
        )}

        {expandButton}
      </div>

      <div className="@container/actions">{renderActions()}</div>
    </article>
  );
}
