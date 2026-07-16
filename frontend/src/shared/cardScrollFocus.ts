// The card you've clicked INTO, so plain scroll reads its content (chat transcript, web page)
// while scroll everywhere else zooms the canvas (Google Maps model). Imperative + read on the
// wheel handler so no re-render; cleared when you click blank canvas.
let scrollFocusedCardId: string | null = null;
type Listener = (id: string | null) => void;
const listeners = new Set<Listener>();

export function setScrollFocusedCard(id: string | null): void {
  if (scrollFocusedCardId === id) return;
  scrollFocusedCardId = id;
  for (const l of listeners) l(id);
}

export function getScrollFocusedCard(): string | null {
  return scrollFocusedCardId;
}

// Browser cards subscribe so they can tell their (out-of-process) guest whether plain wheel should scroll the page or zoom the canvas.
export function onScrollFocusChange(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
