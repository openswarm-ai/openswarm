// While the user is mid-gesture (dragging a card, panning or zooming the canvas), streamed tokens
// must not steal frames: each delta lands as a React commit, and under several live agents those
// commits burst to 50-66ms right through the drag (measured on exp.13, the "still feels glitchy"
// report). A decaying "interacting" stamp is kept here; stream dispatch consults it and falls back
// to the buffer during the gesture. Smoothness beats token immediacy for ~a second.
//
// WHEEL IS NOT MARKED HERE, and that is the point. A blanket capture-phase wheel listener marks
// EVERY wheel in the app, including the one thing a user does most while an answer streams: scroll
// the transcript they are reading. That paused the stream for as long as their hand kept moving and
// then dumped the backlog in one burst, which is the "streams halfway, stops, then re-streams
// everything super fast" report. The canvas already decides who owns a wheel (wheelGestureOwner +
// useCanvasControls) and calls markInteraction() at the single point where it commits to handling
// one, so a pan and a zoom still suppress streaming and a transcript scroll never does. One owner,
// one decision, no second copy of the rule.
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
  window.addEventListener('pointerdown', markInteraction, { capture: true, passive: true });
  window.addEventListener('pointermove', (e: PointerEvent) => { if (e.buttons) markInteraction(); }, { capture: true, passive: true });
}
