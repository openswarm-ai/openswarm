// The card you've clicked INTO, so plain scroll reads its content (chat transcript, scheduled-task
// list) while scroll everywhere else zooms the canvas (Google Maps model). Imperative + read on the
// wheel handler so no re-render; cleared when you click blank canvas. Browser/app cards aren't tracked
// here: their guest page owns its own scroll/zoom (Maps, Figma), so plain wheel always stays in them.
let scrollFocusedCardId: string | null = null;

export function setScrollFocusedCard(id: string | null): void {
  scrollFocusedCardId = id;
}

export function getScrollFocusedCard(): string | null {
  return scrollFocusedCardId;
}
