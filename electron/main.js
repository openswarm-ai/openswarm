const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const getPort = require('get-port');
const http = require('http');

let mainWindow = null;
let backendProcess = null;
let backendPort = null;

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

  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const result = execFileSync(shell, ['-ilc', 'echo $PATH'], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, HOME: os.homedir() },
    });
    const resolved = result.trim();
    if (resolved) return resolved;
  } catch (_) { /* fall through */ }

  const home = os.homedir();
  const fallbackDirs = [
    path.join(home, '.nvm/versions/node'),
    path.join(home, '.volta/bin'),
    path.join(home, '.fnm/aliases/default/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, '.cargo/bin'),
    path.join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];

  // For nvm, resolve the current default version dynamically
  const nvmDir = path.join(home, '.nvm/versions/node');
  try {
    if (fs.existsSync(nvmDir)) {
      const versions = fs.readdirSync(nvmDir).sort().reverse();
      if (versions.length) {
        fallbackDirs.unshift(path.join(nvmDir, versions[0], 'bin'));
      }
    }
  } catch (_) { /* ignore */ }

  const existing = fallbackDirs.filter((d) => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });
  return [...existing, process.env.PATH || ''].join(':');
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
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    console.log(`Update available: ${info.version}`);
    sendToRenderer('update-available', info);
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('App is up to date');
    sendToRenderer('update-not-available', info);
  });

  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer('download-progress', progress);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`Update downloaded: ${info.version}`);
    sendToRenderer('update-downloaded', info);
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err);
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
    }
  } catch (err) {
    console.error('Failed to start:', err);
    app.quit();
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

ipcMain.handle('check-for-updates', async () => {
  if (!isPackaged) {
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
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('install-update', () => {
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
