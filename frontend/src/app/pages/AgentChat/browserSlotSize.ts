// How much of the chat a docked browser is allowed to take (ENG-278).
//
// Extracted from the inline sx so the sizing can be exercised across every viewport and page shape
// rather than whichever one a screenshot happened to catch. The rule it encodes: a docked page is a
// preview, not the view. It previously capped at 52vh / 480px, which is over half the screen, and
// because the transcript sits pinned to the bottom that half was always the half you were reading.

/** Cap for a page that reported its dimensions; width follows so the aspect never breaks. */
export const SLOT_MAX_PX = 380;
export const SLOT_MAX_VH = 34;
/** Cap for a page that reported nothing, so there is no aspect to preserve. */
export const SLOT_FALLBACK_PX = 300;
export const SLOT_FALLBACK_VH = 28;
export const SLOT_MIN_PX = 140;

export interface SlotSize {
  /** Rendered height in CSS px at this viewport. */
  height: number;
  /** Rendered width in CSS px, or null when the slot is full-width (no aspect known). */
  width: number | null;
  fullWidth: boolean;
}

/** Resolve what the slot actually renders at, given the page's size and the viewport height. */
export function browserSlotSize(pageW: number, pageH: number, viewportH: number): SlotSize {
  const known = pageW > 0 && pageH > 0;
  if (!known) {
    const h = Math.min(SLOT_FALLBACK_PX, (SLOT_FALLBACK_VH / 100) * viewportH);
    return { height: Math.max(SLOT_MIN_PX, h), width: null, fullWidth: true };
  }
  const capped = Math.min(SLOT_MAX_PX, (SLOT_MAX_VH / 100) * viewportH);
  const height = Math.max(SLOT_MIN_PX, capped);
  return { height, width: height * (pageW / pageH), fullWidth: false };
}
