// On-demand offscreen browser: spawn a hidden (show:false) BrowserWindow on the
// browser partition, load a URL, scrape the rendered DOM, dispose. This is the
// packaged-app WebFetch/WebSearch tier that beats httpx on JS/paywall/SPA pages
// (httpx sees no rendered content) and, for search, a real browser fingerprint
// sidesteps the per-IP scrape throttle that 202s our headless DDG client.
//
// Main-process only (offscreen BrowserWindow isn't a renderer webview). Every
// path destroys its window in a finally, so a failure can never leak a window.
const { BrowserWindow } = require('electron');

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

async function withWindow(partition, fn) {
  const win = makeWindow(partition);
  const killer = setTimeout(() => { try { win.destroy(); } catch (_) {} }, LOAD_TIMEOUT_MS + SETTLE_MS + 8000);
  try {
    return await fn(win);
  } finally {
    clearTimeout(killer);
    try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
  }
}

async function loadAndSettle(win, url) {
  // loadURL rejects on a sub-resource abort even when the main frame is fine, so a rejection is a warning, not a failure; we still try to read the DOM.
  const load = win.loadURL(url, { userAgent: SCRAPE_UA }).catch(() => {});
  await Promise.race([load, new Promise((r) => setTimeout(r, LOAD_TIMEOUT_MS))]);
  await new Promise((r) => setTimeout(r, SETTLE_MS));
}

// Fetch a URL's rendered visible text.
async function hiddenFetch(partition, url) {
  return withWindow(partition, async (win) => {
    await loadAndSettle(win, url);
    const title = await win.webContents.executeJavaScript('document.title || ""').catch(() => '');
    const text = await win.webContents.executeJavaScript(
      '(document.body && document.body.innerText || "")'
    ).catch(() => '');
    const clean = String(text).replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_FETCH_CHARS);
    if (!clean) return { error: 'empty page (blocked or no rendered text)' };
    return { title: String(title).slice(0, 300), text: clean, url };
  });
}

// Google first (direct result URLs, best quality); DuckDuckGo in a real browser
// second (immune to the httpx 202 throttle); Bing last (results are redirect-wrapped).
const ENGINES = [
  { name: 'google', url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&num=10&hl=en`,
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
        const raw = await win.webContents.executeJavaScript(`JSON.stringify((${eng.scrape}).slice(0, 20))`);
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

module.exports = { hiddenFetch, hiddenSearch };
