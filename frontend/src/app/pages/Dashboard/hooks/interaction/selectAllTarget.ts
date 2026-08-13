// Where should Cmd+A apply? (ENG-231)
//
// It used to be two cases: inside a text field the browser handles it, anywhere else select every
// card on the canvas. That skipped the case people actually hit most, which is reading a chat:
// focus is inside a transcript, you press Cmd+A expecting that conversation, and instead every card
// on the board goes selected and Backspace deletes your work.
//
// Three cases, decided in one place so a caller cannot invent a fourth:
//   'native'     a text field owns it; do nothing and let the browser select the text
//   'transcript' focus is inside a chat; select that conversation, tool outputs and images included
//   'cards'      focus is on the canvas itself; select every card, the original behaviour

export type SelectAllScope = 'native' | 'transcript' | 'cards';

export interface SelectAllDecision {
  scope: SelectAllScope;
  transcript: HTMLElement | null;
}

const P_TRANSCRIPT_ATTR = 'data-chat-transcript';
const P_CHAT_ROOT_ATTR = 'data-chat-root';

function p_isTextField(el: Element | null): boolean {
  if (!el) return false;
  const tag = (el as HTMLElement).tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable === true;
}

function p_hasText(el: Element): boolean {
  const node = el as HTMLInputElement;
  if (typeof node.value === 'string') return node.value.length > 0;
  return ((el as HTMLElement).textContent || '').length > 0;
}

/** The transcript belonging to the same chat as `el`, even when `el` is the composer beside it. */
function p_siblingTranscript(el: Element): HTMLElement | null {
  if (typeof el.closest !== 'function') return null;
  const root = el.closest(`[${P_CHAT_ROOT_ATTR}]`);
  return root ? (root.querySelector(`[${P_TRANSCRIPT_ATTR}]`) as HTMLElement | null) : null;
}

/**
 * @param active the focused element, normally document.activeElement or the key event target
 */
export function selectAllTarget(active: Element | null): SelectAllDecision {
  if (p_isTextField(active)) {
    // A composer with a draft in it owns Cmd+A, same as any text box. An EMPTY one has nothing to
    // select, so the browser's select-all is a no-op and the user just sees nothing happen. In a
    // chat that is exactly the moment they meant "select this conversation", and a fullscreen chat
    // autofocuses its composer, so this was the common case rather than the corner one.
    if (p_hasText(active as Element)) return { scope: 'native', transcript: null };
    const sibling = p_siblingTranscript(active as Element);
    if (sibling) return { scope: 'transcript', transcript: sibling };
    return { scope: 'native', transcript: null };
  }
  // closest() walks through the card's own wrappers, so clicking any part of a chat still counts
  // as being "in" that chat rather than on the canvas behind it.
  const transcript = active && typeof active.closest === 'function'
    ? (active.closest(`[${P_TRANSCRIPT_ATTR}]`) as HTMLElement | null)
    : null;
  if (transcript) return { scope: 'transcript', transcript };
  return { scope: 'cards', transcript: null };
}
