/** Resolve raw URL-bar input to a navigable URL (scheme passthrough, file paths, domains, Google fallback). */
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
