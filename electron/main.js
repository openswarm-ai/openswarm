const { app, components, BrowserWindow, ipcMain, shell, session } = require('electron');
// Platform-split auto-updater: electron-updater on Mac (full-featured: allowPrerelease, allowDowngrade, progress), Electron's built-in autoUpdater on Windows (required for Squirrel.Windows target; electron-updater dropped Squirrel support).
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

// Defender warmup helper. Touches bundled exes so Windows scans them now instead of on first launch.
function _squirrelPrewarmTouch() {
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
}

// Legacy NSIS prewarm path (kept for any user still on 1.1.40 stable NSIS install).
if (process.argv.includes('--prewarm') && process.platform === 'win32') {
  _squirrelPrewarmTouch();
  process.exit(0);
}

// Squirrel hands shortcut creation to the app: when we intercept --squirrel-*
// ourselves, Update.exe won't make the Start Menu / Desktop icons unless we ask
// it to. Skip this and the user only ever sees Setup.exe, no app to click.
function _squirrelUpdate(args) {
  try {
    const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
    const exeName = path.basename(process.execPath);
    execFileSync(updateExe, [...args, exeName], { timeout: 20000, stdio: 'ignore', windowsHide: true });
  } catch (_) {}
}

// Squirrel.Windows lifecycle: app is invoked with --squirrel-* args during install/update/uninstall. Handle and exit fast; --squirrel-firstrun is the only one we let fall through to normal boot.
(function handleSquirrelEvents() {
  if (process.platform !== 'win32' || process.argv.length < 2) return;
  const sq = process.argv[1];
  if (sq === '--squirrel-install' || sq === '--squirrel-updated') {
    _squirrelUpdate(['--createShortcut']);
    _squirrelPrewarmTouch();
    process.exit(0);
  }
  if (sq === '--squirrel-uninstall') {
    _squirrelUpdate(['--removeShortcut']);
    process.exit(0);
  }
  if (sq === '--squirrel-obsolete') {
    process.exit(0);
  }
})();

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
  if (mainWindow) mainWindow.focus();
});

app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
let backendProcess = null;
let backendPort = null;
let cachedUpdateStatus = { status: 'idle', info: null, error: null };

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

const isPackaged = app.isPackaged;
const isDev = process.env.ELECTRON_DEV === '1';
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
  const preferred = getPort({ port: getPort.makeRange(8324, 8424) });
  let timeoutHandle;
  const timeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve(null), PREFERRED_TIMEOUT_MS);
  });
  const winner = await Promise.race([preferred, timeout]);
  clearTimeout(timeoutHandle);
  if (winner !== null) return winner;
  console.warn(`[boot] getPort.makeRange(8324,8424) stalled past ${PREFERRED_TIMEOUT_MS}ms — falling back to OS-assigned port`);
  return await getPort({ port: 0 });
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

  console.log(`Starting backend: ${pythonPath} on port ${backendPort}`);
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
  console.log(`Backend ready on port ${backendPort}`);

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
    },
  });

  if (isDev) {
    mainWindow.loadURL(`http://localhost:3000`);
  } else {
    const frontendPath = getResourcePath('frontend', 'index.html');
    mainWindow.loadFile(frontendPath);
  }

  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    webPreferences.plugins = true;
    webPreferences.enableBlinkFeatures = 'EncryptedMedia';
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

  // Once the renderer has loaded, flush any deep-link URL we captured before
  // the window existed (cold-launch via openswarm://). pendingDeepLink may
  // be a string (legacy) OR a {channel, url} object (v1.0.26+ OAuth claims).
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingDeepLink) {
      if (typeof pendingDeepLink === 'string') {
        mainWindow.webContents.send('openswarm:auth-url', pendingDeepLink);
      } else {
        mainWindow.webContents.send(pendingDeepLink.channel, pendingDeepLink.url);
      }
      pendingDeepLink = null;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Renderer process death (GPU/native/OOM crash) is invisible to React error
  // boundaries: the whole content process is gone, so JS never runs to catch
  // anything. Without this the window just sits blank forever. Reload to
  // recover, but cap retries so a deterministic crash-on-load can't pin the CPU
  // in an infinite reload storm; after the cap we leave it so the splash/quit
  // path can take over rather than thrash.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const reason = details && details.reason;
    if (reason === 'clean-exit') return;
    // Don't fight the shutdown: the renderer dying mid-quit-drain is expected, reloading it then would resurrect a window we're trying to close.
    if (drainingForQuit) return;
    console.error('[main] renderer process gone:', reason);
    const now = Date.now();
    rendererCrashTimes = rendererCrashTimes.filter((t) => now - t < 60_000);
    if (rendererCrashTimes.length >= 3) {
      console.error('[main] renderer crashed 3x in 60s — not auto-reloading again');
      return;
    }
    rendererCrashTimes.push(now);
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    } catch (_) {}
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
}

function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function setupAutoUpdater() {
  if (!autoUpdater) return;
  if (isSquirrelUpdater) {
    // Squirrel.Windows: setFeedURL to GH Releases /latest/download/ so Squirrel fetches RELEASES from there. allowPrerelease/allowDowngrade not supported by built-in autoUpdater; experimental users on Windows get only the latest stable until we wire a separate Squirrel feed for prereleases.
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

  autoUpdater.on('update-available', (info) => {
    console.log(`Update available: ${info.version}`);
    cachedUpdateStatus = { status: 'available', info, error: null };
    sendToRenderer('update-available', info);
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('App is up to date');
    cachedUpdateStatus = { status: 'not-available', info, error: null };
    sendToRenderer('update-not-available', info);
  });

  autoUpdater.on('download-progress', (progress) => {
    cachedUpdateStatus = { status: 'downloading', info: progress, error: null };
    sendToRenderer('download-progress', progress);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`Update downloaded: ${info.version}`);
    cachedUpdateStatus = { status: 'downloaded', info, error: null };
    sendToRenderer('update-downloaded', info);
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err);
    cachedUpdateStatus = { status: 'error', info: null, error: err?.message || String(err) };
    sendToRenderer('update-error', err?.message || String(err));
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.log('Update check skipped:', err.message);
  });

  // Always-on users (lid never closes) miss the once-at-startup check
  // above. Re-check every 4h; coalesces if a download is already cached.
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.log('Periodic update check failed:', err.message);
    });
  }, 4 * 60 * 60 * 1000);
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
}

app.whenReady().then(async () => {
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
      markBackendReady();
    } else {
      // Kick off backend without awaiting so the window can paint while Python is still cold-starting. Renderer fetches lazy-await markBackendReady() via the get-auth-token IPC; splash status updates still fire from inside startBackend.
      backendPort = await pickBackendPort();
      const _backendBoot = startBackend().catch((err) => {
        console.error('[boot] backend startup failed:', err && err.message);
        emitSplashStatus({ text: 'Backend failed to start', level: 'error', logs: recentBackendStderr.slice(-20).join('') });
      });
    }
    emitSplashStatus('Almost ready…');
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
    mainWindow &&
    contents !== mainWindow.webContents
  ) {
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
      if (message.includes('widevine') || message.includes('drm') ||
          message.includes('license') || message.includes('MediaKeySession') ||
          message.includes('EME') || message.includes('[drm-diag]') ||
          message.includes('openswarm') ||
          level >= 2) {
        const tag = ['LOG', 'INFO', 'WARN', 'ERROR'][level] || 'LOG';
        const src = sourceId ? sourceId.split('/').pop() : '';
        console.log(`[webview:${tag}] ${message}${src ? ` (${src}:${line})` : ''}`);
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
      });
    } catch (e) {
      // Older Electron may not have the listener API; non-fatal.
    }

    contents.on('destroyed', () => {
      cdpAxIndexCache.delete(contents.id);
      cdpQueueByWcId.delete(contents.id);
    });

    contents.on('render-process-gone', () => {
      cdpAxIndexCache.delete(contents.id);
      cdpQueueByWcId.delete(contents.id);
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
  if (!isDev) killBackend();
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
  event.preventDefault();
  drainingForQuit = true;
  try {
    await postShutdownAllApps(2000);
  } catch (_) {}
  app.quit();
});


app.on('will-quit', () => {
  if (!isDev) killBackend();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && backendPort) {
    createWindow();
  }
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
    // No backend log file is written to disk today; the next-best thing
    // is opening the OpenSwarm data dir, where the user can see the
    // auth.token file and any future log artifacts. Surfacing the dir
    // also lets advanced users self-serve (clear data, etc).
    try {
      const dataDir = path.dirname(getAuthTokenFilePath());
      shell.openPath(dataDir).catch(() => {});
    } catch (_) {}
  }
});

ipcMain.handle('get-backend-port', () => backendPort);
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
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('get-webview-preload-path', () => {
  return `file://${path.join(__dirname, 'webview-preload.js')}`;
});

ipcMain.handle('get-update-status', () => cachedUpdateStatus);

ipcMain.handle('check-for-updates', async () => {
  if (!autoUpdater || !isPackaged) {
    sendToRenderer('update-error', 'Update check is only available in the packaged app.');
    return { success: false, error: 'Not packaged' };
  }
  try {
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
  // Squirrel built-in autoUpdater has no allowPrerelease; experimental channel on Windows is a TODO once we wire a separate Squirrel feed URL.
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

ipcMain.handle('install-update', () => {
  if (!autoUpdater) return;
  // Built-in autoUpdater on Windows takes no args; electron-updater on Mac takes (isSilent, isForceRunAfter).
  if (isSquirrelUpdater) {
    autoUpdater.quitAndInstall();
  } else {
    autoUpdater.quitAndInstall(false, true);
  }
});

ipcMain.handle('capture-page', async (event, rect) => {
  const image = await event.sender.capturePage(rect || undefined);
  return image.toDataURL();
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

const cdpAxIndexCache = new Map(); // wcId -> Map<index, backendNodeId>
const cdpQueueByWcId = new Map();  // wcId -> Promise (serialization tail)

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
}

async function sendCdpCommandSerialized(wcId, method, params) {
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
      return await wc.debugger.sendCommand(method, params || {});
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

ipcMain.handle('send-cdp-command', async (_event, wcId, method, params) => {
  try {
    const result = await sendCdpCommandSerialized(wcId, method, params);
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
