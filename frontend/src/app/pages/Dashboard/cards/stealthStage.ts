// A browser card an agent is driving on a dashboard the user has LEFT is parked at left:-100000, and
// Chromium composites nothing for an off-viewport guest, so every screenshot fails (ENG-449). The card
// keeps its DOM slot (a moved webview reloads its page) and is placed INSIDE the viewport instead, at
// a size that fits, invisible and click-through. Layer-relative coordinates, the same contract the
// in-chat dock uses, so the camera can sit anywhere.
export interface LayerRect {
  left: number;
  top: number;
}

export interface StealthStage {
  left: number;
  top: number;
  scale: number;
}

export const STEALTH_MARGIN_PX = 8;

export function stealthStage(
  layer: LayerRect,
  zoom: number,
  displayW: number,
  displayH: number,
  innerW: number,
  innerH: number,
): StealthStage {
  const z = zoom > 0 ? zoom : 1;
  const fit = Math.min(1, (innerW - 2 * STEALTH_MARGIN_PX) / Math.max(1, displayW), (innerH - 2 * STEALTH_MARGIN_PX) / Math.max(1, displayH));
  return {
    left: (STEALTH_MARGIN_PX - layer.left) / z,
    top: (STEALTH_MARGIN_PX - layer.top) / z,
    // The card's own transform is applied inside the zoomed layer, so one screen pixel is 1/z card pixels.
    scale: fit / z,
  };
}
