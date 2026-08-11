// Just enough browser surface for a module that touches `window` at import time
// to LOAD inside node:test. This is deliberately not a DOM: if a test ever needs
// real rendering, that is the moment to bring in a proper DOM environment.
const noop = () => {};
const store = new Map();
const storage = {
  getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
  setItem: (k, v) => void store.set(String(k), String(v)),
  removeItem: (k) => void store.delete(String(k)),
  clear: () => void store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
const el = () => ({
  style: {}, classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
  setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
  appendChild: noop, removeChild: noop, addEventListener: noop, removeEventListener: noop,
  getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  querySelector: () => null, querySelectorAll: () => [], contains: () => false, focus: noop, click: noop,
  dataset: {}, children: [], parentElement: null, textContent: '',
});
const doc = {
  ...el(),
  documentElement: el(), body: el(), head: el(),
  createElement: el, createTextNode: () => ({}), getElementById: () => null,
  readyState: 'complete', visibilityState: 'visible', cookie: '',
};
const observer = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
const notWired = () => { throw new Error('network is not wired in tests; stub the module under test'); };
const win = {
  document: doc, localStorage: storage, sessionStorage: storage,
  location: { href: 'http://localhost/', pathname: '/', search: '', hash: '', origin: 'http://localhost' },
  navigator: { userAgent: 'node', onLine: true, language: 'en-US', clipboard: { writeText: async () => {} } },
  addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true,
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  innerWidth: 1440, innerHeight: 900, devicePixelRatio: 2,
  scrollTo: noop, open: () => null, alert: noop, confirm: () => false,
  fetch: globalThis.fetch ?? notWired, WebSocket: class { close() {} send() {} addEventListener() {} removeEventListener() {} },
  ResizeObserver: observer, IntersectionObserver: observer, MutationObserver: observer,
  performance: globalThis.performance, crypto: globalThis.crypto,
  setTimeout, clearTimeout, setInterval, clearInterval,
};
win.window = win; win.self = win; win.top = win; win.parent = win;
for (const [k, v] of Object.entries({ window: win, document: doc, navigator: win.navigator,
  localStorage: storage, sessionStorage: storage, location: win.location,
  matchMedia: win.matchMedia, getComputedStyle: win.getComputedStyle,
  requestAnimationFrame: win.requestAnimationFrame, cancelAnimationFrame: win.cancelAnimationFrame,
  ResizeObserver: observer, IntersectionObserver: observer, MutationObserver: observer,
  WebSocket: win.WebSocket })) {
  if (!(k in globalThis)) Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
}
