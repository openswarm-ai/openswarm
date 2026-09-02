import { API_BASE } from '@/shared/config';

const CATALOG_LISTINGS_URL = `${API_BASE}/catalog/listings`;

export interface Listing {
  id: string;
  title: string;
  kind: string;
  version: string;
  author: string;
  description: string;
  tags: string;
  download_url: string;
  icon_url: string;
  video_url: string;
  size: string;
  updated_at: string;
  // Bundles (kind === 'bundle') list their member ids here, comma separated; empty on ordinary packages.
  bundle_items: string;
  notion_url: string;
  // The linked Notion page converted to DetailDoc JSON at upload time; empty when there is no linked page.
  details_json: string;
}

export interface ListingsResponse {
  source: 'sheet' | 'sample';
  count: number;
  listings: Listing[];
  error: string;
}

export async function fetchListings(): Promise<ListingsResponse> {
  const res = await fetch(CATALOG_LISTINGS_URL);
  if (!res.ok) throw new Error(`Listings request failed (${res.status})`);
  return (await res.json()) as ListingsResponse;
}

export function parseTags(tags: string): string[] {
  return (tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

// Drive's /file/d/{id}/preview URL is a player page an HTML5 <video> cannot play (and its iframe embed fails on clips Drive never transcoded), so pull the file id back out and rebuild the Range-enabled byte-stream URL.
export function driveStreamUrl(url: string): string {
  if (!url) return '';
  if (url.includes('drive.usercontent.google.com/download')) return url;
  const m = url.match(/\/file\/d\/([^/]+)/) || url.match(/[?&]id=([^&]+)/);
  const fileId = m?.[1];
  if (!fileId) return url;
  return `https://drive.usercontent.google.com/download?id=${fileId}&export=download`;
}

// YouTube hands out the same 11-char id through four URL shapes, and listings carry whichever one the author copied.
export function youtubeId(url: string): string | null {
  if (!url) return null;
  const m =
    url.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
    url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
    url.match(/\/embed\/([A-Za-z0-9_-]{11})/) ||
    url.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
  return m?.[1] ?? null;
}

export interface VideoEmbed {
  kind: 'youtube' | 'file';
  src: string;
  poster?: string;
  videoId?: string;
}

// Newer listings host the demo on YouTube (unlisted) and legacy ones on Drive, so the player has to be picked per URL.
export function videoEmbed(url: string): VideoEmbed | null {
  if (!url) return null;
  const yt = youtubeId(url);
  if (yt) {
    return {
      kind: 'youtube',
      src: `https://www.youtube.com/embed/${yt}?rel=0&playsinline=1`,
      poster: `https://i.ytimg.com/vi/${yt}/maxresdefault.jpg`,
      videoId: yt,
    };
  }
  return { kind: 'file', src: driveStreamUrl(url) };
}

// One video_url cell can hold several demos, one URL per line, the primary first; a legacy single-URL cell parses to a one-element list unchanged.
export function parseVideoUrls(raw: string): string[] {
  return (raw || '')
    .split(/[\r\n]+/)
    .map((u) => u.trim())
    .filter(Boolean);
}

// Each entry keeps its original URL so callers can key and dedupe on it.
export function videoEmbeds(raw: string): { url: string; embed: VideoEmbed }[] {
  const out: { url: string; embed: VideoEmbed }[] = [];
  for (const url of parseVideoUrls(raw)) {
    const embed = videoEmbed(url);
    if (embed) out.push({ url, embed });
  }
  return out;
}

export const KIND_LABELS: Record<string, string> = {
  skill: 'Skill',
  workflow: 'Workflow',
  app: 'App',
  mode: 'Mode',
  agent: 'Agent',
  dashboard: 'Dashboard',
  bundle: 'Bundle',
};

export function isBundle(listing: Listing): boolean {
  return (listing.kind || '').trim().toLowerCase() === 'bundle';
}

export function parseBundleItems(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of (raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// Preserves bundle order, drops ids whose listing no longer exists (a member deleted after bundling), and never returns the bundle itself.
export function resolveBundleMembers(bundle: Listing, all: Listing[]): Listing[] {
  const byId = new Map(all.map((l) => [l.id, l]));
  const out: Listing[] = [];
  for (const id of parseBundleItems(bundle.bundle_items)) {
    const member = byId.get(id);
    if (member && member.id !== bundle.id) out.push(member);
  }
  return out;
}
