import { useEffect, RefObject } from 'react';
import { PASTE_CARD_ATTR, getPasteContent } from '@/app/components/editor/richEditorUtils';

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
    if (!saved || !editor) return;
    // Textarea path (Windows ablation): drafts were saved as plain text in .value, so just restore as text. The div path below is for contentEditable on Mac where drafts are HTML with skill pills.
    if (editor.tagName === 'TEXTAREA') {
      const ta = editor as unknown as HTMLTextAreaElement;
      if (ta.value.trim()) return;
      ta.value = saved;
      try { ta.selectionStart = ta.selectionEnd = ta.value.length; } catch (_) {}
      return;
    }
    if (!editor.textContent?.trim()) {
      editor.innerHTML = saved;
      const staleCards = editor.querySelectorAll(`[${PASTE_CARD_ATTR}]`);
      staleCards.forEach((el) => {
        const pid = el.getAttribute(PASTE_CARD_ATTR);
        if (!pid || !getPasteContent(pid)) el.remove();
      });
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
