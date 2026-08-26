// On-demand offscreen browser: spawn a hidden (show:false) BrowserWindow on the
// browser partition, load a URL, scrape the rendered DOM, dispose. This is the
// packaged-app WebFetch/WebSearch tier that beats httpx on JS/paywall/SPA pages
// (httpx sees no rendered content) and, for search, a real browser fingerprint
// sidesteps the per-IP scrape throttle that 202s our headless DDG client.
//
// Main-process only (offscreen BrowserWindow isn't a renderer webview). Every
// path destroys its window in a finally, so a failure can never leak a window.
const { BrowserWindow, session } = require('electron');

const SCRAPE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SETTLE_MS = 2800;
const LOAD_TIMEOUT_MS = 20000;
const MAX_FETCH_CHARS = 200000;

function makeWindow(partition) {
  // Flag set across construction so the web-contents-created OAuth-popup UA spoofer (main.js) leaves our UA alone; the spoofer targets every getType()==='window', which a hidden window is.
  global.__osHiddenBrowserCreating = true;
  try {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.setUserAgent(SCRAPE_UA);
    return win;
  } finally {
    global.__osHiddenBrowserCreating = false;
  }
}

// Tearing a window down while a page call is in flight is how a destroyed object stays in an
// observer list; the next walk over that list calls a virtual method on the corpse, which is the
// exact shape of the ENG-400 main-process segfault. So: one disposer, idempotent, graceful first.
function disposeWindow(win) {
  if (!win || win.isDestroyed()) return;
  // close() runs the normal teardown so observers unregister; destroy() is the escalation for a
  // page wedged hard enough to ignore it. A hidden window has no beforeunload to block on.
  try { win.close(); } catch (_) {}
  setTimeout(() => { try { if (!win.isDestroyed()) win.destroy(); } catch (_) {} }, 1000).unref?.();
}

// The ONLY door to a hidden window's page. Every caller went through webContents directly and any
// one of them could fire after the killer had already torn the window down.
async function evalInPage(win, js, userGesture = false) {
  if (!win || win.isDestroyed()) return null;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return null;
  return wc.executeJavaScript(js, userGesture).catch(() => null);
}

async function withWindow(partition, fn, extraGraceMs = 0) {
  const win = makeWindow(partition);
  const killer = setTimeout(() => disposeWindow(win), LOAD_TIMEOUT_MS + SETTLE_MS + 8000 + extraGraceMs);
  try {
    return await fn(win);
  } finally {
    clearTimeout(killer);
    disposeWindow(win);
  }
}

// The provider-history harvest paginates a genuinely slow endpoint (ChatGPT's
// /backend-api/conversations runs ~4s/page), so its offscreen window must outlive a
// plain fetch/search window or it gets killed mid-pagination and the whole read is lost.
const HARVEST_GRACE_MS = 20000;

async function loadAndSettle(win, url) {
  // loadURL rejects on a sub-resource abort even when the main frame is fine, so a rejection is a warning, not a failure; we still try to read the DOM.
  if (win.isDestroyed()) return;
  const load = win.loadURL(url, { userAgent: SCRAPE_UA }).catch(() => {});
  await Promise.race([load, new Promise((r) => setTimeout(r, LOAD_TIMEOUT_MS))]);
  await new Promise((r) => setTimeout(r, SETTLE_MS));
}

// Fetch a URL's rendered visible text.
async function hiddenFetch(partition, url) {
  return withWindow(partition, async (win) => {
    await loadAndSettle(win, url);
    const title = (await evalInPage(win, 'document.title || ""')) || '';
    const text = (await evalInPage(win, '(document.body && document.body.innerText || "")')) || '';
    const clean = String(text).replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_FETCH_CHARS);
    if (!clean) return { error: 'empty page (blocked or no rendered text)' };
    return { title: String(title).slice(0, 300), text: clean, url };
  });
}

// Load a URL offscreen on the given partition (so it inherits that partition's
// logged-in session) and run an app-authored script in the page context, returning
// whatever it resolves to. Used to read the user's own provider history (chatgpt.com /
// claude.ai) with no visible card. The script is caller-owned and must be app code,
// never anything a remote page or the renderer can choose; the offscreen window is
// destroyed in withWindow's finally regardless of outcome.
async function hiddenEval(partition, url, js) {
  return withWindow(partition, async (win) => {
    await loadAndSettle(win, url);
    return evalInPage(win, js, true);
  }, HARVEST_GRACE_MS);
}

// Inject the user's own session cookies (read + decrypted by the Python backend) into a
// throwaway IN-MEMORY session, then run an app-authored read from a real Chromium context.
// This is how we beat provider Cloudflare: a raw HTTP client's TLS handshake gets fingerprint-
// blocked, but this IS Chrome, so it passes exactly like the user's browser. The partition has
// no "persist:" prefix, so nothing ever hits disk; cookies are cleared before AND after.
const HARVEST_PARTITION = 'osw-usage-harvest';

async function hiddenEvalWithCookies(url, cookieRecords, js) {
  const ses = session.fromPartition(HARVEST_PARTITION);
  const wipe = async () => { try { await ses.clearStorageData({ storages: ['cookies'] }); } catch (_) {} };
  await wipe();
  for (const c of cookieRecords || []) {
    try {
      await ses.cookies.set({
        url,
        name: c.name,
        value: c.value,
        domain: c.domain || undefined,
        path: c.path || '/',
        secure: c.secure !== false,
        httpOnly: !!c.httponly,
      });
    } catch (_) { /* skip a malformed cookie, never abort the set */ }
  }
  try {
    return await withWindow(HARVEST_PARTITION, async (win) => {
      await loadAndSettle(win, url);
      return evalInPage(win, js, true);
    }, HARVEST_GRACE_MS);
  } finally {
    await wipe();
  }
}

// Google first (direct result URLs, best quality); DuckDuckGo in a real browser
// second (immune to the httpx 202 throttle); Bing last (results are redirect-wrapped).
const ENGINES = [
  // udm=14 is Google's plain "Web" tab: ten blue links, no AI Overview and no answer widgets, so the a-h3 scrape gets real result URLs instead of whatever the SERP decided to render today.
  { name: 'google', url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&udm=14&num=10&hl=en`,
    scrape: `Array.from(document.querySelectorAll('a h3')).map(function(h){var a=h.closest('a');return a&&a.href?{t:h.innerText,u:a.href}:null;}).filter(function(x){return x&&x.u.indexOf('http')===0&&x.u.indexOf('google.')===-1;})` },
  { name: 'ddg', url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    scrape: `Array.from(document.querySelectorAll('a.result__a')).map(function(a){var m=a.href.match(/uddg=([^&]+)/);return {t:a.innerText,u:m?decodeURIComponent(m[1]):a.href};})` },
  { name: 'bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    scrape: `Array.from(document.querySelectorAll('li.b_algo h2 a')).map(function(a){return {t:a.innerText,u:a.href};})` },
];

async function hiddenSearch(partition, query, numResults) {
  const errors = [];
  for (const eng of ENGINES) {
    try {
      const rows = await withWindow(partition, async (win) => {
        await loadAndSettle(win, eng.url(query));
        const raw = await evalInPage(win, `JSON.stringify((${eng.scrape}).slice(0, 20))`);
        return JSON.parse(raw || '[]');
      });
      const clean = rows.filter((r) => r && r.u && r.t).slice(0, numResults || 5);
      if (clean.length > 0) {
        const text = clean.map((r, i) => `[${i + 1}] ${String(r.t).trim()}\n    ${r.u}`).join('\n\n');
        return { engine: eng.name, results: text, count: clean.length };
      }
      errors.push(`${eng.name}: 0 results`);
    } catch (e) {
      errors.push(`${eng.name}: ${String(e).slice(0, 80)}`);
    }
  }
  return { error: 'all browser search engines failed', detail: errors.join('; ') };
}

module.exports = { hiddenFetch, hiddenSearch, hiddenEval, hiddenEvalWithCookies };
