"use client";

import * as React from "react";
import { useMemo, useState, useEffect, useRef, memo } from "react";
import { Loader2, Check, X, MoreHorizontal, ChevronRight } from "lucide-react";
import type { PlanProps, PlanTodo, PlanTodoStatus } from "./schema";
import {
  cn,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./_adapter";
import { calculatePlanProgress, shouldCelebrateProgress } from "./progress";

const INITIAL_VISIBLE_TODO_COUNT = 4;

const TodoIcon = memo(function TodoIcon({
  status,
}: {
  status: PlanTodoStatus;
}) {
  if (status === "pending") {
    return (
      <span
        className="border-border bg-card flex size-6 shrink-0 items-center justify-center rounded-full border motion-safe:transition-all motion-safe:duration-200"
        aria-hidden="true"
      />
    );
  }

  if (status === "in_progress") {
    return (
      <span
        className="border-border bg-card flex size-6 shrink-0 items-center justify-center rounded-full border shadow-[0_0_0_4px_hsl(var(--primary)/0.1)] motion-safe:transition-all motion-safe:duration-300"
        aria-hidden="true"
      >
        <Loader2 className="text-primary size-5 motion-safe:animate-spin" />
      </span>
    );
  }

  if (status === "completed") {
    return (
      <span
        className="border-primary bg-primary flex size-6 shrink-0 items-center justify-center rounded-full border shadow-sm motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-75 motion-safe:duration-300 motion-safe:ease-out"
        aria-hidden="true"
      >
        <Check
          className="text-primary-foreground size-4 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-75 motion-safe:delay-75 motion-safe:duration-200 motion-safe:fill-mode-both"
          strokeWidth={3}
        />
      </span>
    );
  }

  if (status === "cancelled") {
    return (
      <span
        className="border-destructive bg-destructive flex size-6 shrink-0 items-center justify-center rounded-full border shadow-sm motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-75 motion-safe:duration-300 motion-safe:ease-out dark:border-red-600 dark:bg-red-600"
        aria-hidden="true"
      >
        <X
          className="size-4 text-white motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-75 motion-safe:delay-75 motion-safe:duration-200 motion-safe:fill-mode-both"
          strokeWidth={3}
        />
      </span>
    );
  }

  return null;
});

interface PlanTodoItemProps {
  todo: PlanTodo;
  className?: string;
  style?: React.CSSProperties;
  showConnector?: boolean;
}

function areTodoPropsEqual(
  prev: PlanTodoItemProps,
  next: PlanTodoItemProps,
): boolean {
  if (prev.todo.id !== next.todo.id) return false;
  if (prev.todo.label !== next.todo.label) return false;
  if (prev.todo.status !== next.todo.status) return false;
  if (prev.todo.description !== next.todo.description) return false;
  if (prev.showConnector !== next.showConnector) return false;
  if (prev.className !== next.className) return false;
  const prevStyle = prev.style;
  const nextStyle = next.style;
  if (prevStyle === nextStyle) return true;
  if (!prevStyle || !nextStyle) return false;
  return (
    prevStyle.animationDelay === nextStyle.animationDelay &&
    prevStyle.animationFillMode === nextStyle.animationFillMode
  );
}

const PlanTodoItem = memo(function PlanTodoItem({
  todo,
  className,
  style,
  showConnector,
}: PlanTodoItemProps) {
  const [isOpen, setIsOpen] = React.useState(false);

  const labelElement = (
    <span
      className={cn(
        "text-sm leading-6 font-medium break-words",
        todo.status === "pending" && "text-muted-foreground",
        todo.status === "in_progress" &&
          "motion-safe:shimmer shimmer-invert text-foreground",
        (todo.status === "completed" || todo.status === "cancelled") &&
          "text-muted-foreground",
      )}
    >
      {todo.label}
    </span>
  );

  if (!todo.description) {
    return (
      <li
        className={cn(
          "relative -mx-2 flex cursor-default items-start gap-3 rounded-md px-2 py-1.5",
          className,
        )}
        style={style}
      >
        {showConnector && (
          <div
            className="bg-border absolute top-6 left-5 w-px"
            style={{
              height: "calc(100% + 0.25rem)",
            }}
            aria-hidden="true"
          />
        )}
        <div className="relative z-10">
          <TodoIcon status={todo.status} />
        </div>
        <div className="min-w-0 flex-1">{labelElement}</div>
      </li>
    );
  }

  return (
    <li
      className={cn(
        "relative -mx-2 min-w-0 cursor-default rounded-md",
        className,
      )}
      style={style}
    >
      {showConnector && (
        <div
          className="bg-border absolute top-6 left-5 w-px"
          style={{
            height: "calc(100% + 0.25rem)",
          }}
          aria-hidden="true"
        />
      )}
      <Collapsible asChild open={isOpen} onOpenChange={setIsOpen}>
        <div
          className="data-[state=open]:bg-primary/5 min-w-0 rounded-md motion-safe:transition-all motion-safe:duration-200"
          style={{
            backdropFilter: isOpen ? "blur(2px)" : undefined,
          }}
        >
          <CollapsibleTrigger className="group/todo flex w-full cursor-default items-start gap-3 px-2 py-1.5 text-left">
            <div className="relative z-10">
              <TodoIcon status={todo.status} />
            </div>
            <span className="min-w-0 flex-1">{labelElement}</span>
            <ChevronRight className="text-muted-foreground/50 group-hover/todo:text-muted-foreground mt-0.5 size-4 shrink-0 rotate-90 group-data-[state=open]/todo:[transform:rotateY(180deg)] motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.34,1.56,0.64,1)]" />
          </CollapsibleTrigger>
          <CollapsibleContent
            className="group/content"
            data-slot="collapsible-content"
          >
            <div className="min-w-0 motion-safe:group-data-[state=closed]/content:animate-out motion-safe:group-data-[state=closed]/content:fade-out motion-safe:group-data-[state=closed]/content:slide-out-to-top-1 motion-safe:group-data-[state=closed]/content:duration-150 motion-safe:group-data-[state=open]/content:animate-in motion-safe:group-data-[state=open]/content:fade-in motion-safe:group-data-[state=open]/content:slide-in-from-top-1 motion-safe:group-data-[state=open]/content:delay-75 motion-safe:group-data-[state=open]/content:duration-150 motion-safe:group-data-[state=open]/content:fill-mode-both">
              <p className="text-muted-foreground min-w-0 pr-2 pb-1.5 pl-11 text-sm text-pretty break-words">
                {todo.description}
              </p>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </li>
  );
}, areTodoPropsEqual);

interface TodoListProps {
  todos: PlanTodo[];
  newTodoIds: Set<string>;
}

function TodoList({ todos, newTodoIds }: TodoListProps) {
  return (
    <>
      {todos.map((todo, index) => {
        const isNew = newTodoIds.has(todo.id);
        const staggerDelay = isNew ? index * 50 : 0;

        return (
          <PlanTodoItem
            key={todo.id}
            todo={todo}
            showConnector={index < todos.length - 1}
            className={cn(
              isNew &&
                "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-300 motion-safe:ease-out",
            )}
            style={
              isNew
                ? {
                    animationDelay: `${staggerDelay}ms`,
                    animationFillMode: "backwards",
                  }
                : undefined
            }
          />
        );
      })}
    </>
  );
}

interface ProgressBarProps {
  progress: number;
  isCelebrating: boolean;
}

const ProgressBar = memo(function ProgressBar({
  progress,
  isCelebrating,
}: ProgressBarProps) {
  return (
    <div
      className="bg-muted relative mb-3 h-1.5 overflow-hidden rounded-full"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
    >
      <div
        className={cn(
          "h-full rounded-full transition-all duration-500",
          progress === 100
            ? "bg-gradient-to-r from-emerald-600 via-emerald-500 to-emerald-400 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500 motion-safe:ease-out"
            : "bg-primary",
        )}
        style={{
          width: `${progress}%`,
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.3), 0 1px 2px rgba(0,0,0,0.2)",
        }}
      />
      {isCelebrating && (
        <div
          className="pointer-events-none absolute inset-0 rounded-full motion-safe:animate-pulse"
          style={{
            boxShadow: "0 0 20px rgba(16, 185, 129, 0.6)",
          }}
        />
      )}
    </div>
  );
});

function PlanRoot({
  id,
  title,
  description,
  todos,
  maxVisibleTodos = INITIAL_VISIBLE_TODO_COUNT,
  className,
  compact = false,
}: PlanProps & { compact?: boolean }) {
  const seenTodoIds = useRef(new Set<string>());
  const [newTodoIds, setNewTodoIds] = useState<Set<string>>(new Set());
  const [isCelebrating, setIsCelebrating] = useState(false);
  const prevProgressRef = useRef(0);

  const { visibleTodos, hiddenTodos, completedCount, allComplete, progress } =
    useMemo(() => {
      const completed = todos.filter((t) => t.status === "completed").length;
      return {
        visibleTodos: todos.slice(0, maxVisibleTodos),
        hiddenTodos: todos.slice(maxVisibleTodos),
        completedCount: completed,
        allComplete: completed === todos.length,
        progress: calculatePlanProgress({
          completedCount: completed,
          totalCount: todos.length,
        }),
      };
    }, [todos, maxVisibleTodos]);

  useEffect(() => {
    const newIds = new Set<string>();

    todos.forEach((todo) => {
      if (!seenTodoIds.current.has(todo.id)) {
        newIds.add(todo.id);
        seenTodoIds.current.add(todo.id);
      }
    });

    if (newIds.size > 0) {
      setNewTodoIds(newIds);

      // Clear animation class after entrance completes
      const timer = setTimeout(() => {
        setNewTodoIds(new Set());
      }, 500);

      return () => clearTimeout(timer);
    }
  }, [todos]);

  useEffect(() => {
    const shouldCelebrate = shouldCelebrateProgress({
      previous: prevProgressRef.current,
      next: progress,
    });
    prevProgressRef.current = progress;

    if (shouldCelebrate) {
      setIsCelebrating(true);
      const timer = setTimeout(() => setIsCelebrating(false), 1000);
      return () => clearTimeout(timer);
    }
  }, [progress]);

  const todoList = (
    <ul className={cn("min-w-0 space-y-1", compact ? "mt-0" : "mt-4")}>
      <TodoList todos={visibleTodos} newTodoIds={newTodoIds} />

      {hiddenTodos.length > 0 && (
        <li className="mt-1">
          <Accordion type="single" collapsible>
            <AccordionItem value="more" className="border-0">
              <AccordionTrigger className="text-muted-foreground hover:text-primary flex cursor-default items-start justify-start gap-2 py-1 text-sm font-normal [&>svg:last-child]:hidden">
                <MoreHorizontal className="text-muted-foreground/70 mt-0.5 size-4 shrink-0" />
                <span>{hiddenTodos.length} more</span>
              </AccordionTrigger>
              <AccordionContent className="pt-2 pb-0">
                <ul className="-mx-2 space-y-2 px-2">
                  <TodoList todos={hiddenTodos} newTodoIds={newTodoIds} />
                </ul>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </li>
      )}
    </ul>
  );

  return (
    <Card
      className={cn("isolate w-full max-w-xl min-w-80 gap-4 py-4", className)}
      data-tool-ui-id={id}
      data-slot="plan"
    >
      {!compact && (
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle className="leading-5 font-medium text-pretty">
              {title}
            </CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </div>
          {allComplete && (
            <Check className="mt-0.5 size-5 shrink-0 text-emerald-500" />
          )}
        </CardHeader>
      )}

      <CardContent className="min-w-0 px-4">
        <div
          className={cn(
            "min-w-0",
            !compact && "bg-muted/70 rounded-lg px-6 py-4",
          )}
        >
          {!compact && (
            <>
              <div className="text-muted-foreground mb-2 text-sm">
                {completedCount} of {todos.length} complete
              </div>
              <ProgressBar progress={progress} isCelebrating={isCelebrating} />
            </>
          )}
          {todoList}
        </div>
      </CardContent>
    </Card>
  );
}

function PlanComponent(props: PlanProps) {
  return <PlanRoot key={props.id} {...props} />;
}

export function PlanCompact(props: PlanProps) {
  return <PlanRoot key={props.id} {...props} compact />;
}

type PlanComponentType = typeof PlanComponent & {
  Compact: typeof PlanCompact;
};

export const Plan = Object.assign(PlanComponent, {
  Compact: PlanCompact,
}) as PlanComponentType;
