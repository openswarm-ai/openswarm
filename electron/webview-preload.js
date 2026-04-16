/**
 * Webview preload script — patches browser fingerprinting so sites like
 * Spotify/Netflix don't detect an Electron shell and disable features.
 * Loaded via the webview's `preload` attribute before any page script runs.
 */

'use strict';

// Diagnostic marker so we can confirm the preload actually attached to
// this webview. Surfaces via main.js's console-message listener.
try { console.warn('[openswarm:webview-preload] loaded for', window.location.href); } catch (_) {}

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
} catch (_) {}
