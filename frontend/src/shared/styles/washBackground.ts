// The theme wash. Anything painted here is a full-window layer, so it is the app's single biggest
// piece of evictable GPU texture: keep it as cheap as the theme allows (see washIsUniform).
export function washBackgroundUrl(stops: string[], washOpacity: number): string {
  const alpha = Math.max(0, Math.min(1, washOpacity));
  // A native CSS gradient, not an SVG data-URL. The data-URL version was a decoded IMAGE resource:
  // Chromium can evict its tiles under GPU memory pressure (many webviews, external displays) and
  // paints the layer's background-color there instead, which is the hard-edged band users report.
  // A gradient is a paint op on the layer itself, so there is no separate texture to drop, and it
  // also stops shipping a ~119KB data-URL string on every theme render.
  const stopEls = stops.map((hex, i) => {
    const offset = stops.length > 1 ? (i / (stops.length - 1)) * 100 : 100;
    return `${p_rgba(hex, alpha)} ${offset}%`;
  }).join(', ');
  return `linear-gradient(115deg, ${stopEls})`;
}

function p_rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`;
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

/**
 * True when the wash is one flat colour, so painting it as an image would be pure waste.
 *
 * A single-accent theme (the common case) resolves to `linear-gradient(115deg, C 100%)` while the
 * element's background-color is already exactly C, measured delta 0/255. That redundant image still
 * costs a full-window texture, and a texture is the only thing Chromium can EVICT: dropping its
 * tiles is what paints the hard-edged rectangle of flat tint people report. A background-color is a
 * compositor solid-colour quad, which can never be evicted, so skipping the image doesn't just save
 * memory, it makes the band unrepresentable for these themes.
 */
export function washIsUniform(stops: string[]): boolean {
  return stops.length < 2 || stops.every((s) => s.toLowerCase() === stops[0].toLowerCase());
}

export interface WashLayers {
  image: string;
  size: string;
  repeat: string;
}

/**
 * The background layers a full-window wash surface should paint, or null for "colour is enough".
 *
 * Both painters (the shell and the canvas viewport) need the identical stack, and getting it wrong
 * is what brings the band back, so it is derived once here rather than re-spelled at each site.
 */
export function washBackgroundLayers(
  stops: string[], washOpacity: number, pageBg: string, grainUrl: string | null,
): WashLayers | null {
  const wash = stops.length > 0 && !washIsUniform(stops)
    ? washOpaqueBackgroundUrl(stops, washOpacity, pageBg)
    : '';
  if (!wash && !grainUrl) return null;
  if (!wash) return { image: grainUrl as string, size: 'auto', repeat: 'repeat' };
  if (!grainUrl) return { image: wash, size: '100% 100%', repeat: 'no-repeat' };
  return { image: `${grainUrl}, ${wash}`, size: 'auto, 100% 100%', repeat: 'repeat, no-repeat' };
}

// What an evicted/unrastered wash tile should paint as: the wash's mean tint, never raw page color.
export function washUnderlayColor(stops: string[], washOpacity: number, pageBg: string): string {
  const alpha = Math.max(0, Math.min(1, washOpacity));
  if (stops.length === 0) return pageBg;
  const mean = stops.reduce((acc, hex, i) => (i === 0 ? hex : mixHex(acc, hex, 1 / (i + 1))), stops[0]);
  return mixHex(pageBg, mean, alpha);
}

// The dot grid's share of the canvas surface. Zoom cancels out of r²/spacing² while the radius is
// unfloored; the floor at r=1 makes far-zoom-out slightly denser, which is why this takes the live
// values instead of hardcoding the ratio.
export function dotGridCoverage(dotRadius: number, dotSpacing: number): number {
  if (dotSpacing <= 0) return 0;
  return Math.min(1, (Math.PI * dotRadius * dotRadius) / (dotSpacing * dotSpacing));
}

/**
 * What an evicted CANVAS tile should paint as: the wash mean PLUS the dot grid's mean contribution.
 *
 * The plain wash underlay was already tint-matched, and the flash still read white on light themes
 * (ENG-340): the dot layer is the largest promoted texture, its repaint lands last, and its share
 * of the composite tone was missing from the fallback. Folding the dots' exact coverage in makes an
 * evicted tile paint the same average tone the rasterized canvas had, so the eviction stops being
 * visible as a blink. Grain stays unfolded: it is a baked PNG with no statically-knowable mean, and
 * it rides the same raster as the wash anyway.
 */
export function canvasUnderlayColor(
  stops: string[], washOpacity: number, pageBg: string,
  dotColor: string, dotRadius: number, dotSpacing: number,
  grainMean: { meanHex: string; meanAlpha: number } | null = null,
): string {
  let under = washUnderlayColor(stops, washOpacity, pageBg);
  // Grain is the tone the flash was actually missing: the dots are ~1% coverage (pattern, not
  // tone), while the baked grain darkens the whole surface by its measured mean. Folding the mean
  // in makes the evicted-tile quad equal what the rasterized canvas averaged.
  if (grainMean && grainMean.meanAlpha > 0) {
    const g = parseCssColor(grainMean.meanHex);
    if (g) under = mixHex(under, g.hex, Math.max(0, Math.min(1, grainMean.meanAlpha)));
  }
  // The dot tokens are rgba() strings (light: rgba(0,0,0,0.08)), and mixHex is hex-only: fed an
  // rgba it NaNs into an invalid colour, the backgroundColor is silently dropped, and the
  // never-white guarantee itself dies. So parse properly, and an unparseable colour falls back to
  // the plain underlay rather than to garbage. An alpha dot over the underlay contributes
  // mix(under, rgb, alpha) across `coverage` of the area, which collapses to one mix at
  // coverage * alpha.
  const parsed = parseCssColor(dotColor);
  if (!parsed) return under;
  return mixHex(under, parsed.hex, dotGridCoverage(dotRadius, dotSpacing) * parsed.alpha);
}

// #rrggbb or rgba(r,g,b,a) -> {hex, alpha}, or null for anything else. Null MUST stay null at the
// caller: guessing a colour here is how an invalid one reaches the compositor.
export function parseCssColor(color: string): { hex: string; alpha: number } | null {
  const c = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return { hex: c, alpha: 1 };
  const m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i);
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => Math.min(255, parseInt(v, 10)));
  const alpha = m[4] === undefined ? 1 : Math.max(0, Math.min(1, parseFloat(m[4])));
  return { hex: `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`, alpha };
}

// Stock wallpaper when the user hasn't picked an accent yet. ONE stop on purpose: a multi-stop
// default needs a full-window texture, and Chromium fills any tile it drops with the layer's single
// background colour, which is why the gradient used to tear into a hard-edged rectangle under GPU
// pressure. This is the mean of the old blue-cream-pink trio, i.e. exactly the colour those torn
// tiles already painted, so the stock look is now what the worst case used to be. Picking any accent
// is also one stop; only a user-chosen gradient opts back into the texture.
export const DEFAULT_WASH_STOPS = ['#DACEDA'];

export function effectiveWashStops(gradient: string[] | null, accent: string | null): string[] {
  if (gradient && gradient.length > 0) return gradient;
  if (accent) return [accent];
  return DEFAULT_WASH_STOPS;
}
