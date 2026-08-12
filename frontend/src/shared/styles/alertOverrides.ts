import type { ClaudeTokens } from './claudeTokens';

// Stock Material Alerts were leaking through the app: a saturated blue/green/red block with white
// text, in a product whose whole surface language is warm paper and glass. There are ~15 call sites
// and most pass no styling at all, so fixing them one at a time would just leave the next one to
// regress. This is the single place the theme reads, so a new Alert anywhere inherits the design
// instead of opting into it. Severity survives in the ICON colour, which is enough signal without a
// full-bleed colour bar shouting at the user.
export function alertStyleOverrides(c: ClaudeTokens): Record<string, object> {
  const surface = {
    backgroundColor: c.bg.elevated,
    color: c.text.primary,
  };
  const icon = (color: string) => ({ '& .MuiAlert-icon': { color } });
  return {
    root: {
      ...surface,
      borderRadius: c.radius.lg,
      fontSize: '0.8125rem',
      border: `1px solid ${c.border.strong}`,
      boxShadow: c.shadow.lg,
      backgroundImage: 'none',
    },
    standardSuccess: icon(c.status.success),
    standardInfo: icon(c.status.info),
    standardWarning: icon(c.status.warning),
    standardError: icon(c.status.error),
    // `variant="filled"` is the loudest offender; give it the same calm surface as the rest.
    filledSuccess: { ...surface, ...icon(c.status.success) },
    filledInfo: { ...surface, ...icon(c.status.info) },
    filledWarning: { ...surface, ...icon(c.status.warning) },
    filledError: { ...surface, ...icon(c.status.error) },
  };
}
