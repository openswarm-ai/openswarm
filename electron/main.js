const { app, components, BrowserWindow, ipcMain, shell, session } = require('electron');
let autoUpdater;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) {}
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const getPort = require('get-port');
const http = require('http');
const affiliateTracking = require('./affiliateTracking');
const tray = require('./tray');
const workflowsLifecycle = require('./workflowsLifecycle');

// openswarm:// protocol must register synchronously at top of main.js, before gotLock branching.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('openswarm', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('openswarm');
}

let pendingDeepLink = null;

function forwardDeepLinkToRenderer(url) {
  if (!url) return;
  // openswarm:// splits by host: "auth" = subscription token, "oauth/{p}/complete" = OAuth claim.
  let channel = 'openswarm:auth-url';
  try {
    const u = new URL(url);
    if (u.host === 'oauth' && u.pathname.endsWith('/complete')) {
      channel = 'openswarm:oauth-claim';
    }
  } catch (_) {}
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send(channel, url);
  } else {
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
    // Windows/Linux: openswarm:// click re-launches the app with the URL as argv.
    const url = extractOpenswarmUrl(argv);
    if (url) forwardDeepLinkToRenderer(url);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// macOS-only: openswarm:// clicks fire this event instead of relaunching the process.
app.on('open-url', (event, url) => {
  event.preventDefault();
  forwardDeepLinkToRenderer(url);
  if (mainWindow) mainWindow.focus();
});

// Windows AppUserModelID: required so native toast notifications fire
// instead of falling back to legacy balloon tips. Must be set BEFORE the
// first Notification is created. electron-builder also injects this at
// install time but setting it here defends against ad-hoc dev runs.
if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.openswarm.app'); } catch (_) {}
}
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
let backendProcess = null;
let backendPort = null;
let cachedUpdateStatus = { status: 'idle', info: null, error: null };

let splashWindow = null;
let mainWindowReady = false;
let isQuittingFromSplash = false;
const recentBackendStderr = [];
let splashDataUrlCache = null;

const isPackaged = app.isPackaged;
const isDev = process.env.ELECTRON_DEV === '1';
const iconPath = process.platform === 'win32'
  ? path.join(__dirname, 'build', 'icon.ico')
  : path.join(__dirname, 'build', 'icon.png');
// build/ is electron-builder input, not in the asar; splash uses splash/icon.png.
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
    skipTaskbar: true,
    show: true,
    center: true,
    backgroundColor: '#0a0a10',  // opaque to dodge Windows DWM transparency quirks
    title: 'OpenSwarm',
    icon: iconPath,
    webPreferences: {
      // Splash is fully self-contained (data URL), so nodeIntegration is safe.
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  w.setMenuBarVisibility(false);
  w.loadURL(dataUrl);
  // Splash close before main window means user bailed; quit so backend doesn't leak.
  w.on('closed', () => {
    splashWindow = null;
    if (!mainWindowReady && !isQuittingFromSplash) {
      isQuittingFromSplash = true;
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

function osStillStartingText() {
  if (process.platform === 'win32') {
    return 'Still starting, Windows Defender is scanning files (first launch only)…';
  }
  if (process.platform === 'darwin') {
    return 'Still starting, macOS is verifying the bundle (first launch only)…';
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

/** Resolves the user's real PATH; macOS GUI apps inherit only launchd's minimal PATH. */
function getShellPath() {
  if (process.platform !== 'darwin' || isDev) return process.env.PATH || '';

  try {
    const userShell = process.env.SHELL || '/bin/zsh';
    const result = execFileSync(userShell, ['-ilc', 'echo $PATH'], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, HOME: os.homedir() },
    });
    const resolved = result.trim();
    if (resolved) return resolved;
  } catch (_) {}

  const systemPaths = [];
  try {
    const base = fs.readFileSync('/etc/paths', 'utf8');
    for (const line of base.split('\n')) {
      const p = line.trim();
      if (p) systemPaths.push(p);
    }
  } catch (_) {}
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
  } catch (_) {}

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
  } catch (_) {}

  const seen = new Set();
  const dirs = [];
  for (const d of [...fallbackDirs, ...systemPaths, ...(process.env.PATH || '').split(':')]) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    try { if (fs.statSync(d).isDirectory()) dirs.push(d); } catch {}
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
  // macOS uses Python.app/Contents/MacOS/python3 so LSUIElement suppresses the Dock entry.
  if (isPackaged) {
    const envPath = path.join(process.resourcesPath, 'python-env');
    if (process.platform === 'win32') {
      return path.join(envPath, 'python.exe');
    }
    if (process.platform === 'darwin') {
      const wrapped = path.join(envPath, 'Python.app', 'Contents', 'MacOS', 'python3');
      if (fs.existsSync(wrapped)) return wrapped;
    }
    return path.join(envPath, 'bin', 'python3');
  }
  if (process.platform === 'win32') {
    return path.join(__dirname, '..', 'backend', '.venv', 'Scripts', 'python.exe');
  }
  return path.join(__dirname, '..', 'backend', '.venv', 'bin', 'python3');
}

// Both arches staged to avoid per-arch beforePack hooks.
function getBundledNodePath() {
  if (!isPackaged) return null;
  const arch = process.arch === 'x64' ? 'x64' : (process.arch === 'arm64' ? 'arm64' : null);
  if (!arch) return null;
  const candidate = process.platform === 'win32'
    ? path.join(process.resourcesPath, 'node', arch, 'node.exe')
    : path.join(process.resourcesPath, 'node', arch, 'bin', 'node');
  return fs.existsSync(candidate) ? candidate : null;
}

// Never wall-clock times out: cold-Defender Windows can take minutes.
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
        // code === null = we killed it ourselves (normal shutdown).
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

// Windows EDR stalls each bind probe; if we don't get a preferred port in 3s, fall back to OS-assigned.
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
  console.warn(`[boot] getPort.makeRange(8324,8424) stalled past ${PREFERRED_TIMEOUT_MS}ms, falling back to OS-assigned port`);
  return await getPort({ port: 0 });
}

async function startBackend() {
  backendPort = await pickBackendPort();

  const pythonPath = getPythonPath();
  const backendDir = getResourcePath('backend');
  const projectRoot = isPackaged ? process.resourcesPath : path.join(__dirname, '..');

  const shellPath = getShellPath();

  let installMethod = process.env.OPENSWARM_INSTALL_METHOD;
  if (!installMethod) {
    if (!isPackaged) {
      installMethod = 'dev';
    } else if (process.platform === 'darwin') {
      installMethod = 'dmg';
    } else if (process.platform === 'win32') {
      installMethod = 'windows-setup';
    } else if (process.platform === 'linux') {
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
    // Asar-relative reads fail in packaged builds, inject app version instead.
    OPENSWARM_APP_VERSION: app.getVersion(),
    // Python's stdlib locale/tz are unreliable cross-OS, inject canonical BCP 47 + IANA.
    OPENSWARM_LOCALE: app.getLocale(),
    OPENSWARM_TIMEZONE: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    PYTHONDONTWRITEBYTECODE: '1',
    // PEP 540: force open() to UTF-8 on Windows (cp1252 otherwise).
    PYTHONUTF8: '1',
  };

  // Bundled node avoids a second Dock entry on fresh Macs and ~5-15s cold-start tail vs ELECTRON_RUN_AS_NODE.
  const bundledNode = getBundledNodePath();
  if (bundledNode) {
    env.OPENSWARM_NODE_PATH = bundledNode;
  }

  if (isPackaged) {
    // Windows site-packages lives under Lib/, not lib/python3.13/.
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
    if (text.indexOf('Application startup complete') !== -1) {
      emitSplashStatus('Loading components…');
    }
  });

  backendProcess.stderr.on('data', (data) => {
    const text = data.toString();
    process.stderr.write(`[backend] ${text}`);
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

  await loadAuthToken();

  // Tray must stay resident so schedules survive window close.
  try {
    tray.setup({ backendPort, authToken });
    workflowsLifecycle.setBackend({ port: backendPort, token: authToken });
    workflowsLifecycle.setActiveChangeListener((active) => {
      const title = active.length ? (active[0].title || 'workflow') : null;
      tray.setStatus({ activeTitle: title, paused: false });
    });
    workflowsLifecycle.startPolling();
  } catch (e) {
    console.warn('[tray] setup failed:', e?.message || e);
  }
}

// Per-install bearer token; mirrors backend/config/paths.py.
let authToken = '';


function getAuthTokenFilePath() {
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
  return path.join(__dirname, '..', 'backend', 'data', 'auth.token');
}

async function loadAuthToken() {
  const tokenPath = getAuthTokenFilePath();
  // 20 * 100ms = 2s retry budget; backend writes the token before HTTP bind, so first-try almost always.
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
  console.warn(`[auth] FAILED to load auth token from ${tokenPath} after 2s, WS/HTTP will be rejected`);
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
    // Hidden until ready-to-show so the splash-to-main swap doesn't white-flash.
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
    // Setting preload from React races contextBridge.expose and ends up empty, so force-attach here.
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

  // Flush any cold-launch deep link captured before the window existed.
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

  // Throttle to 1 per 2s per direction; window drags otherwise spam blur/focus.
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
  // Download on detect, install on quit: OS can't replace a running .app/.exe.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Renderer pushes the user's experimental-updates setting via IPC right after settings load.
  autoUpdater.allowPrerelease = false;

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

  // Always-on users (lid never closed) miss the once-at-startup check, so re-check every 4h.
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
      // child.kill() leaves grandchildren orphaned; taskkill /T /F walks the tree.
      try {
        require('child_process').execFileSync(
          'taskkill', ['/PID', String(backendProcess.pid), '/T', '/F'],
          { stdio: 'ignore' },
        );
      } catch (_) {
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
  // Cold-launch openswarm:// arrives in argv on Windows/Linux (macOS uses open-url instead).
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

  // Read-only logging; modifying interceptors break Widevine header set-up.
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

  splashWindow = createSplashWindow();
  emitSplashStatus('Starting OpenSwarm…');

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
    console.log('CastLabs components API not available, using standard Electron (no DRM)');
    widevinePromise = Promise.resolve();
  }

  try {
    if (isDev) {
      backendPort = parseInt(process.env.OPENSWARM_PORT || '8324', 10);
      console.log(`Dev mode: using existing backend on port ${backendPort}`);
      emitSplashStatus('Connecting to dev backend…');
    } else {
      await startBackend();
    }
    emitSplashStatus('Almost ready…');
    // Hidden-launch: --hidden arg (set by workflowsLifecycle.setLoginItem
    // on Windows + Linux; macOS uses openAsHidden) means skip the main
    // window so tray + scheduler run in background. User enabled
    // "Always-on" -> app boots invisibly.
    const launchedHidden = process.argv.includes('--hidden');
    if (!launchedHidden) {
      createWindow();
    } else if (splashWindow && !splashWindow.isDestroyed()) {
      isQuittingFromSplash = false;
      try { splashWindow.destroy(); } catch (_) {}
      splashWindow = null;
    }
    if (!isDev) {
      setupAutoUpdater();
      if (mainWindow) mainWindow.webContents.on('did-finish-load', () => {
        if (cachedUpdateStatus.status === 'available') {
          sendToRenderer('update-available', cachedUpdateStatus.info);
        } else if (cachedUpdateStatus.status === 'downloaded') {
          sendToRenderer('update-downloaded', cachedUpdateStatus.info);
        }
      });
    }

    // Swap on ready-to-show (post-first-paint); avoids white-flash on mount.
    if (mainWindow) {
      const swapToMain = () => {
        if (mainWindowReady || mainWindow.isDestroyed()) return;
        mainWindowReady = true;
        try { mainWindow.show(); mainWindow.focus(); } catch (_) {}
        // 120ms gap lets the OS raise main before splash hides; avoids a single-frame gap on Windows.
        setTimeout(() => {
          if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.destroy();
          }
          splashWindow = null;
        }, 120);
      };
      mainWindow.once('ready-to-show', swapToMain);
      // ready-to-show never fires if renderer load fails (dev server down); swap anyway so error is visible.
      mainWindow.webContents.once('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
        console.warn('[boot] mainWindow load failed:', errorCode, errorDescription, validatedURL);
        if (isDev) swapToMain();
      });
    }

    widevinePromise.catch(() => {});

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
    // Do NOT app.quit(); user picks the next step from the splash actions.
    emitSplashStatus({
      text: "OpenSwarm couldn't start: " + (err && err.message ? err.message : String(err)),
      level: 'error',
      showActions: true,
      logs: recentBackendStderr.slice(-30).join(''),
    });
  }
});

app.on('web-contents-created', (_event, contents) => {
  // Google/OpenAI auth pages blacklist Electron UA, so spoof Chrome on popups.
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

    // Anthropic still works here; Google/OpenAI route via shell.openExternal (see _EXTERNAL_BROWSER_PROVIDERS).
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
      // Electron can spawn child fullscreen if parent was; force out.
      if (childWindow.isFullScreen()) childWindow.setFullScreen(false);
    }
  });

  // postMessage relay fails on cross-origin redirects, intercept at the navigation layer.
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
    } catch {}
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

    // Lazy attach avoids races with DevTools.
    try {
      contents.debugger.on('detach', (_e, reason) => {
        console.log(`[cdp] detach on wcId ${contents.id}: ${reason}`);
        cdpAxIndexCache.delete(contents.id);
      });
    } catch (e) {}

    contents.on('destroyed', () => {
      cdpAxIndexCache.delete(contents.id);
      cdpQueueByWcId.delete(contents.id);
    });

    contents.on('render-process-gone', () => {
      cdpAxIndexCache.delete(contents.id);
      cdpQueueByWcId.delete(contents.id);
    });

    // Inject on dom-ready in main world; bypasses Trusted Types CSP that blocks inline <script>.
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
  // Scheduler must keep firing after windows close; quit only if tray init failed.
  if (tray.isEnabled()) return;
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
    // Drain in-flight workflow runs (up to 30s) so we don't destroy paid LLM work.
    const active = await workflowsLifecycle.getActive();
    if (active && active.length > 0) {
      tray.setStatus({ activeTitle: active[0]?.title || 'workflow', paused: false });
      await workflowsLifecycle.drainOnQuit(30);
    }
  } catch (_) {}
  try {
    await postShutdownAllApps(2000);
  } catch (_) {}
  app.quit();
});

app.on('will-quit', () => {
  workflowsLifecycle.stopPolling();
  tray.destroy();
  if (!isDev) killBackend();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && backendPort) {
    createWindow();
  }
});

ipcMain.on('splash:action', (_event, action) => {
  if (action === 'quit') {
    isQuittingFromSplash = true;
    app.quit();
  } else if (action === 'restart') {
    app.relaunch();
    app.exit(0);
  } else if (action === 'open-logs') {
    try {
      const dataDir = path.dirname(getAuthTokenFilePath());
      shell.openPath(dataDir).catch(() => {});
    } catch (_) {}
  }
});

ipcMain.handle('get-backend-port', () => backendPort);
ipcMain.handle('get-auth-token', () => {
  // Backend rotates token per start; cached value goes stale across dev hot-reload.
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

ipcMain.handle('workflows:get-app-open-info', () => ({
  alwaysOn: workflowsLifecycle.getLoginItem() && tray.isEnabled(),
  loginAtLaunch: workflowsLifecycle.getLoginItem(),
  trayEnabled: tray.isEnabled(),
}));
ipcMain.handle('workflows:set-login-item', (_e, value) => workflowsLifecycle.setLoginItem(Boolean(value)));
ipcMain.handle('workflows:get-active', () => workflowsLifecycle.getActive());
ipcMain.handle('workflows:notify', (_e, payload) => {
  workflowsLifecycle.showNativeNotification(payload || {});
  return true;
});

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
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('set-allow-prerelease', async (_e, value) => {
  if (!autoUpdater) return { success: false, error: 'Updater not available' };
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

ipcMain.handle('install-update', async () => {
  if (!autoUpdater) return { installed: false, queued: false };
  // Veto while workflow is in flight; lifecycle poller fires deferred install once active drains.
  const vetoEnabled = process.env.OPENSWARM_UPDATER_VETO !== '0';
  if (vetoEnabled) {
    try {
      const vetoed = await workflowsLifecycle.maybeVetoInstall();
      if (vetoed) {
        sendToRenderer('update-queued', { reason: 'workflow_active' });
        return { installed: false, queued: true };
      }
    } catch (_) {}
  }
  autoUpdater.quitAndInstall(false, true);
  return { installed: true, queued: false };
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

ipcMain.handle('get-install-state', () => {
  try {
    return affiliateTracking._readState(app.getPath('userData'));
  } catch (_) {
    return {};
  }
});

const cdpAxIndexCache = new Map();
const cdpQueueByWcId = new Map();

function getWebContentsById(wcId) {
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
    throw new Error(`debugger.attach failed: ${err.message || err}`);
  }
}

async function sendCdpCommandSerialized(wcId, method, params) {
  const prev = cdpQueueByWcId.get(wcId) || Promise.resolve();
  const next = prev
    .catch(() => {})
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

  // Re-navigate popup instead of routing to dashboard browser cards.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      win.loadURL(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  // slack:// tries to launch the native app; swallow it so Slack falls through to a web URL.
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
            // Slack may or may not pre-prefix the d cookie with xoxd-, normalize.
            const raw = decodeURIComponent(dCookie.value);
            const cookie = raw.startsWith('xoxd-') ? raw : `xoxd-${raw}`;
            finish(resolve, { token, cookie });
          }
        }
      } catch (_) {}
    }, 1000);

    const timeoutHandle = setTimeout(() => {
      finish(reject, new Error('Sign-in timed out after 10 minutes'));
    }, 10 * 60 * 1000);
  });
});

function normalizeEnvRecord(mcpEnv) {
  const extra = {};
  if (mcpEnv && typeof mcpEnv === 'object' && !Array.isArray(mcpEnv)) {
    for (const [k, v] of Object.entries(mcpEnv)) {
      if (v !== undefined && v !== null) extra[k] = String(v);
    }
  }
  return extra;
}

// instagram-connect: opens an in-app browser window pointed at instagram.com,
// polls for the sessionid cookie, then hands them to instagram-mcp-buddy's
// `validate-credentials --from-browser` subcommand which builds an instagrapi
// session and saves it to the keychain + platformdirs session.json.
// User never sees a terminal, never types a password, never types 2FA.
ipcMain.handle('instagram-connect', async (_event, payload) => {
  const toolId = (payload && payload.toolId) || '';
  if (!toolId) {
    return { ok: false, error: 'instagram-connect: missing toolId from caller' };
  }

  const win = new BrowserWindow({
    width: 480,
    height: 700,
    title: 'Sign in to Instagram',
    parent: mainWindow || undefined,
    modal: false,
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:instagram-auth',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  try {
    await win.loadURL('https://www.instagram.com/accounts/login/');
  } catch (err) {
    if (!win.isDestroyed()) win.close();
    return { ok: false, error: `Failed to load Instagram: ${err.message}` };
  }

  // POST cookies to the backend /credentials/instagram/from_browser endpoint.
  // The backend uses instagrapi to build a session, writes a trypeggy-compatible
  // session file, and persists tool.credentials + auth_status='connected'.
  const callBackend = (body) => new Promise((res) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port: backendPort || 8324,
      path: '/api/tools/credentials/instagram/from_browser',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'Authorization': `Bearer ${authToken || ''}`,
      },
      timeout: 60000,
    }, (resp) => {
      let chunks = '';
      resp.on('data', (c) => { chunks += c; });
      resp.on('end', () => {
        try {
          res(JSON.parse(chunks));
        } catch (_) {
          res({ ok: false, error: `backend non-JSON response (${resp.statusCode}): ${chunks.slice(0, 200)}` });
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('backend call timed out after 60s')); });
    req.on('error', (e) => { res({ ok: false, error: `backend call failed: ${e.message}` }); });
    req.write(data);
    req.end();
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearInterval(browserPoll);
      clearTimeout(timeoutHandle);
      if (!win.isDestroyed()) win.close();
      resolve(value);
    };

    win.on('closed', () => { if (!settled) finish({ ok: false, error: 'Sign-in window was closed' }); });

    const browserPoll = setInterval(async () => {
      if (win.isDestroyed() || settled) return;
      try {
        const cookies = await win.webContents.session.cookies.get({ domain: '.instagram.com' });
        const sessionid = (cookies.find(c => c.name === 'sessionid') || {}).value;
        const dsUserId = (cookies.find(c => c.name === 'ds_user_id') || {}).value;
        if (!sessionid || !dsUserId) return;

        clearInterval(browserPoll);
        const cookieDict = {};
        for (const c of cookies) cookieDict[c.name] = c.value;

        console.log(`[ig-connect] cookies acquired; calling backend from_browser for tool ${toolId}`);
        const result = await callBackend({
          tool_id: toolId,
          sessionid,
          ds_user_id: dsUserId,
          cookies: cookieDict,
        });
        if (!result.ok) { finish(result); return; }
        finish({ ok: true, username: result.username || dsUserId, user_id: result.user_id });
      } catch (_) { /* transient cookie read, retry next tick */ }
    }, 1500);

    const timeoutHandle = setTimeout(() => {
      finish({ ok: false, error: 'Sign-in timed out after 10 minutes' });
    }, 10 * 60 * 1000);
  });
});

// Full-auth upgrade handler (password + 2FA) disabled while trusted-notification
// polling is unimplemented. Connect uses browser cookies only — see above.
/*
ipcMain.handle('instagram-upgrade-session', async (_event, payload) => {
  const PYTHON = '/usr/local/bin/python3.11';
  return new Promise((res) => {
    const py = spawn(PYTHON, ['-m', 'instagram_mcp_buddy', 'validate-credentials'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '', pyErr = '';
    py.stdout.on('data', d => { out += d; });
    py.stderr.on('data', d => { pyErr += d; });
    py.stdin.write(JSON.stringify(payload));
    py.stdin.end();
    py.on('close', exitCode => {
      const lastLine = out.trim().split('\n').pop() || '';
      try {
        res(JSON.parse(lastLine));
      } catch (_) {
        res({ ok: false, error: exitCode !== 0 ? (pyErr.slice(0, 300) || 'validate-credentials failed') : 'invalid JSON' });
      }
    });
  });
});
*/

ipcMain.handle('instagram-logout', async (_event, _mcpEnv) => {
  try {
    const pyLines = [
      'import keyring',
      'from pathlib import Path',
      'from platformdirs import user_data_dir',
      "username = keyring.get_password('instagram-mcp-buddy', 'active_username')",
      'if username:',
      "    try: keyring.delete_password('instagram-mcp-buddy', f'password:{username}')",
      '    except Exception: pass',
      "    try: keyring.delete_password('instagram-mcp-buddy', 'active_username')",
      '    except Exception: pass',
      "session_file = Path(user_data_dir('instagram-mcp-buddy')) / 'session.json'",
      'if session_file.exists(): session_file.unlink()',
      'print("{\\\"ok\\\": true}")',
    ];
    await new Promise((resolve, reject) => {
      const py = spawn('/usr/local/bin/python3.11', ['-c', pyLines.join('\n')], { windowsHide: true });
      py.on('close', code => code === 0 ? resolve() : reject(new Error('logout failed')));
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// LinkedIn connect/logout via stickerdaniel/linkedin-mcp-server (PyPI: linkedin-scraper-mcp).
// The MCP server reads a Patchright persistent browser profile at ~/.linkedin-mcp/profile/.
// We open an embedded Electron BrowserWindow at linkedin.com/login (same UX as the
// Instagram flow), poll for the li_at cookie, then inject the harvested cookies into
// the Patchright profile via a Python helper. Cookies without an expires timestamp
// are treated as session cookies by Chromium and wiped on context close, so we
// stamp a 1-year default on anything missing one before injection.
// Why path probing for uv/uvx: Electron launched from Finder on macOS inherits
// /usr/bin:/bin only, not the user's shell PATH where uv/uvx typically lives.
function resolveBin(name) {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return name;
}

const LINKEDIN_PROFILE_DIR = path.join(os.homedir(), '.linkedin-mcp', 'profile');

// The linkedin-scraper-mcp server's _auth_ready() check requires THREE things
// in ~/.linkedin-mcp/, not just the Patchright profile/Cookies db. If any are
// missing it quarantines the profile to invalid-state-<timestamp>/ and auto
// re-runs --login (which would pop an external Chromium). We satisfy all three:
//   1. ~/.linkedin-mcp/profile/                  (via add_cookies)
//   2. ~/.linkedin-mcp/cookies.json              (portable JSON export)
//   3. ~/.linkedin-mcp/source-state.json         (SourceState dataclass schema)
// See stickerdaniel/linkedin-mcp-server/session_state.py for the schema.
const LINKEDIN_INJECT_SCRIPT = `
import asyncio, json, sys, platform, uuid
from datetime import datetime, timezone
from pathlib import Path

async def main():
    from patchright.async_api import async_playwright
    raw = sys.stdin.read()
    payload = json.loads(raw)
    cookies = payload["cookies"]
    profile_dir = Path(payload["profile_dir"]).expanduser().resolve()
    profile_dir.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=str(profile_dir),
            headless=True,
        )
        await ctx.add_cookies(cookies)
        all_cookies = await ctx.cookies()
        linkedin_cookies = [c for c in all_cookies if "linkedin.com" in c.get("domain", "")]
        await ctx.close()

    auth_root = profile_dir.parent
    auth_root.mkdir(parents=True, exist_ok=True)

    cookies_path = auth_root / "cookies.json"
    cookies_path.write_text(json.dumps(linkedin_cookies, indent=2))
    try: cookies_path.chmod(0o600)
    except Exception: pass

    os_map = {"Darwin": "macos", "Linux": "linux", "Windows": "windows"}
    arch_map = {"x86_64": "amd64", "amd64": "amd64", "arm64": "arm64", "aarch64": "arm64"}
    os_name = os_map.get(platform.system(), platform.system().lower() or "unknown")
    arch = arch_map.get(platform.machine().lower(), platform.machine().lower() or "unknown")

    source_state = {
        "version": 1,
        "source_runtime_id": f"{os_name}-{arch}-host",
        "login_generation": str(uuid.uuid4()),
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "profile_path": str(profile_dir),
        "cookies_path": str(cookies_path),
    }
    state_path = auth_root / "source-state.json"
    state_path.write_text(json.dumps(source_state, indent=2))
    try: state_path.chmod(0o600)
    except Exception: pass

    print(json.dumps({"ok": True, "count": len(linkedin_cookies)}))

try:
    asyncio.run(main())
except Exception as exc:
    print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
    sys.exit(1)
`;

function electronCookiesToPatchright(electronCookies) {
  const oneYearFromNow = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  const sameSiteMap = {
    'no_restriction': 'None',
    'lax': 'Lax',
    'strict': 'Strict',
    'unspecified': 'Lax',
  };
  return electronCookies.map((c) => {
    const expires = (typeof c.expirationDate === 'number' && c.expirationDate > 0)
      ? Math.floor(c.expirationDate)
      : oneYearFromNow;
    const sameSite = sameSiteMap[c.sameSite] || 'Lax';
    const out = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite,
    };
    if (out.sameSite === 'None') out.secure = true;
    return out;
  });
}

function injectLinkedinCookies(electronCookies) {
  return new Promise((resolve) => {
    const uv = resolveBin('uv');
    const cookies = electronCookiesToPatchright(electronCookies);
    const env = { ...process.env, UV_HTTP_TIMEOUT: '300' };
    let child;
    try {
      child = spawn(uv, ['run', '--with', 'patchright', '--quiet', 'python', '-c', LINKEDIN_INJECT_SCRIPT], {
        env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, error: `failed to spawn ${uv}: ${err.message}` });
      return;
    }
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (e) => resolve({ ok: false, error: `spawn error: ${e.message}` }));
    child.on('exit', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: `cookie inject exited ${code}: ${(stderr || stdout).slice(-400)}` });
        return;
      }
      try {
        const line = stdout.trim().split('\n').filter(Boolean).pop() || '{}';
        const parsed = JSON.parse(line);
        resolve(parsed.ok ? { ok: true, count: parsed.count } : { ok: false, error: parsed.error || 'unknown injection error' });
      } catch (e) {
        resolve({ ok: false, error: `inject script non-JSON output: ${stdout.slice(-200)}` });
      }
    });
    try {
      child.stdin.write(JSON.stringify({ cookies, profile_dir: LINKEDIN_PROFILE_DIR }));
      child.stdin.end();
    } catch (e) {
      resolve({ ok: false, error: `stdin write failed: ${e.message}` });
    }
  });
}

ipcMain.handle('linkedin-connect', async (_event, payload) => {
  const toolId = (payload && payload.toolId) || '';
  if (!toolId) {
    return { ok: false, error: 'linkedin-connect: missing toolId from caller' };
  }

  // Clear any quarantined profiles from prior failed attempts. The MCP server
  // moves a profile to invalid-state-<timestamp>/ whenever its _auth_ready()
  // check fails; left to pile up they take real disk space and confuse later
  // debugging.
  try {
    const authRoot = path.join(os.homedir(), '.linkedin-mcp');
    if (fs.existsSync(authRoot)) {
      for (const entry of fs.readdirSync(authRoot)) {
        if (entry.startsWith('invalid-state-')) {
          fs.rmSync(path.join(authRoot, entry), { recursive: true, force: true });
        }
      }
    }
  } catch (_) { /* best-effort cleanup */ }

  // Fast-path: if the persist partition already has a valid li_at from a
  // previous session, skip the BrowserWindow entirely and inject straight in.
  // Same UX feel as Instagram: re-Connect is near-instant when nothing expired.
  // URL-based query (not { domain }) so we pick up cookies set on .linkedin.com,
  // .www.linkedin.com, www.linkedin.com all in one call.
  try {
    const partitionCookies = await session.fromPartition('persist:linkedin-auth').cookies.get({ url: 'https://www.linkedin.com/' });
    const cached = partitionCookies.find((c) => c.name === 'li_at');
    if (cached) {
      console.log(`[linkedin-connect] cached li_at found in partition (${partitionCookies.length} cookies); fast-path inject for tool ${toolId}`);
      const result = await injectLinkedinCookies(partitionCookies);
      if (result.ok) return { ok: true, count: result.count, fastPath: true };
      console.log(`[linkedin-connect] fast-path inject failed, falling back to window flow: ${result.error}`);
    }
  } catch (err) {
    console.log(`[linkedin-connect] fast-path probe failed: ${err.message}`);
  }

  // Hidden by default. Only shown if the user actually needs to sign in.
  const win = new BrowserWindow({
    width: 520,
    height: 760,
    title: 'Sign in to LinkedIn',
    parent: mainWindow || undefined,
    modal: false,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:linkedin-auth',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    // /feed/ redirects to /login when unauthed, but lets us reuse a cached
    // session without bouncing through the login form when it's still valid.
    await win.loadURL('https://www.linkedin.com/feed/');
  } catch (err) {
    if (!win.isDestroyed()) win.close();
    return { ok: false, error: `Failed to load LinkedIn: ${err.message}` };
  }

  return new Promise((resolve) => {
    let settled = false;
    let shown = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      if (!win.isDestroyed()) win.close();
      resolve(value);
    };
    win.on('closed', () => { if (!settled) finish({ ok: false, error: 'Sign-in window was closed' }); });

    let attempts = 0;
    const tick = async () => {
      if (settled || win.isDestroyed()) return;
      attempts += 1;
      try {
        // URL-based query: matches every cookie Chromium would send to
        // www.linkedin.com regardless of whether the cookie domain is
        // .linkedin.com, .www.linkedin.com, www.linkedin.com, etc.
        const cookies = await win.webContents.session.cookies.get({ url: 'https://www.linkedin.com/' });
        const liAt = cookies.find((c) => c.name === 'li_at');
        if (attempts <= 3 || attempts % 10 === 0) {
          console.log(`[linkedin-connect] tick ${attempts}: ${cookies.length} cookies [${cookies.map(c => c.name).join(',')}], li_at=${liAt ? 'YES' : 'no'}`);
        }
        if (liAt) {
          clearInterval(poll);
          console.log(`[linkedin-connect] li_at acquired (${cookies.length} cookies); injecting into Patchright profile for tool ${toolId}`);
          const result = await injectLinkedinCookies(cookies);
          finish(result.ok ? { ok: true, count: result.count } : result);
          return;
        }
      } catch (err) {
        console.log(`[linkedin-connect] tick ${attempts}: cookie read error: ${err.message}`);
      }
      // No li_at after the first ~1.6s of polling means the user actually
      // needs to sign in; reveal the window so they can.
      if (!shown && attempts >= 2 && !win.isDestroyed()) {
        shown = true;
        win.show();
      }
    };

    // Immediate first check, then 800ms cadence (faster than Instagram's
    // 1500ms; we're optimizing for the silent-reauth case).
    tick();
    const poll = setInterval(tick, 800);
    const timer = setTimeout(() => {
      finish({ ok: false, error: 'LinkedIn sign-in timed out after 10 minutes' });
    }, 10 * 60 * 1000);
  });
});

ipcMain.handle('linkedin-logout', async () => {
  return new Promise((resolve) => {
    try {
      if (fs.existsSync(LINKEDIN_PROFILE_DIR)) {
        fs.rmSync(LINKEDIN_PROFILE_DIR, { recursive: true, force: true });
      }
      session.fromPartition('persist:linkedin-auth').clearStorageData().then(
        () => resolve({ ok: true }),
        (err) => resolve({ ok: false, error: `cleared profile but failed to clear partition: ${err.message}` }),
      );
    } catch (err) {
      resolve({ ok: false, error: err.message || String(err) });
    }
  });
});
