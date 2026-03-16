import type { CardPosition, ViewCardPosition, BrowserCardPosition } from '@/shared/state/dashboardLayoutSlice';

interface AllCards {
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
}

/**
 * Captures a screenshot of the dashboard viewport using Electron's native
 * capturePage API. Captures the viewport as-is (current pan/zoom) to avoid
 * mutating the DOM transform and causing visible flashes.
 */
export async function captureDashboardThumbnail(
  viewportEl: HTMLDivElement,
  _contentEl: HTMLDivElement,
  _allCards: AllCards,
): Promise<string | null> {
  const openswarm = (window as any).openswarm;
  if (!openswarm?.capturePage) return null;

  const vRect = viewportEl.getBoundingClientRect();
  if (vRect.width === 0 || vRect.height === 0) return null;

  try {
    const dpr = window.devicePixelRatio || 1;
    const captureRect = {
      x: Math.round(vRect.x * dpr),
      y: Math.round(vRect.y * dpr),
      width: Math.round(vRect.width * dpr),
      height: Math.round(vRect.height * dpr),
    };

    const dataUrl: string = await openswarm.capturePage(captureRect);
    return dataUrl || null;
  } catch (err) {
    console.warn('Dashboard thumbnail capture failed:', err);
    return null;
  }
}
