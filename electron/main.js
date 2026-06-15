const { app, components, BrowserWindow, ipcMain, shell, session, dialog, crashReporter, powerMonitor } = require('electron');

// E2E flag: when OPENSWARM_E2E=1, append a Chromium command-line switch the
// renderer reads at startup to set window.__OPENSWARM_E2E__ = true BEFORE any
// page script parses, so the production-build store-on-window gate fires
// deterministically. Normal user launches never set the env var so this is a
// no-op for them; only Playwright's electron.launch({env}) flips it on.
if (process.env.OPENSWARM_E2E === '1') {
  try { app.commandLine.appendSwitch('openswarm-e2e', '1'); } catch {}
}

// Local-only crash reporter. Captures native renderer crashes that escape JS-level error handlers and don't otherwise surface in Crashpad. uploadToServer=false keeps minidumps on disk under %APPDATA%/OpenSwarm/Crashpad so we can inspect them post-mortem without sending anywhere.
try {
  crashReporter.start({
    productName: 'OpenSwarm',
    companyName: 'OpenSwarm',
    submitURL: 'https://localhost.invalid',
    uploadToServer: false,
    ignoreSystemCrashHandler: false,
  });
} catch (err) {
  console.warn('[crashReporter] start failed:', err && err.message);
}

// Capture every main-process throw we can. Without these, a throw inside an IPC handler or BrowserWindow event listener can die silently and look indistinguishable from a renderer crash in the trace.
process.on('uncaughtException', (err) => {
  console.error('[diag][main:uncaughtException]', err && err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[diag][main:unhandledRejection]', reason && reason.stack || reason);
});

// child-process-gone fires for GPU/utility/renderer process deaths. The GPU one is especially useful: a GPU crash forces the renderer to recover its compositor, and that recovery can itself crash on Windows.
app.on('child-process-gone', (_event, details) => {
  console.error('[diag][main:child-process-gone]', JSON.stringify(details));
});
// Platform-split auto-updater: electron-updater on Mac (full-featured), Electron's
// built-in autoUpdater on Windows (Squirrel.Windows target; electron-updater dropped Squirrel).
let autoUpdater;
let isSquirrelUpdater = false;
try {
  if (process.platform === 'win32') {
    autoUpdater = require('electron').autoUpdater;
    isSquirrelUpdater = true;
  } else {
    autoUpdater = require('electron-updater').autoUpdater;
  }
} catch (_) {}
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const getPort = require('get-port');
const http = require('http');
const affiliateTracking = require('./affiliateTracking');
const cdpRoutes = require('./cdp-routes');
const workflowsLifecycle = require('./workflowsLifecycle');

// Squirrel makes the APP create its own shortcuts: on --squirrel-install it must
// call Update.exe --createShortcut and exit, else the user finds only Setup.exe
// and no app to click. NSIS never passes these args, so it's a no-op there. The
// prewarm-touch the old Squirrel build did here is omitted: it hung silent installs.
function _squirrelUpdate(args) {
  try {
    const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
    execFileSync(updateExe, [...args, path.basename(process.execPath)], { timeout: 20000, stdio: 'ignore', windowsHide: true });
  } catch (_) {}
}
(function handleSquirrelEvents() {
  if (process.platform !== 'win32' || process.argv.length < 2) return;
  const sq = process.argv[1];
  if (sq === '--squirrel-install' || sq === '--squirrel-updated') { _squirrelUpdate(['--createShortcut']); process.exit(0); }
  if (sq === '--squirrel-uninstall') { _squirrelUpdate(['--removeShortcut']); process.exit(0); }
  if (sq === '--squirrel-obsolete') { process.exit(0); }
})();

// NSIS->Squirrel migration cleanup. The first time this Squirrel build runs after
// an existing NSIS OpenSwarm was updated into it, silently uninstall that legacy
// NSIS copy so the user isn't left with two installs + two shortcuts. Found via
// the HKCU Uninstall entry whose UninstallString is the NSIS uninstaller (NOT
// Squirrel's Update.exe). Deferred to quit so the NSIS uninstaller's taskkill of
// OpenSwarm.exe can't kill this live session (same exe name). Best-effort +
// detached: a failure just leaves the old install (never bricks); NSIS
// deleteAppDataOnUninstall=false keeps the user's data across the swap.
function _removeLegacyNsisInstall() {
  if (process.platform !== 'win32') return;
  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$e = Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' |" +
    " ForEach-Object { Get-ItemProperty $_.PSPath } |" +
    " Where-Object { $_.DisplayName -like 'OpenSwarm*' -and $_.UninstallString -and ($_.UninstallString -notmatch 'Update\\.exe') } |" +
    " Select-Object -First 1;" +
    "if ($e) { if ($e.QuietUninstallString) { $u = $e.QuietUninstallString } else { $u = $e.UninstallString + ' /S' };" +
    " Start-Process -FilePath cmd.exe -ArgumentList '/c', $u -WindowStyle Hidden }";
  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (_) {}
}
if (process.platform === 'win32' && process.argv.includes('--squirrel-firstrun')) {
  try { app.once('before-quit', _removeLegacyNsisInstall); } catch (_) {}
}

// Phase 0 boot instrumentation. Records four ordered milestones as parseable
// lines so the packaged-build timing test (and any future perf-regression
// gate) can read them straight out of backend.log without a separate file.
// Format is load-bearing: `[perf] <name> t=<ms-since-launch>` one per line.
// APP_LAUNCH_T is captured at module load so t=0 is genuinely process start.
const APP_LAUNCH_T = Date.now();
const _perfSeen = new Set();
const _perfValues = {};   // name -> ms; read by the boot beacon below.
function perfMark(name) {
  // One-shot per milestone: first-paint etc. can re-fire on crash-recovery
  // window recreation, but the baseline we care about is the cold boot.
  if (_perfSeen.has(name)) return;
  _perfSeen.add(name);
  const t = Date.now() - APP_LAUNCH_T;
  _perfValues[name] = t;
  try { console.log(`[perf] ${name} t=${t}`); } catch (_) {}
}

// Preflight: log the usual "works on mine, not theirs" causes (python is already covered by the exists-log + spawn handler; this adds the rest). Log-only, guarded, no PII (lengths/flags, never paths).
let _preflightInfo = {};
let _preflightVerdict = null;

// Comprehensive preflight (electron/preflight.js): fans out checks under hard per-check timeouts, emits a [preflight2] verdict line, defers cache write until BOTH preflight finished AND backend-http-ready so a mid-boot kill cannot poison the next launch's cached verdict. Kill switch via OPENSWARM_DISABLE_PREFLIGHT=1.
let _preflightPendingCache = null;
// Cheap deterministic hash of installation_id into [0,99]; used by the cohort gate so the same install always falls in the same bucket regardless of when it boots.
function installIdBucket(id) {
  if (!id) return 0;
  let h = 5381; for (let i = 0; i < id.length; i++) { h = ((h << 5) + h + id.charCodeAt(i)) >>> 0; }
  return h % 100;
}

function runComprehensivePreflight() {
  if (process.env.OPENSWARM_DISABLE_PREFLIGHT === '1') { console.log('[preflight2] skipped (OPENSWARM_DISABLE_PREFLIGHT=1)'); return; }
  // Honor settings.preflight_enabled and cohort gate. Read sync from settings.json
  // since the backend isn't up yet; missing/unreadable file just means "use defaults".
  try {
    const settingsPath = path.join(app.getPath('userData'), 'data', 'settings', 'settings.json');
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const s = JSON.parse(raw);
    if (s && s.preflight_enabled === false) { console.log('[preflight2] skipped (settings.preflight_enabled=false)'); return; }
    const pct = (s && typeof s.preflight_rollout_pct === 'number') ? s.preflight_rollout_pct : 100;
    if (pct < 100) {
      const bucket = installIdBucket(s && s.installation_id);
      if (bucket >= pct) { console.log(`[preflight2] skipped (cohort gate: bucket ${bucket} >= ${pct}%)`); return; }
    }
  } catch { /* no settings yet = first launch = run with defaults */ }
  let pf;
  try { pf = require('./preflight'); } catch (e) { console.log(`[preflight2] module load failed: ${e && e.message}`); return; }
  let dataDir;
  try { dataDir = path.join(app.getPath('userData'), 'data'); } catch { dataDir = null; }
  const version = (() => { try { return app.getVersion(); } catch { return '0.0.0'; } })();
  if (dataDir) { try { pf.pruneOldCaches(pf.defaultEnv(), dataDir, version); } catch {} }
  const cached = dataDir ? pf.readCache(pf.defaultEnv(), dataDir, version) : null;
  if (cached) { console.log(`[preflight2] cached verdict=${cached.verdict} (skipping fresh probes)`); _preflightVerdict = cached; return; }
  pf.run(pf.defaultEnv(), { dataDir, gpu: { app } }).then((result) => {
    _preflightVerdict = result;
    const reasons = result.results.filter((r) => r.status !== 'ok').map((r) => `${r.name}:${r.status}(${r.reason})`).join('; ');
    console.log(`[preflight2] verdict=${result.verdict} totalMs=${result.totalMs} ${reasons || 'all-checks-ok'}`);
    if (dataDir && result.verdict === 'ok') {
      _preflightPendingCache = { pf, dataDir, version, result };
      maybeCommitPreflightCache();
    }
  }).catch((e) => { console.log(`[preflight2] threw: ${e && e.message}`); });
}

// Only write the cache once backend-http-ready has fired, so a kill in the
// window between preflight-finish and backend-actually-serving cannot leave a
// "verdict=ok" token that masks a real boot break on the next launch.
function maybeCommitPreflightCache() {
  if (!_preflightPendingCache) return;
  if (_perfValues['backend-http-ready'] == null) return;
  const { pf, dataDir, version, result } = _preflightPendingCache;
  _preflightPendingCache = null;
  try { pf.writeCache(pf.defaultEnv(), dataDir, version, result); console.log(`[preflight2] cache committed for v${version}`); }
  catch (e) { console.log(`[preflight2] cache write failed: ${e && e.message}`); }
}

function logPreflight(backendPort) {
  const info = {};
  const probe = (label, fn) => { try { info[label] = fn(); } catch (_) { info[label] = 'ERR'; } };
  try {
    const userData = app.getPath('userData');
    probe('userDataWritable', () => { const t = path.join(userData, '.preflight'); fs.writeFileSync(t, 'x'); fs.unlinkSync(t); return true; });
    probe('userDataAscii', () => /^[\x00-\x7F]*$/.test(userData));
    probe('userDataLen', () => userData.length);
    probe('oneDriveProfile', () => /onedrive/i.test(userData));
    probe('portInPreferredRange', () => backendPort >= 8324 && backendPort <= 8424);
    probe('freeDiskMB', () => Math.round((fs.statfsSync(userData).bavail * fs.statfsSync(userData).bsize) / 1048576));
    if (isPackaged) for (const bit of ['router', 'node', 'app.asar', 'frontend', 'backend', 'python-env']) probe(bit, () => fs.existsSync(getResourcePath(bit)));
    _preflightInfo = info;
    console.log(`[preflight] ${Object.entries(info).map(([k, v]) => `${k}=${v}`).join(' | ')}`);
  } catch (_) { /* never break boot */ }
}

// Count local Crashpad minidumps so the beacon can flag a crashy build (the cloud diffs by install_id over time).
function countCrashDumps() {
  try {
    const base = path.join(app.getPath('userData'), 'Crashpad');
    if (!fs.existsSync(base)) return 0;
    let n = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.dmp$/i.test(e.name)) n++;
      }
    };
    walk(base);
    return n;
  } catch (_) { return -1; }
}

// Fleet self-report: POST a compact boot outcome to the LOCAL backend, which forwards it via the existing service client (opt-out honored). No PII. Fire-and-forget, guarded.
function sendBootBeacon() {
  try {
    if (!isPackaged || !backendPort) return;
    const bi = getBuildInfo();
    const body = JSON.stringify({
      surface: 'boot',
      action: 'ready',
      props: {
        sha: bi.shortSha, channel: bi.channel, version: app.getVersion(),
        os: process.platform, arch: process.arch,
        perf: _perfValues, preflight: _preflightInfo, preflight2: _preflightVerdict ? { verdict: _preflightVerdict.verdict, totalMs: _preflightVerdict.totalMs, names: (_preflightVerdict.results || []).map((r) => `${r.name}:${r.status}`) } : null, crash_dumps: countCrashDumps(),
      },
    });
    const req = http.request({
      hostname: '127.0.0.1', port: backendPort, path: '/api/service/event', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
      },
      timeout: 4000,
    }, (res) => { res.on('data', () => {}); res.on('end', () => {}); });
    req.on('error', () => {});
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} });
    req.write(body);
    req.end();
  } catch (_) { /* beacon must never affect the app */ }
}

// Fire the beacon once first-paint AND backend-http-ready have both landed (the POST needs the backend listening); a touch later so it stays off the critical path.
let _beaconScheduled = false;
function maybeSendBootBeacon() {
  if (_beaconScheduled) return;
  if (_perfValues['first-paint'] == null || _perfValues['backend-http-ready'] == null) return;
  _beaconScheduled = true;
  setTimeout(() => sendBootBeacon(), 1500);
}

// Defender warmup: NSIS runs us with --prewarm right after install so Windows scans the bundled binaries while the user is already watching the installer instead of staring at a slow first launch.
if (process.argv.includes('--prewarm') && process.platform === 'win32') {
  const touchExe = (rel) => {
    const full = path.join(process.resourcesPath, rel);
    try {
      if (fs.existsSync(full)) {
        execFileSync(full, ['--version'], { timeout: 15000, stdio: 'ignore', windowsHide: true });
      }
    } catch (_) {}
  };
  touchExe(path.join('python-env', 'python.exe'));
  touchExe(path.join('node', 'x64', 'node.exe'));
  touchExe(path.join('node', 'arm64', 'node.exe'));
  process.exit(0);
}

// Prevent duplicate instances. Without this, double-clicking the app icon
// (or macOS auto-launch + manual launch overlapping) spawns two independent
// processes — each with its own backend on a different port — resulting in
// one populated window and one empty window.
// Register openswarm:// protocol handler BEFORE any gotLock branching.
// Must happen synchronously at the top of main.js so the OS knows this
// binary is the default handler even before whenReady fires.
if (process.defaultApp) {
  // Dev run: `electron .` needs the entry-script path to re-launch cleanly.
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('openswarm', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('openswarm');
}

// Pending deep-link captured before mainWindow exists (cold-launch case).
// Flushed to renderer once mainWindow is ready.
let pendingDeepLink = null;

function forwardDeepLinkToRenderer(url) {
  if (!url) return;
  // openswarm:// URLs split by host: "auth" → subscription token,
  // "oauth/{provider}/complete" → OAuth claim. Each goes to its own
  // IPC channel so the renderer can route without parsing twice.
  let channel = 'openswarm:auth-url';
  try {
    const u = new URL(url);
    if (u.host === 'oauth' && u.pathname.endsWith('/complete')) {
      channel = 'openswarm:oauth-claim';
    }
  } catch (_) {
    // Malformed URL — fall back to legacy channel; renderer ignores anything
    // it doesn't recognise.
  }
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send(channel, url);
  } else {
    // Stash both URL and target channel so we can flush correctly when
    // the renderer is ready. Replaces the simple string with a {channel,url}.
    pendingDeepLink = { channel, url };
  }
}

function extractOpenswarmUrl(argv) {
  return argv && argv.find((a) => typeof a === 'string' && a.startsWith('openswarm://'));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
} else {
  app.on('second-instance', (_event, argv) => {
    // Windows/Linux: a `openswarm://...` click lands here because the OS
    // re-launches the app with the URL as an argv. We swallow the second
    // instance, focus the existing window, and forward the URL to renderer.
    const url = extractOpenswarmUrl(argv);
    if (url) forwardDeepLinkToRenderer(url);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// macOS-only: clicks on openswarm:// links fire this event (instead of
// relaunching the process).
app.on('open-url', (event, url) => {
  event.preventDefault();
  forwardDeepLinkToRenderer(url);
  if (mainWindow && !mainWindow.isDestroyed()) {
    // focus() alone does not unhide a close-to-dock'd window.
    try { if (!mainWindow.isVisible()) mainWindow.show(); } catch (_) {}
    mainWindow.focus();
  } else if (BrowserWindow.getAllWindows().length === 0 &&
             !drainingForQuit && !isCreatingMainWindow && backendPort) {
    // Deep link (e.g. the browser sign-in redirect) arrived while alive but
    // windowless (macOS keep-alive): reopen so the pendingDeepLink stashed
    // by forwardDeepLinkToRenderer has a renderer to flush into (createWindow's
    // did-finish-load handler delivers it). Cold launches are unaffected:
    // backendPort is unset until boot completes, and the splash flow owns
    // first-window creation there.
    console.log('[diag][main] open-url with no window, reopening');
    recreateMainWindow();
  }
});

// Disabled Chromium features. Mac gets one extra: MacWebContentsOcclusion is
// Chromium's window-occlusion tracker that subscribes to NSEvent / NSApplicationSceneWorkspace
// events on the main thread — exactly the code path the user-reported macOS 26.5 + Electron 42
// NSEvent null-deref crash lives in. Disabling it routes around the subscription. Conservative:
// the only cost is slightly higher CPU when the window is fully hidden behind other apps
// (Chromium keeps painting invisible frames instead of pausing), zero impact when window is
// foreground. If this doesn't help, removing the flag is a one-line revert with no UX trace.
const _disabledFeatures = ['HardwareMediaKeyHandling'];
if (process.platform === 'darwin') _disabledFeatures.push('MacWebContentsOcclusion');
app.commandLine.appendSwitch('disable-features', _disabledFeatures.join(','));
// disableHardwareAcceleration() was tried as a fallback but did not stop the 0xC0000005 crashes, confirming the segfault is not GPU-side. Dev mode (http origin) never crashed, packaged (file:// origin) always crashed, so the embedded localhost HTTP server (see startFrontendServer below) is the real fix and we keep GPU acceleration on.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Agent-driven webviews must keep executing while the window is hidden or
// occluded; macOS App Nap was suspending guest renderers, so every
// executeJavaScript read (get_text, evaluate, wait probes) hung to its
// timeout the moment the user looked away. Same lever VS Code ships with.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// Heavy WebGL/webview churn (spam-switching apps, busy dashboards) can crash the
// shared GPU process; Chromium kills the whole app after a few GPU crashes. Lift
// that cap so a GPU hiccup recovers by restarting the GPU process instead of
// taking the app down with it. Fails quiet: at worst a brief compositor blip.
app.commandLine.appendSwitch('disable-gpu-process-crash-limit');

let mainWindow = null;
let backendProcess = null;
let backendPort = null;
let cachedUpdateStatus = { status: 'idle', info: null, error: null };
let isInstallingUpdate = false;

// Splash boot UX. Opens immediately on app.whenReady so the user sees
// motion within ~1s of double-click instead of a 30-60s frozen icon
// while Python imports + Defender real-time scans warm up. Closed once
// mainWindow is `ready-to-show`. See electron/splash/splash.html.
let splashWindow = null;
let mainWindowReady = false;
let isQuittingFromSplash = false;  // guards against double-quit during error shutdown
let rendererCrashTimes = [];       // timestamps of recent render-process-gone events; caps the auto-reload retry storm
const recentBackendStderr = [];   // ring buffer (last ~60 lines) for splash error UI
let splashDataUrlCache = null;
// Set to true around `new BrowserWindow()` for the top-level main window so the popup-UA spoofer in app.on('web-contents-created') doesn't accidentally rewrite the main window's UA. The web-contents-created event fires synchronously inside the BrowserWindow constructor, before mainWindow assignment returns; without this flag, the previous identity check (contents !== mainWindow.webContents) is racy across recreateMainWindow() because mainWindow still points to the OLD window during construction of the NEW one.
let isCreatingMainWindow = false;

// Embedded HTTP server that serves the packaged frontend bundle. The previous loadFile(...) path used file:// which on Windows Electron 40 CastLabs triggered a STATUS_ACCESS_VIOLATION (0xC0000005) renderer crash on every chat / dashboard mount; dev mode using http://localhost:3000 never crashed. Serving over http://127.0.0.1:<random> from the same in-process Node http server keeps the same packaged asset layout, costs no measurable perf (in-process loopback), and avoids the file:// quirk that Chromium 144 segfaults on.
let frontendServerPort = null;
async function startFrontendServer() {
  const frontendDir = path.join(process.resourcesPath, 'frontend');
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.wasm': 'application/wasm',
  };
  const server = http.createServer((req, res) => {
    try {
      let pathname = decodeURIComponent((req.url || '/').split('?')[0]);
      if (pathname === '/' || pathname === '') pathname = '/index.html';
      const resolved = path.normalize(path.join(frontendDir, pathname));
      // Defense-in-depth path-traversal guard; loopback-only listener already prevents external access but a misparsed URL must not escape the frontend dir.
      if (!resolved.startsWith(frontendDir + path.sep) && resolved !== path.join(frontendDir, 'index.html')) {
        res.writeHead(403); res.end(); return;
      }
      fs.readFile(resolved, (err, data) => {
        if (err) {
          // SPA fallback: unknown paths return index.html so client-side routing works even if some code uses BrowserRouter instead of HashRouter.
          fs.readFile(path.join(frontendDir, 'index.html'), (err2, indexData) => {
            if (err2) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(indexData);
          });
          return;
        }
        const ext = path.extname(resolved).toLowerCase();
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        res.end(data);
      });
    } catch (err) {
      console.error('[frontend-server] request handler threw:', err && err.message);
      try { res.writeHead(500); res.end(); } catch (_) {}
    }
  });
  // Try a deterministic port first so the renderer's origin stays stable across launches.
  // localStorage is keyed by origin (incl. port), and the old listen(0) handed out a random
  // port every launch, which wiped onboarding state on every restart and re-triggered the
  // tour. Try a preferred port; if held, fall back to OS-assigned.
  const PREFERRED_PORT = 4173;
  return new Promise((resolve) => {
    server.once('error', () => {
      // Preferred port held; fall back. localStorage may rotate this run but stabilizes once 4173 frees up.
      const fallback = http.createServer(server.listeners('request')[0]);
      fallback.on('error', (err) => {
        console.error('[frontend-server] fallback also failed:', err && err.message);
      });
      fallback.listen(0, '127.0.0.1', () => {
        const addr = fallback.address();
        frontendServerPort = typeof addr === 'object' && addr ? addr.port : null;
        console.log(`[frontend-server] listening (fallback) on 127.0.0.1:${frontendServerPort}`);
        resolve(frontendServerPort);
      });
    });
    server.listen(PREFERRED_PORT, '127.0.0.1', () => {
      const addr = server.address();
      frontendServerPort = typeof addr === 'object' && addr ? addr.port : null;
      console.log(`[frontend-server] listening on 127.0.0.1:${frontendServerPort}`);
      resolve(frontendServerPort);
    });
  });
}

const isPackaged = app.isPackaged;
const isDev = process.env.ELECTRON_DEV === '1';

// Mac-only crash watchdog. Targets the macOS 26.5 + Electron 42 NSEvent
// null-deref users have reported (wake-from-sleep mostly). When the parent
// dies unexpectedly, the watchdog calls `open -n /Applications/OpenSwarm.app`
// to bring the user back in ~2s. Five guards in crash-watchdog.js prevent
// false-positive relaunches (intentional Cmd+Q, auto-updater swap, startup
// crash loop, repeat cap). Packaged builds only; never runs in dev.
const CRASH_WATCHDOG_SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'openswarm');
const CRASH_WATCHDOG_CLEAN_QUIT_LOCK = path.join(CRASH_WATCHDOG_SUPPORT_DIR, 'clean-quit.lock');
// The watchdog skips a relaunch while this exists (guard 4) so the parent dying
// mid-swap isn't read as a crash. We write it when an update install starts and
// clear it on the next boot (the freshly-installed app deletes its own stale lock).
const CRASH_WATCHDOG_UPDATING_LOCK = path.join(CRASH_WATCHDOG_SUPPORT_DIR, 'updating.lock');

function spawnCrashWatchdog() {
  if (process.platform !== 'darwin') return;
  if (!isPackaged) return;
  try {
    const watchdogScript = path.join(__dirname, 'crash-watchdog.js');
    if (!fs.existsSync(watchdogScript)) return;
    // .../OpenSwarm.app/Contents/Resources/  ->  .../OpenSwarm.app
    const appBundle = path.join(process.resourcesPath, '..', '..');
    const { spawn: _spawn } = require('child_process');
    const child = _spawn(process.execPath, [watchdogScript], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        OPENSWARM_PARENT_PID: String(process.pid),
        OPENSWARM_APP_BUNDLE_PATH: appBundle,
        OPENSWARM_PARENT_START_TIME: String(Date.now()),
      },
    });
    child.unref();
  } catch (e) {
    console.warn('[crash-watchdog] spawn failed:', e && e.message);
  }
}

function writeCleanQuitLock() {
  if (process.platform !== 'darwin') return;
  try {
    if (!fs.existsSync(CRASH_WATCHDOG_SUPPORT_DIR)) fs.mkdirSync(CRASH_WATCHDOG_SUPPORT_DIR, { recursive: true });
    fs.writeFileSync(CRASH_WATCHDOG_CLEAN_QUIT_LOCK, '');
  } catch (_) {}
}

// Quit-cause forensics. On a real quit (Cmd+Q, dock Quit, app.quit()) Electron
// fires before-quit BEFORE any window 'close' events; a window closing on its
// own (Cmd+W, red X, programmatic close) fires 'close' with quitInitiated
// still false. The 1.2.77 self-quit investigation died for lack of exactly
// this line: every prod "crash" was an orderly quit and nothing recorded who
// started it. Console output is teed into backend.log in packaged builds.
let quitInitiated = false;
app.on('before-quit', () => {
  quitInitiated = true;
  console.log('[diag][main] before-quit (quit initiated)');
});
app.on('before-quit', writeCleanQuitLock);
const iconPath = process.platform === 'win32'
  ? path.join(__dirname, 'build', 'icon.ico')
  : path.join(__dirname, 'build', 'icon.png');
// PNG version of the icon for the splash. We ship a copy at splash/icon.png
// because electron-builder's `build/` directory is its inputs folder (used
// to GENERATE the .icns bundled icon) and is NOT included in the shipped
// asar archive — so `build/icon.png` exists in dev but ENOENTs in packaged
// builds. `splash/` IS shipped (alongside splash.html), so reading from
// there works in both modes. See the kept-in-sync copy command in the
// build scripts (or just commit both).
const iconPngPath = path.join(__dirname, 'splash', 'icon.png');

function loadSplashDataUrl() {
  if (splashDataUrlCache) return splashDataUrlCache;
  try {
    const html = fs.readFileSync(path.join(__dirname, 'splash', 'splash.html'), 'utf8');
    const iconBytes = fs.readFileSync(iconPngPath);
    const iconDataUrl = 'data:image/png;base64,' + iconBytes.toString('base64');
    const finalHtml = html.replace('__OPENSWARM_LOGO__', iconDataUrl);
    splashDataUrlCache = 'data:text/html;charset=utf-8;base64,' + Buffer.from(finalHtml).toString('base64');
    return splashDataUrlCache;
  } catch (err) {
    console.warn('[splash] failed to load splash payload:', err && err.message);
    return null;
  }
}

function createSplashWindow() {
  const dataUrl = loadSplashDataUrl();
  if (!dataUrl) return null;
  const w = new BrowserWindow({
    width: 460,
    height: 340,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,           // avoid duplicate taskbar entry next to mainWindow
    show: true,
    center: true,
    backgroundColor: '#0a0a10',  // opaque to dodge Windows DWM transparency quirks
    title: 'OpenSwarm',
    icon: iconPath,
    webPreferences: {
      // Splash content is fully self-contained (data URL, no remote
      // resources) so nodeIntegration here is safe and lets the splash
      // listen on ipcRenderer directly without a separate preload.
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  w.setMenuBarVisibility(false);
  w.loadURL(dataUrl);
  // If the splash is dismissed BEFORE the main window has shown itself,
  // treat that as the user intentionally bailing out of boot. Without
  // this, splash.close() would silently leave a backend running with
  // no UI, which is confusing and leaks the python process.
  // The isQuittingFromSplash guard avoids a double-quit when the user
  // clicked the splash's Quit button (which also calls app.quit) — that
  // path closes the splash and would re-trigger this branch.
  w.on('closed', () => {
    splashWindow = null;
    if (!mainWindowReady && !isQuittingFromSplash) {
      isQuittingFromSplash = true;
      console.log('[splash] closed before main window appeared — quitting app');
      try { if (!isDev) killBackend(); } catch (_) {}
      app.quit();
    }
  });
  return w;
}

function emitSplashStatus(payload) {
  if (splashWindow && !splashWindow.isDestroyed() && splashWindow.webContents) {
    try { splashWindow.webContents.send('splash:status', payload); } catch (_) {}
  }
}

// OS-tailored status copy. The "first launch is slow" experience has very
// different causes per platform (Defender on Windows, Gatekeeper +
// XProtect notarization scan on macOS), and naming the actual culprit
// helps users feel like the wait is intentional rather than the app being
// broken. Used by the long-wait branches in waitForBackend below.
function osStillStartingText() {
  if (process.platform === 'win32') {
    return 'Still starting — Windows Defender is scanning files (first launch only)…';
  }
  if (process.platform === 'darwin') {
    return 'Still starting — macOS is verifying the bundle (first launch only)…';
  }
  return 'Still starting (first launch is slower than subsequent launches)…';
}
function osTakingTooLongText() {
  if (process.platform === 'win32') {
    return 'Backend is taking longer than usual. Defender scans of 14k files can take a few minutes on slow drives.';
  }
  if (process.platform === 'darwin') {
    return 'Backend is taking longer than usual. macOS first-launch checks can be slow on cold cache.';
  }
  return 'Backend is taking longer than usual. You can wait, view logs, or restart.';
}

/**
 * macOS GUI apps launched from Finder/Dock inherit a minimal PATH from launchd
 * (/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin) — none of the user's shell
 * additions (nvm, volta, homebrew, bun, etc.) are present. Resolve the real
 * PATH by asking the user's default shell, then fall back to well-known dirs.
 */
function getShellPath() {
  if (process.platform !== 'darwin' || isDev) return process.env.PATH || '';

  // Strategy 1: ask the user's login shell for its PATH
  try {
    const userShell = process.env.SHELL || '/bin/zsh';
    const result = execFileSync(userShell, ['-ilc', 'echo $PATH'], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, HOME: os.homedir() },
    });
    const resolved = result.trim();
    if (resolved) return resolved;
  } catch (_) { /* fall through */ }

  // Strategy 2: read macOS system PATH config (/etc/paths + /etc/paths.d/*)
  const systemPaths = [];
  try {
    const base = fs.readFileSync('/etc/paths', 'utf8');
    for (const line of base.split('\n')) {
      const p = line.trim();
      if (p) systemPaths.push(p);
    }
  } catch (_) { /* ignore */ }
  try {
    const pathsD = '/etc/paths.d';
    if (fs.existsSync(pathsD)) {
      for (const file of fs.readdirSync(pathsD).sort()) {
        const content = fs.readFileSync(path.join(pathsD, file), 'utf8');
        for (const line of content.split('\n')) {
          const p = line.trim();
          if (p) systemPaths.push(p);
        }
      }
    }
  } catch (_) { /* ignore */ }

  // Strategy 3: well-known user-local bin directories
  const home = os.homedir();
  const fallbackDirs = [
    path.join(home, '.local/bin'),
    path.join(home, '.volta/bin'),
    path.join(home, '.fnm/aliases/default/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, '.cargo/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];

  const nvmDir = path.join(home, '.nvm/versions/node');
  try {
    if (fs.existsSync(nvmDir)) {
      const versions = fs.readdirSync(nvmDir).sort().reverse();
      if (versions.length) {
        fallbackDirs.unshift(path.join(nvmDir, versions[0], 'bin'));
      }
    }
  } catch (_) { /* ignore */ }

  const seen = new Set();
  const dirs = [];
  for (const d of [...fallbackDirs, ...systemPaths, ...(process.env.PATH || '').split(':')]) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    try { if (fs.statSync(d).isDirectory()) dirs.push(d); } catch { /* skip */ }
  }
  return dirs.join(':');
}

function getResourcePath(...segments) {
  if (isPackaged) {
    return path.join(process.resourcesPath, ...segments);
  }
  return path.join(__dirname, '..', ...segments);
}

function getPythonPath() {
  // python-build-standalone layout differs by OS:
  //   macOS / Linux: <env>/bin/python3
  //   Windows:       <env>\python.exe   (no bin/, no python3)
  //
  // macOS extra: invoke via Python.app/Contents/MacOS/python3 instead of
  // bin/python3 so LaunchServices reads LSUIElement=1 from the wrapper
  // bundle's Info.plist and skips the Dock entry. Without this, the
  // bundleless python3.13 binary appears as a generic "exec" placeholder
  // in the Dock on fresh user Macs, bouncing for the entire boot window.
  // sys.prefix / sys.executable still resolve via realpath so all stdlib
  // and site-packages discovery is unchanged. See scripts/build-python-env.sh
  // for the wrapper layout invariants.
  if (isPackaged) {
    const envPath = path.join(process.resourcesPath, 'python-env');
    if (process.platform === 'win32') {
      return path.join(envPath, 'python.exe');
    }
    if (process.platform === 'darwin') {
      const wrapped = path.join(envPath, 'Python.app', 'Contents', 'MacOS', 'python3');
      // Defensive fallback: if the wrapper is missing for any reason
      // (e.g. older build cache), fall back to the bare binary so boot
      // still succeeds — only the Dock-icon suppression is lost.
      if (fs.existsSync(wrapped)) return wrapped;
    }
    return path.join(envPath, 'bin', 'python3');
  }
  if (process.platform === 'win32') {
    return path.join(__dirname, '..', 'backend', '.venv', 'Scripts', 'python.exe');
  }
  return path.join(__dirname, '..', 'backend', '.venv', 'bin', 'python3');
}

// Path to a real Node.js binary bundled in extraResources, or null if not
// shipped (dev mode, or build that skipped the node-fetch step). Backend
// reads OPENSWARM_NODE_PATH env var to prefer this over both system `node`
// (which fresh user Macs lack) and the ELECTRON_RUN_AS_NODE fallback
// (which has flaky Dock behavior + slow cold-start). Used by 9Router and
// MCP bundle spawning.
//
// Layout shipped by scripts/build-app.sh:
//   <resources>/node/arm64/bin/node
//   <resources>/node/x64/bin/node
// Both arches are staged so a single extraResources entry covers
// publish-mode dual-arch builds without per-arch staging hooks; the
// runtime picks the matching one by process.arch. Wasted ~25 MB per
// DMG of cross-arch payload is the cost of avoiding electron-builder's
// per-arch beforePack complexity. Windows uses node.exe at the root of
// the per-arch subdir.
function getBundledNodePath() {
  if (!isPackaged) return null;
  const arch = process.arch === 'x64' ? 'x64' : (process.arch === 'arm64' ? 'arm64' : null);
  if (!arch) return null;
  const candidate = process.platform === 'win32'
    ? path.join(process.resourcesPath, 'node', arch, 'node.exe')
    : path.join(process.resourcesPath, 'node', arch, 'bin', 'node');
  return fs.existsSync(candidate) ? candidate : null;
}

// Polls /api/health/check until the backend answers 200, or the spawned
// python process exits non-zero (real failure). Never times out by wall
// clock — on a cold-Defender Windows install this can take several
// minutes the first time, and silently calling app.quit() would leave
// users staring at a vanished icon. Instead we surface progressive
// warnings on the splash so the wait feels intentional.
function waitForBackend(port, opts = {}) {
  const proc = opts.process || null;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let stillStartingNotified = false;
    let actionsShown = false;
    const finish = (fn, val) => { if (settled) return; settled = true; fn(val); };

    if (proc) {
      proc.once('exit', (code) => {
        // exit with code === null means we killed it ourselves (normal shutdown).
        if (code !== 0 && code !== null) {
          finish(reject, new Error(`Backend process exited with code ${code} during startup`));
        }
      });
      // spawn 'error' (missing/quarantined/wrong-arch python.exe) never fires
      // 'exit', so without this the health poll loops forever and the splash
      // hangs. Reject so the caller surfaces the failure UI instead.
      proc.once('error', (err) => {
        finish(reject, new Error(`Backend failed to spawn: ${err && err.message || err}`));
      });
    }

    function check() {
      if (settled) return;
      const elapsed = Date.now() - start;
      if (elapsed > 60_000 && !stillStartingNotified) {
        stillStartingNotified = true;
        emitSplashStatus({ text: osStillStartingText(), level: 'warning' });
      }
      if (elapsed > 180_000 && !actionsShown) {
        actionsShown = true;
        emitSplashStatus({
          text: osTakingTooLongText(),
          level: 'warning',
          showActions: true,
          logs: recentBackendStderr.slice(-20).join(''),
        });
      }
      const req = http.get(`http://127.0.0.1:${port}/api/health/check`, (res) => {
        if (res.statusCode === 200) {
          finish(resolve);
        } else {
          setTimeout(check, 500);
        }
      });
      req.on('error', () => setTimeout(check, 500));
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(check, 500);
      });
    }
    check();
  });
}

// Race a port-range search against a 3-second wall clock. On most machines
// `getPort.makeRange(8324, 8424)` returns within milliseconds, but Windows
// EDR / corp-firewall stacks can intercept the bind() probes and stall each
// attempt for seconds — 100 attempts × multi-second stalls = "OpenSwarm is
// hung at startup." The fallback `getPort({ port: 0 })` lets the OS pick
// any free ephemeral port; we don't actually care about staying inside the
// 8324-range — the renderer reads the port via IPC, no hardcoded assumption.
async function pickBackendPort() {
  const PREFERRED_TIMEOUT_MS = 3000;
  // host:'127.0.0.1' is load-bearing. The backend binds uvicorn --host
  // 127.0.0.1, but get-port defaults to probing 0.0.0.0, and on Windows a
  // 0.0.0.0:PORT probe SUCCEEDS even when another process already holds
  // 127.0.0.1:PORT (loopback). So without this, get-port hands back e.g.
  // 8324 as "free" while something else owns 127.0.0.1:8324, the backend
  // then fails its 127.0.0.1 bind with WinError 10048 and exits, and the
  // app shows "backend crashed". Probing the same interface uvicorn binds
  // makes get-port skip the occupied port. (POSIX already rejects the
  // mismatched 0.0.0.0 probe, so this is a no-op correctness win on Mac.)
  const preferred = getPort({ port: getPort.makeRange(8324, 8424), host: '127.0.0.1' });
  let timeoutHandle;
  const timeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve(null), PREFERRED_TIMEOUT_MS);
  });
  const winner = await Promise.race([preferred, timeout]);
  clearTimeout(timeoutHandle);
  if (winner !== null) return winner;
  console.warn(`[boot] getPort.makeRange(8324,8424) stalled past ${PREFERRED_TIMEOUT_MS}ms — falling back to OS-assigned port`);
  return await getPort({ port: 0, host: '127.0.0.1' });
}

async function startBackend() {
  if (!backendPort) backendPort = await pickBackendPort();

  const pythonPath = getPythonPath();
  const backendDir = getResourcePath('backend');
  const projectRoot = isPackaged ? process.resourcesPath : path.join(__dirname, '..');

  const shellPath = getShellPath();

  // Identifies how this build was packaged. Read by the backend service
  // client so the cloud can split installer-using customers from
  // run-from-source developers in dashboards. Honors a build-time override
  // (set in CI when producing platform installers) before falling back to
  // OS-derived defaults.
  let installMethod = process.env.OPENSWARM_INSTALL_METHOD;
  if (!installMethod) {
    if (!isPackaged) {
      installMethod = 'dev';
    } else if (process.platform === 'darwin') {
      installMethod = 'dmg';
    } else if (process.platform === 'win32') {
      installMethod = 'windows-setup';
    } else if (process.platform === 'linux') {
      // electron-builder produces AppImage by default for linux targets.
      // Override at packaging time when building .deb / .rpm.
      installMethod = 'appimage';
    } else {
      installMethod = 'unknown';
    }
  }

  const env = {
    ...process.env,
    PATH: shellPath,
    OPENSWARM_PACKAGED: isPackaged ? '1' : '0',
    OPENSWARM_PORT: String(backendPort),
    OPENSWARM_ELECTRON_PATH: process.execPath,
    OPENSWARM_INSTALL_METHOD: installMethod,
    // Inject the app version so the Python backend can report it in the
    // analytics envelope. Without this, _read_app_version() in
    // service/service.py tries to read electron/package.json via a relative
    // path that resolves correctly in `bash run.sh` dev mode but fails in
    // packaged dmg/exe builds — which made every shipped install report
    // app_version="unknown". The path-based fallback stays in place so this
    // change is purely additive.
    OPENSWARM_APP_VERSION: app.getVersion(),
    // Inject the user's BCP 47 locale + IANA timezone. The Python backend
    // doesn't have reliable APIs for either: locale.getdefaultlocale() is
    // deprecated and inconsistent across OSes, and Python's local-tz string
    // sometimes returns "PDT" or "Romance (zomertijd)" rather than
    // "America/Los_Angeles". Electron has both in canonical form via
    // app.getLocale() and Intl.DateTimeFormat().resolvedOptions().timeZone.
    OPENSWARM_LOCALE: app.getLocale(),
    OPENSWARM_TIMEZONE: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    PYTHONDONTWRITEBYTECODE: '1',
    // PEP 540 UTF-8 mode: makes open() default to UTF-8 on Windows where
    // the locale is otherwise cp1252. Many backend modules read UTF-8
    // .md / .json files without an explicit encoding= argument.
    PYTHONUTF8: '1',
  };

  // Tell the backend where to find a real Node binary for 9Router and
  // bundled MCP servers. Preferring this over ELECTRON_RUN_AS_NODE avoids
  // (a) the second OpenSwarm-as-Node process briefly registering in the
  // Dock on fresh Macs, and (b) the slow Electron cold-start tail (~5-15s)
  // that Electron-as-Node adds vs. native node (~1-2s). Falls back to the
  // existing system-node / Electron-as-Node chain in nine_router._find_node()
  // if the env var is unset (dev mode, or build without node fetch).
  const bundledNode = getBundledNodePath();
  if (bundledNode) {
    env.OPENSWARM_NODE_PATH = bundledNode;
  }

  if (isPackaged) {
    // site-packages location differs by OS — Windows has no lib/python3.13/.
    const pythonEnvSitePackages = process.platform === 'win32'
      ? path.join(process.resourcesPath, 'python-env', 'Lib', 'site-packages')
      : path.join(process.resourcesPath, 'python-env', 'lib', 'python3.13', 'site-packages');
    const debuggerDir = getResourcePath('debugger');
    env.PYTHONPATH = [projectRoot, debuggerDir, pythonEnvSitePackages].join(path.delimiter);
  }

  openBackendLog();
  // app-launch is the first milestone that can reach backend.log, since the
  // console tee is installed by openBackendLog() just above. APP_LAUNCH_T
  // (module load) remains the t=0 reference, so this t is real elapsed.
  perfMark('app-launch');
  // Provenance: name the exact commit + version at the top of every boot trace,
  // so a user-submitted backend.log instantly says what shipped. Emitted here
  // (not in whenReady) because openBackendLog() above just installed the console
  // tee; logging earlier would miss the persistent file.
  const _bi = getBuildInfo();
  console.log(`[provenance] OpenSwarm ${app.getVersion()} sha=${_bi.shortSha} channel=${_bi.channel} builtAt=${_bi.builtAt || 'n/a'}`);
  logPreflight(backendPort);
  runComprehensivePreflight();
  // Record what we're about to launch and whether the interpreter is even
  // present. If AV quarantined python.exe or the wrong-arch bundle shipped,
  // exists=false (or spawn 'error' below) names the cause that otherwise
  // produces a silent "backend crashed" with no stdout/stderr at all.
  let pythonExists = false;
  try { pythonExists = fs.existsSync(pythonPath); } catch (_) {}
  console.log(`Starting backend: ${pythonPath} (exists=${pythonExists}) on port ${backendPort}`);
  console.log(`Project root: ${projectRoot}`);

  backendProcess = spawn(
    pythonPath,
    ['-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', String(backendPort)],
    {
      cwd: projectRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );

  backendProcess.stdout.on('data', (data) => {
    const text = data.toString();
    process.stdout.write(`[backend] ${text}`);
    // uvicorn prints this exact phrase once the ASGI app is live and
    // routes are mounted — perfect milestone for the splash to flip
    // from "starting backend" to "loading components".
    if (text.indexOf('Application startup complete') !== -1) {
      emitSplashStatus('Loading components…');
    }
  });

  backendProcess.stderr.on('data', (data) => {
    const text = data.toString();
    process.stderr.write(`[backend] ${text}`);
    // Buffer the most recent stderr lines for the splash error UI so
    // when boot fails we can show actionable context inline instead of
    // making the user dig through a log file.
    recentBackendStderr.push(text);
    while (recentBackendStderr.length > 60) recentBackendStderr.shift();
  });

  // spawn() fires 'error' (not 'exit', not stdout/stderr) when the binary is
  // missing, AV-quarantined, blocked, or the wrong arch (ENOEXEC). This is the
  // most common silent cross-machine failure; without this handler it produced
  // an unhandled emitter error and an empty log. Surface it in both the log and
  // the splash error buffer so "View logs" actually explains the crash.
  backendProcess.on('error', (err) => {
    const msg = `\n[electron] backend spawn FAILED: ${err && err.code ? err.code + ' ' : ''}${err && err.message || err}\n` +
      `  python path: ${pythonPath} (exists=${pythonExists})\n` +
      `  arch: ${process.arch}, platform: ${process.platform}\n`;
    console.error(msg);
    recentBackendStderr.push(msg);
    while (recentBackendStderr.length > 60) recentBackendStderr.shift();
  });

  backendProcess.on('exit', (code) => {
    console.log(`Backend exited with code ${code}`);
    if (code !== 0 && code !== null && mainWindow) {
      mainWindow.webContents.executeJavaScript(
        `document.title = "OpenSwarm (backend crashed)";`
      );
    }
  });

  emitSplashStatus('Starting backend…');
  await waitForBackend(backendPort, { process: backendProcess });
  perfMark('backend-http-ready');
  console.log(`Backend ready on port ${backendPort}`);
  maybeCommitPreflightCache();
  maybeSendBootBeacon();

  // Backend writes a per-install auth token file at startup. Read it
  // here so the renderer can include it in WS URLs (`?token=...`) and
  // HTTP Authorization headers. Without this, any webpage loaded in
  // any browser on the machine could hit our localhost API and
  // impersonate the user. See backend/auth.py.
  await loadAuthToken();
  markBackendReady();
}

// Per-install auth token read from <data-root>/auth.token (backend
// generates this at startup). Cached here so `get-auth-token` IPC
// calls are fast. If reads fail initially (race with backend) we
// retry a few times.
let authToken = '';

// Lazy-backend gate: renderer fetches block on this until backend is reachable AND auth token is loaded. Lets the main window open immediately while Python is still cold-starting on Windows.
let backendReady = false;
let _backendReadyResolve;
const backendReadyPromise = new Promise((resolve) => { _backendReadyResolve = resolve; });
function markBackendReady() {
  if (backendReady) return;
  backendReady = true;
  _backendReadyResolve();
  try {
    workflowsLifecycle.setBackend({ port: backendPort, token: authToken });
    workflowsLifecycle.startPolling();
  } catch (_) {}
}

function getAuthTokenFilePath() {
  // Mirrors backend/config/paths.py. On macOS the file lives at
  // ~/Library/Application Support/OpenSwarm/data/auth.token; on
  // Windows under %APPDATA%/OpenSwarm/data/; on Linux under
  // ~/.local/share/OpenSwarm/data/. In dev the backend writes it to
  // backend/data/auth.token instead.
  if (isPackaged) {
    if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', 'OpenSwarm', 'data', 'auth.token');
    } else if (process.platform === 'win32') {
      return path.join(process.env.APPDATA || os.homedir(), 'OpenSwarm', 'data', 'auth.token');
    } else {
      const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
      return path.join(xdg, 'OpenSwarm', 'data', 'auth.token');
    }
  }
  // Dev: backend/data/auth.token relative to repo root.
  return path.join(__dirname, '..', 'backend', 'data', 'auth.token');
}

// Persistent backend log on disk. Until now the bundled-Python stdout/stderr
// only went to the Electron process streams, which a packaged Windows app
// has no console for, so a user whose backend failed on their machine had
// nothing to send us. This file is the one artifact that names the actual
// cause (UnicodeDecodeError, EADDRINUSE, missing DLL, AV quarantine) of the
// "works on my laptop, not theirs" failures. Lives next to auth.token.
function getBackendLogPath() {
  return path.join(path.dirname(getAuthTokenFilePath()), 'backend.log');
}

let backendLogStream = null;
let _consoleTeed = false;
function openBackendLog() {
  try {
    const logPath = getBackendLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // Size-based rotation: keep one previous file so the log can't grow
    // unbounded across long-running sessions. 5MB is plenty for a boot trace.
    try {
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 * 1024) {
        fs.renameSync(logPath, logPath + '.1');
      }
    } catch (_) {}
    backendLogStream = fs.createWriteStream(logPath, { flags: 'a' });
    backendLogStream.write(`\n===== launch ${new Date().toISOString()} (app ${app.getVersion()}, ${process.platform}/${process.arch}) =====\n`);
    installConsoleTee();
  } catch (err) {
    console.warn('[backend-log] could not open log file:', err && err.message);
    backendLogStream = null;
  }
}
// Tee the whole main-process stdout/stderr into the log file, not just the
// Python child's streams. A packaged Windows GUI app has no console, so
// otherwise every main-process console.log/error (boot failures, frontend
// server errors, renderer-forwarded crashes, the spawn-error handler) is lost.
// Patched once; reads the current backendLogStream so it survives restarts.
function installConsoleTee() {
  if (_consoleTeed) return;
  _consoleTeed = true;
  for (const name of ['stdout', 'stderr']) {
    const orig = process[name].write.bind(process[name]);
    process[name].write = (chunk, ...rest) => {
      try { if (backendLogStream) backendLogStream.write(chunk); } catch (_) {}
      return orig(chunk, ...rest);
    };
  }
}

async function loadAuthToken() {
  const tokenPath = getAuthTokenFilePath();
  // Retry up to 20 × 100ms = 2s in case backend is still writing the
  // file. Backend writes BEFORE binding HTTP port though, so this
  // usually returns on the first attempt.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const contents = fs.readFileSync(tokenPath, 'utf8').trim();
      if (contents) {
        authToken = contents;
        console.log(`[auth] loaded token from ${tokenPath}`);
        return;
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  console.warn(`[auth] FAILED to load auth token from ${tokenPath} after 2s — WS/HTTP will be rejected`);
}

function createWindow() {
  isCreatingMainWindow = true;
  console.log('[diag][main] createWindow start');
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'OpenSwarm',
    icon: iconPath,
    titleBarStyle: 'hiddenInset',
    // Stay hidden until the renderer fires `ready-to-show`. The splash
    // is what the user looks at; we swap it out for this window only
    // once React has actually painted, avoiding the white-flash that
    // Electron windows do during initial layout.
    show: false,
    backgroundColor: '#1a1a1f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      // E2E: additionalArguments lands in the renderer process.argv, which the
      // preload reads to expose the Redux store deterministically. No-op for
      // normal launches (env var unset).
      ...(process.env.OPENSWARM_E2E === '1' ? { additionalArguments: ['--openswarm-e2e=1'] } : {}),
    },
  });

  if (isDev) {
    mainWindow.loadURL(`http://localhost:3000`);
  } else if (frontendServerPort) {
    mainWindow.loadURL(`http://127.0.0.1:${frontendServerPort}/index.html`);
  } else {
    // Fallback only if the embedded server failed to start; the file:// path is known to segfault on Windows CastLabs Electron 40 but it is better than a white screen.
    const frontendPath = getResourcePath('frontend', 'index.html');
    mainWindow.loadFile(frontendPath);
  }

  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    webPreferences.plugins = true;
    webPreferences.enableBlinkFeatures = 'EncryptedMedia';
    // Block autoplay in agent webviews. A profile page full of autoplaying video
    // (the repeated video.js logs) saturates the renderer's main thread and is a
    // prime reason the tab goes unresponsive and every command then times out. The
    // agent never needs autoplay; a human who wants to watch just clicks play, which
    // is the user gesture that re-enables it. Scoped to webviews, not the main window.
    webPreferences.autoplayPolicy = 'document-user-activation-required';
    // Force our webview preload to attach for every <webview>, unconditionally.
    // The alternative (reading window.openswarm.getWebviewPreloadPath() in
    // BrowserCard's React code at module-eval time) raced against the
    // preload's async contextBridge exposure — the resulting attribute on
    // the <webview> element ended up empty, so no preload ran and our
    // passkey shim never loaded. Setting webPreferences.preload here runs
    // on every attach and can't be out-raced. Absolute path (not file://)
    // is what webPreferences expects.
    webPreferences.preload = path.join(__dirname, 'webview-preload.js');
    try {
      console.log('[openswarm:attach-webview] forced preload=', webPreferences.preload, 'src=', params.src);
    } catch (_) {}
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isDev && url.startsWith('http://localhost:3000')) return;
    if (url.startsWith('file://')) return;
    event.preventDefault();
    mainWindow.webContents.send('webview-new-window', url, mainWindow.webContents.id);
  });

  // Neuter renderer-side window.close() in the main window's page world.
  // Our React bundle never calls it legitimately, and while a window-level
  // close (Cmd+W / red X) is hidden-not-destroyed by the close interception
  // below, a renderer-side window.close() SKIPS the preventable 'close'
  // event and destroys the webContents outright (reproduced via CDP).
  // contextIsolation is on, so a preload override can't reach page callers;
  // executeJavaScript runs in the page world. The stub logs the caller's
  // stack and the console tee lands it in backend.log, so a phantom close
  // becomes a self-identifying report instead of a vanished window.
  // on(), not once(): re-applies across reloads and crash-recreates.
  {
    const wc = mainWindow.webContents;
    wc.on('did-finish-load', () => {
      wc.executeJavaScript(
        "window.close = function () { console.warn('[diag][renderer] window.close() blocked; caller:', new Error().stack); };"
      ).catch(() => {});
    });
  }

  // Once the renderer has loaded, flush any deep-link URL we captured before
  // the window existed (cold-launch via openswarm://). pendingDeepLink may
  // be a string (legacy) OR a {channel, url} object (v1.0.26+ OAuth claims).
  mainWindow.webContents.once('did-finish-load', () => {
    perfMark('first-paint');
    maybeSendBootBeacon();
    if (pendingDeepLink) {
      if (typeof pendingDeepLink === 'string') {
        mainWindow.webContents.send('openswarm:auth-url', pendingDeepLink);
      } else {
        mainWindow.webContents.send(pendingDeepLink.channel, pendingDeepLink.url);
      }
      pendingDeepLink = null;
    }
  });

  // Identity-checked: on crash recovery we recreate the window, which means BOTH the old and new BrowserWindow are alive briefly. The OLD window's closed handler must not clobber the NEW mainWindow reference when the old finally destroys.
  const thisWindow = mainWindow;
  // Forensic: quitInitiated=false here means the close was window-initiated
  // (Cmd+W via the default menu, red X, or a programmatic close) — the
  // signature of the 1.2.77 prod self-quits. True means a normal quit is
  // closing windows as part of its pipeline.
  mainWindow.on('close', (e) => {
    console.log(`[diag][main] mainWindow close (quitInitiated=${quitInitiated})`);
    // macOS close-to-dock: a close that is not part of a real quit (Cmd+Q,
    // dock Quit, logout, updater — all fire before-quit first, flipping
    // quitInitiated) gets prevented and the window HIDES instead. This keeps
    // the renderer, webviews, and running agents fully alive, so both the
    // user's Cmd+W/red-X and the un-attributed programmatic closer behind
    // the 1.2.77 self-quits cost nothing: the next dock click shows the
    // same window back instantly (`activate` below). Real quits must pass
    // through — preventing a close during app.quit() cancels the quit
    // (Electron semantics), which is exactly what the flag guards against.
    // isInstallingUpdate must pass through: native quitAndInstall TERMINATES the app
    // by closing the window (with quitInitiated still false), so intercepting it here
    // hides the window and strands the update uninstalled. That was THE bug behind
    // "Restart & Update does nothing" on Mac. Let that close (and real quits) through.
    if (process.platform === 'darwin' && !quitInitiated && !isInstallingUpdate) {
      e.preventDefault();
      // A staged update waiting + a user close = "apply it on the way out". Kick off
      // the install (arms ShipIt + drives a real quit) instead of just hiding, so the
      // red button finally updates instead of looping.
      if (cachedUpdateStatus && cachedUpdateStatus.status === 'downloaded') {
        console.log('[updater] close with a staged update; applying it');
        installDownloadedUpdate();
        return;
      }
      try {
        if (thisWindow.isFullScreen()) {
          // Hiding a fullscreen window strands a black space; leave
          // fullscreen first, then hide once the transition lands.
          thisWindow.once('leave-full-screen', () => { try { thisWindow.hide(); } catch (_) {} });
          thisWindow.setFullScreen(false);
        } else {
          thisWindow.hide();
        }
        console.log('[diag][main] close intercepted, window hidden (app + agents stay alive)');
      } catch (_) {}
    }
  });
  mainWindow.on('closed', () => {
    // 'close' only fires for window-level closes (Cmd+W / red X / win.close());
    // a webContents-level teardown skips it and lands here directly, so log
    // both or the forensics miss that family.
    console.log(`[diag][main] mainWindow closed (quitInitiated=${quitInitiated})`);
    if (mainWindow === thisWindow) mainWindow = null;
  });

  // Renderer process death (GPU/native/OOM crash) is invisible to React error boundaries since the whole content process is gone. We RECREATE the window rather than reload(): the Electron 40 CastLabs build hits NOTREACHED in base/observer_list.h on reload after a renderer crash (some session/webview observer is re-registered against a list that disallows duplicates), aborting the entire main process with exit 3. A fresh BrowserWindow side-steps that. Crashes capped at 3 in 60s; after the cap we surface a native dialog so the user picks Reload vs Quit themselves rather than thrashing.
  mainWindow.webContents.on('preload-error', (_event, preloadPath, err) => {
    console.error('[diag][main:preload-error]', preloadPath, err && err.stack || err);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const reason = details && details.reason;
    if (reason === 'clean-exit') return;
    // Renderer dying mid-quit-drain is expected; recreating then would resurrect a window we're trying to close.
    if (drainingForQuit) return;
    console.error('[main] renderer process gone:', JSON.stringify(details));
    const now = Date.now();
    rendererCrashTimes = rendererCrashTimes.filter((t) => now - t < 60_000);
    if (rendererCrashTimes.length >= 3) {
      console.error('[main] renderer crashed 3x in 60s, showing recovery dialog');
      showCrashRecoveryOverlay();
      return;
    }
    rendererCrashTimes.push(now);
    recreateMainWindow();
  });

  // Window-blur / window-focus tracking — analytics signal for "user
  // switched to another app" (temp-churn). The renderer captures these
  // through the existing report() pipeline; we just emit IPC notices
  // here so the React layer can timestamp them and forward to the
  // local backend's /api/service/submit endpoint.
  //
  // Cadence: at most once every 2 seconds per direction. Without that
  // throttle, dragging a window across desktops or having a popup steal
  // focus generates a burst of blur/focus pairs that pollute analytics
  // with noise.
  let _lastFocusEvent = 0;
  const FOCUS_THROTTLE_MS = 2000;
  const sendFocusEvent = (kind) => {
    const now = Date.now();
    if (now - _lastFocusEvent < FOCUS_THROTTLE_MS) return;
    _lastFocusEvent = now;
    sendToRenderer('openswarm:window-focus', { kind, ts: now });
  };
  mainWindow.on('blur', () => sendFocusEvent('blur'));
  mainWindow.on('focus', () => sendFocusEvent('focus'));

  // Forward renderer console output to main stderr so packaged-build diagnostics survive without DevTools open.
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['LOG', 'INFO', 'WARN', 'ERROR'][level] || 'LOG';
    const src = sourceId ? sourceId.split('/').pop() : '';
    console.log(`[renderer:${tag}] ${message}${src ? ` (${src}:${line})` : ''}`);
  });

  // DevTools shortcut. Windows/Linux hide the menu bar, so the default View >
  // Toggle Developer Tools route is unreachable there (Mac keeps its menu);
  // wire F12 and Ctrl/Cmd+Shift+I directly so support can grab logs anywhere.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    const isInspect = (input.control || input.meta) && input.shift && key === 'i';
    if (key === 'f12' || isInspect) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  isCreatingMainWindow = false;
  console.log('[diag][main] createWindow end, ua=', mainWindow.webContents.getUserAgent());
}

// Crash recovery path A: tear down the dead BrowserWindow and stand up a fresh one. Used by the render-process-gone handler under the 3-in-60s cap.
//
// Why createWindow first, destroy old after:
//   - If we destroy old before creating new, mainWindow goes null. Electron fires window-all-closed → app.quit() runs in the gap and we lose the process before the new window exists.
//   - createWindow() assigns mainWindow = newWindow synchronously, so the window list never drops to zero.
//
// Why setImmediate for the destroy:
//   - We're INSIDE the old window's render-process-gone handler. Destroying its BrowserWindow from inside its own event callback works in current Electron but is fragile across version bumps; deferring one tick is free insurance.
function recreateMainWindow() {
  console.log('[diag][main] recreateMainWindow START, crashesInWindow=', rendererCrashTimes.length);
  const oldWindow = mainWindow;
  mainWindowReady = false;
  try {
    createWindow();
  } catch (err) {
    console.error('[diag][main] recreateMainWindow: createWindow failed:', err && err.message);
    return;
  }
  console.log('[diag][main] recreateMainWindow created fresh window, ua=', mainWindow && mainWindow.webContents.getUserAgent());
  const freshWindow = (mainWindow && mainWindow !== oldWindow) ? mainWindow : null;
  if (freshWindow) {
    freshWindow.once('ready-to-show', () => {
      try {
        freshWindow.show();
        freshWindow.focus();
        mainWindowReady = true;
      } catch (_) {}
    });
    // After recreate the splash is long gone, so we can't rely on the boot path's swapToMain. Re-attach the update-notif listener that app.whenReady installed on the original webContents; the new webContents has no listeners yet.
    if (!isDev) {
      freshWindow.webContents.on('did-finish-load', () => {
        if (cachedUpdateStatus.status === 'available') {
          sendToRenderer('update-available', cachedUpdateStatus.info);
        } else if (cachedUpdateStatus.status === 'downloaded') {
          sendToRenderer('update-downloaded', cachedUpdateStatus.info);
        }
      });
    }
  }
  setImmediate(() => {
    if (oldWindow && !oldWindow.isDestroyed()) {
      try { oldWindow.destroy(); } catch (_) {}
    }
  });
}

// Crash recovery path B: the cap-exceeded fallback. Native dialog (not a BrowserWindow) so we cannot trigger the same observer-double-add DCHECK that motivated this whole change. User-driven Reload runs in a clean call stack outside the render-process-gone handler.
async function showCrashRecoveryOverlay() {
  try {
    const result = await dialog.showMessageBox({
      type: 'error',
      title: 'OpenSwarm needs to reload',
      message: 'OpenSwarm had repeated UI errors and stopped auto-recovering.',
      detail: 'Reload to try again, or quit if this keeps happening.',
      buttons: ['Reload', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0) {
      rendererCrashTimes = [];
      recreateMainWindow();
    } else {
      app.quit();
    }
  } catch (err) {
    console.error('[main] showCrashRecoveryOverlay failed:', err && err.message);
    app.quit();
  }
}

function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send(channel, ...args);
    } catch (err) {
      // webContents.send throws after the renderer dies but before mainWindow.isDestroyed() returns true (race during recreate). Swallow so the blur/focus listener cannot become a secondary crash source.
      console.warn('[sendToRenderer] send failed for', channel, ':', err && err.message);
    }
  }
}

// Maps a raw electron-updater error to a short, human message. The raw error
// is always logged separately for debugging; users only ever see this. No
// em/en dashes per repo style.
function friendlyUpdateError(err) {
  const raw = ((err && err.message) || String(err) || '').toLowerCase();
  // Experimental on, but there is no pre-release to fetch: the provider 404s
  // looking for the pre-release channel feed. This is the screenshot case.
  if (autoUpdater && autoUpdater.allowPrerelease &&
      /404|not found|cannot find|no published|latest.*\.yml/.test(raw)) {
    return 'No experimental builds available right now. You are on the latest version.';
  }
  if (/net::|enotfound|etimedout|econnrefused|getaddrinfo|network/.test(raw)) {
    return 'Could not reach the update server. Check your connection and try again.';
  }
  return 'Update check failed. Please try again later.';
}

// Phase 2 provenance: which exact commit produced this build. The build
// scripts write electron/build-info.json (gitignored, regenerated each build)
// next to main.js, so it ships inside the asar. In dev there is no such file,
// so we fall back to a live `git rev-parse` and tag it dev. Cached after first
// read; never throws (a missing/garbled file just yields 'unknown').
let _buildInfoCache = null;
function getBuildInfo() {
  if (_buildInfoCache) return _buildInfoCache;
  let info = { sha: 'unknown', shortSha: 'unknown', builtAt: null, channel: 'unknown' };
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.sha) info = parsed;
  } catch (_) {
    // Dev fallback: resolve the working-tree HEAD so `npm start` still reports something useful.
    try {
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, timeout: 2000 }).toString().trim();
      if (sha) info = { sha, shortSha: sha.slice(0, 12), builtAt: null, channel: 'dev' };
    } catch (_) { /* not a git checkout either; keep 'unknown' */ }
  }
  _buildInfoCache = info;
  return info;
}

// The packaged frontend ships as an unversioned `./bundle.js` served with no
// validation headers, so Chromium caches it heuristically and can keep serving
// OLD cross-version JS, a shipped fix silently no-ops and reinstalling the .app
// doesn't help (the cache outlives it). A marker-on-build-change clear missed the
// downgrade-bounce (new->old->new leaves the same marker but a re-poisoned cache),
// so just drop the HTTP cache every launch before the window loads. The V8 code
// cache is left intact, so unchanged JS still skips recompile; the only cost is a
// couple of localhost refetches at startup.
async function clearStaleFrontendCache() {
  if (isDev) return;
  try {
    await session.defaultSession.clearCache();
    console.log('[cache] cleared HTTP cache so the on-disk frontend always loads');
  } catch (err) {
    console.warn('[cache] clearStaleFrontendCache failed:', err && err.message);
  }
}

function setupAutoUpdater() {
  if (!autoUpdater) return;
  if (isSquirrelUpdater) {
    // Squirrel.Windows fetches its RELEASES feed from GH /latest/download/. The
    // built-in autoUpdater has no autoDownload/allowPrerelease/allowDowngrade knobs.
    try {
      autoUpdater.setFeedURL({ url: 'https://github.com/openswarm-ai/openswarm/releases/latest/download/' });
    } catch (err) {
      console.warn('[updater] Squirrel setFeedURL failed:', err && err.message);
      return;
    }
  } else {
    // Silent background updates: download on detect, install on next quit.
    // The OS gates the install on main-process exit (can't replace a
    // running .app / locked .exe), so an active session is never disrupted.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // Renderer pushes the user's experimental-updates setting via IPC right after settings load.
    autoUpdater.allowPrerelease = false;
    // Lets us un-ship a bad release: re-flip GH 'latest' to an older one and users hop back to it.
    autoUpdater.allowDowngrade = true;
  }

  // electron-updater (Mac) passes an info object ({version,...}); the built-in
  // Windows autoUpdater (Squirrel) fires update-available/-not-available with NO
  // args and update-downloaded with positional (event, releaseNotes, releaseName,
  // releaseDate, updateURL). Normalize so these handlers work for both.
  autoUpdater.on('update-available', (info) => {
    const norm = info && info.version ? info : { version: '' };
    console.log(`Update available: ${norm.version || '(version not reported by Squirrel)'}`);
    cachedUpdateStatus = { status: 'available', info: norm, error: null };
    sendToRenderer('update-available', norm);
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('App is up to date');
    cachedUpdateStatus = { status: 'not-available', info: info || {}, error: null };
    sendToRenderer('update-not-available', info || {});
  });

  autoUpdater.on('download-progress', (progress) => {
    cachedUpdateStatus = { status: 'downloading', info: progress, error: null };
    sendToRenderer('download-progress', progress);
  });

  autoUpdater.on('update-downloaded', (info, releaseNotes, releaseName) => {
    const version = (info && info.version) || releaseName || '';
    console.log(`Update downloaded: ${version || '(ready to install)'}`);
    const norm = info && info.version ? info : { version };
    cachedUpdateStatus = { status: 'downloaded', info: norm, error: null };
    sendToRenderer('update-downloaded', norm);
  });

  autoUpdater.on('error', (err) => {
    // Squirrel throws "AutoUpdater process ... is already running" when a check or
    // download is already in flight (e.g. the user clicked Check twice). Benign.
    if (/already running/i.test((err && err.message) || '')) {
      console.log('[updater] check already in progress; ignoring duplicate trigger');
      return;
    }
    // Raw electron-updater errors are verbose (full URL, HTTP status, stack,
    // sometimes an HTML body). Keep the raw text in the log for debugging, but
    // never show it to the user. The common case is "Experimental updates is on
    // but no pre-release exists": the GitHub provider 404s hunting a pre-release
    // feed, which is not a real failure, just "nothing newer to install".
    console.error('Auto-update error:', err);
    const friendly = friendlyUpdateError(err);
    cachedUpdateStatus = { status: 'error', info: null, error: friendly };
    sendToRenderer('update-error', friendly);
  });

  // electron-updater's checkForUpdates() returns a promise; the built-in Windows
  // autoUpdater (Squirrel) returns nothing and reports via events, so a bare
  // .catch() on it throws. Guard the call so both updaters work.
  const _runUpdateCheck = (label) => {
    try {
      const p = autoUpdater.checkForUpdates();
      if (p && typeof p.catch === 'function') p.catch((err) => console.log(`${label}:`, err && err.message));
    } catch (err) {
      console.log(`${label} threw:`, err && err.message);
    }
  };
  _runUpdateCheck('Update check skipped');

  // Always-on users (lid never closes) miss the once-at-startup check
  // above. Re-check every 4h; coalesces if a download is already cached.
  setInterval(() => _runUpdateCheck('Periodic update check failed'), 4 * 60 * 60 * 1000);

  // Evergreen catch-all: our keep-alive means the app rarely truly quits, so the staged
  // update can sit unapplied for days. If one is downloaded AND the machine has been idle
  // with NO agent running for a sustained stretch, swap to it silently via the same path
  // the button uses. Deliberately conservative so it can never land on top of a live task.
  const IDLE_INSTALL_MIN_IDLE_S = 30 * 60;
  const IDLE_INSTALL_MIN_UPTIME_MS = 2 * 60 * 60 * 1000;
  const _idleInstallStart = Date.now();
  const _backendActiveAgents = () => new Promise((resolve) => {
    if (!backendPort) return resolve(-1);
    const req = http.request({
      hostname: '127.0.0.1', port: backendPort, path: '/api/agents/activity', method: 'GET',
      headers: { ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) }, timeout: 4000,
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(Number(JSON.parse(d).active)); } catch (_) { resolve(-1); } });
    });
    req.on('error', () => resolve(-1));
    req.on('timeout', () => { req.destroy(); resolve(-1); });
    req.end();
  });
  setInterval(async () => {
    try {
      if (isInstallingUpdate || !cachedUpdateStatus || cachedUpdateStatus.status !== 'downloaded') return;
      if (Date.now() - _idleInstallStart < IDLE_INSTALL_MIN_UPTIME_MS) return;
      if (powerMonitor.getSystemIdleTime() < IDLE_INSTALL_MIN_IDLE_S) return;
      const active = await _backendActiveAgents();
      if (active !== 0) return; // unknown (-1) or busy -> stay put, never interrupt a task
      console.log('[updater] staged update + machine idle + no agents; applying silently');
      installDownloadedUpdate();
    } catch (_) { /* a heartbeat must never throw */ }
  }, 5 * 60 * 1000);
}

function killBackend() {
  if (backendProcess) {
    console.log('Killing backend process...');
    if (process.platform === 'win32') {
      // Windows: Node's child.kill() only terminates the direct child, leaving
      // grandchildren (e.g. the router node process the Python backend
      // spawned) as orphans. Use `taskkill /T /F` to walk the process tree.
      try {
        require('child_process').execFileSync(
          'taskkill', ['/PID', String(backendProcess.pid), '/T', '/F'],
          { stdio: 'ignore' },
        );
      } catch (_) {
        // taskkill failed (process may have already exited) — fall back to kill().
        try { backendProcess.kill(); } catch (_) {}
      }
    } else {
      backendProcess.kill('SIGTERM');
      setTimeout(() => {
        if (backendProcess && !backendProcess.killed) {
          backendProcess.kill('SIGKILL');
        }
      }, 3000);
    }
    backendProcess = null;
  }
  if (backendLogStream) {
    try { backendLogStream.end(`[electron] backend killed ${new Date().toISOString()}\n`); } catch (_) {}
    backendLogStream = null;
  }
}

// macOS only: dodge the Chromium RootView::UpdateCursor null-deref (a browser-process
// SIGSEGV when the mouse is released OUTSIDE the window mid-drag, easy with a second
// display) by snapping off-window releases to the window edge before Chromium hit-tests
// them. The fault is upstream of our renderer so JS can't catch it; this native addon
// sits on an AppKit local event monitor. Fail-open: any miss leaves behavior as today.
function installMacMouseClamp() {
  if (process.platform !== 'darwin') return;
  try {
    const nodePath = isPackaged
      ? path.join(process.resourcesPath, 'mouseclamp', 'mouseclamp.node')
      : path.join(__dirname, 'build-staging', 'mouseclamp', process.arch, 'mouseclamp.node');
    if (!fs.existsSync(nodePath)) {
      console.log('[mouseclamp] addon not present, skipping:', nodePath);
      return;
    }
    console.log('[mouseclamp] install =>', require(nodePath).install());
  } catch (e) {
    console.log('[mouseclamp] install failed (continuing):', e && e.message);
  }
}

app.whenReady().then(async () => {
  // We made it here, so any prior update swap finished. Drop a stale updating.lock
  // (the watchdog never deletes it) so a real crash later isn't silently swallowed.
  try { fs.unlinkSync(CRASH_WATCHDOG_UPDATING_LOCK); } catch (_) {}
  // Spawn the Mac crash watchdog. Detached process; if it fails to spawn the
  // app continues normally (silent fail by design). Guards inside the
  // watchdog itself prevent false-positive relaunches.
  spawnCrashWatchdog();

  // Off-window mouse-release crash dodge (macOS). Safe to call before windows exist.
  installMacMouseClamp();

  // Cold-launch: if the OS opened us via openswarm:// (Windows/Linux it's
  // in argv; macOS fires open-url AFTER whenReady which we handle above)
  // route through forwardDeepLinkToRenderer so the URL gets stashed under
  // its correct IPC channel (auth-url vs oauth-claim).
  const initialDeepLink = extractOpenswarmUrl(process.argv);
  if (initialDeepLink) forwardDeepLinkToRenderer(initialDeepLink);

  if (process.platform === 'darwin' && !isPackaged) {
    try { app.dock.setIcon(iconPath); } catch (_) {}
  }

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = [
      'media', 'mediaKeySystem', 'protected-media-identifier',
      'geolocation', 'notifications', 'midi', 'midiSysex',
      'clipboard-read', 'clipboard-sanitized-write',
      'pointerLock', 'fullscreen', 'idle-detection',
    ];
    console.log('Permission request:', permission, '->', allowed.includes(permission) ? 'granted' : 'denied');
    callback(allowed.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    const allowed = [
      'media', 'mediaKeySystem', 'protected-media-identifier',
      'clipboard-read', 'clipboard-sanitized-write',
      'pointerLock', 'fullscreen', 'idle-detection',
    ];
    return allowed.includes(permission);
  });

  // Strip X-Frame-Options and CSP frame-ancestors directives on iframe subframe loads so the Windows BrowserCard iframe fallback (used because <webview> tag commit segfaults on Chromium 144 + this Electron 40 CastLabs build) can render sites that normally refuse to be embedded. Scoped to types:['sub_frame'] so OAuth popups, the main app frame, deep-link redirects, and DRM license fetches keep their security headers intact. urls filter limits to http/https so file:// loads of the bundled frontend are untouched.
  session.defaultSession.webRequest.onHeadersReceived(
    // Electron's webRequest type name for iframes is 'subFrame' (camelCase), not the Chrome-extension 'sub_frame' — passing the wrong name throws "Invalid type sub_frame" synchronously which becomes an unhandledRejection and prevents the app from booting.
    { urls: ['http://*/*', 'https://*/*'], types: ['subFrame'] },
    (details, callback) => {
      const headers = { ...(details.responseHeaders || {}) };
      for (const k of Object.keys(headers)) {
        const lk = k.toLowerCase();
        if (lk === 'x-frame-options') {
          delete headers[k];
        } else if (lk === 'content-security-policy' || lk === 'content-security-policy-report-only') {
          const cleaned = (headers[k] || [])
            .map((v) => v.split(';').filter((d) => !/^\s*frame-ancestors\b/i.test(d)).join(';').trim())
            .filter(Boolean);
          if (cleaned.length) headers[k] = cleaned; else delete headers[k];
        }
      }
      callback({ responseHeaders: headers });
    },
  );

  // Read-only logging for DRM license requests — no modifying interceptors
  // so the network stack can set Content-Type and other headers normally.
  session.defaultSession.webRequest.onSendHeaders(
    { urls: ['*://*/*widevine*license*'] },
    (details) => {
      console.log(`[drm-req] ${details.method} ${details.url}`);
      for (const [k, v] of Object.entries(details.requestHeaders || {})) {
        if (/content-type|origin|referer|auth|accept/i.test(k)) {
          console.log(`[drm-req]   ${k}: ${v}`);
        }
      }
    },
  );
  session.defaultSession.webRequest.onCompleted(
    { urls: ['*://*/*widevine*', '*://*/*license*'] },
    (details) => {
      console.log(`[drm-net] ${details.method} ${details.url} → ${details.statusCode}`);
    },
  );
  session.defaultSession.webRequest.onErrorOccurred(
    { urls: ['*://*/*widevine*', '*://*/*license*'] },
    (details) => {
      console.log(`[drm-net] FAILED ${details.method} ${details.url} → ${details.error}`);
    },
  );

  // Splash window opens immediately so the user sees motion within ~1s
  // of double-clicking. Without this, on a cold-Defender Windows install
  // the dock/taskbar icon flashes for 30-60s with nothing visible.
  splashWindow = createSplashWindow();
  emitSplashStatus('Starting OpenSwarm…');

  // Widevine CDM and backend startup are independent — run them
  // concurrently. Backend is the long pole on Windows (Defender + Python
  // cold start), so we don't want a slow CDM download to add seconds to
  // every boot. Webviews that need DRM still wait on `components.whenReady`
  // before loading via the existing webview-preload flow, so parallelizing
  // here is safe.
  let widevinePromise;
  if (components && typeof components.whenReady === 'function') {
    widevinePromise = components.whenReady().then(
      () => {
        console.log('Widevine CDM ready');
        if (typeof components.status === 'function') {
          console.log('CDM component status:', JSON.stringify(components.status()));
        }
      },
      (err) => { console.warn('Widevine CDM not available:', err && err.message); }
    );
  } else {
    console.log('CastLabs components API not available — using standard Electron (no DRM)');
    widevinePromise = Promise.resolve();
  }

  try {
    if (isDev) {
      backendPort = parseInt(process.env.OPENSWARM_PORT || '8324', 10);
      console.log(`Dev mode: using existing backend on port ${backendPort}`);
      emitSplashStatus('Connecting to dev backend…');
      // Load the token before marking ready, same as prod, so the workflow
      // poller's setBackend() gets a real token instead of '' (else it 401s).
      await loadAuthToken();
      markBackendReady();
    } else {
      // Kick off backend without awaiting so the window can paint while Python is still cold-starting. Renderer fetches lazy-await markBackendReady() via the get-auth-token IPC; splash status updates still fire from inside startBackend.
      backendPort = await pickBackendPort();
      const _backendBoot = startBackend().catch((err) => {
        console.error('[boot] backend startup failed:', err && err.message);
        emitSplashStatus({ text: 'Backend failed to start', level: 'error', logs: recentBackendStderr.slice(-20).join('') });
      });
    }
    // Start the embedded frontend HTTP server before createWindow so loadURL has a real port. Only relevant in packaged mode; in dev, frontend lives on webpack-dev-server :3000.
    if (!isDev) {
      try {
        await startFrontendServer();
      } catch (err) {
        console.error('[boot] frontend server failed to start, falling back to file://:', err && err.message);
      }
    }
    emitSplashStatus('Almost ready…');
    // Must run before createWindow loads the URL, or the renderer fetches the stale bundle first.
    await clearStaleFrontendCache();
    createWindow();
    if (!isDev) {
      setupAutoUpdater();
      mainWindow.webContents.on('did-finish-load', () => {
        if (cachedUpdateStatus.status === 'available') {
          sendToRenderer('update-available', cachedUpdateStatus.info);
        } else if (cachedUpdateStatus.status === 'downloaded') {
          sendToRenderer('update-downloaded', cachedUpdateStatus.info);
        }
      });
    }

    // Swap splash → main only once React has actually painted. ready-to-show
    // fires after the renderer's first frame, eliminating the white-flash
    // that would otherwise pop between splash close and React mount.
    // Also gated on backendReady: with lazy backend, ready-to-show can fire while React is still showing null (SignInGateLoader returns null until settings load), so we'd show a blank window if we swapped early.
    if (mainWindow) {
      const swapToMain = () => {
        if (mainWindowReady || mainWindow.isDestroyed()) return;
        if (!backendReady) {
          backendReadyPromise.then(() => swapToMain()).catch(() => {});
          return;
        }
        mainWindowReady = true;
        try { mainWindow.show(); mainWindow.focus(); } catch (_) {}
        // Tiny delay so the OS gets a chance to bring main to front
        // before splash disappears — avoids a single-frame "no window"
        // gap on Windows.
        setTimeout(() => {
          if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.destroy();
          }
          splashWindow = null;
        }, 120);
      };
      mainWindow.once('ready-to-show', swapToMain);
      // Fallback: if the renderer fails to load (e.g. dev server not
      // running on localhost:3000), `ready-to-show` never fires and
      // the splash would hang forever. Show main anyway so the dev
      // sees the load error in the window itself.
      mainWindow.webContents.once('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
        console.warn('[boot] mainWindow load failed:', errorCode, errorDescription, validatedURL);
        if (isDev) {
          // Force-skip the backend gate so dev sees the error.
          mainWindowReady = true;
          try { mainWindow.show(); mainWindow.focus(); } catch (_) {}
          if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
          splashWindow = null;
        }
      });
    }

    // Don't block on Widevine; it'll resolve in the background. Logged above.
    widevinePromise.catch(() => {});

    // Affiliate / referral handshake. On the very first launch, opens the
    // landing page's /welcome handler in the user's default browser so the
    // browser (which holds the install_token from the click on the
    // download CTA) can pair our app_install_id with the referral code.
    // No-op on every subsequent launch, no-op in dev unless forced. Fire
    // and forget, never blocks UI startup. See electron/affiliateTracking.js.
    affiliateTracking.maybeRunFirstLaunchHandshake({
      shell,
      userDataDir: app.getPath('userData'),
      isDev,
      isPackaged,
    }).catch((err) => {
      console.warn('[affiliate] handshake failed:', err && err.message);
    });
  } catch (err) {
    console.error('Failed to start:', err);
    // Surface the failure on the splash instead of silently quitting.
    // The user picks: view logs, restart, or quit. This eliminates the
    // class of "I clicked OpenSwarm and nothing happened" reports.
    emitSplashStatus({
      text: "OpenSwarm couldn't start: " + (err && err.message ? err.message : String(err)),
      level: 'error',
      showActions: true,
      logs: recentBackendStderr.slice(-30).join(''),
    });
    // Do NOT call app.quit() here — the user controls the next step
    // through the splash action buttons.
  }
});

app.on('web-contents-created', (_event, contents) => {
  // Override the user-agent on popup BrowserWindows (i.e. anything created
  // via window.open from the renderer, which includes the OAuth popup for
  // subscription connect flows). Electron's default UA includes an
  // `Electron/X.Y.Z` token that accounts.google.com blacklists with a
  // "browser not supported" page — and auth.openai.com is similarly picky.
  // Spoofing a current Chrome UA makes those identity providers treat the
  // popup like a real browser without changing the flow OpenSwarm uses to
  // capture the callback (window.open + postMessage).
  //
  // This check runs synchronously during `new BrowserWindow()` construction.
  // On the very first invocation (for mainWindow itself), `mainWindow` is
  // still null because assignment happens after the constructor returns,
  // so the `mainWindow &&` short-circuits and we leave the main window's
  // UA alone. Webview tags report `getType() === 'webview'` and are also
  // skipped — they render user-visited sites and must advertise the real UA.
  if (
    contents.getType() === 'window' &&
    !isCreatingMainWindow &&
    mainWindow &&
    contents !== mainWindow.webContents
  ) {
    console.log('[diag][main] spoofing UA for popup webContents id=', contents.id);
    const OAUTH_POPUP_UA = process.platform === 'win32'
      ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    contents.setUserAgent(OAUTH_POPUP_UA);
  }

  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (disposition === 'foreground-tab' || disposition === 'background-tab') {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('webview-new-window', url, contents.id);
      }
      return { action: 'deny' };
    }

    // Note on which providers still use this popup path:
    // - Anthropic/Claude: still works here with the Chrome UA override above.
    // - Google (Gemini, Antigravity): blocks embedded browsers wholesale
    //   ("browser not supported"), even with UA spoofing + sandboxed
    //   partition + navigator.webdriver patches. Routes through
    //   shell.openExternal instead.
    // - OpenAI/Codex: now also routes through shell.openExternal — the
    //   embedded popup renders blank for some users (newer embed
    //   detection + regional access checks), and the system browser
    //   surfaces the actual error.
    // See _EXTERNAL_BROWSER_PROVIDERS in backend/apps/nine_router.py.
    // When Anthropic adds the same checks, add "claude" there too.

    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent: mainWindow || undefined,
        width: 520,
        height: 680,
        center: true,
        fullscreen: false,
        fullscreenable: false,
        resizable: true,
        minimizable: false,
        maximizable: false,
      },
    };
  });

  contents.on('did-create-window', (childWindow) => {
    if (mainWindow && !mainWindow.isDestroyed() && !childWindow.isDestroyed()) {
      childWindow.setParentWindow(mainWindow);
      // Belt-and-suspenders: if the parent was fullscreen when window.open
      // fired, Electron can still spawn the child fullscreen. Force it back.
      if (childWindow.isFullScreen()) childWindow.setFullScreen(false);
    }
  });

  // OAuth callback URL interception. The npm `9router` package's /callback
  // page relays the code back via window.opener.postMessage — which
  // silently no-ops on some flows (e.g. Anthropic's Claude Code auth pages
  // that reset the opener chain across cross-origin redirects). Capturing
  // the URL at the navigation layer is format-agnostic and works regardless
  // of whether the relay via postMessage/BroadcastChannel/localStorage made
  // it back to the renderer. Same code+state then gets forwarded to the
  // main window via IPC, where Settings.tsx picks it up and calls
  // /api/agents/subscriptions/exchange.
  const forwardOauthCallback = (url) => {
    try {
      const u = new URL(url);
      const onRouter = (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
                       u.port === '20128' && u.pathname === '/callback';
      if (!onRouter) return;
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      const error = u.searchParams.get('error');
      if (!code && !error) return;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('openswarm:oauth-callback', { code, state, error });
      }
    } catch { /* not a URL we care about */ }
  };
  contents.on('did-navigate', (_e, url) => forwardOauthCallback(url));
  contents.on('did-redirect-navigation', (_e, url) => forwardOauthCallback(url));

  if (contents.getType() === 'webview') {
    contents.on('console-message', (_e, level, message, line, sourceId) => {
      const tag = ['LOG', 'INFO', 'WARN', 'ERROR'][level] || 'LOG';
      const src = sourceId ? sourceId.split('/').pop() : '';
      if (message.includes('widevine') || message.includes('drm') ||
          message.includes('license') || message.includes('MediaKeySession') ||
          message.includes('EME') || message.includes('[drm-diag]') ||
          message.includes('openswarm') ||
          level >= 2) {
        console.log(`[webview:${tag}] ${message}${src ? ` (${src}:${line})` : ''}`);
      }
      // Buffer warnings + errors so a stuck browser agent can READ why a page is
      // broken (JS exceptions, failed resource loads) via BrowserGetConsole. The
      // listener already fires for these, so this adds no forwarding; capped at 30
      // and clamped to 300 chars each so a chatty page can't bloat memory.
      if (level >= 2) {
        let buf = webviewConsoleErrors.get(contents.id);
        if (!buf) { buf = []; webviewConsoleErrors.set(contents.id, buf); }
        buf.push({ level: tag, message: String(message).slice(0, 300), source: src, line });
        if (buf.length > 30) buf.shift();
      }
    });

    // -----------------------------------------------------------------
    // CDP debugger auto-attach for browser sub-agent accessibility tree
    // -----------------------------------------------------------------
    // The browser sub-agent uses Chrome DevTools Protocol (specifically
    // Accessibility.getFullAXTree, DOM.resolveNode, Input.dispatchMouseEvent)
    // to perceive and act on hostile sites where CSS selectors fail. CDP
    // commands require webContents.debugger.attach() which is only callable
    // from the main process. We attach lazily on first use rather than at
    // creation time — that avoids the "Another debugger is already attached"
    // race when DevTools is opened on the webview.
    try {
      contents.debugger.on('detach', (_e, reason) => {
        console.log(`[cdp] detach on wcId ${contents.id}: ${reason}`);
        cdpAxIndexCache.delete(contents.id);
        // Clear stale child sessions but KEEP the map object + the wired guard:
        // the 'message' listener stays bound to wc.debugger across detach, so
        // dropping the guard here would stack a duplicate listener on reattach.
        cdpChildSessions.get(contents.id)?.clear();
      });
    } catch (e) {
      // Older Electron may not have the listener API; non-fatal.
    }

    contents.on('destroyed', () => {
      cdpAxIndexCache.delete(contents.id);
      cdpQueueByWcId.delete(contents.id);
      cdpChildSessions.delete(contents.id);
      cdpAutoAttachWired.delete(contents.id);
      cdpRoutesByWcId.delete(contents.id);
      webviewConsoleErrors.delete(contents.id);
    });

    contents.on('render-process-gone', () => {
      cdpAxIndexCache.delete(contents.id);
      cdpQueueByWcId.delete(contents.id);
      cdpChildSessions.delete(contents.id);
      cdpAutoAttachWired.delete(contents.id);
      cdpRoutesByWcId.delete(contents.id);
      webviewConsoleErrors.delete(contents.id);
    });

    // A heavy SPA can HANG the renderer without crashing it (a render-process-gone
    // never fires), leaving every CDP command to time out and the agent to abort the
    // card. Chromium flags that state as 'unresponsive'; reload once to try to un-stick
    // it instead of giving up. Rate-limited so a page that also hangs on reload can't
    // spin, and the agent's own card-gone detection still bails if reload doesn't help.
    let lastRecoveryReloadAt = 0;
    contents.on('unresponsive', () => {
      const now = Date.now();
      if (now - lastRecoveryReloadAt < 30000) return;
      lastRecoveryReloadAt = now;
      console.log(`[webview] renderer unresponsive on wcId ${contents.id}; reloading to recover`);
      try { contents.reload(); } catch { /* nothing more we can do from here */ }
    });

    // WebAuthn/passkey shim. Injected on every dom-ready in the main world
    // via executeJavaScript (which uses V8's direct evaluation path and
    // bypasses Trusted Types CSP — inline <script> injection from the
    // webview preload was being blocked on accounts.google.com because of
    // `require-trusted-types-for 'script'`). The shim overrides
    // navigator.credentials so passkey calls reject cleanly and post a
    // tagged message back; webview-preload.js listens and forwards to the
    // embedder, which surfaces the "Passkeys aren't supported" dialog.
    contents.on('dom-ready', () => {
      contents.executeJavaScript(`
        (function() {
          if (window.__openswarm_passkey_shim__) return;
          window.__openswarm_passkey_shim__ = true;
          try {
            console.warn('[openswarm:shim] main-world shim installing at', location.href);
            var notify = function(kind) {
              try { console.warn('[openswarm:shim] passkey intercepted:', kind); } catch (_) {}
              try { window.postMessage({ __openswarm__: '__openswarm_passkey__' }, '*'); } catch (_) {}
            };
            var rejected = function() {
              return Promise.reject(new DOMException(
                'OpenSwarm does not support passkeys. Please use another sign-in method.',
                'NotAllowedError'
              ));
            };
            if (navigator.credentials) {
              var origGet = navigator.credentials.get && navigator.credentials.get.bind(navigator.credentials);
              navigator.credentials.get = function(options) {
                if (options && options.publicKey) {
                  if (options.mediation !== 'conditional') notify('get:' + (options.mediation || 'default'));
                  return rejected();
                }
                return origGet ? origGet(options) : Promise.reject(new DOMException('Not supported', 'NotSupportedError'));
              };
              var origCreate = navigator.credentials.create && navigator.credentials.create.bind(navigator.credentials);
              navigator.credentials.create = function(options) {
                if (options && options.publicKey) { notify('create'); return rejected(); }
                return origCreate ? origCreate(options) : Promise.reject(new DOMException('Not supported', 'NotSupportedError'));
              };
              console.warn('[openswarm:shim] navigator.credentials patched');
            }
            if (window.PublicKeyCredential) {
              window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = function() { return Promise.resolve(false); };
              if (window.PublicKeyCredential.isConditionalMediationAvailable) {
                window.PublicKeyCredential.isConditionalMediationAvailable = function() { return Promise.resolve(false); };
              }
            }
          } catch (e) {
            try { console.warn('[openswarm:shim] error:', e && e.message); } catch (_) {}
          }
        })();
      `).catch(() => {});

      const url = contents.getURL();
      if (url.includes('spotify')) {
        contents.executeJavaScript(`
          (function() {
            const origFetch = window.fetch;
            window.fetch = async function(...args) {
              const resp = await origFetch.apply(this, args);
              const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
              if (url.includes('widevine-license') && !resp.ok) {
                const clone = resp.clone();
                try {
                  const text = await clone.text();
                  console.log('[drm-diag] License response ' + resp.status + ': ' + text.substring(0, 500));
                } catch(e) {}
              }
              return resp;
            };

            // Check EME availability
            if (navigator.requestMediaKeySystemAccess) {
              navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
                initDataTypes: ['cenc'],
                audioCapabilities: [{contentType: 'audio/mp4; codecs="mp4a.40.2"'}],
              }]).then(function(access) {
                console.log('[drm-diag] Widevine EME access: ' + access.keySystem);
              }).catch(function(err) {
                console.log('[drm-diag] Widevine EME FAILED: ' + err.message);
              });
            } else {
              console.log('[drm-diag] EME API not available');
            }
          })();
        `).catch(() => {});
      }
    });
  }
});

app.on('window-all-closed', () => {
  console.log(`[diag][main] window-all-closed (platform=${process.platform}${process.platform === 'darwin' ? ', staying alive' : ', quitting'})`);
  // macOS: stay alive like a standard Mac app. We never install a custom
  // application menu, so Electron's DEFAULT menu ships File > Close Window
  // (Cmd+W) — and with a single window, quitting here turned "close the
  // window" into "tear down the backend and every running agent". The 1.2.77
  // prod self-quits all carried this exact signature (window close with no
  // preceding before-quit). Keeping the process alive de-fangs the whole
  // class: the dock icon stays, `activate` below reopens against the warm
  // backend in ~1s, and the [diag][main] close-cause logging identifies the
  // closer. Explicit quits (Cmd+Q, dock Quit) are untouched — Electron's
  // quit pipeline runs will-quit -> killBackend regardless of this handler.
  if (process.platform === 'darwin') {
    // An update install closed the window (native quitAndInstall) and now needs the
    // process to actually die so ShipIt can swap + relaunch; finish the quit instead
    // of the keep-alive return. This is the half my first pass missed: without it the
    // window closes but the app lingers and the swap never happens.
    if (isInstallingUpdate) { app.quit(); return; }
    // A staged update with no explicit install (a teardown that skipped the 'close'
    // handler): apply it on the way out instead of re-prompting next launch.
    if (cachedUpdateStatus && cachedUpdateStatus.status === 'downloaded') {
      console.log('[updater] all windows closed with a staged update; applying it');
      installDownloadedUpdate();
    }
    return;
  }
  // Windows/Linux: quit on last window, but intentionally NOT killBackend()
  // here. before-quit POSTs /shutdown-all so the backend reaps App Builder
  // child processes (bundled node/vite, uvicorn) while it is still alive;
  // will-quit kills the backend after. Killing it here first (on Windows
  // that is taskkill /F, which skips uvicorn's graceful stop_all) orphans
  // those children, and an orphaned vite node.exe keeps a lock on its own
  // image at resources\node\x64\node.exe, blocking the next NSIS upgrade
  // with "OpenSwarm cannot be closed".
  app.quit();
});

// Ask the backend to reap every per-app subprocess (bash run.sh / vite /
// uvicorn descendants) BEFORE we SIGTERM the backend itself. SIGTERM on
// the backend PID doesn't propagate to those children, so without this
// they reparent to PID 1 and squat on the workspace's .env-pinned ports,
// breaking the NEXT launch's app reload. Fire-and-forget with a hard
// timeout so a wedged backend can't block quit indefinitely.
function postShutdownAllApps(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!backendPort) return resolve();
    const req = http.request({
      hostname: '127.0.0.1',
      port: backendPort,
      path: '/api/outputs/shutdown-all',
      method: 'POST',
      headers: authToken
        ? { 'Authorization': `Bearer ${authToken}`, 'Content-Length': 0 }
        : { 'Content-Length': 0 },
      timeout: timeoutMs,
    }, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', () => resolve());
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(); });
    req.end();
  });
}

let drainingForQuit = false;
app.on('before-quit', async (event) => {
  if (drainingForQuit) return;
  // An update install already reaped the subprocesses and is driving its own
  // quit + relaunch through Squirrel; cancelling that quit to drain again can
  // strand the relaunch, so let it pass straight through.
  if (isInstallingUpdate) return;
  event.preventDefault();
  drainingForQuit = true;
  // 10s, not 2s: stop_all() reaps runtimes in parallel but each can take up
  // to ~8s on Windows (taskkill /T /F up to 5s + a 3s SIGTERM grace). At 2s
  // the backend got hard-killed mid-reap, orphaning the vite node.exe. The
  // ceiling is only reached when an App Builder app is actually running and
  // slow to die; with none active stop_all returns instantly.
  try {
    await postShutdownAllApps(10000);
  } catch (_) {}
  // Give in-flight workflow runs up to 30s to land so we don't destroy paid LLM work.
  try {
    await workflowsLifecycle.drainOnQuit(30);
  } catch (_) {}
  app.quit();
});


app.on('will-quit', () => {
  if (!isDev) killBackend();
});

app.on('activate', () => {
  // Dock-click after close-to-dock: the common case is a HIDDEN (not
  // destroyed) window — just show it again; renderer, webviews, and agents
  // never stopped, so this is instant and lossless.
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      } else if (!mainWindow.isVisible()) {
        console.log('[diag][main] activate: showing hidden window');
        mainWindow.show();
        mainWindow.focus();
      }
    } catch (_) {}
    return;
  }
  // Destroyed-window fallback (webContents-level teardown skips the close
  // interception, and crash recovery destroys windows directly). Guards, in
  // order: any live window (incl. the boot splash) means there's nothing to
  // do; drainingForQuit blocks a dock-click mid-quit-drain from resurrecting
  // a window whose backend is being torn down; isCreatingMainWindow blocks
  // re-entrancy; backendPort gates on boot having completed (pre-boot, the
  // splash flow owns first-window creation).
  if (BrowserWindow.getAllWindows().length !== 0) return;
  // isInstallingUpdate: a close-to-update is mid-flight (windowless for a beat
  // before Squirrel quits + relaunches); don't resurrect a window it's about to tear down.
  if (drainingForQuit || isInstallingUpdate || isCreatingMainWindow || !backendPort) return;
  // recreateMainWindow, NOT bare createWindow: the window is built show:false
  // and the boot path's splash swapToMain is long gone, so the recreate
  // path's own ready-to-show -> show()/focus() is what makes it visible.
  console.log('[diag][main] activate with no window, reopening');
  recreateMainWindow();
});

// Splash window action buttons. Only meaningful while splashWindow is alive
// (during boot or in the post-failure error state). Sent via ipcRenderer.send
// from electron/splash/splash.html.
ipcMain.on('splash:action', (_event, action) => {
  if (action === 'quit') {
    isQuittingFromSplash = true;
    app.quit();
  } else if (action === 'restart') {
    // app.relaunch + app.exit is the canonical Electron restart pattern.
    // killBackend runs via the will-quit listener so the python child
    // gets cleaned up before we re-spawn ourselves.
    app.relaunch();
    app.exit(0);
  } else if (action === 'open-logs') {
    // Reveal the backend log so a user hitting a boot failure on their
    // machine can hand us the one file that names the cause. Falls back to
    // the data dir if the log was never created (e.g. spawn never reached).
    try {
      const logPath = getBackendLogPath();
      if (fs.existsSync(logPath)) {
        shell.showItemInFolder(logPath);
      } else {
        shell.openPath(path.dirname(getAuthTokenFilePath())).catch(() => {});
      }
    } catch (_) {}
  }
});

// Log every IPC handle entry so the trace shows which main-process call the renderer was making in the seconds before death.
// The CDP channels fire once PER accessibility-tree node (hundreds per page read), pure noise that buries the useful trace,
// so skip those by default; OPENSWARM_DIAG_IPC=1 brings them back when you genuinely need the firehose.
const _NOISY_IPC = new Set(['send-cdp-command', 'cdp-cache-get', 'cdp-cache-set', 'cdp-routes-get', 'cdp-child-sessions-get']);
const _DIAG_IPC_ALL = process.env.OPENSWARM_DIAG_IPC === '1';
const _origHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => {
  return _origHandle(channel, async (...args) => {
    if (_DIAG_IPC_ALL || !_NOISY_IPC.has(channel)) console.log('[diag][ipc.handle]', channel);
    try {
      return await handler(...args);
    } catch (err) {
      console.error('[diag][ipc.handle:throw]', channel, err && err.stack || err);
      throw err;
    }
  });
};

ipcMain.handle('get-backend-port', () => backendPort);
// Sync mirrors so preload.js can expose window.openswarm synchronously (no await), closing the race where React renders before the async exposure resolves and window.openswarm is briefly undefined. backendPort is assigned in app.whenReady before any BrowserWindow is created, so it is always set by the time preload runs.
ipcMain.on('get-backend-port-sync', (event) => { event.returnValue = backendPort; });
ipcMain.on('get-webview-preload-path-sync', (event) => {
  event.returnValue = `file://${path.join(__dirname, 'webview-preload.js')}`;
});
ipcMain.handle('get-auth-token', async () => {
  // Wait for backend if it's still cold-starting; this is the lazy-backend gate that lets the window open while Python is warming up.
  if (!backendReady) await backendReadyPromise;
  // Re-read the file every time. The backend rotates the token on each
  // start, and during dev hot-reload the cached value could go stale
  // while the renderer stays alive. Re-reading is cheap (small file,
  // OS caches it) and guarantees the renderer never holds a dead token.
  try {
    const p = getAuthTokenFilePath();
    const current = fs.readFileSync(p, 'utf8').trim();
    if (current) authToken = current;
  } catch (_) {}
  return authToken;
});
// Phase 0: renderer fires this once, when it renders the first streamed token
// of the first agent response. Main owns the timing log (backend.log), so the
// renderer reports the event and we stamp it against the same APP_LAUNCH_T as
// the other milestones. Idempotent via perfMark's one-shot guard.
ipcMain.on('perf:first-agent-response', () => perfMark('first-agent-response'));

ipcMain.handle('get-app-version', () => app.getVersion());
// Phase 2 provenance: the renderer's About panel shows the commit this build
// was cut from, so a screenshot is enough to identify the exact code shipped.
ipcMain.handle('get-build-info', () => getBuildInfo());
ipcMain.handle('get-webview-preload-path', () => {
  return `file://${path.join(__dirname, 'webview-preload.js')}`;
});

ipcMain.handle('get-update-status', () => cachedUpdateStatus);

// One-shot recovery info: if the crash-watchdog relaunched us, returns the
// {ts, parent_pid, uptime_ms} JSON it wrote and then DELETES the file so the
// chip only shows once. Returns null if no marker present (normal launch).
// macOS-only path; Windows/Linux always returns null.
let _cachedRecoveryInfo = undefined;
ipcMain.handle('get-crash-recovery-info', () => {
  if (process.platform !== 'darwin') return null;
  if (_cachedRecoveryInfo !== undefined) return _cachedRecoveryInfo;
  const markerPath = path.join(os.homedir(), 'Library', 'Application Support', 'openswarm', 'crash-recovery.json');
  try {
    if (!fs.existsSync(markerPath)) { _cachedRecoveryInfo = null; return null; }
    const raw = fs.readFileSync(markerPath, 'utf-8');
    _cachedRecoveryInfo = JSON.parse(raw);
    try { fs.unlinkSync(markerPath); } catch (_) {}
    return _cachedRecoveryInfo;
  } catch (_) {
    _cachedRecoveryInfo = null;
    return null;
  }
});

ipcMain.handle('check-for-updates', async () => {
  if (!autoUpdater || !isPackaged) {
    sendToRenderer('update-error', 'Update check is only available in the packaged app.');
    return { success: false, error: 'Not packaged' };
  }
  try {
    // Built-in Windows autoUpdater (Squirrel) returns nothing and reports via
    // update-available / update-not-available events, so don't expect a result.
    if (isSquirrelUpdater) {
      autoUpdater.checkForUpdates();
      return { success: true };
    }
    const result = await autoUpdater.checkForUpdates();
    if (!result) {
      sendToRenderer('update-error', 'Unable to check for updates.');
      return { success: false, error: 'No result from update check' };
    }
    return { success: true, version: result.updateInfo?.version };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('download-update', async () => {
  if (!autoUpdater) return { success: false, error: 'Updater not available' };
  // Squirrel built-in autoUpdater auto-downloads on detect; no manual trigger needed.
  if (isSquirrelUpdater) return { success: true };
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('set-allow-prerelease', async (_e, value) => {
  if (!autoUpdater) return { success: false, error: 'Updater not available' };
  // Built-in autoUpdater has no allowPrerelease; experimental channel on Windows is a TODO once we wire a separate Squirrel prerelease feed.
  if (isSquirrelUpdater) return { success: false, error: 'Experimental channel not yet supported on Windows Squirrel target' };
  const next = Boolean(value);
  if (autoUpdater.allowPrerelease === next) return { success: true, changed: false };
  autoUpdater.allowPrerelease = next;
  if (!isPackaged) return { success: true, changed: true };
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    return { success: false, changed: true, error: err?.message || String(err) };
  }
  return { success: true, changed: true };
});

// Single way to apply a downloaded update, from the Restart button OR a close-with-
// update-pending. quitAndInstall does the quit + swap + relaunch itself (the user
// never manually quits), but the install only lands once the process really dies,
// so: reap App Builder subprocesses up front, arm the watchdog lock, then flag the
// quit so before-quit lets Squirrel's relaunch through clean instead of draining it.
async function installDownloadedUpdate() {
  if (!autoUpdater || isInstallingUpdate) return;
  isInstallingUpdate = true;
  // Watchdog lock is Mac-only (the watchdog is darwin-only and the path is a Mac path).
  if (process.platform === 'darwin') {
    try {
      if (!fs.existsSync(CRASH_WATCHDOG_SUPPORT_DIR)) fs.mkdirSync(CRASH_WATCHDOG_SUPPORT_DIR, { recursive: true });
      fs.writeFileSync(CRASH_WATCHDOG_UPDATING_LOCK, '');
    } catch (_) {}
  }
  try { await postShutdownAllApps(8000); } catch (_) {}
  // Built-in autoUpdater (Windows) takes no args; electron-updater (Mac) takes (isSilent, isForceRunAfter).
  if (isSquirrelUpdater) { autoUpdater.quitAndInstall(); return; }
  autoUpdater.quitAndInstall(false, true);
  // Safety net: a healthy install terminates us in a few seconds, so this timer
  // dies with the process and never fires. It only runs if Squirrel never quit us
  // (still validating, or signature validation failed): un-stick the flag, drop the
  // lock, and either tell the user or bring a window back so we're never stranded
  // windowless-but-alive. A late quit, if it ever lands, still wins.
  setTimeout(() => {
    if (!isInstallingUpdate) return;
    isInstallingUpdate = false;
    try { fs.unlinkSync(CRASH_WATCHDOG_UPDATING_LOCK); } catch (_) {}
    if (BrowserWindow.getAllWindows().length > 0) {
      sendToRenderer('update-error', 'Update could not be installed. Please download the latest from openswarm.com.');
    } else if (backendPort && !isCreatingMainWindow) {
      try { recreateMainWindow(); } catch (_) {}
    }
  }, 30000);
}

ipcMain.handle('install-update', async () => {
  // Veto while a workflow is in flight; lifecycle poller fires the deferred install once active drains.
  try {
    const vetoed = await workflowsLifecycle.maybeVetoInstall();
    if (vetoed) return { vetoed: true };
  } catch (_) {}
  await installDownloadedUpdate();
});

ipcMain.handle('capture-page', async (event, rect) => {
  // Capturing a webContents whose GPU surface is mid-recycle (a webview navigating
  // a heavy SPA) can crash the renderer (SharedImage 'non-existent mailbox' ->
  // V8 ToLocalChecked). The caller now waits for webviews to settle, but guard
  // here too: skip a gone/crashed/loading sender and never encode an empty image,
  // returning null so the dashboard keeps its last good preview instead of dying.
  try {
    const wc = event.sender;
    if (!wc || wc.isDestroyed() || wc.isCrashed() || wc.isLoading()) return null;
    const image = await wc.capturePage(rect || undefined);
    if (!image || image.isEmpty()) return null;
    return image.toDataURL();
  } catch {
    return null;
  }
});

ipcMain.handle('open-external', (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    shell.openExternal(url);
  }
});

// Affiliate install state. Returns the persisted install.json contents so
// the renderer can attach the referral code to authenticated cloud calls
// (Stripe checkout, sign-in events) for downstream attribution.
ipcMain.handle('get-install-state', () => {
  try {
    return affiliateTracking._readState(app.getPath('userData'));
  } catch (_) {
    return {};
  }
});

// ---------------------------------------------------------------------------
// CDP debugger bridge for the browser sub-agent
// ---------------------------------------------------------------------------
// Maintains a per-webContents AX index cache (numeric index → backendNodeId)
// and serializes CDP commands per target so concurrent calls don't interleave.
// The renderer calls window.openswarm.sendCdpCommand(wcId, method, params),
// which routes through this handler to webContents.debugger.sendCommand().

const cdpAxIndexCache = new Map(); // wcId -> map of index -> {backendNodeId, sessionId}
const cdpQueueByWcId = new Map();  // wcId -> Promise (serialization tail)

// OOPIF support: cross-origin iframes are out-of-process, so their nodes never
// show up in the root frame's accessibility tree (this is the Google Docs
// "share dialog" blind spot). With flatten auto-attach we get a CDP session per
// child frame and can query + click into them. Tracks, per webContents, every
// attached child-frame session and where it sits in the frame tree.
const cdpChildSessions = new Map();   // wcId -> Map<sessionId, {frameId, parentSessionId, url}>
const cdpAutoAttachWired = new Set(); // wcIds whose 'message' listener is attached
const cdpRoutesByWcId = new Map();    // wcId -> Map<routeKey, entry> (tier-2 shadow-API capture)
const webviewConsoleErrors = new Map(); // wcId -> [{level,message,source,line}] capped warn+error, read via BrowserGetConsole

function wireChildSessions(wc) {
  const wcId = wc.id;
  if (cdpAutoAttachWired.has(wcId)) return;
  cdpAutoAttachWired.add(wcId);
  cdpChildSessions.set(wcId, new Map());
  cdpRoutesByWcId.set(wcId, new Map());
  wc.debugger.on('message', (_e, method, params, sessionId) => {
    const sessions = cdpChildSessions.get(wcId);
    if (!sessions) return;
    if (method === 'Network.requestWillBeSent') {
      // Tier-2 passive shadow-API capture: record the XHR/fetch endpoints the
      // page fires (from root or any child session) so a later task can replay
      // a safe one. Secrets are redacted inside cdp-routes.
      const routes = cdpRoutesByWcId.get(wcId);
      if (routes && params && params.request) {
        cdpRoutes.recordRoute(routes, params.request, params.type);
      }
      return;
    }
    if (method === 'Target.attachedToTarget') {
      const info = params.targetInfo || {};
      if (info.type !== 'iframe') return;
      // The event's own sessionId is the PARENT session (empty = root frame).
      sessions.set(params.sessionId, {
        frameId: info.targetId,
        parentSessionId: sessionId || null,
        url: info.url || '',
      });
      // Enable perception + network domains and propagate auto-attach into nested OOPIF.
      const sid = params.sessionId;
      wc.debugger.sendCommand('Accessibility.enable', {}, sid).catch(() => {});
      wc.debugger.sendCommand('DOM.enable', {}, sid).catch(() => {});
      wc.debugger.sendCommand('Network.enable', {}, sid).catch(() => {});
      wc.debugger.sendCommand('Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid).catch(() => {});
    } else if (method === 'Target.detachedFromTarget') {
      sessions.delete(params.sessionId);
    }
  });
}

function getWebContentsById(wcId) {
  // webContents is exposed as a top-level Electron API
  const { webContents } = require('electron');
  return webContents.fromId(wcId);
}

async function ensureDebuggerAttached(wc) {
  if (!wc || wc.isDestroyed()) {
    throw new Error('webContents is destroyed');
  }
  if (wc.debugger.isAttached()) return;
  try {
    wc.debugger.attach('1.3');
  } catch (err) {
    // Re-raise as a clean error string for the renderer.
    throw new Error(`debugger.attach failed: ${err.message || err}`);
  }
  // Auto-attach to cross-origin child frames so the agent can see/click into
  // them. Non-fatal if it fails; single-frame perception still works. Raced
  // so a dead pipe can't hang the attach path itself.
  wireChildSessions(wc);
  try {
    await raceCdp(wc.debugger.sendCommand('Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }), 5000, 'setAutoAttach');
  } catch (_) {}
  // Tier-2: record the page's own XHR/fetch endpoints as the agent drives it.
  try {
    await raceCdp(wc.debugger.sendCommand('Network.enable', {}), 5000, 'Network.enable');
  } catch (_) {}
}

// debugger.sendCommand can hang FOREVER when the target's pipe breaks without
// a detach event (renderer process swap, wedged guest). Unraced, one hung call
// poisons the per-card queue and every later command "times out" while
// navigate (non-CDP) keeps working: the exact wedge we kept chasing.
const CDP_COMMAND_TIMEOUT_MS = 10000;

function raceCdp(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function sendCdpCommandSerialized(wcId, method, params, sessionId) {
  // Chain on the per-wcId queue so concurrent renderer calls run in order.
  const prev = cdpQueueByWcId.get(wcId) || Promise.resolve();
  const next = prev
    .catch(() => {}) // never let a previous failure poison the chain
    .then(async () => {
      const wc = getWebContentsById(wcId);
      if (!wc || wc.isDestroyed()) {
        throw new Error(`webContents ${wcId} not found or destroyed`);
      }
      await ensureDebuggerAttached(wc);
      // sessionId undefined routes to the root frame; a child-frame sessionId
      // routes into that OOPIF.
      try {
        return await raceCdp(
          wc.debugger.sendCommand(method, params || {}, sessionId),
          CDP_COMMAND_TIMEOUT_MS, `CDP ${method}`,
        );
      } catch (err) {
        if (!String(err && err.message).includes('timed out after')) throw err;
        // The pipe is likely dead; recycle the attachment and retry once.
        console.log(`[cdp] ${method} hung on wcId ${wcId}; recycling debugger attachment`);
        try { wc.debugger.detach(); } catch { /* already detached */ }
        await ensureDebuggerAttached(wc);
        return await raceCdp(
          wc.debugger.sendCommand(method, params || {}, sessionId),
          CDP_COMMAND_TIMEOUT_MS, `CDP ${method} (after reattach)`,
        );
      }
    });
  cdpQueueByWcId.set(wcId, next);
  try {
    return await next;
  } finally {
    // If we're still the tail of the queue, clear it so the map doesn't grow.
    if (cdpQueueByWcId.get(wcId) === next) {
      cdpQueueByWcId.delete(wcId);
    }
  }
}

ipcMain.handle('send-cdp-command', async (_event, wcId, method, params, sessionId) => {
  try {
    const result = await sendCdpCommandSerialized(wcId, method, params, sessionId);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// Renderer-side AX index cache helpers — the renderer stores its own copy
// keyed by (browser_id, tab_id). The main process only stores per-wcId for
// invalidation purposes.
ipcMain.handle('cdp-cache-set', (_event, wcId, indexMap) => {
  cdpAxIndexCache.set(wcId, indexMap || {});
  return { ok: true };
});

ipcMain.handle('cdp-cache-get', (_event, wcId) => {
  return cdpAxIndexCache.get(wcId) || null;
});

ipcMain.handle('cdp-cache-clear', (_event, wcId) => {
  cdpAxIndexCache.delete(wcId);
  return { ok: true };
});

// Returns the attached OOPIF child-frame sessions for a webContents so the
// renderer can query their AX trees and compose click coordinates.
ipcMain.handle('cdp-child-sessions-get', (_event, wcId) => {
  const m = cdpChildSessions.get(wcId);
  if (!m) return [];
  return [...m.entries()].map(([sessionId, info]) => ({ sessionId, ...info }));
});

// Tier-2: captured shadow-API routes for a webContents, newest-busiest first,
// optionally filtered to an origin. Secrets were already redacted at capture.
ipcMain.handle('cdp-routes-get', (_event, wcId, originFilter) => {
  const m = cdpRoutesByWcId.get(wcId);
  if (!m) return [];
  let list = [...m.values()];
  if (originFilter) list = list.filter((r) => r.template.startsWith(originFilter));
  return list.sort((a, b) => b.hits - a.hits || b.lastSeen - a.lastSeen);
});

// Recent warn+error console output for one webview, so a stuck browser agent can
// see the page's own JS/network errors. Returns a shallow copy (newest last).
ipcMain.handle('get-webview-console', (_event, wcId) => (webviewConsoleErrors.get(wcId) || []).slice());

ipcMain.handle('connect-slack', async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 750,
    title: 'Sign in to Slack',
    parent: mainWindow || undefined,
    modal: false,
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:slack-auth',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Override the global window-open handler so new tabs/windows from Slack
  // (e.g. workspace redirects) navigate this popup instead of getting
  // hijacked into a dashboard browser card.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      win.loadURL(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  // Block slack:// deep-link attempts (they'd try to launch the native app
  // and fail). Slack always falls through to a web URL after the deep link
  // fails, so just swallow these.
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('slack://')) {
      event.preventDefault();
    }
  });

  try {
    await win.loadURL('https://app.slack.com/signin');
  } catch (err) {
    if (!win.isDestroyed()) win.close();
    throw new Error(`Failed to load Slack: ${err.message}`);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(pollInterval);
      clearTimeout(timeoutHandle);
      if (!win.isDestroyed()) win.close();
      fn(value);
    };

    win.on('closed', () => {
      if (!settled) {
        settled = true;
        clearInterval(pollInterval);
        clearTimeout(timeoutHandle);
        reject(new Error('Sign-in window was closed'));
      }
    });

    const pollInterval = setInterval(async () => {
      if (win.isDestroyed()) return;
      try {
        const token = await win.webContents.executeJavaScript(
          '(() => { try { return window.boot_data && window.boot_data.api_token; } catch(e) { return null; } })()'
        );
        if (typeof token === 'string' && token.startsWith('xoxc-')) {
          const cookies = await win.webContents.session.cookies.get({ url: 'https://slack.com' });
          const dCookie = cookies.find((c) => c.name === 'd');
          if (dCookie && dCookie.value) {
            // The d cookie value may or may not already include the xoxd- prefix
            // depending on how Slack encodes it. Normalize it.
            const raw = decodeURIComponent(dCookie.value);
            const cookie = raw.startsWith('xoxd-') ? raw : `xoxd-${raw}`;
            finish(resolve, { token, cookie });
          }
        }
      } catch (_) {
        // page navigating, ignore
      }
    }, 1000);

    const timeoutHandle = setTimeout(() => {
      finish(reject, new Error('Sign-in timed out after 10 minutes'));
    }, 10 * 60 * 1000);
  });
});
