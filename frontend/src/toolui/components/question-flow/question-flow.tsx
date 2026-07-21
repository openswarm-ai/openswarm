"use client";

import {
  useMemo,
  useState,
  useCallback,
  useRef,
  useEffect,
  Fragment,
} from "react";
import type { KeyboardEvent } from "react";
import type {
  QuestionFlowProps,
  QuestionFlowProgressiveProps,
  QuestionFlowUpfrontProps,
  QuestionFlowReceiptProps,
  QuestionFlowOption,
} from "./schema";
import { cn, Button, Separator } from "./_adapter";
import { Check, ChevronLeft } from "lucide-react";

interface SelectionIndicatorProps {
  mode: "single" | "multi";
  isSelected: boolean;
  disabled?: boolean;
}

interface ProgressBarProps {
  current: number;
  total: number;
}

function ProgressBar({ current, total }: ProgressBarProps) {
  return (
    <div
      className="flex h-1.5 gap-1"
      role="progressbar"
      aria-valuenow={current}
      aria-valuemin={1}
      aria-valuemax={total}
    >
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className="relative flex-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              "absolute inset-0 origin-left rounded-full bg-primary",
              "motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-[var(--cubic-ease-in-out)]",
              i < current ? "scale-x-100" : "scale-x-0",
            )}
          />
        </div>
      ))}
    </div>
  );
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
        "flex size-4 shrink-0 items-center justify-center border-2",
        "motion-safe:transition-colors motion-safe:duration-200",
        shape,
        isSelected && [
          "border-primary bg-primary text-primary-foreground",
          "motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-75 motion-safe:duration-300 motion-safe:ease-out",
        ],
        !isSelected && "border-muted-foreground/50",
        disabled && "opacity-50",
      )}
    >
      {mode === "multi" && isSelected && (
        <Check
          className="size-3 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-75 motion-safe:delay-75 motion-safe:duration-200 motion-safe:fill-mode-both"
          strokeWidth={3}
        />
      )}
      {mode === "single" && isSelected && (
        <span className="size-2 rounded-full bg-current motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-75 motion-safe:duration-300 motion-safe:ease-out" />
      )}
    </div>
  );
}

interface OptionItemProps {
  option: QuestionFlowOption;
  isSelected: boolean;
  isDisabled: boolean;
  selectionMode: "single" | "multi";
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
        "rounded-none border-0 bg-transparent px-0 py-2 text-base shadow-none transition-none hover:bg-transparent! @md/question-flow:text-sm",
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

function QuestionFlowReceipt({
  id,
  choice,
  className,
}: QuestionFlowReceiptProps) {
  return (
    <div
      className={cn(
        "@container/question-flow flex w-full min-w-80 max-w-md flex-col",
        "text-foreground",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:blur-in-sm motion-safe:zoom-in-95 motion-safe:duration-300 motion-safe:ease-out motion-safe:fill-mode-both",
        className,
      )}
      data-slot="question-flow"
      data-tool-ui-id={id}
      data-receipt="true"
      role="status"
      aria-label={choice.title}
    >
      <div
        className={cn(
          "bg-card/60 flex w-full flex-col gap-3 rounded-2xl border px-5 py-4 shadow-xs",
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-base font-medium">{choice.title}</span>
          <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-500">
            <Check className="size-3.5" />
            Complete
          </span>
        </div>
        <div className="flex flex-col">
          {choice.summary.map((item, index) => (
            <Fragment key={index}>
              {index > 0 && <Separator className="my-2" />}
              <div
                className="flex flex-col gap-0.5 text-sm motion-safe:animate-in motion-safe:fade-in motion-safe:blur-in-sm motion-safe:slide-in-from-bottom-1 motion-safe:duration-300 motion-safe:ease-out motion-safe:fill-mode-both"
                style={{ animationDelay: `${150 + index * 75}ms` }}
              >
                <span className="text-muted-foreground">{item.label}</span>
                <span className="font-medium">{item.value}</span>
              </div>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

interface StepBodyData {
  stepKey: string;
  title: string;
  description?: string;
  options: QuestionFlowOption[];
  selectionMode: "single" | "multi";
  selectedIds: Set<string>;
}

export function getQuestionFlowStepIds(id: string, stepKey: string) {
  const safeId = encodeURIComponent(id).replace(/%/g, "_");
  const safeStepKey = encodeURIComponent(stepKey).replace(/%/g, "_");
  return {
    titleId: `${safeId}-${safeStepKey}-title`,
    descriptionId: `${safeId}-${safeStepKey}-description`,
  };
}

interface StepContentProps {
  step: number;
  totalSteps?: number;
  title: string;
  description?: string;
  options: QuestionFlowOption[];
  selectionMode: "single" | "multi";
  selectedIds: Set<string>;
  onToggle: (optionId: string) => void;
  onBack?: () => void;
  onNext: () => void;
  showBack: boolean;
  isLastStep: boolean;
  id: string;
  className?: string;
  stepKey?: string;
  exitingStepData?: StepBodyData | null;
  transitionDirection?: "forward" | "backward";
}

function StepBodyContent({
  stepKey,
  title,
  description,
  options,
  selectionMode,
  selectedIds,
  onToggle,
  id,
  isExiting,
  transitionDirection,
}: {
  stepKey: string;
  title: string;
  description?: string;
  options: QuestionFlowOption[];
  selectionMode: "single" | "multi";
  selectedIds: Set<string>;
  onToggle?: (optionId: string) => void;
  id: string;
  isExiting?: boolean;
  transitionDirection?: "forward" | "backward";
}) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const { titleId, descriptionId } = getQuestionFlowStepIds(id, stepKey);

  const optionStates = useMemo(() => {
    return options.map((option) => {
      const isSelected = selectedIds.has(option.id);
      const isDisabled = option.disabled ?? false;
      return { option, isSelected, isDisabled };
    });
  }, [options, selectedIds]);

  const [activeIndex, setActiveIndex] = useState(() => {
    const firstSelected = optionStates.findIndex(
      (s) => s.isSelected && !s.isDisabled,
    );
    if (firstSelected >= 0) return firstSelected;
    const firstEnabled = optionStates.findIndex((s) => !s.isDisabled);
    return firstEnabled >= 0 ? firstEnabled : 0;
  });

  const focusOptionAt = useCallback((index: number) => {
    const el = optionRefs.current[index];
    if (el) el.focus();
    setActiveIndex(index);
  }, []);

  const findNextEnabledIndex = useCallback(
    (start: number, direction: 1 | -1) => {
      const len = optionStates.length;
      if (len === 0) return 0;
      for (let s = 1; s <= len; s++) {
        const idx = (start + direction * s + len) % len;
        if (!optionStates[idx].isDisabled) return idx;
      }
      return start;
    },
    [optionStates],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (optionStates.length === 0 || isExiting) return;

      const key = e.key;

      if (key === "ArrowDown") {
        e.preventDefault();
        focusOptionAt(findNextEnabledIndex(activeIndex, 1));
        return;
      }

      if (key === "ArrowUp") {
        e.preventDefault();
        focusOptionAt(findNextEnabledIndex(activeIndex, -1));
        return;
      }

      if (key === "Home") {
        e.preventDefault();
        const first = optionStates.findIndex((s) => !s.isDisabled);
        focusOptionAt(first >= 0 ? first : 0);
        return;
      }

      if (key === "End") {
        e.preventDefault();
        for (let i = optionStates.length - 1; i >= 0; i--) {
          if (!optionStates[i].isDisabled) {
            focusOptionAt(i);
            return;
          }
        }
        return;
      }

      if (key === "Enter" || key === " ") {
        e.preventDefault();
        const current = optionStates[activeIndex];
        if (!current || current.isDisabled) return;
        onToggle?.(current.option.id);
        return;
      }
    },
    [
      activeIndex,
      findNextEnabledIndex,
      focusOptionAt,
      isExiting,
      onToggle,
      optionStates,
    ],
  );

  const isTransitioning = transitionDirection !== undefined;

  const enterClass =
    transitionDirection === "forward"
      ? "motion-safe:slide-in-from-right-4"
      : "motion-safe:slide-in-from-left-4";

  const exitClass =
    transitionDirection === "forward"
      ? "motion-safe:slide-out-to-left-4"
      : "motion-safe:slide-out-to-right-4";

  return (
    <div
      key={stepKey}
      className={cn(
        "flex flex-col gap-4",
        isExiting && [
          "absolute inset-0",
          "motion-safe:animate-out motion-safe:fade-out motion-safe:blur-out-sm motion-safe:duration-250 motion-safe:ease-[var(--cubic-ease-in-out)] motion-safe:fill-mode-forwards",
          exitClass,
        ],
        !isExiting &&
          isTransitioning && [
            "motion-safe:animate-in motion-safe:fade-in motion-safe:blur-in-sm motion-safe:duration-250 motion-safe:ease-[var(--cubic-ease-in-out)] motion-safe:fill-mode-both",
            enterClass,
          ],
      )}
      aria-hidden={isExiting}
    >
      <div className="flex flex-col gap-1">
        <h2 id={titleId} className="text-lg font-semibold leading-tight">
          {title}
        </h2>
        {description && (
          <p id={descriptionId} className="text-muted-foreground text-sm">
            {description}
          </p>
        )}
      </div>

      <div
        className="flex flex-col px-1"
        role="listbox"
        aria-multiselectable={selectionMode === "multi"}
        onKeyDown={isExiting ? undefined : handleKeyDown}
      >
        {optionStates.map(({ option, isSelected, isDisabled }, index) => (
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
              isDisabled={isExiting || isDisabled}
              selectionMode={selectionMode}
              isFirst={index === 0}
              isLast={index === optionStates.length - 1}
              tabIndex={isExiting ? -1 : index === activeIndex ? 0 : -1}
              onFocus={() => !isExiting && setActiveIndex(index)}
              buttonRef={(el) => {
                optionRefs.current[index] = el;
              }}
              onToggle={() => !isExiting && onToggle?.(option.id)}
            />
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function StepContent({
  step,
  totalSteps,
  title,
  description,
  options,
  selectionMode,
  selectedIds,
  onToggle,
  onBack,
  onNext,
  showBack,
  isLastStep,
  id,
  className,
  stepKey,
  exitingStepData,
  transitionDirection = "forward",
}: StepContentProps) {
  const isTransitioning =
    exitingStepData !== null && exitingStepData !== undefined;
  const canProceed = selectedIds.size > 0;
  const resolvedStepKey = stepKey ?? "current";
  const { titleId, descriptionId } = getQuestionFlowStepIds(
    id,
    resolvedStepKey,
  );

  const stepLabel = totalSteps
    ? `Step ${step} of ${totalSteps}`
    : `Step ${step}`;

  return (
    <div
      className={cn(
        "@container/question-flow flex w-full min-w-80 max-w-md flex-col gap-3",
        "text-foreground",
        className,
      )}
      data-slot="question-flow"
      data-tool-ui-id={id}
      role="form"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
    >
      <div
        className={cn(
          "bg-card flex w-full flex-col gap-4 rounded-2xl border p-5 shadow-xs",
        )}
      >
        <div className="flex flex-col gap-1">
          <div className="flex flex-col gap-2">
            <span
              className="text-muted-foreground text-xs font-medium uppercase tracking-wide"
              aria-label={stepLabel}
            >
              {stepLabel}
            </span>
            {totalSteps && <ProgressBar current={step} total={totalSteps} />}
          </div>
        </div>

        <div className="relative mt-1">
          {exitingStepData && (
            <StepBodyContent
              key={exitingStepData.stepKey}
              stepKey={exitingStepData.stepKey}
              title={exitingStepData.title}
              description={exitingStepData.description}
              options={exitingStepData.options}
              selectionMode={exitingStepData.selectionMode}
              selectedIds={exitingStepData.selectedIds}
              id={id}
              isExiting
              transitionDirection={transitionDirection}
            />
          )}
          <StepBodyContent
            key={resolvedStepKey}
            stepKey={resolvedStepKey}
            title={title}
            description={description}
            options={options}
            selectionMode={selectionMode}
            selectedIds={selectedIds}
            onToggle={onToggle}
            id={id}
            isExiting={false}
            transitionDirection={
              exitingStepData ? transitionDirection : undefined
            }
          />
        </div>

        <div className="flex items-center justify-between pt-2">
          {showBack ? (
            <Button
              variant="ghost"
              size="default"
              onClick={onBack}
              disabled={isTransitioning}
              className="gap-1 rounded-full text-muted-foreground"
            >
              <ChevronLeft className="size-4" />
              Back
            </Button>
          ) : (
            <div />
          )}
          <Button
            variant="default"
            size="default"
            onClick={onNext}
            disabled={!canProceed || isTransitioning}
            className="rounded-full"
          >
            {isLastStep ? "Complete" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function QuestionFlowProgressive({
  id,
  step,
  title,
  description,
  options,
  selectionMode = "single",
  defaultValue,
  onSelect,
  onBack,
  className,
}: QuestionFlowProgressiveProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(defaultValue ?? []),
  );

  const handleToggle = useCallback(
    (optionId: string) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (selectionMode === "single") {
          if (next.has(optionId)) {
            next.delete(optionId);
          } else {
            next.clear();
            next.add(optionId);
          }
        } else {
          if (next.has(optionId)) {
            next.delete(optionId);
          } else {
            next.add(optionId);
          }
        }
        return next;
      });
    },
    [selectionMode],
  );

  const handleNext = useCallback(() => {
    if (selectedIds.size === 0) return;
    const selection = Array.from(selectedIds);
    onSelect?.(selection);
  }, [onSelect, selectedIds]);

  return (
    <StepContent
      id={id}
      step={step}
      title={title}
      description={description}
      options={options}
      selectionMode={selectionMode}
      selectedIds={selectedIds}
      onToggle={handleToggle}
      onBack={onBack}
      onNext={handleNext}
      showBack={step > 1 && onBack !== undefined}
      isLastStep={false}
      className={className}
    />
  );
}

function QuestionFlowUpfront({
  id,
  steps,
  onStepChange,
  onComplete,
  className,
}: QuestionFlowUpfrontProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [exitingStepData, setExitingStepData] = useState<StepBodyData | null>(
    null,
  );
  const [transitionDirection, setTransitionDirection] = useState<
    "forward" | "backward"
  >("forward");

  const currentStep = steps[currentStepIndex];
  const isLastStep = currentStepIndex === steps.length - 1;
  const totalSteps = steps.length;

  useEffect(() => {
    if (exitingStepData) {
      const timer = setTimeout(() => setExitingStepData(null), 250);
      return () => clearTimeout(timer);
    }
  }, [exitingStepData]);

  const currentSelection = useMemo(() => {
    const answer = answers[currentStep.id];
    return new Set(answer ?? []);
  }, [answers, currentStep.id]);

  const handleToggle = useCallback(
    (optionId: string) => {
      const mode = currentStep.selectionMode ?? "single";
      setAnswers((prev) => {
        const current = prev[currentStep.id] ?? [];
        let next: string[];

        if (mode === "single") {
          next = current.includes(optionId) ? [] : [optionId];
        } else {
          next = current.includes(optionId)
            ? current.filter((id) => id !== optionId)
            : [...current, optionId];
        }

        return { ...prev, [currentStep.id]: next };
      });
    },
    [currentStep.id, currentStep.selectionMode],
  );

  const handleBack = useCallback(() => {
    if (currentStepIndex > 0) {
      const currentStepData = steps[currentStepIndex];
      const stepOptions: QuestionFlowOption[] = currentStepData.options.map(
        (opt) => ({
          ...opt,
          icon: undefined,
        }),
      );

      setExitingStepData({
        stepKey: currentStepData.id,
        title: currentStepData.title,
        description: currentStepData.description,
        options: stepOptions,
        selectionMode: currentStepData.selectionMode ?? "single",
        selectedIds: new Set(answers[currentStepData.id] ?? []),
      });
      setTransitionDirection("backward");
      const prevIndex = currentStepIndex - 1;
      setCurrentStepIndex(prevIndex);
      onStepChange?.(steps[prevIndex].id);
    }
  }, [answers, currentStepIndex, onStepChange, steps]);

  const handleNext = useCallback(() => {
    if (currentSelection.size === 0) return;

    if (isLastStep) {
      onComplete?.(answers);
    } else {
      const currentStepData = steps[currentStepIndex];
      const stepOptions: QuestionFlowOption[] = currentStepData.options.map(
        (opt) => ({
          ...opt,
          icon: undefined,
        }),
      );

      setExitingStepData({
        stepKey: currentStepData.id,
        title: currentStepData.title,
        description: currentStepData.description,
        options: stepOptions,
        selectionMode: currentStepData.selectionMode ?? "single",
        selectedIds: new Set(answers[currentStepData.id] ?? []),
      });
      setTransitionDirection("forward");
      const nextIndex = currentStepIndex + 1;
      setCurrentStepIndex(nextIndex);
      onStepChange?.(steps[nextIndex].id);
    }
  }, [
    answers,
    currentSelection.size,
    currentStepIndex,
    isLastStep,
    onComplete,
    onStepChange,
    steps,
  ]);

  const stepOptions: QuestionFlowOption[] = currentStep.options.map((opt) => ({
    ...opt,
    icon: undefined,
  }));

  return (
    <StepContent
      id={id}
      step={currentStepIndex + 1}
      totalSteps={totalSteps}
      title={currentStep.title}
      description={currentStep.description}
      options={stepOptions}
      selectionMode={currentStep.selectionMode ?? "single"}
      selectedIds={currentSelection}
      onToggle={handleToggle}
      onBack={handleBack}
      onNext={handleNext}
      showBack={currentStepIndex > 0}
      isLastStep={isLastStep}
      className={className}
      stepKey={currentStep.id}
      exitingStepData={exitingStepData}
      transitionDirection={transitionDirection}
    />
  );
}

export function QuestionFlow(props: QuestionFlowProps) {
  if ("choice" in props && props.choice !== undefined) {
    return <QuestionFlowReceipt {...(props as QuestionFlowReceiptProps)} />;
  }

  if ("steps" in props && props.steps !== undefined) {
    return <QuestionFlowUpfront {...(props as QuestionFlowUpfrontProps)} />;
  }

  return (
    <QuestionFlowProgressive {...(props as QuestionFlowProgressiveProps)} />
  );
}
