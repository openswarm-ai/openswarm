export interface TabLocalState {
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

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