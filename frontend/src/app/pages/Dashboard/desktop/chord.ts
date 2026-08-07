// Renders a shortcut the way the platform writes it: mac glyphs run together, Windows spells them with +.
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform);

const GLYPH: Record<string, string> = {
  mod: IS_MAC ? '⌘' : 'Ctrl',
  ctrl: IS_MAC ? '⌃' : 'Ctrl',
  shift: IS_MAC ? '⇧' : 'Shift',
  alt: IS_MAC ? '⌥' : 'Alt',
  enter: IS_MAC ? '↩' : 'Enter',
  del: IS_MAC ? '⌫' : 'Del',
  tab: IS_MAC ? '⇥' : 'Tab',
};

export function chord(...keys: string[]): string {
  return keys.map((k) => GLYPH[k] ?? k).join(IS_MAC ? '' : '+');
}
