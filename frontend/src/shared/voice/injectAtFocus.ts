import { getLastInteractedBrowser } from '@/shared/browserFocus';
import { getWebview } from '@/shared/browserRegistry';
import { takeInjectSnapshot, setInjectSnapshot, isUsableTarget } from './injectTargetSnapshot';
import { guestHasEditableFocus } from './guestHasEditableFocus';

// Dictation lands where the user's cursor actually is, like every real dictation tool: a focused
// in-app field gets the text typed in (undo-friendly, fires React input events), a focused browser
// card forwards into the guest page's field, anything else falls back to the OS-level paste.
export type InjectTarget = 'field' | 'webview' | 'composer' | null;

export async function injectAtFocus(text: string): Promise<InjectTarget> {
  const snap = takeInjectSnapshot();
  // The cursor wins, not where you started. Wispr's grammar, and Eric's call: you dictate, you click
  // where you want it, it lands there. This deliberately reverts the snapshot-first version, which
  // pinned the text to the origin field and dropped it outright when that field went away.
  // The snapshot is still the fallback for the case it was really built for: focus drifting to
  // nothing typeable (a button, the body) while you were talking.
  const live = document.activeElement as HTMLElement | null;
  const active = isUsableTarget(live) ? live : snap.el;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
    try {
      active.focus();
      // execCommand keeps the undo stack and fires the input events React listens for; the manual
      // fallback covers fields where Chromium refuses the command (rare, e.g. type=number).
      const ok = document.execCommand('insertText', false, text);
      if (!ok && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        const el = active as HTMLInputElement | HTMLTextAreaElement;
        const s = el.selectionStart ?? el.value.length;
        const e = el.selectionEnd ?? el.value.length;
        el.value = el.value.slice(0, s) + text + el.value.slice(e);
        el.selectionStart = el.selectionEnd = s + text.length;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return 'field';
    } catch {
      return null;
    }
  }
  // A webview steals focus when the user clicks into a page, so activeElement IS the webview tag.
  // insertText silently no-ops when the guest has no focused editable, which read as the dictation
  // vanishing (ENG-254): confirm the guest target BEFORE claiming success, and await the insert so a
  // suspended/crashed guest falls through to the visible composer fallback instead of eating words.
  const focusedTag = active && active.tagName === 'WEBVIEW'
    ? (active as unknown as { insertText?: (t: string) => Promise<void>; executeJavaScript?: (c: string) => Promise<unknown> }) : null;
  if (focusedTag?.insertText && await guestHasEditableFocus(focusedTag)) {
    try { await focusedTag.insertText(text); return 'webview'; } catch { /* fall through */ }
  }
  // Last-interacted browser card: the user clicked a page field, then hit the hotkey.
  const browserId = snap.browserId || getLastInteractedBrowser();
  if (browserId) {
    const wv = getWebview(browserId) as unknown as { insertText?: (t: string) => Promise<void>; executeJavaScript?: (c: string) => Promise<unknown>; focus?: () => void } | undefined;
    if (wv?.insertText && await guestHasEditableFocus(wv)) {
      try { wv.focus?.(); await wv.insertText(text); return 'webview'; } catch { /* fall through */ }
    }
  }
  // No cursor anywhere: open the dashboard composer with the transcript typed in. Words are never dropped.
  window.dispatchEvent(new CustomEvent('openswarm:dictation-fallback', { detail: { text } }));
  return 'composer';
}

/** Called at press-start so the words land where the user was looking, not where focus drifted. */
export function snapshotInjectTarget(): void {
  // Only a typeable element counts as "aimed at". document.activeElement is <body> when nothing is
  // focused, and storing that would read as a lost target later and swallow the composer fallback.
  const active = document.activeElement as HTMLElement | null;
  setInjectSnapshot({
    el: isUsableTarget(active) ? active : null,
    browserId: getLastInteractedBrowser(),
  });
}
