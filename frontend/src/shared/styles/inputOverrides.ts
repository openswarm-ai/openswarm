import type { ClaudeTokens } from './claudeTokens';

// A bare <TextField> renders with MUI's own palette, not ours. On a dark surface that is black text
// on a black field: you cannot see what you are typing (ENG-281, hit on the question flow's
// "Other..." box). Fixing the one call site would leave every future bare field able to do it again,
// so the colours are pinned at the theme and every input in the app inherits them.

export function inputStyleOverrides(c: ClaudeTokens): Record<string, object> {
  return {
    root: {
      color: c.text.primary,
      backgroundColor: c.bg.surface,
      borderRadius: 10,
      '& input, & textarea': { color: c.text.primary },
      // Placeholders need their own rule: MUI paints them via opacity on the inherited colour, which
      // lands invisible when the inherited colour was already wrong.
      '& input::placeholder, & textarea::placeholder': { color: c.text.tertiary, opacity: 1 },
      '& fieldset': { borderColor: c.border.medium },
      '&:hover fieldset': { borderColor: c.border.strong },
      '&.Mui-focused fieldset': { borderColor: c.accent.primary },
      '&.Mui-disabled': { color: c.text.ghost },
    },
  };
}
