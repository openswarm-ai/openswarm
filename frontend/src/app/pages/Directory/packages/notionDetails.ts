import type { Listing } from './catalog';

// A package's long-form writeup is authored in Notion; we model it as structured blocks and render it natively rather than iframing Notion, which would drag in its own fonts, chrome and network load with no theming.

export type DetailBlock =
  | { type: 'heading'; emoji?: string; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'callout'; emoji?: string; title?: string; text: string; tone?: 'default' | 'warning' | 'info' }
  | { type: 'features'; items: { emoji: string; title: string; text: string }[] }
  | { type: 'steps'; items: string[] }
  | { type: 'bullets'; items: string[] }
  | { type: 'faq'; items: { q: string; a: string }[] };

export interface DetailDoc {
  title: string;
  meta?: string;
  tagline?: string;
  tags?: string[];
  blocks: DetailBlock[];
}

// Null when the listing has no linked page or the stored JSON is malformed, and the dialog then renders nothing below the video.
export function detailsForListing(listing: Listing): DetailDoc | null {
  const raw = (listing.details_json || '').trim();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isDetailDoc(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// details_json arrives from a spreadsheet cell, so the shape is validated at this boundary; per-block fields are not, because PackageDetails already skips block types it does not recognize.
function isDetailDoc(v: unknown): v is DetailDoc {
  if (!v || typeof v !== 'object') return false;
  const doc = v as Record<string, unknown>;
  if (typeof doc.title !== 'string') return false;
  if (!Array.isArray(doc.blocks)) return false;
  return doc.blocks.every(
    (b) => b && typeof b === 'object' && typeof (b as Record<string, unknown>).type === 'string',
  );
}
