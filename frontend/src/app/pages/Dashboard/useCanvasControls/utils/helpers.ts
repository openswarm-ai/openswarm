export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3.0;
export const ZOOM_IN_FACTOR = 1.1;
export const ZOOM_OUT_FACTOR = 1 / ZOOM_IN_FACTOR;
export const FIT_PADDING = 80;

export function sensitivityToMultiplier(setting: number): number {
  return 0.00008 * setting;
}

export interface CanvasState {
  panX: number;
  panY: number;
  zoom: number;
}

export function clamp(val: number, min: number, max: number) {
  return Math.min(max, Math.max(min, val));
}

export function zoomAroundCenter(
  prev: CanvasState,
  newZoom: number,
  cx: number,
  cy: number,
): CanvasState {
  const ratio = newZoom / prev.zoom;
  return {
    panX: cx - (cx - prev.panX) * ratio,
    panY: cy - (cy - prev.panY) * ratio,
    zoom: newZoom,
  };
}
