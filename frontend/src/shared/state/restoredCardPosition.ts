// Where should a card land when you un-minimize it? (Haik, 2026-08-13)
//
// It used to land exactly where it was parked, which is right when that space is still empty and
// wrong when the board moved on without it: the card reappears on top of whatever took its place.
//
// So: keep the user's spot when it is still free, and only reflow when it is not. Always reflowing
// would be its own bug, because a user who parked a card somewhere deliberately expects it back
// there, and the nearest-free-spot search is anchored on the old position so even a reflowed card
// comes back close to where it was left rather than at the far end of the board.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * @param current where the card was parked
 * @param occupied every other card's rect (the restoring card MUST be excluded, or it collides
 *                 with its own footprint and always reflows)
 * @param findSpot nearest-free-spot search, injected so this stays free of the layout slice
 */
export function restoredCardPosition(
  current: Rect,
  occupied: Rect[],
  findSpot: (x: number, y: number, occupied: Rect[], w: number, h: number) => { x: number; y: number },
): { x: number; y: number } {
  const clash = occupied.some((r) => (
    current.x < r.x + r.w && current.x + current.w > r.x
    && current.y < r.y + r.h && current.y + current.h > r.y
  ));
  if (!clash) return { x: current.x, y: current.y };
  return findSpot(current.x, current.y, occupied, current.w, current.h);
}
