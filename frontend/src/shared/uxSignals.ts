// Silent-failure UX sensors: rage clicks (the user telling us a button did nothing) and renderer
// wedge recoveries. Threshold-emission only; nothing here runs per-frame or per-render.
import { report } from '@/shared/serviceClient';

const RAGE_COUNT = 3;
const RAGE_WINDOW_MS = 2000;
const RAGE_THROTTLE_MS = 60_000;

let p_lastTarget: EventTarget | null = null;
let p_clickTimes: number[] = [];
let p_lastRageReport = 0;

function describeTarget(el: Element | null): string {
  if (!el) return 'unknown';
  const sel = el.closest('[data-select-type]');
  if (sel) return sel.getAttribute('data-select-type') || 'card';
  const btn = el.closest('button, [role="button"]');
  if (btn) return (btn.getAttribute('aria-label') || btn.textContent || 'button').trim().slice(0, 40);
  return el.tagName.toLowerCase();
}

// A main-thread task this long IS the freeze the user felt; measured live at 40,001ms in a forced
// wedge where Chromium's own `unresponsive` never fired, so this is the primary wedge sensor.
const WEDGE_MS = 3000;
const WEDGE_THROTTLE_MS = 60_000;
let p_lastWedgeReport = 0;

function installWedgeObserver(): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => {};
  if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return () => {};
  const obs = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const now = Date.now();
      if (entry.duration >= WEDGE_MS && now - p_lastWedgeReport > WEDGE_THROTTLE_MS) {
        p_lastWedgeReport = now;
        report('process', 'wedge_recovered', { wedge_ms: Math.round(entry.duration), source: 'longtask' });
      }
    }
  });
  obs.observe({ entryTypes: ['longtask'] });
  return () => obs.disconnect();
}

export function installUxSignals(): () => void {
  const onClick = (e: MouseEvent): void => {
    const now = Date.now();
    if (e.target !== p_lastTarget) {
      p_lastTarget = e.target;
      p_clickTimes = [now];
      return;
    }
    p_clickTimes = [...p_clickTimes.filter((t) => now - t < RAGE_WINDOW_MS), now];
    if (p_clickTimes.length >= RAGE_COUNT && now - p_lastRageReport > RAGE_THROTTLE_MS) {
      p_lastRageReport = now;
      report('ux', 'rage_click', {
        target: describeTarget(e.target as Element | null),
        clicks: p_clickTimes.length,
      });
      p_clickTimes = [];
    }
  };
  window.addEventListener('click', onClick, true);
  const bridge = window as unknown as { openswarm?: { onWedge?: (cb: (info: { ms: number }) => void) => () => void } };
  // Chromium's own hang signal stays wired as a second, independent witness (it costs nothing and
  // catches hangs the observer can't see, e.g. a renderer stuck outside a task).
  const offWedge = bridge.openswarm?.onWedge?.((info) => {
    report('process', 'wedge_recovered', { wedge_ms: info?.ms ?? -1, source: 'chromium' });
  });
  const offObserver = installWedgeObserver();
  const offMem = (bridge.openswarm as { onMemoryAlert?: (cb: (i: Record<string, number | string>) => void) => () => void } | undefined)?.onMemoryAlert?.((info) => {
    report('process', 'memory_alert', info);
  });
  return () => {
    window.removeEventListener('click', onClick, true);
    offWedge?.();
    offObserver();
    offMem?.();
  };
}
