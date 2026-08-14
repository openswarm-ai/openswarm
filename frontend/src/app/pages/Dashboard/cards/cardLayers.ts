// Where things stack inside a canvas card (ENG-290).
//
// App cards could only be resized on the preview tab. The Code/Terminal/History panel renders only
// when `activeView !== 'preview'`, covers the card with `inset: 0`, and sat at z-index 13 while the
// resize handles sat at 10, so switching tabs buried the handles under the panel. AgentCard already
// used 20 for the same handles, so this was one component drifting rather than a design question.
//
// Named and ordered here so the next panel someone adds has an obvious ceiling to stay under, and
// so the ordering is a thing a test can check rather than a number to eyeball.

/** Full-card content that replaces the preview (code, terminal, history). */
export const CONTENT_OVERLAY_Z = 13;

/** The invisible grab strips at the card's edges. Must sit ABOVE any content that fills the card,
 *  or the edges stop being grabbable wherever that content is showing. */
export const RESIZE_HANDLE_Z = 20;
