import type { BrowserWebview, ElectronNativeImage } from '@/shared/browserRegistry';

// ENG-279: a window.open from a browser card becomes a NATIVE window with no <webview> element,
// so every tool that resolves a target via the DOM registry went blind exactly at the auth popup.
// The CDP layer is target-agnostic (main addresses webContents by id), so this registry hands the
// command chokepoint a shim that speaks the BrowserWebview subset the agent path actually uses,
// proxied over sendCdpCommand by webContents id. The popup stays a REAL popup, so window.opener
// (how OAuth returns its code) is fully preserved; that is why fix A (reopen as a tab) was rejected.

interface PopupRecord {
  browserId: string;
  wcId: number;
  url: string;
  shim: BrowserWebview;
}

const p_byBrowserId = new Map<string, PopupRecord>();

type CdpSend = (wcId: number, method: string, params?: object) => Promise<any>;

function p_cdp(): CdpSend {
  const bridge = (window as any).openswarm;
  if (!bridge?.sendCdpCommand) throw new Error('CDP bridge unavailable');
  return (wcId, method, params) => bridge.sendCdpCommand(wcId, method, params ?? {});
}

function p_makeImage(base64: string, width: number, height: number): ElectronNativeImage {
  const img: ElectronNativeImage = {
    toDataURL: () => `data:image/png;base64,${base64}`,
    toPNG: () => Buffer.from(base64, 'base64'),
    toJPEG: () => Buffer.from(base64, 'base64'),
    isEmpty: () => base64.length === 0,
    getSize: () => ({ width, height }),
    resize: () => img,
  };
  return img;
}

// The agent path calls: getWebContentsId (every CDP tool), executeJavaScript, getURL/getTitle,
// isLoading, loadURL, capturePage, sendInputEvent (keyDown/char/keyUp), stop/reload, focus.
// Everything else is a safe no-op; the shim is never handed to layout/UI code.
function p_makeShim(rec: { browserId: string; wcId: number; url: string; title: string }): BrowserWebview {
  const send = p_cdp();
  const shim: any = {
    src: rec.url,
    getWebContentsId: () => rec.wcId,
    executeJavaScript: async (code: string) => {
      const r = await send(rec.wcId, 'Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true, userGesture: true });
      p_refresh(rec, send);
      return r?.result?.value;
    },
    loadURL: async (url: string) => { await send(rec.wcId, 'Page.navigate', { url }); rec.url = url; },
    getURL: () => rec.url,
    getTitle: () => rec.title,
    isLoading: () => false,
    isCurrentlyAudible: () => false,
    reload: () => { void send(rec.wcId, 'Page.reload', {}); },
    stop: () => { void send(rec.wcId, 'Page.stopLoading', {}); },
    goBack: () => { void send(rec.wcId, 'Runtime.evaluate', { expression: 'history.back()' }); },
    goForward: () => { void send(rec.wcId, 'Runtime.evaluate', { expression: 'history.forward()' }); },
    canGoBack: () => false,
    canGoForward: () => false,
    capturePage: async () => {
      const r = await send(rec.wcId, 'Page.captureScreenshot', { format: 'png' });
      const metrics = await send(rec.wcId, 'Page.getLayoutMetrics').catch(() => null);
      const vp = metrics?.cssLayoutViewport;
      return p_makeImage(String(r?.data || ''), vp?.clientWidth || 520, vp?.clientHeight || 680);
    },
    sendInputEvent: (event: { type: string; keyCode?: string }) => {
      // The handler's key path sends Electron keyDown/char/keyUp with a keyCode string; CDP's
      // equivalent trio is rawKeyDown/char/keyUp keyed on text for printable input.
      const k = String(event.keyCode ?? '');
      if (event.type === 'keyDown') void send(rec.wcId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, text: k.length === 1 ? k : undefined });
      else if (event.type === 'char') void send(rec.wcId, 'Input.dispatchKeyEvent', { type: 'char', text: k, key: k });
      else if (event.type === 'keyUp') void send(rec.wcId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: k });
    },
    getZoomLevel: () => 0,
    setZoomLevel: () => undefined,
    findInPage: () => 0,
    stopFindInPage: () => undefined,
    focus: () => { void send(rec.wcId, 'Page.bringToFront', {}); },
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 520, bottom: 680, width: 520, height: 680, toJSON: () => ({}) }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return shim as BrowserWebview;
}

function p_refresh(rec: { wcId: number; url: string; title: string }, send: CdpSend): void {
  void send(rec.wcId, 'Runtime.evaluate', { expression: 'JSON.stringify({u: location.href, t: document.title})', returnByValue: true })
    .then((r) => {
      try {
        const v = JSON.parse(r?.result?.value || '{}');
        if (v.u) rec.url = v.u;
        if (typeof v.t === 'string') rec.title = v.t;
      } catch { /* popup mid-navigation; keep the cached values */ }
    })
    .catch(() => undefined);
}

export function registerPopup(browserId: string, wcId: number, url: string): void {
  const rec = { browserId, wcId, url, title: '' };
  p_byBrowserId.set(browserId, { browserId, wcId, url, shim: p_makeShim(rec) });
}

export function unregisterPopupByWcId(wcId: number): string | null {
  for (const [bid, rec] of p_byBrowserId) {
    if (rec.wcId === wcId) {
      p_byBrowserId.delete(bid);
      return bid;
    }
  }
  return null;
}

/** The live popup shim for a card, or undefined; while one is open it OWNS the card's commands. */
export function activePopupShim(browserId: string): BrowserWebview | undefined {
  return p_byBrowserId.get(browserId)?.shim;
}

export function activePopupCount(): number {
  return p_byBrowserId.size;
}
