// Remembers the editable the USER last put their caret in, so when an agent-driven webview steals
// host focus (Chromium hands the <webview> element focus when the guest focuses an input) we can put
// the caret back where the user was instead of leaving them typing into the agent's page (ENG-252).

let lastEl: HTMLElement | null = null;

function isEditable(el: Element | null): el is HTMLElement {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable === true;
}

if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    const t = e.target as Element | null;
    // A webview grabbing focus is exactly what we guard against, never a target to remember.
    if (t && t.tagName !== 'WEBVIEW' && isEditable(t)) lastEl = t as HTMLElement;
  }, true);
}

/** Put the caret back in the user's last editable, if it is still attached. Returns true if it stuck. */
export function restoreLastUserFocus(): boolean {
  if (lastEl && lastEl.isConnected) {
    try { lastEl.focus(); return document.activeElement === lastEl; } catch { return false; }
  }
  return false;
}
