import { useEffect, RefObject } from 'react';

// Module-level draft store keyed by sessionId; survives unmount/remount and preserves skill pills via innerHTML.
const _draftStore = new Map<string, string>();
// 200ms debounce coalesces fast typing; innerHTML reads do full DOM serialization.
const _draftDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DRAFT_DEBOUNCE_MS = 200;

export function scheduleDraftSave(ownerId: string, getHtml: () => string) {
  const existing = _draftDebounceTimers.get(ownerId);
  if (existing) clearTimeout(existing);
  _draftDebounceTimers.set(ownerId, setTimeout(() => {
    _draftDebounceTimers.delete(ownerId);
    const html = getHtml();
    if (html && html !== '<br>') _draftStore.set(ownerId, html);
    else _draftStore.delete(ownerId);
  }, DRAFT_DEBOUNCE_MS));
}

export function loadDraft(ownerId: string): string | undefined {
  return _draftStore.get(ownerId);
}

export function deleteDraft(ownerId: string) {
  _draftStore.delete(ownerId);
}

export function useDraftLoad(editorRef: RefObject<HTMLDivElement>, ownerId: string) {
  useEffect(() => {
    const saved = _draftStore.get(ownerId);
    const editor = editorRef.current;
    if (saved && editor && !editor.textContent?.trim()) {
      editor.innerHTML = saved;
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
