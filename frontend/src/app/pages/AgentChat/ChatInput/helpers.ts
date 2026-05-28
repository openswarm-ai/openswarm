export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// Path basename that works on both POSIX (/Users/x/file.pdf) and Windows
// (C:\Users\x\file.pdf). Splits on either separator; falls back to the
// raw path so empty segments don't yield ''.
export function basename(p: string): string {
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

export function pathTail(p: string, n: number): string {
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-n).join('/');
}
