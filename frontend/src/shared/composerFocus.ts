// The composer the user last typed in, by its data-osw-composer owner id. Dictation with no cursor anywhere lands there (expanding a collapsed card on the way) instead of in a brand-new chat, so a pending attachment or draft is never stranded.
let lastFocusedComposerId: string | null = null;

export function setLastFocusedComposer(ownerId: string): void {
  lastFocusedComposerId = ownerId;
}

export function getLastFocusedComposer(): string | null {
  return lastFocusedComposerId;
}
