import type { BrowserWebview } from './browserRegistry';

// Capsules carry site session tokens: in-memory ONLY, never redux, never disk, never logged.
export interface TabCapsule {
  ss: Record<string, string>;
  sx: number;
  sy: number;
  origin: string;
  capturedAt: number;
}

const CAPSULE_CAP = 100;
const CAPTURE_TIMEOUT_MS = 800;
const capsules = new Map<string, TabCapsule>();

interface OpenswarmCapsuleBridge {
  setSessionCapsule?: (wcId: number, capsule: TabCapsule) => void;
}

/** Snapshot a tab's sessionStorage + scroll before its webview unmounts, so resume can restore it Chrome-style instead of logging the user out. */
export async function captureTabCapsule(wv: BrowserWebview | null | undefined, tabId: string): Promise<void> {
  if (!wv) return;
  try {
    const raw = await Promise.race([
      wv.executeJavaScript(
        `(() => { const ss = {}; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k !== null) ss[k] = sessionStorage.getItem(k); } return JSON.stringify({ ss, sx: window.scrollX, sy: window.scrollY, origin: location.origin }); })()`,
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS)),
    ]);
    if (typeof raw !== 'string') return;
    const parsed = JSON.parse(raw) as { ss: Record<string, string>; sx: number; sy: number; origin: string };
    if (!parsed.origin || !parsed.origin.startsWith('http')) return;
    capsules.set(tabId, { ss: parsed.ss, sx: parsed.sx, sy: parsed.sy, origin: parsed.origin, capturedAt: Date.now() });
    if (capsules.size > CAPSULE_CAP) {
      const oldest = [...capsules.entries()].sort((a, b) => a[1].capturedAt - b[1].capturedAt)[0];
      if (oldest) capsules.delete(oldest[0]);
    }
  } catch {
    // A dead/navigating webview just means no capsule; resume falls back to a plain reload.
  }
}

/** Hand a resumed tab's capsule to the main process, keyed by the fresh webContents id, BEFORE loadURL fires; the guest preload sync-takes it at document-start so page scripts see restored state. */
export function registerCapsuleForRestore(wv: BrowserWebview, tabId: string): void {
  const capsule = capsules.get(tabId);
  if (!capsule) return;
  const bridge = (window as unknown as { openswarm?: OpenswarmCapsuleBridge }).openswarm;
  if (!bridge?.setSessionCapsule) return;
  try {
    bridge.setSessionCapsule(wv.getWebContentsId(), capsule);
  } catch {
    // Bridge unavailable (iframe fallback / non-Electron): plain reload, same as before capsules existed.
  }
}

export function hasCapsule(tabId: string): boolean {
  return capsules.has(tabId);
}
