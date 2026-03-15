const { app, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawn } = require('child_process');
const getPort = require('get-port');
const http = require('http');

let mainWindow = null;
let backendProcess = null;
let backendPort = null;

const isPackaged = app.isPackaged;

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

  const env = {
    ...process.env,
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
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const frontendPath = getResourcePath('frontend', 'index.html');
  mainWindow.loadFile(frontendPath);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log(`Update available: ${info.version}`);
    if (mainWindow) {
      mainWindow.webContents.executeJavaScript(
        `window.__OPENSWARM_UPDATE_AVAILABLE__ = ${JSON.stringify(info)};`
      );
    }
    autoUpdater.downloadUpdate();
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`Update downloaded: ${info.version}`);
    if (mainWindow) {
      mainWindow.webContents.executeJavaScript(
        `window.__OPENSWARM_UPDATE_DOWNLOADED__ = ${JSON.stringify(info)};`
      );
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err);
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
  try {
    await startBackend();
    createWindow();
    setupAutoUpdater();
  } catch (err) {
    console.error('Failed to start:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  killBackend();
  app.quit();
});

app.on('will-quit', () => {
  killBackend();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && backendPort) {
    createWindow();
  }
});

ipcMain.handle('get-backend-port', () => backendPort);
