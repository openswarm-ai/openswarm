import { getLastInteractedBrowser } from '@/shared/browserFocus';
import { getLastFocusedComposer } from '@/shared/composerFocus';
import { getWebview } from '@/shared/browserRegistry';
import { store } from '@/shared/state/store';
import { expandSession } from '@/shared/state/agentsSlice';
import { selectViewportCoveringCardId } from '@/shared/state/dashboardLayoutSlice';
import { takeInjectSnapshot, setInjectSnapshot, isUsableTarget } from './injectTargetSnapshot';
import { guestHasEditableFocus } from './guestHasEditableFocus';

// Dictation lands where the user's cursor actually is, like every real dictation tool: a focused
// in-app field gets the text typed in (undo-friendly, fires React input events), a focused browser
// card forwards into the guest page's field, anything else falls back to the OS-level paste.
export type InjectTarget = 'field' | 'webview' | 'composer' | null;

function isField(el: HTMLElement): boolean {
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

function insertIntoField(active: HTMLElement, text: string): boolean {
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
    return true;
  } catch {
    return false;
  }
}

// A programmatic focus parks the caret at the START of a contenteditable, which would splice the dictation in front of an existing draft.
function placeCaretAtEnd(el: HTMLElement): void {
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const f = el as HTMLInputElement | HTMLTextAreaElement;
    f.selectionStart = f.selectionEnd = f.value.length;
    return;
  }
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function composerEditor(ownerId: string): HTMLElement | null {
  const root = document.querySelector<HTMLElement>(`[data-osw-composer="${CSS.escape(ownerId)}"]`);
  return root?.querySelector<HTMLElement>('[contenteditable="true"], textarea, input') ?? null;
}

// The one composer a dictation with no cursor can honestly mean: the card owning the screen (its only input), else the composer the user last typed in; a collapsed card is expanded first, and since its chat stays mounted across collapse the draft and pending attachments ride along.
async function resolveComposerTarget(): Promise<HTMLElement | null> {
  const state = store.getState();
  const covering = selectViewportCoveringCardId(state);
  const ownerId = covering ?? getLastFocusedComposer();
  if (!ownerId) return null;
  const editor = composerEditor(ownerId);
  if (!editor) return null;
  if (editor.getClientRects().length === 0) {
    if (!state.agents.sessions[ownerId] || state.agents.expandedSessionIds.includes(ownerId)) return null;
    store.dispatch(expandSession(ownerId));
    for (let i = 0; i < 12 && editor.getClientRects().length === 0; i++) await nextFrame();
    if (editor.getClientRects().length === 0) return null;
  }
  return editor;
}

export async function injectAtFocus(text: string): Promise<InjectTarget> {
  const snap = takeInjectSnapshot();
  // The cursor wins, not where you started. Wispr's grammar, and Eric's call: you dictate, you click
  // where you want it, it lands there. This deliberately reverts the snapshot-first version, which
  // pinned the text to the origin field and dropped it outright when that field went away.
  // The snapshot is still the fallback for the case it was really built for: focus drifting to
  // nothing typeable (a button, the body) while you were talking.
  const live = document.activeElement as HTMLElement | null;
  const active = isUsableTarget(live) ? live : snap.el;
  if (active && isField(active)) return insertIntoField(active, text) ? 'field' : null;
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
  const composer = await resolveComposerTarget();
  if (composer) {
    composer.focus();
    placeCaretAtEnd(composer);
    if (insertIntoField(composer, text)) return 'field';
  }
  // No composer anywhere: the dashboard toolbar opens with the transcript typed in and claims the event by cancelling it; unclaimed (no dashboard, or a card owns the screen) means nobody took the words, so the caller's clipboard fallback speaks instead of the text vanishing.
  const claimed = !window.dispatchEvent(new CustomEvent('openswarm:dictation-fallback', { detail: { text }, cancelable: true }));
  return claimed ? 'composer' : null;
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
