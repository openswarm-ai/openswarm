// Haik: in fullscreen, scrolling only works over the center text column; the wide side gutters eat
// the wheel. A wheel on the BARE gutter forwards to the transcript; everything else keeps its owner.
export function shouldForwardGutterWheel(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  deltaX: number;
  deltaY: number;
  targetIsGutter: boolean;
}): boolean {
  if (e.ctrlKey || e.metaKey) return false;
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return false;
  return e.targetIsGutter;
}
