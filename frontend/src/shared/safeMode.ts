// Safe-mode loop breaker (ENG-228): after two dirty exits in ten minutes the main process arms
// safe mode, and this boot restores layout with webviews parked as screenshots until clicked, so a
// relaunch stops rebuilding the exact state that crashed. Resolved once at bundle eval; the IPC
// round-trip finishes long before the layout fetch that first reads it.
export interface SafeModeInfo {
  safeMode: boolean;
  dirtyCount: number;
  fingerprint: { exception: string | null; code: number | null; address: number | null } | null;
  reducedGraphics?: boolean;
}

let cached: SafeModeInfo = { safeMode: false, dirtyCount: 0, fingerprint: null };

// Import-safe outside a renderer: the layout slice imports this, and its reducer tests run under node:test.
const api = typeof window === 'undefined'
  ? undefined
  : (window as unknown as { openswarm?: { getSafeMode?: () => Promise<SafeModeInfo> } }).openswarm;
if (api?.getSafeMode) {
  void api.getSafeMode().then((info) => {
    if (info && typeof info.safeMode === 'boolean') cached = info;
  }).catch(() => {});
}

export function safeModeInfo(): SafeModeInfo {
  return cached;
}

export function isSafeMode(): boolean {
  return cached.safeMode;
}
