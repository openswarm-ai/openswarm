/**
 * An app's icon is one emoji symbol or nothing. The stored default ("view_quilt") is a Material
 * icon NAME that no surface ever rendered, so names and words count as "no icon" and the surface
 * falls back to its generic mark (never a letter: an initial on a tile reads as a bug).
 */
export function appIconGlyph(icon: string | null | undefined): string | null {
  const g = (icon || '').trim();
  if (!g || [...g].length > 4) return null;
  return /[\p{L}\p{N}_]/u.test(g) ? null : g;
}
