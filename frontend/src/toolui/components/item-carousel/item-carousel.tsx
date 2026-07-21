"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { cn, Button, Card, ChevronLeft, ChevronRight } from "./_adapter";
import { ItemCard } from "./item-card";
import { prefersReducedMotion } from "../shared/utils";
import type { ItemCarouselProps } from "./schema";

const SCROLL_PADDING_STYLE = { scrollPaddingInline: "1rem" };

const SCROLL_EDGE_THRESHOLD_PX = 8;
const SNAP_EPSILON_PX = 5;
const SCROLL_ANIMATION_DURATION_MS = 300;
const PAGE_SCROLL_RATIO = 0.8;
const PAGE_SCROLL_BREAKPOINT_PX = 640;

type ScrollDirection = "left" | "right";

interface ScrollAnimationState {
  target: number;
  start: number;
  startTime: number;
  duration: number;
  onComplete?: () => void;
}

function useSmoothScroll() {
  const animationRef = useRef<ScrollAnimationState | null>(null);
  const frameRef = useRef<number | null>(null);

  const cancelAnimation = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    animationRef.current = null;
  }, []);

  useEffect(() => cancelAnimation, [cancelAnimation]);

  const scrollTo = useCallback(
    (
      element: HTMLElement,
      target: number,
      duration = SCROLL_ANIMATION_DURATION_MS,
      onComplete?: () => void,
    ) => {
      if (prefersReducedMotion() || duration <= 0) {
        element.scrollLeft = target;
        onComplete?.();
        return;
      }

      cancelAnimation();

      animationRef.current = {
        target,
        start: element.scrollLeft,
        startTime: performance.now(),
        duration,
        onComplete,
      };

      element.style.scrollSnapType = "none";

      const step = () => {
        const anim = animationRef.current;
        if (!anim) return;

        const elapsed = performance.now() - anim.startTime;
        const progress = Math.min(elapsed / anim.duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);

        element.scrollLeft = anim.start + (anim.target - anim.start) * eased;

        if (progress < 1) {
          frameRef.current = requestAnimationFrame(step);
          return;
        }

        element.scrollLeft = anim.target;
        const callback = anim.onComplete;
        cancelAnimation();

        requestAnimationFrame(() => {
          element.style.scrollSnapType = "";
          callback?.();
        });
      };

      frameRef.current = requestAnimationFrame(step);
    },
    [cancelAnimation],
  );

  const isAnimating = useCallback(
    () => animationRef.current !== null && frameRef.current !== null,
    [],
  );

  return { scrollTo, isAnimating, cancelAnimation };
}

function useScrollEdgeState(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  itemCount: number,
) {
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateState = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;

    const scrollLeft = Math.round(container.scrollLeft);
    const maxScroll = Math.max(
      0,
      Math.round(container.scrollWidth - container.clientWidth),
    );

    setCanScrollLeft(scrollLeft > SCROLL_EDGE_THRESHOLD_PX);
    setCanScrollRight(scrollLeft < maxScroll - SCROLL_EDGE_THRESHOLD_PX);
  }, [scrollRef]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    let rafId: number | null = null;

    const scheduleUpdate = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateState();
      });
    };

    scheduleUpdate();

    container.addEventListener("scroll", scheduleUpdate, { passive: true });
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(container);

    return () => {
      container.removeEventListener("scroll", scheduleUpdate);
      resizeObserver.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [scrollRef, updateState, itemCount]);

  return { canScrollLeft, canScrollRight };
}

function CarouselNavButton({
  direction,
  visible,
  onClick,
}: {
  direction: ScrollDirection;
  visible: boolean;
  onClick: () => void;
}) {
  const isLeft = direction === "left";
  const Icon = isLeft ? ChevronLeft : ChevronRight;

  return (
    <Button
      type="button"
      variant="secondary"
      size="icon-sm"
      className={cn(
        "pointer-events-none scale-90 border-none opacity-0",
        "bg-background/60 absolute inset-y-0 z-20 my-auto hidden h-[6cqh] min-h-[50px] rounded-2xl backdrop-blur-lg",
        "transition-[opacity,transform] duration-250 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
        "@md:flex",
        isLeft ? "left-1.5" : "right-1.5",
        visible &&
          "pointer-events-auto scale-100 opacity-100 @md:group-focus-within:pointer-events-auto @md:group-focus-within:scale-100 @md:group-focus-within:opacity-100 @md:group-hover:pointer-events-auto @md:group-hover:scale-100 @md:group-hover:opacity-100",
      )}
      onClick={onClick}
      aria-label={isLeft ? "Scroll left" : "Scroll right"}
      tabIndex={visible ? 0 : -1}
      aria-hidden={!visible}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}

interface ItemCarouselHeaderProps {
  title?: string;
  description?: string;
}

function ItemCarouselHeader({ title, description }: ItemCarouselHeaderProps) {
  if (!title && !description) return null;

  return (
    <div className="px-4 pt-4 pb-1">
      {title && (
        <h3 className="text-[15px] leading-tight font-semibold tracking-tight">
          {title}
        </h3>
      )}
      {description && (
        <p className="text-muted-foreground mt-1 text-sm leading-snug">
          {description}
        </p>
      )}
    </div>
  );
}

interface EmptyStateProps {
  id: string;
  className?: string;
}

function EmptyState({ id, className }: EmptyStateProps) {
  return (
    <Card
      data-tool-ui-id={id}
      data-slot="item-carousel"
      className={cn("flex h-48 items-center justify-center", className)}
    >
      <p className="text-muted-foreground text-sm">No items to display</p>
    </Card>
  );
}

function ItemCarouselRoot({
  id,
  title,
  description,
  items,
  className,
  onItemClick,
  onItemAction,
}: ItemCarouselProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const targetIndexRef = useRef<number | null>(null);

  const { scrollTo, isAnimating } = useSmoothScroll();
  const { canScrollLeft, canScrollRight } = useScrollEdgeState(
    scrollRef,
    items.length,
  );

  const scroll = useCallback(
    (direction: ScrollDirection) => {
      const container = scrollRef.current;
      if (!container) return;

      const paddingValue = window.getComputedStyle(container).scrollPaddingLeft;
      const scrollPaddingLeft = Number.isFinite(Number.parseFloat(paddingValue))
        ? Number.parseFloat(paddingValue)
        : 0;

      const itemElements = Array.from(
        container.querySelectorAll<HTMLElement>("[data-carousel-item]"),
      );
      if (itemElements.length === 0) return;

      const snapPositions = itemElements.map((el) =>
        Math.max(0, el.offsetLeft - scrollPaddingLeft),
      );

      const scrollLeft = Math.round(container.scrollLeft);
      let currentIndex: number;
      if (isAnimating()) {
        currentIndex = Math.min(
          targetIndexRef.current ?? 0,
          snapPositions.length - 1,
        );
      } else {
        currentIndex = snapPositions.length - 1;
        for (let i = 0; i < snapPositions.length; i++) {
          const snap = snapPositions[i];
          if (Math.abs(snap - scrollLeft) < SNAP_EPSILON_PX) {
            currentIndex = i;
            break;
          }
          if (snap > scrollLeft) {
            currentIndex = Math.max(0, i - 1);
            break;
          }
        }
      }

      const itemStep =
        itemElements.length > 1
          ? itemElements[1].offsetLeft - itemElements[0].offsetLeft
          : 0;
      const safeStep =
        itemStep > 0 ? itemStep : itemElements[0].offsetWidth || 1;

      const pageIndexStep =
        container.clientWidth >= PAGE_SCROLL_BREAKPOINT_PX
          ? Math.max(
              1,
              Math.floor(
                (container.clientWidth * PAGE_SCROLL_RATIO) / safeStep,
              ),
            )
          : 1;

      const targetIndex =
        direction === "right"
          ? Math.min(currentIndex + pageIndexStep, itemElements.length - 1)
          : Math.max(currentIndex - pageIndexStep, 0);

      targetIndexRef.current = targetIndex;
      const targetScrollLeft = snapPositions[targetIndex];

      if (Math.abs(targetScrollLeft - container.scrollLeft) > 1) {
        scrollTo(
          container,
          targetScrollLeft,
          SCROLL_ANIMATION_DURATION_MS,
          () => {
            targetIndexRef.current = null;
          },
        );
      }
    },
    [scrollTo, isAnimating],
  );

  const handleScrollLeft = useCallback(() => scroll("left"), [scroll]);
  const handleScrollRight = useCallback(() => scroll("right"), [scroll]);

  if (items.length === 0) {
    return <EmptyState id={id} className={className} />;
  }

  return (
    <div
      data-tool-ui-id={id}
      data-slot="item-carousel"
      className={cn(
        "bg-background @container relative isolate w-full gap-0 overflow-hidden rounded-2xl border p-0",
        className,
      )}
    >
      <ItemCarouselHeader title={title} description={description} />

      <div className="group relative">
        <CarouselNavButton
          direction="left"
          visible={canScrollLeft}
          onClick={handleScrollLeft}
        />
        <CarouselNavButton
          direction="right"
          visible={canScrollRight}
          onClick={handleScrollRight}
        />

        <div
          ref={scrollRef}
          className={cn(
            "grid auto-cols-max grid-flow-col gap-4 overflow-x-auto overscroll-x-contain p-4",
            "snap-x snap-mandatory",
          )}
          role="list"
          style={SCROLL_PADDING_STYLE}
        >
          {items.map((item) => (
            <div
              key={item.id}
              data-carousel-item
              data-item-id={item.id}
              role="listitem"
              className="flex snap-start snap-always"
            >
              <ItemCard
                item={item}
                onItemClick={onItemClick}
                onItemAction={onItemAction}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type ItemCarouselComponent = typeof ItemCarouselRoot & {
  Root: typeof ItemCarouselRoot;
  Header: typeof ItemCarouselHeader;
  EmptyState: typeof EmptyState;
  NavButton: typeof CarouselNavButton;
  Card: typeof ItemCard;
};

export const ItemCarousel = Object.assign(ItemCarouselRoot, {
  Root: ItemCarouselRoot,
  Header: ItemCarouselHeader,
  EmptyState,
  NavButton: CarouselNavButton,
  Card: ItemCard,
}) as ItemCarouselComponent;
