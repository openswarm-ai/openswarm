type ProgressInput = {
  completedCount: number;
  totalCount: number;
};

type CelebrateProgressInput = {
  previous: number;
  next: number;
};

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function calculatePlanProgress({
  completedCount,
  totalCount,
}: ProgressInput): number {
  if (totalCount <= 0) return 0;
  return clampProgress((completedCount / totalCount) * 100);
}

export function shouldCelebrateProgress({
  previous,
  next,
}: CelebrateProgressInput): boolean {
  return previous < 100 && next === 100;
}
