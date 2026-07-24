// Dev-only responsiveness watchdog: regressions show up as numbers in the console, not vibes.
interface LongTaskStats {
  count: number;
  totalMs: number;
  worstMs: number;
  reset: () => void;
}

declare global {
  interface Window {
    OSW_PERF?: LongTaskStats;
  }
}

const NOISY_TASK_MS = 150;

export function startLongTaskLogger(): void {
  if (process.env.NODE_ENV === 'production') return;
  if (typeof PerformanceObserver === 'undefined') return;
  if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;

  const stats: LongTaskStats = {
    count: 0,
    totalMs: 0,
    worstMs: 0,
    reset: () => {
      stats.count = 0;
      stats.totalMs = 0;
      stats.worstMs = 0;
    },
  };
  window.OSW_PERF = stats;

  const observer = new PerformanceObserver((list: PerformanceObserverEntryList) => {
    for (const entry of list.getEntries()) {
      stats.count += 1;
      stats.totalMs += entry.duration;
      if (entry.duration > stats.worstMs) stats.worstMs = entry.duration;
      if (entry.duration >= NOISY_TASK_MS) {
        console.debug(`[perf] long task ${Math.round(entry.duration)}ms (total ${stats.count} tasks, ${Math.round(stats.totalMs)}ms)`);
      }
    }
  });
  observer.observe({ entryTypes: ['longtask'] });
}
