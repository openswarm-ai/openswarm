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
  capturePage: (rect?: { x: number; y: number; width: number; height: number }) => Promise<{
    toDataURL: () => string;
    toPNG: () => Buffer;
  }>;
  executeJavaScript: (code: string) => Promise<any>;
  sendInputEvent: (event: any) => void;
  getWebContentsId: () => number;
  addEventListener: (event: string, listener: (...args: any[]) => void) => void;
  removeEventListener: (event: string, listener: (...args: any[]) => void) => void;
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

export function getActiveTabId(browserId: string): string | undefined {
  return activeTabMap.get(browserId);
}

export function getAllWebviews(): Map<string, BrowserWebview> {
  return new Map(registry);
}

export function findBrowserByWebContentsId(wcId: number): string | undefined {
  for (const [key, wv] of registry.entries()) {
    if ((wv as any).getWebContentsId?.() === wcId) {
      return key.split(':')[0];
    }
  }
  return undefined;
}

export function unregisterAllForBrowser(browserId: string): void {
  const prefix = `${browserId}:`;
  for (const key of registry.keys()) {
    if (key.startsWith(prefix)) registry.delete(key);
  }
  activeTabMap.delete(browserId);
}
