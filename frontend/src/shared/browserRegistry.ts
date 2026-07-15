// Subset of Electron's NativeImage we actually call. resize() returns another NativeImage, hence the self-reference.
export interface ElectronNativeImage {
  toDataURL: () => string;
  toPNG: () => Buffer;
  toJPEG: (quality: number) => Buffer;
  isEmpty: () => boolean;
  getSize: () => { width: number; height: number };
  resize: (options: {
    width?: number;
    height?: number;
    quality?: 'good' | 'better' | 'best';
  }) => ElectronNativeImage;
}

export interface BrowserWebview extends HTMLElement {
  src: string;
  loadURL: (url: string) => Promise<void>;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  getURL: () => string;
  getTitle: () => string;
  isLoading: () => boolean;
  // Optional: present on real Electron webviews; the iframe fallback lacks it, callers must ?.() it.
  isCurrentlyAudible?: () => boolean;
  capturePage: (rect?: { x: number; y: number; width: number; height: number }) => Promise<ElectronNativeImage>;
  executeJavaScript: (code: string) => Promise<any>;
  sendInputEvent: (event: any) => void;
  getWebContentsId: () => number;
  getZoomLevel: () => number;
  setZoomLevel: (level: number) => void;
  findInPage: (text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }) => number;
  stopFindInPage: (action: 'clearSelection' | 'keepSelection' | 'activateSelection') => void;
  addEventListener: (event: string, listener: (...args: any[]) => void, options?: boolean | AddEventListenerOptions) => void;
  removeEventListener: (event: string, listener: (...args: any[]) => void, options?: boolean | EventListenerOptions) => void;
}

const registry = new Map<string, BrowserWebview>();
const activeTabMap = new Map<string, string>();

function makeKey(browserId: string, tabId: string): string {
  return `${browserId}:${tabId}`;
}

export function registerWebview(browserId: string, tabId: string, wv: BrowserWebview): void {
  registry.set(makeKey(browserId, tabId), wv);
}

export function unregisterWebview(browserId: string, tabId: string): void {
  registry.delete(makeKey(browserId, tabId));
}

export function setActiveTab(browserId: string, tabId: string): void {
  activeTabMap.set(browserId, tabId);
}

export function getWebview(browserId: string, tabId?: string): BrowserWebview | undefined {
  const resolvedTabId = tabId || activeTabMap.get(browserId);
  if (!resolvedTabId) return undefined;
  return registry.get(makeKey(browserId, resolvedTabId));
}

export function getBrowserWebviews(browserId: string): BrowserWebview[] {
  const out: BrowserWebview[] = [];
  for (const [key, wv] of registry.entries()) {
    if (key.split(':')[0] === browserId) out.push(wv);
  }
  return out;
}

export function findBrowserByWebContentsId(wcId: number): string | undefined {
  for (const [key, wv] of registry.entries()) {
    if ((wv as any).getWebContentsId?.() === wcId) {
      return key.split(':')[0];
    }
  }
  return undefined;
}

// Find the live webview currently on `domain` (e.g. tiktok.com). The session-borrow shims use
// this to drive the user's own already-open, logged-in card for that site, resolving by the
// LIVE url (not a stale persisted card.url) so the action lands on the real tab.
export function findWebviewByDomain(domain: string): BrowserWebview | undefined {
  const d = domain.toLowerCase().replace(/^\./, '');
  for (const wv of registry.values()) {
    try {
      const host = new URL(wv.getURL()).hostname.toLowerCase();
      if (host === d || host.endsWith('.' + d)) return wv;
    } catch {
      // about:blank or a torn-down webview has no parseable URL; skip it.
    }
  }
  return undefined;
}

// True if ANY registered webview is mid-navigation. Capturing the dashboard (which composites live webview pixels) while a webview's GPU surface is being recycled crashes the renderer (SharedImage 'non-existent mailbox' -> V8 ToLocalChecked), so the thumbnail capture must wait until they've settled.
export function anyWebviewLoading(): boolean {
  for (const wv of registry.values()) {
    try {
      if (typeof wv.isLoading === 'function' && wv.isLoading()) return true;
    } catch {
      // a torn-down webview can throw; treat as "not safe to capture"
      return true;
    }
  }
  return false;
}
