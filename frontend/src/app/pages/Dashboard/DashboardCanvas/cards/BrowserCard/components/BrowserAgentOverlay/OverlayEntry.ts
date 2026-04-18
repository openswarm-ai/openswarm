export interface OverlayEntry {
  type: 'thought' | 'action' | 'result' | 'skip';
  text: string;
}