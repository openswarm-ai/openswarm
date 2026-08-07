import React, { useCallback, useEffect, useRef, useState } from 'react';

const TILE_MAX = 30;
// Apple's floor is deliberately tiny: magnification, not tile size, is what keeps a small tile hittable.
const TILE_MIN = 14;
const ROOT_PAD = 7;
const GAP_RATIO = 0.3;
const GAP_MIN = 3;
const ICON_RATIO = 0.58;
// Breathing room above and below the dock; the canvas root clips overflow, so this is also the magnify headroom.
const EDGE_MARGIN = 16;
// macOS magnifies to an ABSOLUTE size, not a fixed ratio, so a 14px tile still grows to something you can hit.
const MAGNIFY_TARGET = 44;
// The bell curve was hand-tuned as 44px against a 30px tile; keep that ratio so it narrows as tiles shrink.
const FALLOFF_RATIO = 44 / 30;

export interface DockLayoutInput {
  cardCount: number;
  actionCount: number;
  dividerCount: number;
}

export interface DockLayout {
  dockRef: React.MutableRefObject<HTMLDivElement | null>;
  scrollRef: React.MutableRefObject<HTMLDivElement | null>;
  tile: number;
  gap: number;
  iconSize: number;
  scrolls: boolean;
  scrollHeight: number;
  bleed: number;
  applyMagnify: (clientY: number | null) => void;
}

function gapFor(tile: number): number {
  return Math.max(GAP_MIN, Math.round(tile * GAP_RATIO));
}

function columnHeight(tile: number, tiles: number, dividers: number): number {
  const gaps = Math.max(0, tiles + dividers - 1);
  return ROOT_PAD * 2 + tiles * tile + dividers + gaps * gapFor(tile);
}

interface DockGeom {
  els: HTMLElement[];
  bases: number[];
  rootTop: number;
  written: string[];
}

function beginGesture(root: HTMLElement, box: HTMLDivElement | null): DockGeom {
  const els = Array.from(root.querySelectorAll<HTMLElement>('.osw-dock-tile'));
  const boxShift = box ? box.offsetTop - box.scrollTop : 0;
  // The curve already tracks the cursor frame by frame; easing every tile on top of that is a tax, not motion.
  els.forEach((t) => { t.style.transition = 'none'; });
  return {
    els,
    bases: els.map((t) => (box?.contains(t) ? boxShift : 0) + t.offsetTop + t.offsetHeight / 2),
    rootTop: root.getBoundingClientRect().top,
    written: els.map(() => ''),
  };
}

/** macOS Dock sizing: tiles shrink to fit the column and only scroll once they hit the floor. */
export function useDockLayout({ cardCount, actionCount, dividerCount }: DockLayoutInput): DockLayout {
  const dockRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [containerH, setContainerH] = useState<number>(() => window.innerHeight);

  useEffect(() => {
    const host = dockRef.current?.parentElement;
    if (!host) return undefined;
    const measure = (): void => setContainerH(host.clientHeight || window.innerHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const tileCount = cardCount + actionCount;
  const budget = Math.max(TILE_MIN * 6, containerH - EDGE_MARGIN * 2);
  const guess = Math.floor(
    (budget - ROOT_PAD * 2 - dividerCount) /
      (tileCount + GAP_RATIO * Math.max(0, tileCount + dividerCount - 1)),
  );
  let fitted = Math.min(TILE_MAX, Math.max(TILE_MIN, Number.isFinite(guess) ? guess : TILE_MAX));
  while (fitted > TILE_MIN && columnHeight(fitted, tileCount, dividerCount) > budget) fitted -= 1;

  // Size hysteresis: minimize/restore changes the count, and resizing EVERY tile on each change was
  // the dock's layout-shift cluster. The current size holds while it still fits; shrink fires only
  // on true overflow, and growth waits for a settle beat so rapid-fire toggles never pump the rail.
  const [stableTile, setStableTile] = useState(fitted);
  const mustShrink = columnHeight(stableTile, tileCount, dividerCount) > budget;
  useEffect(() => {
    if (mustShrink) { setStableTile(fitted); return undefined; }
    if (fitted !== stableTile) {
      const t = window.setTimeout(() => setStableTile(fitted), 300);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [fitted, stableTile, mustShrink]);
  const tile = mustShrink ? fitted : stableTile;
  const gap = gapFor(tile);
  const scrolls = columnHeight(tile, tileCount, dividerCount) > budget;
  // Slack inside the scroll box so a magnified tile grows past the column without the scroll clip cutting it.
  const bleed = Math.ceil((MAGNIFY_TARGET - tile) / 2) + 2;

  // Pinned rows keep their full height; whatever is left is what the card column may occupy.
  const pinned = ROOT_PAD * 2 + dividerCount + actionCount * tile + (dividerCount + actionCount) * gap;
  const step = tile + gap;
  // Whole tile steps only, so the clip edge always lands in a gap instead of bisecting an icon.
  const rows = Math.max(1, Math.floor((budget - pinned - bleed * 2 + gap) / step));
  const scrollHeight = rows * step - gap + bleed * 2;

  const tileRef = useRef(tile);
  tileRef.current = tile;
  const geomRef = useRef<DockGeom | null>(null);
  const dropGeom = useCallback((): void => { geomRef.current = null; }, []);

  // Tiles cannot move mid-hover, so re-measuring them per mousemove was pure style-recalc tax; these are
  // every signal that CAN move them.
  useEffect(dropGeom, [dropGeom, tile, gap, scrollHeight, scrolls, containerH, cardCount, actionCount]);

  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return undefined;
    box.addEventListener('scroll', dropGeom, { passive: true });
    return () => box.removeEventListener('scroll', dropGeom);
  }, [dropGeom, scrolls, cardCount]);

  // macOS Dock magnification: the tile under the cursor grows on a bell curve and its neighbors SLIDE
  // AWAY to make room. Each tile that grows by `extra` pushes every tile past it by extra/2.
  const applyMagnify = useCallback((clientY: number | null) => {
    const root = dockRef.current;
    if (!root) return;
    if (clientY == null) {
      // Handing the transition back before clearing the transform is what makes the settle glide instead of snap.
      root.querySelectorAll<HTMLElement>('.osw-dock-tile').forEach((t) => {
        t.style.transition = '';
        t.style.transform = '';
        t.style.zIndex = '';
      });
      geomRef.current = null;
      return;
    }
    const geom = geomRef.current ?? beginGesture(root, scrollRef.current);
    geomRef.current = geom;
    const { els, bases } = geom;
    if (els.length === 0) return;
    const size = tileRef.current;
    const boost = MAGNIFY_TARGET / size - 1;
    const falloff = size * FALLOFF_RATIO;
    const cy = clientY - geom.rootTop;
    const scales = bases.map((b) => 1 + boost * Math.exp(-(((cy - b) / falloff) ** 2)));
    const extra = scales.map((s) => size * (s - 1));
    const total = extra.reduce((a, b) => a + b, 0);
    // Bases run in DOM order, top to bottom, so "everything before me" is a running sum, not an inner loop.
    const head = (extra[0] - total) / 2;
    const tail = (total - extra[els.length - 1]) / 2;
    const span = bases[els.length - 1] - bases[0];
    // Apple's Dock never grows longer than its rail: pin both ends and let the spread squeeze the middle.
    const slope = span > 0 ? (tail - head) / span : 0;
    let before = 0;
    els.forEach((t, i) => {
      const raw = before - (total - before - extra[i]);
      const shift = raw / 2 - head - slope * (bases[i] - bases[0]);
      before += extra[i];
      const next = `translateY(${shift.toFixed(1)}px) scale(${scales[i].toFixed(3)})`;
      // Tiles outside the bell curve land on the same transform move after move, and a no-op style write is not free.
      if (geom.written[i] === next) return;
      geom.written[i] = next;
      t.style.transform = next;
      t.style.zIndex = String(10 + Math.round((scales[i] - 1) * 100));
    });
  }, []);

  return {
    dockRef,
    scrollRef,
    tile,
    gap,
    iconSize: Math.round(tile * ICON_RATIO),
    scrolls,
    scrollHeight,
    bleed,
    applyMagnify,
  };
}
