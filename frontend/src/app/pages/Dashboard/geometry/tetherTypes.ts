export type Side = 'left' | 'right' | 'top' | 'bottom';
export interface Anchor { x: number; y: number; side: Side }
export interface Rect { x: number; y: number; width: number; height: number }
export interface Routed { path: string; head: string; labelX: number; labelY: number }
