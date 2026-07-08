/**
 * Webview preload script — patches browser fingerprinting so sites like
 * Spotify/Netflix don't detect an Electron shell and disable features.
 * Loaded via the webview's `preload` attribute before any page script runs.
 */

'use strict';

// Diagnostic marker so we can confirm the preload actually attached to
// this webview. Surfaces via main.js's console-message listener.
try { console.warn('[openswarm:webview-preload] loaded for', window.location.href); } catch (_) {}

// Chrome-style suspend/resume: sync-take a pending sessionStorage capsule (staged by the host right before this load) at document-start, so page scripts wake to their old state and logins survive suspension. Origin-matched in main; null for every ordinary navigation.
(function restoreSessionCapsule() {
  try {
    const { ipcRenderer } = require('electron');
    const cap = ipcRenderer.sendSync('browser-capsule-take', window.location.origin);
    if (!cap || !cap.ss) return;
    for (const k of Object.keys(cap.ss)) {
      try { sessionStorage.setItem(k, cap.ss[k]); } catch (_) {}
    }
    if (cap.sx || cap.sy) {
      window.addEventListener('load', () => {
        setTimeout(() => { try { window.scrollTo(cap.sx, cap.sy); } catch (_) {} }, 80);
      });
    }
  } catch (_) {}
})();

// Hide webdriver flag
Object.defineProperty(navigator, 'webdriver', {
  get: () => false,
  configurable: true,
});

// Spoof navigator.plugins (Chrome has a few built-in ones)
const fakePlugins = {
  0: { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
  1: { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
  2: { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
  length: 3,
  item: (i) => fakePlugins[i] || null,
  namedItem: (name) => {
    for (let i = 0; i < fakePlugins.length; i++) {
      if (fakePlugins[i].name === name) return fakePlugins[i];
    }
    return null;
  },
  refresh: () => {},
  [Symbol.iterator]: function* () {
    for (let i = 0; i < this.length; i++) yield this[i];
  },
};
try {
  Object.defineProperty(navigator, 'plugins', {
    get: () => fakePlugins,
    configurable: true,
  });
} catch (_) {}

// Ensure window.chrome exists (sites test for it)
if (!window.chrome) {
  window.chrome = {};
}
if (!window.chrome.runtime) {
  window.chrome.runtime = {
    connect: () => {},
    sendMessage: () => {},
    onMessage: { addListener: () => {}, removeListener: () => {} },
  };
}

// Ensure navigator.languages has sensible values
try {
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
    configurable: true,
  });
} catch (_) {}

// Patch permissions.query to report 'granted' for common permissions
const originalQuery = navigator.permissions?.query?.bind(navigator.permissions);
if (originalQuery) {
  navigator.permissions.query = (params) => {
    if (params.name === 'notifications') {
      return Promise.resolve({ state: 'granted', onchange: null });
    }
    return originalQuery(params).catch(() =>
      Promise.resolve({ state: 'prompt', onchange: null })
    );
  };
}

// Prevent iframe detection heuristics
try {
  Object.defineProperty(document, 'hidden', {
    get: () => false,
    configurable: true,
  });
  Object.defineProperty(document, 'visibilityState', {
    get: () => 'visible',
    configurable: true,
  });
} catch (_) {}

// Fix console.debug detection (some sites use it as a breakpoint detector)
const noop = () => {};
if (!window.console.debug) window.console.debug = noop;

// ---------------------------------------------------------------------------
// Passkey / WebAuthn handling
//
// Electron webviews can't trigger the OS platform authenticator (Touch ID,
// Windows Hello) — see electron/electron#15404, #24573. Sites that offer
// "Sign in with passkey" either fail silently or loop (#41472 on LinkedIn).
//
// With contextIsolation on (the Electron default), any patches we make to
// navigator.credentials from this preload only apply in the ISOLATED world;
// the page's own JS runs in the MAIN world and sees the original API. We
// have to inject the shim via webFrame.executeJavaScript so it lands in
// the page's JS context, then bridge the event back out with a DOM
// CustomEvent that this isolated-world preload listens for and relays via
// ipcRenderer.sendToHost to the embedding <webview> element.
//
// Two-pronged shim (both evaluated in the main world):
//   1. Probe APIs (isUserVerifyingPlatformAuthenticatorAvailable,
//      isConditionalMediationAvailable) return false so sites that check
//      before rendering a passkey button fall back to passwords quietly.
//   2. credentials.get / credentials.create with publicKey options reject
//      with a clean NotAllowedError AND dispatch the passkey event so the
//      embedder can surface a dialog. Conditional mediation (silent
//      autofill) is intercepted but doesn't fire the dialog — that's
//      not a user click.
// ---------------------------------------------------------------------------
try {
  const { ipcRenderer } = require('electron');

  // The actual WebAuthn shim is injected by the MAIN process via
  // contents.executeJavaScript on each 'dom-ready' (see electron/main.js).
  // That path runs in the page's main world and bypasses Trusted Types
  // CSP enforcement, which blocks our previous inline-<script> approach
  // on sites like accounts.google.com.
  //
  // Our only job here is to act as the postMessage→IPC bridge: the main-
  // world shim posts a tagged message, we relay it via sendToHost to the
  // embedding <webview> element, which shows the "passkeys not supported"
  // dialog.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.__openswarm__ === '__openswarm_passkey__') {
      console.warn('[openswarm:webview-preload] passkey bridge → sendToHost');
      try { ipcRenderer.sendToHost('passkey-detected', window.location.href); } catch (_) {}
    }
  });

  // When the host marks this webview as "interactive" (user clicked into the
  // app), the preload stops forwarding wheel/middle gestures to the canvas
  // and lets the app handle everything. Host pushes via webview.send.
  let isInteractive = false;
  try {
    ipcRenderer.on('openswarm:set-interactive', (_event, payload) => {
      isInteractive = !!(payload && payload.interactive);
    });
  } catch (_) {}

  // First in-guest mousedown tells the host to activate interact mode. Never
  // preventDefault so the click still reaches the app (Minecraft etc).
  const onMouseDownNotify = (e) => {
    if (isInteractive) return;
    try { ipcRenderer.sendToHost('app-clicked', { button: e.button }); } catch (_) {}
  };
  window.addEventListener('mousedown', onMouseDownNotify, { capture: true });

  // ---------------------------------------------------------------------------
  // Horizontal scroll passthrough to canvas pan
  //
  // <webview> is an out-of-process guest; wheel events inside it never bubble
  // to the embedding renderer. Vertical scroll and ctrl/meta+wheel zoom stay
  // with the page (chromium default). A horizontal-dominant gesture, however,
  // should pan the dashboard canvas if the guest page has nothing horizontal
  // to scroll, to match the behavior over chat panels (which never have a
  // horizontal scroller and always pan the canvas).
  const pageCanScrollX = (node, dx) => {
    let t = node;
    while (t) {
      const sw = t.scrollWidth || 0;
      const cw = t.clientWidth || 0;
      if (sw > cw) {
        let style;
        try { style = getComputedStyle(t); } catch (_) {}
        const ox = style ? style.overflowX : 'visible';
        if (ox === 'auto' || ox === 'scroll') {
          const atRight = t.scrollLeft + cw >= sw - 1;
          const atLeft = t.scrollLeft <= 1;
          const atBoundary = (dx > 0 && atRight) || (dx < 0 && atLeft);
          if (!atBoundary) return true;
        }
      }
      t = t.parentElement;
    }
    const docEl = document.scrollingElement || document.documentElement;
    if (docEl && docEl.scrollWidth > docEl.clientWidth) {
      const atRight = docEl.scrollLeft + docEl.clientWidth >= docEl.scrollWidth - 1;
      const atLeft = docEl.scrollLeft <= 1;
      const atBoundary = (dx > 0 && atRight) || (dx < 0 && atLeft);
      if (!atBoundary) return true;
    }
    return false;
  };

  const onWheelCapture = (e) => {
    // Canvas zoom is a dashboard-level gesture: forward cmd/ctrl+wheel even in interact mode, matching browser cards (which never set interactive and always zoom the canvas).
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      const iw = window.innerWidth || 1;
      const ih = window.innerHeight || 1;
      try {
        ipcRenderer.sendToHost('canvas-wheel-zoom', {
          deltaY: e.deltaY,
          deltaMode: e.deltaMode,
          fracX: Math.max(0, Math.min(1, e.clientX / iw)),
          fracY: Math.max(0, Math.min(1, e.clientY / ih)),
        });
      } catch (_) {}
      return;
    }
    if (isInteractive) return;
    // Vertical-dominant scroll stays with the page.
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    // Horizontal-dominant: defer to the page if anything inside can absorb
    // it; otherwise forward to the host as a canvas pan.
    if (pageCanScrollX(e.target, e.deltaX)) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      ipcRenderer.sendToHost('canvas-wheel-pan', {
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
      });
    } catch (_) {}
  };
  // Listen on both window and document in capture phase so we run before any
  // page-level handler that might swallow the event. passive:false is required
  // to call preventDefault on a wheel event.
  window.addEventListener('wheel', onWheelCapture, { capture: true, passive: false });
  document.addEventListener('wheel', onWheelCapture, { capture: true, passive: false });

  // ---------------------------------------------------------------------------
  // Middle-mouse-button drag → canvas pan
  //
  // Empty canvas and agent cards already get middle-button pan because the
  // event bubbles to the dashboard's mousedown handler. <webview> is a
  // separate compositor layer that eats mouse events, so middle-drag over a
  // browser silently did nothing. Intercept here and forward the per-event
  // movement as a pan delta through the existing canvas-wheel-pan channel
  // (negated, since drag pans panX += dx while wheel pans panX -= dx).
  // Always pans regardless of capture state — middle-drag is unambiguously
  // a canvas gesture.
  let middleDragging = false;
  const onMouseDownMiddle = (e) => {
    if (isInteractive) return;
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    middleDragging = true;
  };
  const onMouseMoveMiddle = (e) => {
    if (!middleDragging) return;
    e.preventDefault();
    e.stopPropagation();
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    if (dx === 0 && dy === 0) return;
    try {
      ipcRenderer.sendToHost('canvas-wheel-pan', { deltaX: -dx, deltaY: -dy, deltaMode: 0 });
    } catch (_) {}
  };
  const onMouseUpMiddle = (e) => {
    if (e.button !== 1) return;
    middleDragging = false;
  };
  // Chromium starts auxiliary-scroll on middle-click; auxclick prevents that.
  const onAuxClickSuppress = (e) => {
    if (isInteractive) return;
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); }
  };
  window.addEventListener('mousedown', onMouseDownMiddle, { capture: true });
  window.addEventListener('mousemove', onMouseMoveMiddle, { capture: true });
  window.addEventListener('mouseup', onMouseUpMiddle, { capture: true });
  window.addEventListener('auxclick', onAuxClickSuppress, { capture: true });

  // ---------------------------------------------------------------------------
  // Double-click to fit the browser card (parity with agent-chat dblclick).
  //
  // A <webview> is an out-of-process guest, so a dblclick inside it never
  // reaches the embedding renderer and the dashboard's card dblclick-to-fit
  // never fires over page content. Forward non-interactive dblclicks to the
  // host (BrowserCard's ipc-message handler calls onDoubleClick -> fitToCards).
  // We never preventDefault: the page keeps its native behavior. We skip
  // interactive targets and skip when the dblclick selected a word, so links/
  // buttons/inputs and native word-select win there. canvas is treated as
  // interactive on purpose (maps/games/design tools use dblclick meaningfully).
  const INTERACTIVE_DBLCLICK_SELECTOR = [
    'a[href]', 'button', 'input', 'textarea', 'select', 'option', 'label',
    'summary', 'details', 'video', 'audio', 'iframe', 'embed', 'object', 'canvas',
    '[contenteditable=""]', '[contenteditable="true"]',
    '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="menuitem"]',
    '[role="tab"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="slider"]',
  ].join(',');
  const onDblClickCapture = (e) => {
    try {
      const t = e.target;
      if (t && t.closest && t.closest(INTERACTIVE_DBLCLICK_SELECTOR)) return;
      const sel = window.getSelection && window.getSelection();
      if (sel && String(sel).trim().length > 0) return;
      ipcRenderer.sendToHost('browser-dblclick');
    } catch (_) {}
  };
  document.addEventListener('dblclick', onDblClickCapture, { capture: true });

  // ---------------------------------------------------------------------------
  // [FRONTEND] console capture for the App Builder Terminal pane.
  //
  // Wrap window.console.{log,warn,error,info,debug} so each call also goes
  // out via ipcRenderer.sendToHost('webview-console', {level, text}). The
  // embedding <webview> element's ipc-message listener in ViewPreview
  // forwards these to ViewEditor, which interleaves them with [BACKEND]
  // lines coming over the runtime WS.
  //
  // Stringify args defensively — most console.log calls pass primitives or
  // objects, but a thrown Error has a stack we want, and circular objects
  // would blow up JSON.stringify. Fall back to String() for everything
  // that won't serialize cleanly.
  const _stringifyArg = (a) => {
    if (a === null) return 'null';
    if (a === undefined) return 'undefined';
    if (typeof a === 'string') return a;
    if (typeof a === 'number' || typeof a === 'boolean') return String(a);
    if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
    try {
      return JSON.stringify(a);
    } catch (_) {
      try { return String(a); } catch (__) { return '[unserializable]'; }
    }
  };
  const _consoleLevels = ['log', 'warn', 'error', 'info', 'debug'];
  for (const level of _consoleLevels) {
    const orig = window.console[level];
    if (typeof orig !== 'function') continue;
    window.console[level] = function (...args) {
      try {
        const text = args.map(_stringifyArg).join(' ');
        ipcRenderer.sendToHost('webview-console', { level, text });
      } catch (_) { /* never break the page's own logging */ }
      try { return orig.apply(this, args); } catch (_) {}
    };
  }
} catch (_) {}
