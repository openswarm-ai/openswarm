// Fetch helpers for the app-publishing endpoints. The global interceptor in
// shared/config.ts attaches the bearer, so we never set it here. The /publish
// endpoints return a result object (ok / blocked / error) rather than HTTP errors
// for the normal flow, so callers inspect the body.
import { API_BASE } from '@/shared/config';

import { ReviewSummary } from './shareTypes';

const OUTPUTS_API = `${API_BASE}/outputs`;

export interface PublishResult {
  ok: boolean;
  published_slug?: string | null;
  published_url?: string | null;
  /** True when the AST safety net blocked a non-force publish; review carries why. */
  blocked?: boolean;
  review?: ReviewSummary | null;
  error?: string | null;
}

export async function publishPreflight(outputId: string): Promise<ReviewSummary> {
  const res = await fetch(`${OUTPUTS_API}/publish/preflight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ output_id: outputId }),
  });
  if (!res.ok) throw new Error("We couldn't check this app.");
  const data = await res.json();
  return data.review as ReviewSummary;
}

export async function publishApp(
  outputId: string,
  opts: { slug?: string; force?: boolean } = {},
): Promise<PublishResult> {
  const res = await fetch(`${OUTPUTS_API}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ output_id: outputId, slug: opts.slug, force: !!opts.force }),
  });
  if (!res.ok) throw new Error('Publishing failed. Please try again.');
  return (await res.json()) as PublishResult;
}

export async function unpublishApp(outputId: string): Promise<void> {
  const res = await fetch(`${OUTPUTS_API}/unpublish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ output_id: outputId }),
  });
  if (!res.ok) throw new Error("We couldn't unpublish this app.");
}
