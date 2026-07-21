"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import type { ParameterSliderProps, SliderConfig, SliderValue } from "./schema";
import { ActionButtons } from "../shared/action-buttons";
import { normalizeActionsConfig } from "../shared/actions-config";
import { useControllableState } from "../shared/use-controllable-state";
import { useSignatureReset } from "../shared/use-signature-reset";

import { cn } from "./_adapter";
import {
  createSliderSignature,
  createSliderValueSnapshot,
  sliderRangeToPercent,
} from "./math";

function formatSignedValue(
  value: number,
  min: number,
  max: number,
  precision?: number,
  unit?: string,
): string {
  const crossesZero = min < 0 && max > 0;
  const fixed =
    precision !== undefined ? value.toFixed(precision) : String(value);
  const numericPart = crossesZero && value >= 0 ? `+${fixed}` : fixed;
  return unit ? `${numericPart} ${unit}` : numericPart;
}

function getAriaValueText(
  value: number,
  min: number,
  max: number,
  unit?: string,
): string {
  const crossesZero = min < 0 && max > 0;
  if (crossesZero) {
    if (value > 0) {
      return unit ? `plus ${value} ${unit}` : `plus ${value}`;
    } else if (value < 0) {
      return unit
        ? `minus ${Math.abs(value)} ${unit}`
        : `minus ${Math.abs(value)}`;
    }
  }
  return unit ? `${value} ${unit}` : String(value);
}

const TICK_COUNT = 16;
const TEXT_PADDING_X = 4;
const TEXT_PADDING_X_OUTER = 0; // Less inset on outer-facing side (near edges)
const TEXT_PADDING_Y = 2;
const DETECTION_MARGIN_X = 12;
const DETECTION_MARGIN_X_OUTER = 4; // Small margin at edges for steep falloff - segments fully close at terminal positions
const DETECTION_MARGIN_Y = 12;
const TRACK_HEIGHT = 48;
const TEXT_RELEASE_INSET = 8;
const TRACK_EDGE_INSET = 4; // px from track edge - keeps elements visible at extremes
const THUMB_WIDTH = 12; // w-3
// Text vertical offset: raised slightly from center
// Positive = raised, negative = lowered
const TEXT_VERTICAL_OFFSET = 0.5;

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

// Convert a percentage (0-100) to an inset position string
// At 0%: 4px from left edge; at 100%: 4px from right edge
function toInsetPosition(percent: number): string {
  const safePercent = clampPercent(percent);
  return `calc(${TRACK_EDGE_INSET}px + (100% - ${TRACK_EDGE_INSET * 2}px) * ${safePercent / 100})`;
}

// Radix keeps the thumb in bounds by applying a percent-dependent px offset.
// Matching this for fill clipping prevents handle/fill drift near extremes.
function getRadixThumbInBoundsOffsetPx(percent: number): number {
  const safePercent = clampPercent(percent);
  const halfWidth = THUMB_WIDTH / 2;
  return halfWidth - (safePercent * halfWidth) / 50;
}

function toRadixThumbPosition(percent: number): string {
  const safePercent = clampPercent(percent);
  const offsetPx = getRadixThumbInBoundsOffsetPx(safePercent);
  return `calc(${safePercent}% + ${offsetPx}px)`;
}

function signedDistanceToRoundedRect(
  px: number,
  py: number,
  left: number,
  right: number,
  top: number,
  bottom: number,
  radiusLeft: number,
  radiusRight: number,
): number {
  const innerLeft = left + radiusLeft;
  const innerRight = right - radiusRight;
  const innerTop = top + Math.max(radiusLeft, radiusRight);
  const innerBottom = bottom - Math.max(radiusLeft, radiusRight);

  const inLeftCorner = px < innerLeft;
  const inRightCorner = px > innerRight;
  const inCornerY = py < innerTop || py > innerBottom;

  if ((inLeftCorner || inRightCorner) && inCornerY) {
    const radius = inLeftCorner ? radiusLeft : radiusRight;
    const cornerX = inLeftCorner ? innerLeft : innerRight;
    const cornerY = py < innerTop ? top + radius : bottom - radius;
    const distToCornerCenter = Math.hypot(px - cornerX, py - cornerY);
    return distToCornerCenter - radius;
  }

  const dx = Math.max(left - px, px - right, 0);
  const dy = Math.max(top - py, py - bottom, 0);

  if (dx === 0 && dy === 0) {
    return -Math.min(px - left, right - px, py - top, bottom - py);
  }

  return Math.max(dx, dy);
}

const OUTER_EDGE_RADIUS_FACTOR = 0.3; // Reduced radius on outer-facing sides for steeper falloff

function calculateGap(
  thumbCenterX: number,
  textRect: { left: number; right: number; height: number; centerY: number },
  isLeftAligned: boolean,
): number {
  const { left, right, height, centerY } = textRect;
  // Asymmetric padding/margin: outer-facing side has less padding, more margin
  const paddingLeft = isLeftAligned ? TEXT_PADDING_X_OUTER : TEXT_PADDING_X;
  const paddingRight = isLeftAligned ? TEXT_PADDING_X : TEXT_PADDING_X_OUTER;
  const marginLeft = isLeftAligned
    ? DETECTION_MARGIN_X_OUTER
    : DETECTION_MARGIN_X;
  const marginRight = isLeftAligned
    ? DETECTION_MARGIN_X
    : DETECTION_MARGIN_X_OUTER;
  const paddingY = TEXT_PADDING_Y;
  const marginY = DETECTION_MARGIN_Y;
  const thumbCenterY = centerY;

  // Inner boundary (where max gap occurs)
  const innerLeft = left - paddingLeft;
  const innerRight = right + paddingRight;
  const innerTop = centerY - height / 2 - paddingY;
  const innerBottom = centerY + height / 2 + paddingY;
  const innerHeight = height + paddingY * 2;
  const innerRadius = innerHeight / 2;
  // Smaller radius on outer-facing side (left for label, right for value)
  const innerRadiusLeft = isLeftAligned
    ? innerRadius * OUTER_EDGE_RADIUS_FACTOR
    : innerRadius;
  const innerRadiusRight = isLeftAligned
    ? innerRadius
    : innerRadius * OUTER_EDGE_RADIUS_FACTOR;

  // Outer boundary (where effect starts) - proportionally larger
  const outerLeft = left - paddingLeft - marginLeft;
  const outerRight = right + paddingRight + marginRight;
  const outerTop = centerY - height / 2 - paddingY - marginY;
  const outerBottom = centerY + height / 2 + paddingY + marginY;
  const outerHeight = height + paddingY * 2 + marginY * 2;
  const outerRadius = outerHeight / 2;
  const outerRadiusLeft = isLeftAligned
    ? outerRadius * OUTER_EDGE_RADIUS_FACTOR
    : outerRadius;
  const outerRadiusRight = isLeftAligned
    ? outerRadius
    : outerRadius * OUTER_EDGE_RADIUS_FACTOR;

  const outerDist = signedDistanceToRoundedRect(
    thumbCenterX,
    thumbCenterY,
    outerLeft,
    outerRight,
    outerTop,
    outerBottom,
    outerRadiusLeft,
    outerRadiusRight,
  );

  // Outside outer boundary - no gap
  if (outerDist > 0) return 0;

  const innerDist = signedDistanceToRoundedRect(
    thumbCenterX,
    thumbCenterY,
    innerLeft,
    innerRight,
    innerTop,
    innerBottom,
    innerRadiusLeft,
    innerRadiusRight,
  );

  // Inside inner boundary - max gap
  const maxGap = height + paddingY * 2;
  if (innerDist <= 0) return maxGap;

  // Between boundaries - linear interpolation
  // outerDist is negative (inside outer), innerDist is positive (outside inner)
  const totalDist = Math.abs(outerDist) + innerDist;
  const t = Math.abs(outerDist) / totalDist;

  return maxGap * t;
}

interface SliderRowProps {
  config: SliderConfig;
  value: number;
  onChange: (value: number) => void;
  trackClassName?: string;
  fillClassName?: string;
  handleClassName?: string;
}

function SliderRow({
  config,
  value,
  onChange,
  trackClassName,
  fillClassName,
  handleClassName,
}: SliderRowProps) {
  const { id, label, min, max, step = 1, unit, precision, disabled } = config;
  // Per-slider theming overrides component-level theming
  const resolvedTrackClassName = config.trackClassName ?? trackClassName;
  const resolvedFillClassName = config.fillClassName ?? fillClassName;
  const resolvedHandleClassName = config.handleClassName ?? handleClassName;
  const crossesZero = min < 0 && max > 0;
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const trackRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const valueRef = useRef<HTMLSpanElement>(null);

  const [dragGap, setDragGap] = useState(0);
  const [fullGap, setFullGap] = useState(0);
  const [intersectsText, setIntersectsText] = useState(false);
  const [layoutVersion, setLayoutVersion] = useState(0);

  useEffect(() => {
    if (!isDragging) return;
    const handlePointerUp = () => setIsDragging(false);
    document.addEventListener("pointerup", handlePointerUp);
    return () => document.removeEventListener("pointerup", handlePointerUp);
  }, [isDragging]);

  useEffect(() => {
    const track = trackRef.current;
    const labelEl = labelRef.current;
    const valueEl = valueRef.current;
    if (!track || !labelEl || !valueEl) return;

    const bumpLayoutVersion = () => setLayoutVersion((v) => v + 1);

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        bumpLayoutVersion();
      });
      observer.observe(track);
      observer.observe(labelEl);
      observer.observe(valueEl);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", bumpLayoutVersion);
    return () => window.removeEventListener("resize", bumpLayoutVersion);
  }, []);

  useLayoutEffect(() => {
    const track = trackRef.current;
    const labelEl = labelRef.current;
    const valueEl = valueRef.current;

    if (!track || !labelEl || !valueEl) return;

    const trackRect = track.getBoundingClientRect();
    const labelRect = labelEl.getBoundingClientRect();
    const valueRect = valueEl.getBoundingClientRect();

    const trackWidth = trackRect.width;
    const valuePercent = sliderRangeToPercent({ value, min, max });
    // Use same inset coordinate system as visual elements
    const thumbCenterPx =
      (trackWidth * clampPercent(valuePercent)) / 100 +
      getRadixThumbInBoundsOffsetPx(valuePercent);
    const thumbHalfWidth = THUMB_WIDTH / 2;

    // Text is raised by TEXT_VERTICAL_OFFSET from center
    const trackCenterY = TRACK_HEIGHT / 2 - TEXT_VERTICAL_OFFSET;

    const labelGap = calculateGap(
      thumbCenterPx,
      {
        left: labelRect.left - trackRect.left,
        right: labelRect.right - trackRect.left,
        height: labelRect.height,
        centerY: trackCenterY,
      },
      true,
    ); // label is left-aligned

    const valueGap = calculateGap(
      thumbCenterPx,
      {
        left: valueRect.left - trackRect.left,
        right: valueRect.right - trackRect.left,
        height: valueRect.height,
        centerY: trackCenterY,
      },
      false,
    ); // value is right-aligned

    setDragGap(Math.max(labelGap, valueGap));

    // Tight intersection check for release state
    // Inset by px-2 (8px) padding to check against actual text, not padded container
    const labelLeft = labelRect.left - trackRect.left + TEXT_RELEASE_INSET;
    const labelRight = labelRect.right - trackRect.left - TEXT_RELEASE_INSET;
    const valueLeft = valueRect.left - trackRect.left + TEXT_RELEASE_INSET;
    const valueRight = valueRect.right - trackRect.left - TEXT_RELEASE_INSET;

    const thumbLeft = thumbCenterPx - thumbHalfWidth;
    const thumbRight = thumbCenterPx + thumbHalfWidth;

    const hitsLabel = thumbRight > labelLeft && thumbLeft < labelRight;
    const hitsValue = thumbRight > valueLeft && thumbLeft < valueRight;

    setIntersectsText(hitsLabel || hitsValue);

    // Calculate full separation gap for release state
    // Use the max gap of whichever text element(s) the handle intersects
    const labelFullGap = labelRect.height + TEXT_PADDING_Y * 2;
    const valueFullGap = valueRect.height + TEXT_PADDING_Y * 2;
    const releaseGap =
      hitsLabel && hitsValue
        ? Math.max(labelFullGap, valueFullGap)
        : hitsLabel
          ? labelFullGap
          : hitsValue
            ? valueFullGap
            : 0;
    setFullGap(releaseGap);
  }, [value, min, max, layoutVersion]);

  // While dragging: use distance-based separation, but never collapse below
  // the release split when the thumb still intersects text.
  const gap = isDragging
    ? Math.max(dragGap, intersectsText ? fullGap : 0)
    : intersectsText
      ? fullGap
      : 0;

  const ticks = useMemo(() => {
    // Generate equidistant ticks regardless of step value
    const majorTickCount = TICK_COUNT;
    const result: { percent: number; isCenter: boolean; isSubtick: boolean }[] =
      [];

    for (let i = 0; i <= majorTickCount; i++) {
      const percent = (i / majorTickCount) * 100;
      const isCenter = !crossesZero && percent === 50;

      // Skip the center tick (50%) for crossesZero sliders
      if (crossesZero && percent === 50) continue;

      // Add subtick at midpoint before this tick (except for first)
      if (i > 0) {
        const prevPercent = ((i - 1) / majorTickCount) * 100;
        // Don't add subtick if it would be at 50% for crossesZero
        const midPercent = (prevPercent + percent) / 2;
        if (!(crossesZero && midPercent === 50)) {
          result.push({
            percent: midPercent,
            isCenter: false,
            isSubtick: true,
          });
        }
      }

      result.push({ percent, isCenter, isSubtick: false });
    }

    return result;
  }, [crossesZero]);

  const zeroPercent = crossesZero
    ? sliderRangeToPercent({ value: 0, min, max })
    : 0;
  const valuePercent = sliderRangeToPercent({ value, min, max });

  // Fill clip-path uses the same inset coordinate system as the handle.
  // This keeps the collapsed stroke aligned with the fill edge near extremes.
  const fillClipPath = useMemo(() => {
    const toClipFromRightInset = (percent: number) =>
      `calc(100% - ${toRadixThumbPosition(percent)})`;
    const toClipFromLeftInset = (percent: number) =>
      toRadixThumbPosition(percent);
    const TERMINAL_EPSILON = 1e-6;
    const snapLeftInset = (percent: number) => {
      if (percent <= TERMINAL_EPSILON) return "0";
      if (percent >= 100 - TERMINAL_EPSILON) return "100%";
      return toClipFromLeftInset(percent);
    };
    const snapRightInset = (percent: number) => {
      if (percent <= TERMINAL_EPSILON) return "100%";
      if (percent >= 100 - TERMINAL_EPSILON) return "0";
      return toClipFromRightInset(percent);
    };

    if (crossesZero) {
      // Keep center anchor stable by always clipping the low/high pair,
      // independent of sign branch, then snapping at terminal edges.
      const lowPercent = Math.min(valuePercent, zeroPercent);
      const highPercent = Math.max(valuePercent, zeroPercent);
      return `inset(0 ${snapRightInset(highPercent)} 0 ${snapLeftInset(lowPercent)})`;
    }
    // Non-crossing: fill starts at left edge; snap right inset at terminals.
    return `inset(0 ${snapRightInset(valuePercent)} 0 0)`;
  }, [crossesZero, zeroPercent, valuePercent]);

  const fillMaskImage = crossesZero
    ? "linear-gradient(to right, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.35) 50%, rgba(0,0,0,0.7) 100%)"
    : "linear-gradient(to right, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.7) 100%)";

  // Metallic reflection gradient that follows the handle position
  // Visible while dragging OR when resting at edges (0%/100%)
  const reflectionStyle = useMemo(() => {
    const edgeThreshold = 3;
    const nearEdge =
      valuePercent <= edgeThreshold || valuePercent >= 100 - edgeThreshold;

    // Narrower spread when stationary at edges (~35% narrower)
    const spreadPercent = nearEdge && !isDragging ? 6.5 : 10;
    const handlePos = toRadixThumbPosition(valuePercent);
    const start = `clamp(0%, calc(${handlePos} - ${spreadPercent}%), 100%)`;
    const end = `clamp(0%, calc(${handlePos} + ${spreadPercent}%), 100%)`;

    const gradient = `linear-gradient(to right,
      transparent ${start},
      white ${handlePos},
      transparent ${end})`;

    return {
      background: gradient,
      WebkitMask:
        "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
      WebkitMaskComposite: "xor",
      maskComposite: "exclude",
      padding: "1px",
    };
  }, [valuePercent, isDragging]);

  // Opacity scales with handle size: rest → hover → drag
  const reflectionOpacity = useMemo(() => {
    const edgeThreshold = 3;
    const atEdge =
      valuePercent <= edgeThreshold || valuePercent >= 100 - edgeThreshold;

    if (isDragging || atEdge) {
      return 1;
    }
    if (isHovered) {
      return 0.6;
    }
    return 0;
  }, [valuePercent, isDragging, isHovered]);

  const handleValueChange = useCallback(
    (values: number[]) => {
      if (values[0] !== undefined) {
        onChange(values[0]);
      }
    },
    [onChange],
  );

  return (
    <div className="py-2">
      <SliderPrimitive.Root
        id={id}
        className={cn(
          "group/slider relative flex w-full touch-none items-center select-none",
          "isolate h-12",
          isDragging
            ? "[&>span]:transition-[left,transform] [&>span]:duration-45 [&>span]:ease-linear"
            : "[&>span]:transition-[left,transform] [&>span]:duration-90 [&>span]:ease-[cubic-bezier(0.22,1,0.36,1)]",
          "[&>span]:will-change-[left,transform]",
          "motion-reduce:[&>span]:transition-none",
          disabled && "pointer-events-none opacity-50",
        )}
        value={[value]}
        onValueChange={handleValueChange}
        onPointerDown={() => setIsDragging(true)}
        onPointerUp={() => setIsDragging(false)}
        onPointerEnter={() => setIsHovered(true)}
        onPointerLeave={() => setIsHovered(false)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-valuetext={getAriaValueText(value, min, max, unit)}
      >
        <SliderPrimitive.Track
          ref={trackRef}
          className={cn(
            "squircle relative h-12 w-full grow overflow-hidden rounded-sm",
            "ring-border ring-1 ring-inset",
            "dark:ring-white/10",
            resolvedTrackClassName ?? "bg-muted",
          )}
        >
          <div
            className={cn(
              "absolute inset-0 will-change-[clip-path]",
              isDragging
                ? "transition-[clip-path] duration-45 ease-linear"
                : "transition-[clip-path] duration-90 ease-[cubic-bezier(0.22,1,0.36,1)]",
              "motion-reduce:transition-none",
              resolvedFillClassName ?? "bg-primary/30 dark:bg-primary/40",
            )}
            style={{
              maskImage: fillMaskImage,
              WebkitMaskImage: fillMaskImage,
              clipPath: fillClipPath,
            }}
          />

          {ticks.map((tick, i) => {
            const isEdge =
              !tick.isSubtick && (tick.percent === 0 || tick.percent === 100);
            return (
              <span
                key={i}
                className={cn(
                  "pointer-events-none absolute bottom-px w-px",
                  tick.isSubtick ? "h-1.5" : "h-2",
                  isEdge
                    ? "bg-transparent"
                    : tick.isSubtick
                      ? "bg-foreground/8 dark:bg-white/5"
                      : tick.isCenter
                        ? "bg-foreground/30 dark:bg-white/25"
                        : "bg-foreground/15 dark:bg-white/8",
                )}
                style={{
                  left: toInsetPosition(tick.percent),
                  transform: "translateX(-50%)",
                }}
              />
            );
          })}
        </SliderPrimitive.Track>

        {/* Metallic reflection overlay - follows handle, brightness scales with interaction */}
        <div
          className={cn(
            "squircle pointer-events-none absolute inset-0 rounded-sm",
            isDragging
              ? "transition-[opacity,background] duration-45 ease-linear"
              : "transition-[opacity,background] duration-90 ease-[cubic-bezier(0.22,1,0.36,1)]",
            "motion-reduce:transition-none",
          )}
          style={{
            ...reflectionStyle,
            opacity: reflectionOpacity,
            filter: "blur(1px)",
            mixBlendMode: "overlay",
          }}
        />

        <SliderPrimitive.Thumb
          className={cn(
            "group/thumb z-0 block w-3 shrink-0 cursor-grab rounded-sm",
            "relative bg-transparent outline-none",
            "transition-[height,opacity] duration-150 ease-[var(--cubic-ease-in-out)]",
            "focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-1",
            "active:cursor-grabbing",
            "disabled:pointer-events-none disabled:opacity-50",
            // Height morphs: rest (track height) → hover → active
            isDragging ? "h-[56px]" : isHovered ? "h-[54px]" : "h-12",
          )}
        >
          {(() => {
            // Calculate morph state
            const isActive = isHovered || isDragging;

            // Indicator stays centered on the real thumb while CSS transitions
            // smooth thumb wrapper and fill movement together.
            const fillEdgeOffset = 0;

            // Hide rest-state indicator at edges (0% or 100%) - the reflection gradient handles this
            const edgeThreshold = 3;
            const atEdge =
              valuePercent <= edgeThreshold ||
              valuePercent >= 100 - edgeThreshold;
            const restOpacity = atEdge ? 0 : 0.25;

            // Asymmetric segment heights: gap is shifted up to match raised text position
            // Top segment is shorter, bottom segment is taller
            const topHeight =
              isActive && gap > 0
                ? `calc(50% - ${gap / 2 + TEXT_VERTICAL_OFFSET}px)`
                : "50%";
            const bottomHeight =
              isActive && gap > 0
                ? `calc(50% - ${gap / 2 - TEXT_VERTICAL_OFFSET}px)`
                : "50%";

            return (
              <>
                <span
                  className={cn(
                    "absolute top-0 left-1/2",
                    "transition-all duration-100 ease-[var(--cubic-ease-in-out)]",
                    isActive
                      ? gap > 0
                        ? "rounded-full"
                        : "rounded-t-full"
                      : "rounded-t-sm",
                    isDragging ? "w-2" : isActive ? "w-1.5" : "w-px",
                    resolvedHandleClassName ?? "bg-primary",
                  )}
                  style={{
                    transform: `translateX(calc(-50% + ${fillEdgeOffset}px))`,
                    height: topHeight,
                    opacity: isActive ? 1 : restOpacity,
                  }}
                />
                <span
                  className={cn(
                    "absolute bottom-0 left-1/2",
                    "transition-all duration-100 ease-[var(--cubic-ease-in-out)]",
                    isActive
                      ? gap > 0
                        ? "rounded-full"
                        : "rounded-b-full"
                      : "rounded-b-sm",
                    isDragging ? "w-2" : isActive ? "w-1.5" : "w-px",
                    resolvedHandleClassName ?? "bg-primary",
                  )}
                  style={{
                    transform: `translateX(calc(-50% + ${fillEdgeOffset}px))`,
                    height: bottomHeight,
                    opacity: isActive ? 1 : restOpacity,
                  }}
                />
              </>
            );
          })()}
        </SliderPrimitive.Thumb>

        <div
          className="pointer-events-none absolute inset-x-3 top-1/2 z-10 flex items-center justify-between"
          style={{
            transform: `translateY(calc(-50% - ${TEXT_VERTICAL_OFFSET}px))`,
          }}
        >
          <span
            ref={labelRef}
            className="text-primary -mt-px rounded-full px-2 py-px text-sm font-normal tracking-wide"
          >
            {label}
          </span>
          <span
            ref={valueRef}
            className="text-foreground -mt-px -mb-0.5 flex h-6 items-center rounded-full px-2 font-mono text-xs tabular-nums"
          >
            {formatSignedValue(value, min, max, precision, unit)}
          </span>
        </div>
      </SliderPrimitive.Root>
    </div>
  );
}

export function ParameterSlider({
  id,
  sliders,
  values: controlledValues,
  onChange,
  actions,
  onAction,
  onBeforeAction,
  className,
  trackClassName,
  fillClassName,
  handleClassName,
}: ParameterSliderProps) {
  const slidersSignature = useMemo(
    () => createSliderSignature(sliders),
    [sliders],
  );
  const sliderSnapshot = useMemo(
    () => createSliderValueSnapshot(sliders),
    [sliders],
  );
  const {
    value: currentValues,
    isControlled,
    setValue,
    setUncontrolledValue,
  } = useControllableState<SliderValue[]>({
    value: controlledValues,
    defaultValue: sliderSnapshot,
    onChange,
  });

  useSignatureReset(slidersSignature, () => {
    if (!isControlled) {
      setUncontrolledValue(sliderSnapshot);
    }
  });

  const valueMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const v of currentValues) {
      map.set(v.id, v.value);
    }
    return map;
  }, [currentValues]);

  const updateValue = useCallback(
    (sliderId: string, newValue: number) => {
      setValue((prev) =>
        prev.map((v) => (v.id === sliderId ? { ...v, value: newValue } : v)),
      );
    },
    [setValue],
  );

  const handleReset = useCallback(() => {
    setValue(sliderSnapshot);
  }, [setValue, sliderSnapshot]);

  const handleAction = useCallback(
    async (actionId: string) => {
      let nextValues = currentValues;
      if (actionId === "reset") {
        handleReset();
        nextValues = sliderSnapshot;
      }

      await onAction?.(actionId, nextValues);
    },
    [currentValues, handleReset, onAction, sliderSnapshot],
  );

  const normalizedActions = useMemo(() => {
    const normalized = normalizeActionsConfig(actions);
    if (normalized) return normalized;
    return {
      items: [
        { id: "reset", label: "Reset", variant: "ghost" as const },
        { id: "apply", label: "Apply", variant: "default" as const },
      ],
      align: "right" as const,
    };
  }, [actions]);

  return (
    <article
      className={cn(
        "@container/parameter-slider isolate flex w-full max-w-md min-w-80 flex-col gap-3",
        "text-foreground",
        className,
      )}
      data-slot="parameter-slider"
      data-tool-ui-id={id}
    >
      <div
        className={cn(
          "bg-card flex w-full flex-col overflow-hidden rounded-2xl border px-5 py-3 shadow-xs",
        )}
      >
        {sliders.map((slider) => (
          <SliderRow
            key={slider.id}
            config={slider}
            value={valueMap.get(slider.id) ?? slider.value}
            onChange={(v) => updateValue(slider.id, v)}
            trackClassName={trackClassName}
            fillClassName={fillClassName}
            handleClassName={handleClassName}
          />
        ))}
      </div>

      <div className="@container/actions">
        <ActionButtons
          actions={normalizedActions.items}
          align={normalizedActions.align}
          confirmTimeout={normalizedActions.confirmTimeout}
          onAction={handleAction}
          onBeforeAction={
            onBeforeAction
              ? (actionId) => onBeforeAction(actionId, currentValues)
              : undefined
          }
        />
      </div>
    </article>
  );
}
