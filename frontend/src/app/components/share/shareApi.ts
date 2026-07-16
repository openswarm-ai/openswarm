// Thin fetch helpers for the .swarm endpoints. The global interceptor in shared/config.ts attaches the bearer token, so we never set it here. Errors surface the backend's short detail message (those are already user-facing) or a friendly fallback; callers translate to a toast.
import { API_BASE } from '@/shared/config';

import {
  ExportPreflight,
  ImportCommitResult,
  ImportPreflight,
  ShareTarget,
} from './shareTypes';

async function _detail(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.detail === 'string' && data.detail) return data.detail;
  } catch {
    /* non-JSON error body */
  }
  return fallback;
}

export async function exportPreflight(target: ShareTarget): Promise<ExportPreflight> {
  const res = await fetch(`${API_BASE}/swarm/export/preflight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: target.kind, id: target.id }),
  });
  if (!res.ok) throw new Error(await _detail(res, "We couldn't read this for sharing."));
  return res.json();
}

export async function downloadSwarm(target: ShareTarget, filename: string, allowSecrets = false): Promise<void> {
  const res = await fetch(`${API_BASE}/swarm/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: target.kind, id: target.id, allow_secrets: allowSecrets }),
  });
  if (!res.ok) throw new Error(await _detail(res, "We couldn't build the file."));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function importPreflight(file: File): Promise<ImportPreflight> {
  const form = new FormData();
  form.append('file', file);
  // No Content-Type header: the browser sets the multipart boundary itself.
  const res = await fetch(`${API_BASE}/swarm/import/preflight`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(await _detail(res, "We couldn't read this file."));
  return res.json();
}

export async function importCommit(
  stagingToken: string,
  acceptRequirements: string[] = [],
): Promise<ImportCommitResult> {
  const res = await fetch(`${API_BASE}/swarm/import/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ staging_token: stagingToken, accept_requirements: acceptRequirements }),
  });
  if (!res.ok) throw new Error(await _detail(res, "We couldn't finish the import."));
  return res.json();
}
