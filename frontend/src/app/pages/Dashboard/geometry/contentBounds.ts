import type {
  CardPosition,
  ViewCardPosition,
  BrowserCardPosition,
} from '@/shared/state/dashboardLayoutSlice';

export interface ContentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Bounding box over agent + view + browser cards (notes intentionally
// excluded, same as before). Returns undefined for an empty canvas.
export function computeContentBounds(
  cards: Record<string, CardPosition>,
  viewCards: Record<string, ViewCardPosition>,
  browserCards: Record<string, BrowserCardPosition>,
): ContentBounds | undefined {
  const allRects = [
    ...Object.values(cards).map((c) => ({ x: c.x, y: c.y, w: c.width, h: c.height })),
    ...Object.values(viewCards).map((c) => ({ x: c.x, y: c.y, w: c.width, h: c.height })),
    ...Object.values(browserCards).map((c) => ({ x: c.x, y: c.y, w: c.width, h: c.height })),
  ];
  if (allRects.length === 0) return undefined;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of allRects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { minX, minY, maxX, maxY };
}
