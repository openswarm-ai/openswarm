import { API_BASE } from '@/shared/config';
import type { ImportPreflight } from '@/app/components/share/shareTypes';

// Installing a marketplace package is the ordinary bundle import with the download done for you:
// the backend fetches the .swarm and stages it, then the SAME confirm surface and commit route a
// dropped file uses take over. One door, so the secret review and the skill-confirm rule cannot
// hold on one path and not the other.
export async function stagePackageInstall(listingId: string): Promise<ImportPreflight> {
  const res = await fetch(`${API_BASE}/marketplace/install/preflight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: listingId }),
  });
  if (!res.ok) {
    let detail = "We couldn't download this package.";
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      // A non-JSON error body is still an error; the default sentence stands.
    }
    throw new Error(detail);
  }
  return res.json();
}
