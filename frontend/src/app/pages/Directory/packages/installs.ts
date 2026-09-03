import { API_BASE } from '@/shared/config';
import type { Listing } from './catalog';

// One typed pointer per importable root, mirroring the backend record.
export interface InstallRecord {
  listing_id: string;
  root_type: string;
  output_id?: string | null;
  skill_id?: string | null;
  workflow_id?: string | null;
  dashboard_id?: string | null;
  session_id?: string | null;
  version: string;
  installed_at: number;
}

export function recordFor(listingId: string, rootType: string, rootId: string, version: string): Omit<InstallRecord, 'installed_at'> {
  const rec: Omit<InstallRecord, 'installed_at'> = { listing_id: listingId, root_type: rootType, version };
  if (rootType === 'app') rec.output_id = rootId;
  else if (rootType === 'skill') rec.skill_id = rootId;
  else if (rootType === 'workflow') rec.workflow_id = rootId;
  else if (rootType === 'dashboard') rec.dashboard_id = rootId;
  else if (rootType === 'session' || rootType === 'mode') rec.session_id = rootId;
  return rec;
}

export type PillState = 'get' | 'installing' | 'open' | 'installed';

interface LiveEntities {
  outputs: Record<string, unknown>;
  skills: Record<string, unknown>;
  workflows: Record<string, unknown>;
}

// Get until the record says otherwise; Open only while the thing it became still exists, so a deleted app offers Get again instead of an Open that goes nowhere.
export function installState(listing: Listing, record: InstallRecord | undefined, live: LiveEntities): PillState {
  if (!record) return 'get';
  if (record.output_id) return record.output_id in live.outputs ? 'open' : 'get';
  if (record.skill_id) return record.skill_id in live.skills ? 'open' : 'get';
  if (record.workflow_id) return record.workflow_id in live.workflows ? 'open' : 'get';
  return 'installed';
}

export async function fetchInstalls(): Promise<Record<string, InstallRecord>> {
  const res = await fetch(`${API_BASE}/marketplace/installed`);
  if (!res.ok) return {};
  const body = (await res.json()) as { installs: Record<string, InstallRecord> };
  return body.installs || {};
}

export async function recordInstall(rec: Omit<InstallRecord, 'installed_at'>): Promise<Record<string, InstallRecord>> {
  const res = await fetch(`${API_BASE}/marketplace/installed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...rec, installed_at: 0 }),
  });
  if (!res.ok) throw new Error('Installed, but it may show Install again after a restart.');
  const body = (await res.json()) as { installs: Record<string, InstallRecord> };
  return body.installs || {};
}
