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

function p_isTextField(el: Element | null): boolean {
  if (!el) return false;
  const tag = (el as HTMLElement).tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable === true;
}

/**
 * @param active the focused element, normally document.activeElement or the key event target
 */
export function selectAllTarget(active: Element | null): SelectAllDecision {
  if (p_isTextField(active)) return { scope: 'native', transcript: null };
  // closest() walks through the card's own wrappers, so clicking any part of a chat still counts
  // as being "in" that chat rather than on the canvas behind it.
  const transcript = active && typeof active.closest === 'function'
    ? (active.closest(`[${P_TRANSCRIPT_ATTR}]`) as HTMLElement | null)
    : null;
  if (transcript) return { scope: 'transcript', transcript };
  return { scope: 'cards', transcript: null };
}
