// The single source of truth for font families. If a family string lives anywhere
// else in the app, that's a bug waiting to drift; point it here instead.
export const FONT_SANS = "'Hanken Grotesk', Arial, sans-serif";
export const FONT_SERIF = "'Newsreader', Georgia, serif";
export const FONT_MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

// Ask for text by ROLE, not by family. Sizes and weights stay at the call site.
export const font: {
  display: string;
  detail: string;
  paragraph: string;
  heading: string;
  body: string;
  mono: string;
} = {
  display: FONT_SANS,
  detail: FONT_SANS,
  paragraph: FONT_SERIF,
  heading: FONT_SANS,
  body: FONT_SANS,
  mono: FONT_MONO,
};
