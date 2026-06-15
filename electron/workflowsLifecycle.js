// Lifecycle helpers that keep scheduled workflows surviving real-world
// app states (machine sleep, window closed, auto-update). All exports are
// safe to call before the backend is up; failed fetches return null and
// callers degrade to "no active runs known."

const { app, powerSaveBlocker, Notification, shell } = require('electron');
const http = require('http');

let backendPortRef = null;
let authTokenRef = null;
let blockerId = null;
let updaterVetoPending = false;
let pollTimer = null;
let lastActiveCount = 0;
let onActiveChange = () => {};

function setBackend({ port, token }) {
  backendPortRef = port;
  authTokenRef = token;
}

function setActiveChangeListener(cb) {
  onActiveChange = cb || (() => {});
}

// Cheap GET to the localhost backend. Resolves null on any error.
function fetchJson(pathStr) {
  return new Promise((resolve) => {
    if (!backendPortRef) return resolve(null);
    const req = http.request({
      hostname: '127.0.0.1',
      port: backendPortRef,
      path: pathStr,
      method: 'GET',
      headers: authTokenRef ? { Authorization: `Bearer ${authTokenRef}` } : {},
      timeout: 1500,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function getActive() {
  // Must hit the /api prefix; the bare path 401s and would leave the
  // powerSaveBlocker + updater-veto blind to in-flight runs.
  const res = await fetchJson('/api/workflows/active');
  if (!res || !Array.isArray(res.active)) return [];
  return res.active;
}

// powerSaveBlocker holds the system awake while at least one workflow is
// active. Released as soon as the active list goes empty so we don't pin
// the user's laptop on idle.
function ensureBlocker(active) {
  if (active && blockerId == null) {
    try { blockerId = powerSaveBlocker.start('prevent-app-suspension'); } catch (_) {}
  } else if (!active && blockerId != null) {
    try { powerSaveBlocker.stop(blockerId); } catch (_) {}
    blockerId = null;
  }
}

function startPolling() {
  if (pollTimer) return;
  // 5s cadence is the sweet spot: fast enough to release the
  // powerSaveBlocker promptly after a fire, slow enough that the localhost
  // request is invisible in CPU traces.
  pollTimer = setInterval(async () => {
    const active = await getActive();
    const count = active.length;
    ensureBlocker(count > 0);
    if (count !== lastActiveCount) {
      lastActiveCount = count;
      try { onActiveChange(active); } catch (_) {}
    }
    // If the updater queued an install while a run was in flight, fire it
    // the moment the active list drains.
    if (updaterVetoPending && count === 0) {
      updaterVetoPending = false;
      try {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.quitAndInstall(false, true);
      } catch (_) {}
    }
  }, 5000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Updater veto: if a workflow is running and the user clicks "Install
// update," queue it instead of quitAndInstall'ing on top of an active
// run. Returns true if vetoed (caller should display a "queued" banner),
// false otherwise.
async function maybeVetoInstall() {
  const active = await getActive();
  if (active.length === 0) return false;
  updaterVetoPending = true;
  return true;
}

// Drain on quit: give in-flight runs up to QUIT_DRAIN_S to finish before
// killing the backend. The user-facing tradeoff is a slow quit when busy
// vs. losing the run; we lean toward "wait" because the run already
// committed real cost.
function drainOnQuit(maxSeconds = 30) {
  return new Promise((resolve) => {
    const deadline = Date.now() + maxSeconds * 1000;
    const tick = async () => {
      const active = await getActive();
      if (active.length === 0 || Date.now() > deadline) return resolve();
      setTimeout(tick, 500);
    };
    tick();
  });
}

// Native OS notification. Falls back silently when Notification isn't
// supported (some Linux setups, headless test envs). When `actions` is
// provided AND we're on macOS, attaches button actions so the user can
// ack/re-run/open without the app taking focus. Routes the chosen
// outcome back to the renderer via an IPC channel that the renderer's
// WebSocketManager already listens for.
function showNativeNotification({ title, body, deepLink, runId, workflowId, actions }) {
  if (!Notification || !Notification.isSupported()) return null;
  try {
    const opts = { title: title || 'OpenSwarm', body: body || '', silent: false };
    const platformActions = Array.isArray(actions) && process.platform === 'darwin'
      ? actions.map((a) => ({ type: 'button', text: a.text }))
      : undefined;
    if (platformActions && platformActions.length) opts.actions = platformActions;
    const n = new Notification(opts);
    const route = (outcome) => {
      try {
        const { BrowserWindow } = require('electron');
        const wins = BrowserWindow.getAllWindows();
        const wc = wins[0]?.webContents;
        if (wc) wc.send('workflow:notification-action', { outcome, runId, workflowId, deepLink });
      } catch (_) {}
    };
    n.on('action', (_event, idx) => {
      const a = (actions || [])[idx];
      if (a) route(a.outcome);
    });
    n.on('click', () => {
      if (deepLink) {
        try { shell.openExternal(deepLink); } catch (_) {}
      }
      route('open');
    });
    n.show();
    return n;
  } catch (_) {
    return null;
  }
}

// Launch-at-login wrappers. macOS + Windows both honor this; Linux is a
// no-op in Electron's API.
function getLoginItem() {
  try {
    const { openAtLogin } = app.getLoginItemSettings();
    return Boolean(openAtLogin);
  } catch (_) { return false; }
}

function setLoginItem(value) {
  try {
    // openAsHidden is macOS-only; on Windows the equivalent is passing
    // a --hidden arg and having main.js suppress the initial window
    // when the arg is present. Linux uses a .desktop file in
    // ~/.config/autostart/ which Electron writes for us via this same
    // call (no extra plumbing needed).
    const opts = {
      openAtLogin: Boolean(value),
      openAsHidden: true,
    };
    if (process.platform === 'win32') {
      opts.args = ['--hidden'];
    }
    app.setLoginItemSettings(opts);
    return Boolean(value);
  } catch (_) { return false; }
}

module.exports = {
  setBackend,
  setActiveChangeListener,
  startPolling,
  stopPolling,
  getActive,
  maybeVetoInstall,
  drainOnQuit,
  showNativeNotification,
  getLoginItem,
  setLoginItem,
};
