/**
 * Resolves raw URL-bar input into a navigable URL.
 *
 * Priority:
 *  1. Already has a scheme (http://, https://, file://, etc.) → pass through
 *  2. Starts with / or ~ → file path, prefix with file://
 *  3. localhost (with optional port/path) → http://
 *  4. IP address (with optional port/path) → http://
 *  5. No spaces + contains a dot followed by a 2+ char TLD → domain, prefix https://
 *  6. Everything else → Google search
 */
export function resolveInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^[~/]/.test(trimmed)) return `file://${trimmed}`;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(trimmed)) return `http://${trimmed}`;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(trimmed)) return `http://${trimmed}`;
  if (!/\s/.test(trimmed) && /\.[a-zA-Z]{2,}/.test(trimmed)) return `https://${trimmed}`;

  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

export function isGoogleSearch(url: string): boolean {
  return url.startsWith('https://www.google.com/search');
}
