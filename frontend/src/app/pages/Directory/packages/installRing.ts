// The ring on an installing pill: a fraction fills it, an unknown total spins it. A freshly started
// download shows a sliver rather than an empty ring, because an empty ring reads as nothing happening.
export const RING_FLOOR_PERCENT = 4;

export function ringFor(progress: number | null | undefined): { variant: 'determinate' | 'indeterminate'; value: number } {
  if (progress == null || !Number.isFinite(progress)) return { variant: 'indeterminate', value: 0 };
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  return { variant: 'determinate', value: Math.max(RING_FLOOR_PERCENT, pct) };
}

export function fractionOf(progress: { received: number; total: number } | null | undefined): number | null {
  if (!progress || progress.total <= 0) return null;
  return progress.received / progress.total;
}
