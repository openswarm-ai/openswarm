/** Last visual of a card captured at minimize time; in-memory only, keyed by card id. */
const shots = new Map<string, string>();
const CAP = 40;

export function saveMinimizedShot(cardId: string, dataUrl: string): void {
  if (shots.size >= CAP && !shots.has(cardId)) {
    const oldest = shots.keys().next().value;
    if (oldest) shots.delete(oldest);
  }
  shots.set(cardId, dataUrl);
}

export function getMinimizedShot(cardId: string): string | undefined {
  return shots.get(cardId);
}

export function dropMinimizedShot(cardId: string): void {
  shots.delete(cardId);
}
