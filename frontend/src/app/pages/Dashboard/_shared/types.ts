export interface TetherInfo {
  key: string;
  path: string;
  labelX: number;
  labelY: number;
  label: string;
  fading: boolean;
}

export type CardType = 'agent' | 'view' | 'browser';

export interface CanvasActions {
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  fitToView: () => void;
  fitToCards: (
    cardRects: Array<{ x: number; y: number; width: number; height: number }>,
    maxZoom?: number,
    animate?: boolean,
  ) => void;
}

export interface OverlayState {
  visible: boolean;
  top: number;
  left: number;
  width: number;
  height: number;
  label: string;
}

export interface DragRect {
  visible: boolean;
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface DragPreviewElement {
  selectId: string;
  top: number;
  left: number;
  width: number;
  height: number;
  label: string;
  action: 'add' | 'remove';
}