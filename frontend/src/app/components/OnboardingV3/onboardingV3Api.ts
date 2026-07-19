import { API_BASE } from '@/shared/config';
import type { PersonalizedStarter, PersonalizedAutomation } from '@/shared/state/settingsSlice';

export interface ProviderIdentity {
  provider: string;
  label: string;
  email?: string | null;
  plan?: string | null;
}

export interface FolderSummary {
  name: string;
  entry_count: number;
  screenshot_count: number;
  top_extensions: string[];
}

export interface ScanResult {
  apps: string[];
  signal_apps: string[];
  folders: FolderSummary[];
  git_repo_count: number;
  has_gitconfig: boolean;
}

export interface PrepResponse {
  greeting: string;
  starters: PersonalizedStarter[];
  app_title: string;
  app_prompt: string;
  app_reason: string;
  research_title: string;
  research_prompt: string;
  research_reason: string;
  automations: PersonalizedAutomation[];
}

export async function fetchIdentity(): Promise<ProviderIdentity[]> {
  try {
    const res = await fetch(`${API_BASE}/onboarding/identity`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.providers) ? data.providers : [];
  } catch {
    return [];
  }
}

export async function runScan(): Promise<ScanResult | null> {
  try {
    const res = await fetch(`${API_BASE}/onboarding/scan`, { method: 'POST' });
    if (!res.ok) return null;
    return (await res.json()) as ScanResult;
  } catch {
    return null;
  }
}

export async function runPrep(scan: ScanResult | null, pickedApps: string[], identity: ProviderIdentity[], usageSummary: string): Promise<PrepResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/onboarding/prep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scan, picked_apps: pickedApps, identity, usage_summary: usageSummary }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as PrepResponse;
    return Array.isArray(data?.starters) && data.starters.length > 0 ? data : null;
  } catch {
    return null;
  }
}

// One human-readable line about what the scan found, reused by the reveal note so the user can see exactly what informed their starters. Leads with the telling apps (the sharp part), then repos + folder volume.
export function summarizeScan(scan: ScanResult | null): string | null {
  if (!scan) return null;
  const parts: string[] = [];
  if (scan.signal_apps?.length) parts.push(scan.signal_apps.slice(0, 3).join(', '));
  if (scan.git_repo_count > 0) parts.push(`${scan.git_repo_count} git repo${scan.git_repo_count === 1 ? '' : 's'}`);
  for (const f of scan.folders) {
    if (f.screenshot_count > 20) parts.push(`${f.screenshot_count} screenshots on your ${f.name}`);
    else if (f.entry_count > 300) parts.push(`${f.entry_count} files in ${f.name}`);
  }
  return parts.length > 0 ? parts.slice(0, 4).join(', ') : null;
}
