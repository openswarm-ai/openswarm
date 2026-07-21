import type { SliderConfig, SliderValue } from "./schema";

type SliderPercentInput = {
  value: number;
  min: number;
  max: number;
};

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function sliderRangeToPercent({
  value,
  min,
  max,
}: SliderPercentInput): number {
  const range = max - min;
  if (!Number.isFinite(range) || range <= 0) return 0;
  return clampPercent(((value - min) / range) * 100);
}

export function createSliderValueSnapshot(
  sliders: SliderConfig[],
): SliderValue[] {
  return sliders.map((slider) => ({ id: slider.id, value: slider.value }));
}

export function createSliderSignature(sliders: SliderConfig[]): string {
  return JSON.stringify(
    sliders.map(({ id, min, max, step, value, unit, precision }) => ({
      id,
      min,
      max,
      step: step ?? 1,
      value,
      unit: unit ?? "",
      precision: precision ?? null,
    })),
  );
}
