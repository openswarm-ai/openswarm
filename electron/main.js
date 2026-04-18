const { app, components, BrowserWindow, ipcMain, shell, session, dialog } = require('electron');
let autoUpdater;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) {}
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const getPort = require('get-port');
const http = require('http');

const portsConfig = JSON.parse(
  fs.readFileSync(
    app.isPackaged
      ? path.join(process.resourcesPath, 'ports.config.json')
      : path.join(__dirname, '..', 'ports.config.json'),
    'utf8',
  )
);

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
  backendPort = await getPort({ port: portsConfig.backend.prod });

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
    env.PYTHONPATH = [projectRoot, pythonEnvSitePackages].join(':');
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
      backendPort = parseInt(process.env.OPENSWARM_PORT || String(portsConfig.backend.dev), 10);
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
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (disposition === 'foreground-tab' || disposition === 'background-tab') {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('webview-new-window', url, contents.id);
      }
      return { action: 'deny' };
    }

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

    const rerouteModelSubscriptionOAuthCallback = (event, url) => {
      if (!backendPort) return;
      if (!url.includes('/callback') || !url.includes('code=')) return;
      if (url.includes(`localhost:${backendPort}`)) return;
      try {
        const parsed = new URL(url);
        const code = parsed.searchParams.get('code');
        const state = parsed.searchParams.get('state');
        if (code) {
          event.preventDefault();
          const backendUrl = `http://localhost:${backendPort}/api/subscriptions/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state || '')}`;
          console.log('[oauth] intercepted callback, redirecting to backend:', backendUrl);
          childWindow.loadURL(backendUrl);
        }
      } catch (e) {
        console.error('[oauth] intercept error:', e.message);
      }
    };
    childWindow.webContents.on('will-redirect', rerouteModelSubscriptionOAuthCallback);
    childWindow.webContents.on('will-navigate', rerouteModelSubscriptionOAuthCallback);
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

ipcMain.handle('show-open-dialog', async (_event, options) => {
  const win = BrowserWindow.getFocusedWindow();
  return dialog.showOpenDialog(win || BrowserWindow.getAllWindows()[0], options || {});
});
