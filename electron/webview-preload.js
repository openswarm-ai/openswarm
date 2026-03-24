/**
 * Webview preload script — patches browser fingerprinting so sites like
 * Spotify/Netflix don't detect an Electron shell and disable features.
 * Loaded via the webview's `preload` attribute before any page script runs.
 */

'use strict';

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
