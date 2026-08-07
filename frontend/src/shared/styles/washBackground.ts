// Theme wash as an SVG IMAGE, not a CSS linear-gradient: Chromium caches a decoded image as a GPU
// texture, while a window-sized procedural gradient re-rasterizes on resize and, under GPU memory
// pressure (webviews, external monitors), those rasters get DROPPED and paint as a half/blank
// rectangle (the same class as the 1.5.9 dot-grid white-patch bug; see DashboardCanvas's grid note).
export function washBackgroundUrl(stops: string[], washOpacity: number): string {
  const alpha = Math.max(0, Math.min(1, washOpacity));
  const stopEls = stops.map((hex, i) => {
    const offset = stops.length > 1 ? (i / (stops.length - 1)) * 100 : 100;
    return `<stop offset='${offset}%' stop-color='${hex}' stop-opacity='${alpha}'/>`;
  }).join('');
  // x2/y2 approximate the CSS 115deg direction (25 degrees below horizontal).
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100' preserveAspectRatio='none'><defs><linearGradient id='w' x1='0%' y1='0%' x2='90%' y2='42%'>${stopEls}</linearGradient></defs><rect width='100' height='100' fill='url(%23w)'/></svg>`;
  return `url("data:image/svg+xml,${svg.replace(/#/g, '%23').replace(/'/g, '%27')}")`;
}

function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number): number => Math.round(((pa >> shift) & 0xff) * (1 - t) + ((pb >> shift) & 0xff) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

// The canvas wash, pre-blended over the page color so the layer is OPAQUE: identical pixels to the translucent version, but Chromium can then paint the declared background-color for any tile it evicted or hasn't rastered yet, instead of raw page white/black.
export function washOpaqueBackgroundUrl(stops: string[], washOpacity: number, pageBg: string): string {
  const alpha = Math.max(0, Math.min(1, washOpacity));
  const blended = stops.map((hex) => mixHex(pageBg, hex, alpha));
  return washBackgroundUrl(blended, 1);
}

// What an evicted/unrastered wash tile should paint as: the wash's mean tint, never raw page color.
export function washUnderlayColor(stops: string[], washOpacity: number, pageBg: string): string {
  const alpha = Math.max(0, Math.min(1, washOpacity));
  if (stops.length === 0) return pageBg;
  const mean = stops.reduce((acc, hex, i) => (i === 0 ? hex : mixHex(acc, hex, 1 / (i + 1))), stops[0]);
  return mixHex(pageBg, mean, alpha);
}

// Stock wallpaper when the user hasn't picked an accent yet: a designed blue-to-cream-to-pink
// gradient (contrasting stops), so a fresh install and the onboarding stage never look flat/white.
export const DEFAULT_WASH_STOPS = ['#B7CDEA', '#EFE0D2', '#E7BDD1'];

export function effectiveWashStops(gradient: string[] | null, accent: string | null): string[] {
  if (gradient && gradient.length > 0) return gradient;
  if (accent) return [accent];
  return DEFAULT_WASH_STOPS;
}
