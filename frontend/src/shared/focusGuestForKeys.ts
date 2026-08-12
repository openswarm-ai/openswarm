import type { BrowserWebview } from './browserRegistry';

// A synthetic key or text insert follows the HOST window's focus, not the CDP target it was
// addressed to. Measured in an isolated Electron probe, with the user's caret in a plain input:
//
//   Input.dispatchKeyEvent -> the characters landed in the USER's input, not the page
//   Input.insertText       -> a whole string landed in the USER's input, not the page
//   after focusing the <webview> element first -> both landed in the page, user's input untouched
//
// So the guest MUST hold host focus while the agent types, and the previously trusted in-guest
// document.body.focus() does not provide it (same probe, still leaked). This is also why the
// caret-restore idea in ENG-252 is not merely useless but harmful: hand the caret back mid-run and
// the agent's next Enter submits whatever the user was halfway through writing.

let p_takeovers = 0;

/** How many times a keystroke had to take the caret off a real user text surface. */
export function guestKeyTakeoverCount(): number {
  return p_takeovers;
}

export function resetGuestKeyTakeoverCount(): void {
  p_takeovers = 0;
}

function p_isUserTextSurface(el: Element | null): boolean {
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable === true;
}

/** Give the guest the host focus its keystrokes need, counting when we took it from a user. */
export function focusGuestForKeys(wv: BrowserWebview): void {
  const before = typeof document !== 'undefined' ? document.activeElement : null;
  if (before !== (wv as unknown as Element) && p_isUserTextSurface(before)) p_takeovers += 1;
  try {
    wv.focus();
  } catch {
    // The card unmounted mid-command. The keystroke will miss, which beats it hitting the user.
  }
}
