const { app, components, BrowserWindow, ipcMain, shell, session } = require('electron');
let autoUpdater;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) {}
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const getPort = require('get-port');
const http = require('http');

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
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('openswarm:auth-url', url);
  } else {
    pendingDeepLink = url;
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

const isPackaged = app.isPackaged;
const isDev = process.env.ELECTRON_DEV === '1';
const iconPath = path.join(__dirname, 'build', 'icon.png');

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
  if (isPackaged) {
    const envPath = path.join(process.resourcesPath, 'python-env');
    return path.join(envPath, 'bin', 'python3');
  }
  const venvPython = path.join(__dirname, '..', 'backend', '.venv', 'bin', 'python3');
  return venvPython;
}

function waitForBackend(port, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('Backend startup timed out'));
      }
      const req = http.get(`http://127.0.0.1:${port}/api/health/check`, (res) => {
        if (res.statusCode === 200) {
          resolve();
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

async function startBackend() {
  backendPort = await getPort({ port: getPort.makeRange(8324, 8424) });

  const pythonPath = getPythonPath();
  const backendDir = getResourcePath('backend');
  const projectRoot = isPackaged ? process.resourcesPath : path.join(__dirname, '..');

  const shellPath = getShellPath();

  const env = {
    ...process.env,
    PATH: shellPath,
    OPENSWARM_PACKAGED: isPackaged ? '1' : '0',
    OPENSWARM_PORT: String(backendPort),
    OPENSWARM_ELECTRON_PATH: process.execPath,
    PYTHONDONTWRITEBYTECODE: '1',
  };

  if (isPackaged) {
    const pythonEnvSitePackages = path.join(
      process.resourcesPath, 'python-env', 'lib',
      'python3.13', 'site-packages'
    );
    const debuggerDir = getResourcePath('debugger');
    env.PYTHONPATH = [projectRoot, debuggerDir, pythonEnvSitePackages].join(':');
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
  });

  backendProcess.stderr.on('data', (data) => {
    const text = data.toString();
    process.stderr.write(`[backend] ${text}`);
  });

  backendProcess.on('exit', (code) => {
    console.log(`Backend exited with code ${code}`);
    if (code !== 0 && code !== null && mainWindow) {
      mainWindow.webContents.executeJavaScript(
        `document.title = "OpenSwarm (backend crashed)";`
      );
    }
  });

  await waitForBackend(backendPort);
  console.log(`Backend ready on port ${backendPort}`);
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

  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, _params) => {
    webPreferences.plugins = true;
    webPreferences.enableBlinkFeatures = 'EncryptedMedia';
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isDev && url.startsWith('http://localhost:3000')) return;
    if (url.startsWith('file://')) return;
    event.preventDefault();
    mainWindow.webContents.send('webview-new-window', url, mainWindow.webContents.id);
  });

  // Once the renderer has loaded, flush any deep-link URL we captured before
  // the window existed (cold-launch via openswarm://).
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingDeepLink) {
      mainWindow.webContents.send('openswarm:auth-url', pendingDeepLink);
      pendingDeepLink = null;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function setupAutoUpdater() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

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
}

function killBackend() {
  if (backendProcess) {
    console.log('Killing backend process...');
    backendProcess.kill('SIGTERM');
    setTimeout(() => {
      if (backendProcess && !backendProcess.killed) {
        backendProcess.kill('SIGKILL');
      }
    }, 3000);
    backendProcess = null;
  }
}

app.whenReady().then(async () => {
  // Cold-launch: if the OS opened us via openswarm:// (Windows/Linux it's
  // in argv; macOS fires open-url AFTER whenReady which we handle above)
  // buffer the URL for when mainWindow loads.
  const initialDeepLink = extractOpenswarmUrl(process.argv);
  if (initialDeepLink) pendingDeepLink = initialDeepLink;

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

  // Wait for the Widevine CDM to be downloaded/ready (CastLabs Component
  // Updater Service). On first launch this downloads the CDM; subsequent
  // launches use the cached version.
  if (components && typeof components.whenReady === 'function') {
    try {
      await components.whenReady();
      console.log('Widevine CDM ready');
      if (typeof components.status === 'function') {
        console.log('CDM component status:', JSON.stringify(components.status()));
      }
    } catch (err) {
      console.warn('Widevine CDM not available:', err.message);
    }
  } else {
    console.log('CastLabs components API not available — using standard Electron (no DRM)');
  }

  try {
    if (isDev) {
      backendPort = parseInt(process.env.OPENSWARM_PORT || '8324', 10);
      console.log(`Dev mode: using existing backend on port ${backendPort}`);
    } else {
      await startBackend();
    }
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
  } catch (err) {
    console.error('Failed to start:', err);
    app.quit();
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
    const OAUTH_POPUP_UA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
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

    // Note on Google OAuth: we tried running the Gemini flow inside this
    // popup BrowserWindow with a spoofed Chrome UA, fresh session partition,
    // sandboxed webPreferences, and a preload script that patched
    // navigator.webdriver/plugins/chrome/permissions. Google's consent page
    // still rejected with "browser not supported". Their detection is
    // actively adversarial and Google explicitly prohibits embedded browser
    // OAuth. Gemini now routes through shell.openExternal instead (see
    // _EXTERNAL_BROWSER_PROVIDERS in backend/apps/nine_router.py). Anthropic
    // and OpenAI/Codex don't fingerprint, so they still use this popup path
    // with the generic Chrome UA override set above.

    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent: mainWindow || undefined,
      },
    };
  });

  contents.on('did-create-window', (childWindow) => {
    if (mainWindow && !mainWindow.isDestroyed() && !childWindow.isDestroyed()) {
      childWindow.setParentWindow(mainWindow);
    }
  });

  if (contents.getType() === 'webview') {
    contents.on('console-message', (_e, level, message, line, sourceId) => {
      if (message.includes('widevine') || message.includes('drm') ||
          message.includes('license') || message.includes('MediaKeySession') ||
          message.includes('EME') || message.includes('[drm-diag]') || level >= 2) {
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

    contents.on('dom-ready', () => {
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

app.on('will-quit', () => {
  if (!isDev) killBackend();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && backendPort) {
    createWindow();
  }
});

ipcMain.handle('get-backend-port', () => backendPort);
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
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('install-update', () => {
  if (!autoUpdater) return;
  autoUpdater.quitAndInstall(false, true);
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
