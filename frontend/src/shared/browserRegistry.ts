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
  stop: () => void;
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

// Electron suspends webContents.executeJavaScript until the page "stops loading", and pages with straggler iframes (LinkedIn's recaptcha/trackers) can stay isLoading for minutes; the guarded eval in browserCommandHandler needs to know the document itself is usable before it dares wv.stop().
const domReadyDocs = new WeakSet<BrowserWebview>();
const loadTrackingArmed = new WeakSet<BrowserWebview>();

function armLoadStateTracking(wv: BrowserWebview): void {
  if (loadTrackingArmed.has(wv)) return;
  loadTrackingArmed.add(wv);
  wv.addEventListener('dom-ready', () => domReadyDocs.add(wv));
  // a real main-frame navigation starts a new document; in-page (SPA pushState) ones don't
  wv.addEventListener('did-navigate', () => domReadyDocs.delete(wv));
}

export function hasDomReady(wv: BrowserWebview): boolean {
  return domReadyDocs.has(wv);
}

export function markDomReady(wv: BrowserWebview): void {
  domReadyDocs.add(wv);
}

export function registerWebview(browserId: string, tabId: string, wv: BrowserWebview): void {
  registry.set(makeKey(browserId, tabId), wv);
  armLoadStateTracking(wv);
}

// Lazy-tab loading: a background tab mounts its <webview> (so it stays registered + resolvable
// exactly like a live one) but defers loadURL until it's actually needed, so a many-tab card
// doesn't load every page at once. The tab is never starved: it's woken when it becomes active
// OR the moment an agent command resolves it.
const pendingLoad = new WeakMap<BrowserWebview, () => void>();
const intendedUrl = new WeakMap<BrowserWebview, string>();

export function registerPendingLoad(wv: BrowserWebview, url: string, load: () => void): void {
  pendingLoad.set(wv, load);
  intendedUrl.set(wv, url);
}

export function isPendingLoad(wv: BrowserWebview): boolean {
  return pendingLoad.has(wv);
}

// Fire a lazy tab's deferred load exactly once; returns true if it was pending (the caller then
// waits out the page load, same as a resumed suspended card). No-op on an already-loaded tab.
export function wakePendingLoad(wv: BrowserWebview): boolean {
  const load = pendingLoad.get(wv);
  if (!load) return false;
  pendingLoad.delete(wv);
  load();
  return true;
}

// Drop a lazy tab's deferred load WITHOUT firing it: an agent navigate is about to load a
// different url, so loading the old intended url first would be wasted work.
export function clearPendingLoad(wv: BrowserWebview): void {
  pendingLoad.delete(wv);
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
  const matchesHost = (u: string): boolean => {
    try {
      const host = new URL(u).hostname.toLowerCase();
      return host === d || host.endsWith('.' + d);
    } catch {
      // about:blank or a torn-down webview has no parseable URL; skip it.
      return false;
    }
  };
  for (const wv of registry.values()) {
    if (matchesHost(wv.getURL())) return wv;
  }
  // A lazy background tab sits at about:blank, so its LIVE url can't match; fall back to its
  // INTENDED (deferred) url so the session-borrow shims still find + wake it. The caller wakes it.
  for (const wv of registry.values()) {
    const pend = intendedUrl.get(wv);
    if (pend && pendingLoad.has(wv) && matchesHost(pend)) return wv;
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
