// While the user is mid-gesture (dragging a card, wheeling the canvas), streamed tokens must not
// steal frames: each delta lands as a React commit, and under several live agents those commits
// burst to 50-66ms right through the drag (measured on exp.13, the "still feels glitchy" report).
// Capture-phase listeners keep a decaying "interacting" stamp; stream dispatch consults it and
// falls back to the 1Hz buffer during the gesture. Smoothness beats token immediacy for ~a second.
const DECAY_MS = 350;
// -Infinity, not 0: performance.now() is near 0 at process start, so 0 would read as 'mid-gesture' for the app's first 350ms.
let p_lastInteraction = Number.NEGATIVE_INFINITY;

export function markInteraction(): void {
  p_lastInteraction = performance.now();
}

export function interactionActive(): boolean {
  return performance.now() - p_lastInteraction < DECAY_MS;
}

let p_installed = false;
export function installInteractionListeners(): void {
  if (p_installed || typeof window === 'undefined') return;
  p_installed = true;
  window.addEventListener('wheel', markInteraction, { capture: true, passive: true });
  window.addEventListener('pointerdown', markInteraction, { capture: true, passive: true });
  window.addEventListener('pointermove', (e: PointerEvent) => { if (e.buttons) markInteraction(); }, { capture: true, passive: true });
}
