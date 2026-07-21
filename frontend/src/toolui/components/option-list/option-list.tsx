"use client";

import {
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
  Fragment,
} from "react";
import type { KeyboardEvent } from "react";
import type {
  OptionListProps,
  OptionListSelection,
  OptionListOption,
} from "./schema";
import {
  normalizeSelectionForOptions,
  parseSelectionToIdSet,
} from "./selection";
import { ActionButtons } from "../shared/action-buttons";
import { normalizeActionsConfig } from "../shared/actions-config";
import type { Action } from "../shared/schema";
import { cn, Button, Separator } from "./_adapter";
import { Check } from "lucide-react";

function convertIdSetToSelection(
  selected: Set<string>,
  mode: "multi" | "single",
): OptionListSelection {
  if (mode === "single") {
    const [first] = selected;
    return first ?? null;
  }
  return Array.from(selected);
}

function areSetsEqual(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const val of a) {
    if (!b.has(val)) return false;
  }
  return true;
}

interface SelectionIndicatorProps {
  mode: "multi" | "single";
  isSelected: boolean;
  disabled?: boolean;
}

function SelectionIndicator({
  mode,
  isSelected,
  disabled,
}: SelectionIndicatorProps) {
  const shape = mode === "single" ? "rounded-full" : "rounded";

  return (
    <div
      className={cn(
        "flex size-4 shrink-0 items-center justify-center border-2 transition-colors",
        shape,
        isSelected && "border-primary bg-primary text-primary-foreground",
        !isSelected && "border-muted-foreground/50",
        disabled && "opacity-50",
      )}
    >
      {mode === "multi" && isSelected && <Check className="size-3" />}
      {mode === "single" && isSelected && (
        <span className="size-2 rounded-full bg-current" />
      )}
    </div>
  );
}

interface OptionItemProps {
  option: OptionListOption;
  isSelected: boolean;
  isDisabled: boolean;
  selectionMode: "multi" | "single";
  isFirst: boolean;
  isLast: boolean;
  onToggle: () => void;
  tabIndex?: number;
  onFocus?: () => void;
  buttonRef?: (el: HTMLButtonElement | null) => void;
}

function OptionItem({
  option,
  isSelected,
  isDisabled,
  selectionMode,
  isFirst,
  isLast,
  onToggle,
  tabIndex,
  onFocus,
  buttonRef,
}: OptionItemProps) {
  const hasAdjacentOptions = !isFirst && !isLast;

  return (
    <Button
      ref={buttonRef}
      data-id={option.id}
      variant="ghost"
      size="lg"
      role="option"
      aria-selected={isSelected}
      onClick={onToggle}
      onFocus={onFocus}
      tabIndex={tabIndex}
      disabled={isDisabled}
      className={cn(
        "peer group relative h-auto min-h-[50px] w-full justify-start text-left text-sm font-medium",
        "rounded-none border-0 bg-transparent px-0 py-2 text-base shadow-none transition-none hover:bg-transparent! @md/option-list:text-sm",
        isFirst && "pb-2.5",
        hasAdjacentOptions && "py-2.5",
      )}
    >
      <span
        className={cn(
          "bg-primary/5 absolute inset-0 -mx-3 -my-0.5 rounded-xl opacity-0 transition-opacity group-hover:opacity-100",
        )}
      />
      <div className="relative flex items-start gap-3">
        <span className="flex h-6 items-center">
          <SelectionIndicator
            mode={selectionMode}
            isSelected={isSelected}
            disabled={option.disabled}
          />
        </span>
        {option.icon && (
          <span className="flex h-6 items-center">{option.icon}</span>
        )}
        <div className="flex flex-col text-left">
          <span className="leading-6 text-pretty">{option.label}</span>
          {option.description && (
            <span className="text-muted-foreground text-sm font-normal text-pretty">
              {option.description}
            </span>
          )}
        </div>
      </div>
    </Button>
  );
}

interface OptionListConfirmationProps {
  id: string;
  options: OptionListOption[];
  selectedIds: Set<string>;
  className?: string;
}

function OptionListConfirmation({
  id,
  options,
  selectedIds,
  className,
}: OptionListConfirmationProps) {
  const confirmedOptions = options.filter((opt) => selectedIds.has(opt.id));

  return (
    <div
      className={cn(
        "@container/option-list flex w-full max-w-md min-w-80 flex-col",
        "text-foreground",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:blur-in-sm motion-safe:zoom-in-95 motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)] motion-safe:fill-mode-both",
        className,
      )}
      data-slot="option-list"
      data-tool-ui-id={id}
      data-receipt="true"
      role="status"
      aria-label="Confirmed selection"
    >
      <div
        className={cn(
          "bg-card/60 flex w-full flex-col overflow-hidden rounded-2xl border px-5 py-2.5 shadow-xs",
        )}
      >
        {confirmedOptions.map((option, index) => (
          <Fragment key={option.id}>
            {index > 0 && (
              <Separator className="my-1.5" orientation="horizontal" />
            )}
            <div className="flex items-start gap-3 py-1">
              <span className="flex h-6 items-center">
                <Check className="text-primary size-4 shrink-0" />
              </span>
              {option.icon && (
                <span className="flex h-6 items-center">{option.icon}</span>
              )}
              <div className="flex flex-col text-left">
                <span className="text-base leading-6 font-medium text-pretty @md/option-list:text-sm">
                  {option.label}
                </span>
                {option.description && (
                  <span className="text-muted-foreground text-sm font-normal text-pretty">
                    {option.description}
                  </span>
                )}
              </div>
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function OptionList({
  id,
  options,
  selectionMode = "multi",
  minSelections = 1,
  maxSelections,
  value,
  defaultValue,
  choice,
  onChange,
  actions,
  onAction,
  onBeforeAction,
  className,
}: OptionListProps) {
  if (process.env["NODE_ENV"] !== "production") {
    if (value !== undefined && defaultValue !== undefined) {
      console.warn(
        "[OptionList] Both `value` (controlled) and `defaultValue` (uncontrolled) were provided. `defaultValue` is ignored when `value` is set.",
      );
    }
    if (value !== undefined && !onChange) {
      console.warn(
        "[OptionList] `value` was provided without `onChange`. This makes OptionList controlled; selection will not update unless the parent updates `value`.",
      );
    }
  }

  const effectiveMaxSelections = selectionMode === "single" ? 1 : maxSelections;
  const optionIds = useMemo(
    () => new Set(options.map((option) => option.id)),
    [options],
  );

  const [uncontrolledSelected, setUncontrolledSelected] = useState<Set<string>>(
    () =>
      normalizeSelectionForOptions(
        parseSelectionToIdSet(
          defaultValue,
          selectionMode,
          effectiveMaxSelections,
        ),
        optionIds,
      ),
  );

  const selectedIds = useMemo(() => {
    const parsed =
      value !== undefined
        ? parseSelectionToIdSet(value, selectionMode, effectiveMaxSelections)
        : uncontrolledSelected;
    return normalizeSelectionForOptions(parsed, optionIds);
  }, [
    value,
    uncontrolledSelected,
    selectionMode,
    effectiveMaxSelections,
    optionIds,
  ]);

  const selectedCount = selectedIds.size;

  const optionStates = useMemo(() => {
    return options.map((option) => {
      const isSelected = selectedIds.has(option.id);
      const isSelectionLocked =
        selectionMode === "multi" &&
        effectiveMaxSelections !== undefined &&
        selectedCount >= effectiveMaxSelections &&
        !isSelected;
      const isDisabled = option.disabled || isSelectionLocked;

      return { option, isSelected, isDisabled };
    });
  }, [
    options,
    selectedIds,
    selectionMode,
    effectiveMaxSelections,
    selectedCount,
  ]);

  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(() => {
    const firstSelected = optionStates.findIndex(
      (s) => s.isSelected && !s.isDisabled,
    );
    if (firstSelected >= 0) return firstSelected;
    const firstEnabled = optionStates.findIndex((s) => !s.isDisabled);
    return firstEnabled >= 0 ? firstEnabled : 0;
  });

  useEffect(() => {
    if (optionStates.length === 0) return;
    setActiveIndex((prev) => {
      if (
        prev < 0 ||
        prev >= optionStates.length ||
        optionStates[prev].isDisabled
      ) {
        const firstEnabled = optionStates.findIndex((s) => !s.isDisabled);
        return firstEnabled >= 0 ? firstEnabled : 0;
      }
      return prev;
    });
  }, [optionStates]);

  const updateSelection = useCallback(
    (next: Set<string>) => {
      const normalizedNext = normalizeSelectionForOptions(
        parseSelectionToIdSet(
          Array.from(next),
          selectionMode,
          effectiveMaxSelections,
        ),
        optionIds,
      );

      if (value === undefined) {
        if (!areSetsEqual(uncontrolledSelected, normalizedNext)) {
          setUncontrolledSelected(normalizedNext);
        }
      }

      onChange?.(convertIdSetToSelection(normalizedNext, selectionMode));
    },
    [
      effectiveMaxSelections,
      selectionMode,
      uncontrolledSelected,
      value,
      onChange,
      optionIds,
    ],
  );

  const toggleSelection = useCallback(
    (optionId: string) => {
      const next = new Set(selectedIds);
      const isSelected = next.has(optionId);

      if (selectionMode === "single") {
        if (isSelected) {
          next.delete(optionId);
        } else {
          next.clear();
          next.add(optionId);
        }
      } else {
        if (isSelected) {
          next.delete(optionId);
        } else {
          if (effectiveMaxSelections && next.size >= effectiveMaxSelections) {
            return;
          }
          next.add(optionId);
        }
      }

      updateSelection(next);
    },
    [effectiveMaxSelections, selectedIds, selectionMode, updateSelection],
  );

  const toSelectionState = useCallback(
    (selected: Set<string>): OptionListSelection =>
      convertIdSetToSelection(selected, selectionMode),
    [selectionMode],
  );

  const handleCancel = useCallback((): OptionListSelection => {
    const empty = new Set<string>();
    updateSelection(empty);
    return toSelectionState(empty);
  }, [toSelectionState, updateSelection]);

  const customActions = useMemo(
    () => normalizeActionsConfig(actions),
    [actions],
  );

  const handleFooterAction = useCallback(
    async (actionId: string) => {
      let nextState = toSelectionState(selectedIds);

      if (actionId === "cancel") {
        nextState = handleCancel();
      }

      await onAction?.(actionId, nextState);
    },
    [handleCancel, onAction, selectedIds, toSelectionState],
  );

  const normalizedFooterActions = useMemo(() => {
    if (customActions) return customActions;
    return {
      items: [
        { id: "cancel", label: "Clear", variant: "ghost" as const },
        { id: "confirm", label: "Confirm", variant: "default" as const },
      ],
      align: "right" as const,
    } satisfies ReturnType<typeof normalizeActionsConfig>;
  }, [customActions]);

  const isConfirmDisabled =
    selectedCount < minSelections || selectedCount === 0;
  const hasNothingToClear = selectedCount === 0;

  const focusOptionAt = useCallback((index: number) => {
    const el = optionRefs.current[index];
    if (el) el.focus();
    setActiveIndex(index);
  }, []);

  const findFirstEnabledIndex = useCallback(() => {
    const idx = optionStates.findIndex((s) => !s.isDisabled);
    return idx >= 0 ? idx : 0;
  }, [optionStates]);

  const findLastEnabledIndex = useCallback(() => {
    for (let i = optionStates.length - 1; i >= 0; i--) {
      if (!optionStates[i].isDisabled) return i;
    }
    return 0;
  }, [optionStates]);

  const findNextEnabledIndex = useCallback(
    (start: number, direction: 1 | -1) => {
      const len = optionStates.length;
      if (len === 0) return 0;
      for (let step = 1; step <= len; step++) {
        const idx = (start + direction * step + len) % len;
        if (!optionStates[idx].isDisabled) return idx;
      }
      return start;
    },
    [optionStates],
  );

  const handleListboxKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (optionStates.length === 0) return;

      const key = e.key;

      if (key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        focusOptionAt(findNextEnabledIndex(activeIndex, 1));
        return;
      }

      if (key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        focusOptionAt(findNextEnabledIndex(activeIndex, -1));
        return;
      }

      if (key === "Home") {
        e.preventDefault();
        e.stopPropagation();
        focusOptionAt(findFirstEnabledIndex());
        return;
      }

      if (key === "End") {
        e.preventDefault();
        e.stopPropagation();
        focusOptionAt(findLastEnabledIndex());
        return;
      }

      if (key === "Enter" || key === " ") {
        e.preventDefault();
        e.stopPropagation();
        const current = optionStates[activeIndex];
        if (!current || current.isDisabled) return;
        toggleSelection(current.option.id);
        return;
      }

      if (key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!hasNothingToClear) {
          handleCancel();
        }
      }
    },
    [
      activeIndex,
      findFirstEnabledIndex,
      findLastEnabledIndex,
      findNextEnabledIndex,
      focusOptionAt,
      handleCancel,
      hasNothingToClear,
      optionStates,
      toggleSelection,
    ],
  );

  const actionsWithDisabledState = useMemo((): Action[] => {
    return normalizedFooterActions.items.map((action) => {
      const isDisabledByValidation =
        (action.id === "confirm" && isConfirmDisabled) ||
        (action.id === "cancel" && hasNothingToClear);
      return {
        ...action,
        disabled: action.disabled || isDisabledByValidation,
        label:
          action.id === "confirm" &&
          selectionMode === "multi" &&
          selectedCount > 0
            ? `${action.label} (${selectedCount})`
            : action.label,
      };
    });
  }, [
    normalizedFooterActions.items,
    isConfirmDisabled,
    hasNothingToClear,
    selectionMode,
    selectedCount,
  ]);

  const isReceipt = choice !== undefined && choice !== null;
  const viewKey = isReceipt ? `receipt-${String(choice)}` : "interactive";

  return (
    <div key={viewKey} className="contents">
      {isReceipt ? (
        <OptionListConfirmation
          id={id}
          options={options}
          selectedIds={normalizeSelectionForOptions(
            parseSelectionToIdSet(choice, selectionMode),
            optionIds,
          )}
          className={className}
        />
      ) : (
        <div
          className={cn(
            "@container/option-list flex w-full max-w-md min-w-80 flex-col gap-3",
            "text-foreground",
            className,
          )}
          data-slot="option-list"
          data-tool-ui-id={id}
          role="group"
          aria-label="Option list"
        >
          <div
            className={cn(
              "group/list bg-card flex w-full flex-col overflow-hidden rounded-2xl border px-4 py-1.5 shadow-xs",
            )}
            role="listbox"
            aria-multiselectable={selectionMode === "multi"}
            onKeyDown={handleListboxKeyDown}
          >
            {optionStates.map(({ option, isSelected, isDisabled }, index) => {
              return (
                <Fragment key={option.id}>
                  {index > 0 && (
                    <Separator
                      className="transition-opacity [@media(hover:hover)]:[&:has(+_:hover)]:opacity-0 [@media(hover:hover)]:[.peer:hover+&]:opacity-0"
                      orientation="horizontal"
                    />
                  )}
                  <OptionItem
                    option={option}
                    isSelected={isSelected}
                    isDisabled={isDisabled}
                    selectionMode={selectionMode}
                    isFirst={index === 0}
                    isLast={index === optionStates.length - 1}
                    tabIndex={index === activeIndex ? 0 : -1}
                    onFocus={() => setActiveIndex(index)}
                    buttonRef={(el) => {
                      optionRefs.current[index] = el;
                    }}
                    onToggle={() => toggleSelection(option.id)}
                  />
                </Fragment>
              );
            })}
          </div>

          <div className="@container/actions">
            <ActionButtons
              actions={actionsWithDisabledState}
              align={normalizedFooterActions.align}
              confirmTimeout={normalizedFooterActions.confirmTimeout}
              onAction={handleFooterAction}
              onBeforeAction={
                onBeforeAction
                  ? (actionId) =>
                      onBeforeAction(actionId, toSelectionState(selectedIds))
                  : undefined
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
