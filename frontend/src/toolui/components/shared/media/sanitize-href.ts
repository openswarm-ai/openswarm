/**
 * Sanitize a URL to ensure it's safe for use in href attributes.
 * Allows:
 * - Absolute http(s) URLs
 * - Relative URLs (/path, ./path, ../path, ?query, #hash)
 *
 * @returns The sanitized URL string, or undefined if invalid/unsafe
 */
export function sanitizeHref(href?: string): string | undefined {
  if (!href) return undefined;
  const candidate = href.trim();
  if (!candidate) return undefined;

  if (
    candidate.startsWith("/") ||
    candidate.startsWith("./") ||
    candidate.startsWith("../") ||
    candidate.startsWith("?") ||
    candidate.startsWith("#")
  ) {
    if (candidate.startsWith("//")) return undefined;
    // eslint-disable-next-line no-control-regex -- intentionally matching control characters
    if (/[\u0000-\u001F\u007F]/.test(candidate)) return undefined;
    return candidate;
  }

  try {
    const url = new URL(candidate);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}
