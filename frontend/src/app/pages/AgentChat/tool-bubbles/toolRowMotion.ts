// The motion vocabulary every tool disclosure shares, copied value-for-value from the best open
// implementations: assistant-ui's 200ms cubic-bezier(0.32,0.72,0,1) height choreography with a
// parallel fade + slide + 2px blur-in on the content, and open-webui's text shimmer
// (110deg sweep, 1.5s cubic-bezier(0.7,0,1,0.4)) for labels of tools still running.

export const COLLAPSE_MS = 200;
export const COLLAPSE_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

// Chevron spec: ONE glyph that rotates with the panel (never an icon swap): -90deg points right at
// rest, 0 when open, on the same duration/curve as the height so they move as a single object.
export function chevronSx(open: boolean): Record<string, unknown> {
  return {
    transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
    transition: `transform ${COLLAPSE_MS}ms ${COLLAPSE_EASE}`,
  };
}

export function shimmerTextSx(color: string): Record<string, unknown> {
  return {
    WebkitTextFillColor: 'transparent',
    background: `linear-gradient(110deg, color-mix(in srgb, ${color} 55%, transparent) 43%, ${color} 50%, color-mix(in srgb, ${color} 55%, transparent) 57%) 0 0 / 200% 100%`,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    animation: 'oswToolShimmer 1.5s cubic-bezier(0.7, 0, 1, 0.4) infinite',
    '@keyframes oswToolShimmer': {
      from: { backgroundPosition: '100% 0' },
      to: { backgroundPosition: '-100% 0' },
    },
    '@media (prefers-reduced-motion: reduce)': { animation: 'none', WebkitTextFillColor: 'unset', background: 'none', color },
  };
}

// Content entrance layered over the height animation; the 2px blur-in is the expensive-feeling detail.
export function railEnterSx(open: boolean): Record<string, unknown> {
  if (!open) return {};
  return {
    animation: `oswRailEnter ${COLLAPSE_MS}ms ${COLLAPSE_EASE}`,
    '@keyframes oswRailEnter': {
      from: { opacity: 0, transform: 'translateY(-4px)', filter: 'blur(2px)' },
      to: { opacity: 1, transform: 'none', filter: 'none' },
    },
    '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
  };
}

// assistant-ui's free win: triggers acknowledge the press with a tiny origin-left squeeze.
export const pressSx: Record<string, unknown> = {
  transformOrigin: 'left center',
  transition: 'transform 100ms ease',
  '&:active': { transform: 'scale(0.98)' },
};

// assistant-ui's scroll lock, anchored: while a disclosure animates, the clicked row keeps its exact
// viewport Y (the scroller compensates per frame), so collapsing a tall block never jumps the page.
export function keepRowAnchored(rowEl: HTMLElement | null): void {
  if (!rowEl) return;
  let scroller: HTMLElement | null = rowEl.parentElement;
  while (scroller) {
    const style = getComputedStyle(scroller);
    if (/(auto|scroll)/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight) break;
    scroller = scroller.parentElement;
  }
  if (!scroller) return;
  const anchorY = rowEl.getBoundingClientRect().top;
  let raf = 0;
  const step = (): void => {
    const dy = rowEl.getBoundingClientRect().top - anchorY;
    if (dy !== 0) scroller!.scrollTop += dy;
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  window.setTimeout(() => cancelAnimationFrame(raf), COLLAPSE_MS + 80);
}
