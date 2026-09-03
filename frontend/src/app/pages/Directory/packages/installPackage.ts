import { API_BASE } from '@/shared/config';
import type { ImportPreflight } from '@/app/components/share/shareTypes';

// Installing a marketplace package is the ordinary bundle import with the download done for you:
// the backend fetches the .swarm and stages it, then the SAME confirm surface and commit route a
// dropped file uses take over. One door, so the secret review and the skill-confirm rule cannot
// hold on one path and not the other. The download runs as a job so the pill can show real bytes.

export interface InstallProgress {
  received: number;
  total: number;
}

interface JobStatus {
  job_id: string;
  phase: 'downloading' | 'staging' | 'ready' | 'failed';
  received: number;
  total: number;
  preflight?: ImportPreflight | null;
  error?: string | null;
}

export const POLL_MS = 150;
const DOWNLOAD_FAILED = "Couldn't download it. Try again.";

async function detailOf(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: string };
    return body.detail || fallback;
  } catch {
    // A non-JSON error body is still an error; the default sentence stands.
    return fallback;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export async function stagePackageInstall(
  listingId: string,
  onProgress?: (progress: InstallProgress) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<ImportPreflight> {
  const started = await fetchImpl(`${API_BASE}/marketplace/install/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: listingId }),
  });
  if (!started.ok) throw new Error(await detailOf(started, DOWNLOAD_FAILED));
  const { job_id } = (await started.json()) as { job_id: string };
  for (;;) {
    const res = await fetchImpl(`${API_BASE}/marketplace/install/${job_id}`);
    if (!res.ok) throw new Error(await detailOf(res, DOWNLOAD_FAILED));
    const status = (await res.json()) as JobStatus;
    if (status.phase === 'failed') throw new Error(status.error || DOWNLOAD_FAILED);
    if (status.phase === 'ready' && status.preflight) return status.preflight;
    // Staging is local and quick; the ring reads as full while it runs.
    onProgress?.(status.phase === 'staging' && status.total > 0
      ? { received: status.total, total: status.total }
      : { received: status.received, total: status.total });
    await sleep(POLL_MS);
  }
}
