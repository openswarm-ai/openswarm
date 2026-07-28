// Warm a borrowed sign-in in a hidden window before the visible card loads the site.
//
// Measured 2026-07-27: transplanting the user's own Chrome session into the browser partition works
// (claude.ai accepted it and showed the real account name and plan), but sites behind a serious
// anti-bot edge refuse it in a browser CARD: chatgpt.com, medium.com and instagram.com all had the
// cookies applied and the user agent matched and still reported signed-out. The decisive clue is
// that onboarding's harvest beats Cloudflare on chatgpt.com with those SAME cookies, and the only
// thing it does differently is load them in a plain hidden BrowserWindow instead of a <webview>
// guest. A guest carries a preload and the automation tells that come with being embedded; a hidden
// window is just a browser.
//
// So we let the context that passes do the handshake. The hidden window shares the card's partition,
// which means any clearance it earns lands in the same cookie jar the card is about to use. The
// card then arrives already cleared instead of being challenged on its first request.
//
// Main-process only (an offscreen BrowserWindow is not a renderer webview). Always destroys its
// window in a finally, so a failure can never leak one, and never throws: a warm that does not work
// just leaves the card exactly as it would have been.
const { BrowserWindow } = require('electron');

const LOAD_TIMEOUT_MS = 15000;
// Anti-bot edges run a JS challenge after the document lands; the clearance cookie is only written
// once that finishes, so returning at load time would throw away the entire point of doing this.
const SETTLE_MS = 2500;
const DESTROY_GRACE_MS = 5000;

async function warmBorrowedSession(partition, url, userAgent) {
  let win = null;
  try {
    win = new BrowserWindow({
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
  } catch {
    return false;
  }

  const killer = setTimeout(() => {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* already gone */ }
  }, LOAD_TIMEOUT_MS + SETTLE_MS + DESTROY_GRACE_MS);

  try {
    // Passed to loadURL, not just setUserAgent: the popup-UA spoofer in main.js rewrites any
    // contents of type 'window' during construction, and the per-load option is what wins.
    if (userAgent) {
      try { win.webContents.setUserAgent(userAgent); } catch { /* the load option still carries it */ }
    }
    const opts = userAgent ? { userAgent } : undefined;
    // loadURL rejects when any sub-resource aborts even though the main frame is fine, so a
    // rejection here is noise; what matters is that the challenge got time to run.
    const load = win.loadURL(url, opts).catch(() => {});
    await Promise.race([load, new Promise((r) => setTimeout(r, LOAD_TIMEOUT_MS))]);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(killer);
    try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* already gone */ }
  }
}

module.exports = { warmBorrowedSession, LOAD_TIMEOUT_MS, SETTLE_MS, DESTROY_GRACE_MS };
