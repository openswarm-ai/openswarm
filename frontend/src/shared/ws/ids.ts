export function genUuid(): string {
  // Avoid pulling in `crypto.randomUUID` for compat; this is a disambiguator, not a security boundary.
  const a = Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, '0');
  const b = Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, '0');
  const c = Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, '0');
  return `${a}${b}${c}`;
}
