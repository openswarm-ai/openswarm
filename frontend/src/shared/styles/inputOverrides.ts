import type { ClaudeTokens } from './claudeTokens';

// A bare <TextField> renders its text with MUI's palette, not ours. On a dark surface that is black
// text on a black field: you cannot see what you are typing (ENG-281, hit on the question flow's
// "Other..." box). Pinned at the theme so every input inherits it and no future bare field can
// reintroduce the bug.
//
// Deliberately COLOUR ONLY. An earlier version of this also set borderRadius, backgroundColor and
// the fieldset border colours, which changed the appearance of all 38 TextFields and 36 Selects in
// the app (Select renders through MuiOutlinedInput too) to fix a problem that was only ever about
// text contrast. Geometry and fill are left exactly as they were: the blast radius of a readability
// fix should be readability.

export function inputStyleOverrides(c: ClaudeTokens): Record<string, object> {
  return {
    root: {
      color: c.text.primary,
      '& input, & textarea': { color: c.text.primary },
      // Placeholders need their own rule: MUI dims them with opacity on the inherited colour, which
      // lands invisible when the inherited colour was already wrong.
      '& input::placeholder, & textarea::placeholder': { color: c.text.tertiary, opacity: 1 },
    },
  };
}
