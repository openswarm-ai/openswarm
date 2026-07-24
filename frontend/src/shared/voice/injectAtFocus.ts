import { getLastInteractedBrowser } from '@/shared/browserFocus';
import { getWebview } from '@/shared/browserRegistry';

// Dictation lands where the user's cursor actually is, like every real dictation tool: a focused
// in-app field gets the text typed in (undo-friendly, fires React input events), a focused browser
// card forwards into the guest page's field, anything else falls back to the OS-level paste.
export type InjectTarget = 'field' | 'webview' | null;

export function injectAtFocus(text: string): InjectTarget {
  const active = document.activeElement as HTMLElement | null;
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
  const focusedTag = active && active.tagName === 'WEBVIEW' ? (active as unknown as { insertText?: (t: string) => Promise<void> }) : null;
  if (focusedTag?.insertText) {
    try { void focusedTag.insertText(text); return 'webview'; } catch { /* fall through */ }
  }
  // Last-interacted browser card: the user clicked a page field, then hit the hotkey.
  const browserId = getLastInteractedBrowser();
  if (browserId) {
    const wv = getWebview(browserId) as unknown as { insertText?: (t: string) => Promise<void>; focus?: () => void } | undefined;
    if (wv?.insertText) {
      try { wv.focus?.(); void wv.insertText(text); return 'webview'; } catch { /* fall through */ }
    }
  }
  return null;
}
