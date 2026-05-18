/** Webview preload: patches fingerprinting so sites like Spotify/Netflix don't detect Electron. */

'use strict';

try { console.warn('[openswarm:webview-preload] loaded for', window.location.href); } catch (_) {}

Object.defineProperty(navigator, 'webdriver', {
  get: () => false,
  configurable: true,
});

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

try {
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
    configurable: true,
  });
} catch (_) {}

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

// console.debug existence is used as a breakpoint detector by some sites.
const noop = () => {};
if (!window.console.debug) window.console.debug = noop;

// Webviews can't reach the OS authenticator (electron#15404, #24573); relay tagged postMessage from main-world shim out to embedding <webview>.
try {
  const { ipcRenderer } = require('electron');

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.__openswarm__ === '__openswarm_passkey__') {
      console.warn('[openswarm:webview-preload] passkey bridge → sendToHost');
      try { ipcRenderer.sendToHost('passkey-detected', window.location.href); } catch (_) {}
    }
  });

  // Webview wheel events don't bubble out; forward ctrl+wheel to host so canvas zoom works (issue #27).
  const onWheelCapture = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      console.warn('[openswarm:webview-preload] ctrl+wheel intercept → sendToHost', {
        deltaY: e.deltaY,
        clientX: e.clientX,
        clientY: e.clientY,
      });
      ipcRenderer.sendToHost('canvas-wheel-zoom', {
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        clientX: e.clientX,
        clientY: e.clientY,
      });
    } catch (err) {
      console.warn('[openswarm:webview-preload] sendToHost failed', err);
    }
  };
  // Capture-phase + passive:false so we run before page handlers and can preventDefault.
  window.addEventListener('wheel', onWheelCapture, { capture: true, passive: false });
  document.addEventListener('wheel', onWheelCapture, { capture: true, passive: false });

  // Forwards console.* to host for App Builder Terminal pane.
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
      } catch (_) {}
      try { return orig.apply(this, args); } catch (_) {}
    };
  }
} catch (_) {}
