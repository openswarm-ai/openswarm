// Which notifications the user actually asked for. Pure, so the decision can be tested without a
// store: this is the branch that decides whether someone hears about a failed run at all, and the
// old version got it wrong in a way nobody could see (a workflow alert was re-checked against the
// AGENT toggle on the fallback path, so switching agents off silently muted workflows too).

export interface NotifyPrefs {
  notify_agent_completion?: boolean;
  notify_agent_errors?: boolean;
  notify_workflow_runs?: boolean;
  notify_workflow_failures?: boolean;
  notify_sound?: boolean;
  notify_when_focused?: boolean;
}

/** Absent means on, so a profile saved before a toggle existed keeps behaving as its owner expects. */
export const notifyOn = (v: boolean | undefined): boolean => v !== false;

export function notifyWanted(d: NotifyPrefs, kind: 'agent' | 'workflow', bad: boolean): boolean {
  if (kind === 'agent') return bad ? notifyOn(d.notify_agent_errors) : notifyOn(d.notify_agent_completion);
  return bad ? notifyOn(d.notify_workflow_failures) : notifyOn(d.notify_workflow_runs);
}

/** Held back while you are already looking at the window, unless you said otherwise. */
export function notifyAllowedNow(d: NotifyPrefs, documentHidden: boolean): boolean {
  return documentHidden || d.notify_when_focused === true;
}
