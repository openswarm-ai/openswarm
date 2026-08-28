// Who owns the wheel gesture in flight. One owner, decided once and then held, so "the canvas and
// Settings both own this scroll" cannot be expressed.
//
// Holding it matters in BOTH directions, and only one direction used to exist. A scroll being served
// by a scrollable surface stays there past that surface's end, so hitting the bottom of Settings
// never chains into a canvas pan. And a pan the canvas already owns keeps flowing when it drifts
// over an app window, instead of being swallowed mid-gesture (ENG-420).

export const GESTURE_GAP_MS = 220;

// The windows that own every wheel inside them without needing a click first. Matched with `closest`,
// so it must name each type EXACTLY: a bare '[data-select-type]' finds the nearest tagged element
// instead, and Settings tags its own rows 'settings-option' with an id of their own, so from over any
// setting the window was invisible and the canvas ate the wheel.
export const APP_WINDOW_SELECTOR = ['settings-card', 'marketplace-card', 'workflows-hub-card']
  .map((t) => `[data-select-type="${t}"]`)
  .join(',');
export const CANVAS_OWNER = 'canvas';

export type WheelOwner = HTMLElement | typeof CANVAS_OWNER | null;

export interface WheelGesture {
  owner: WheelOwner;
  at: number;
}

// A zoom is exempt on every surface so a pinch is always reachable, and it claims nothing: a pinch
// over Settings must not hand the next two-finger scroll to the world just because it passed through.
export function heldBy(
  gesture: WheelGesture,
  now: number,
  isZoom: boolean,
  target: EventTarget | null,
): WheelOwner {
  const { owner } = gesture;
  if (owner === null || isZoom || now - gesture.at >= GESTURE_GAP_MS) return null;
  if (owner === CANVAS_OWNER) return CANVAS_OWNER;
  if (!owner.isConnected) return null;
  return target instanceof Node && owner.contains(target) ? owner : null;
}
