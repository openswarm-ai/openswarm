// Plumbing chats the UI spins up for itself: a workflow card's Edit Agent, a workflow run, a browser
// or sub agent working for a parent. They are real sessions, they just aren't things the user started.
const PLUMBING_MODES: ReadonlySet<string> = new Set(['browser-agent', 'invoked-agent', 'sub-agent']);

export interface SessionOrigin {
  mode: string;
  workflow_run_id?: string | null;
  workflow_edit_id?: string | null;
}

/** A run that is still working, so its card is worth having on screen. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['running', 'waiting_approval']);

/** True for a helper session (sub/browser/invoked agent) whose card can only exist by an explicit
 * reveal click; reconcile must never delete such a card while its session lives (ENG-304). */
export function isPlumbingSession(session: SessionOrigin): boolean {
  return PLUMBING_MODES.has(session.mode);
}

/** True for a chat the user started themselves, which is the only kind that earns a notification. */
export function isUserLaunchedSession(session: SessionOrigin): boolean {
  return !session.workflow_run_id && !session.workflow_edit_id && !PLUMBING_MODES.has(session.mode);
}

/** True for a session that should have a card on the canvas right now.
 *
 * A workflow run earns one WHILE IT RUNS. Denying it a card is what made its browsers spawn as loose
 * canvas windows that nothing owned and nothing tore down (ENG-248/249/250 were all symptoms of it):
 * the dock path is gated on the parent card existing, so no card meant no owner. Give the run a card
 * and the existing inline-dock plus despawn logic applies to it unchanged. The card goes when the run
 * stops, or a nightly workflow would leave one behind every single night.
 */
export function deservesCanvasCard(session: SessionOrigin & { status?: string }): boolean {
  if (isUserLaunchedSession(session)) return true;
  return !!session.workflow_run_id && LIVE_STATUSES.has(session.status ?? '');
}
