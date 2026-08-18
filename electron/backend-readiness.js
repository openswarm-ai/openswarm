const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function authTokenFilePath(options) {
  const {
    isPackaged,
    platform,
    env,
    electronDir,
    homedir = os.homedir,
    pathImpl = path,
  } = options;
  const home = homedir();
  if (!isPackaged) {
    return pathImpl.join(electronDir, '..', 'backend', 'data', 'auth.token');
  }
  if (platform === 'darwin') {
    return pathImpl.join(home, 'Library', 'Application Support', 'OpenSwarm', 'data', 'auth.token');
  }
  if (platform === 'win32') {
    return pathImpl.join(env.APPDATA || home, 'OpenSwarm', 'data', 'auth.token');
  }
  const dataRoot = env.XDG_DATA_HOME || pathImpl.join(home, '.local', 'share');
  return pathImpl.join(dataRoot, 'OpenSwarm', 'data', 'auth.token');
}

function readAuthToken(tokenPath, fsImpl = fs) {
  try {
    return fsImpl.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return '';
  }
}

function createBackendImportWarmup(options) {
  const {
    pythonPath,
    projectRoot,
    debuggerDir,
    pythonSitePackages,
    scratchRoot,
    platform,
    env = process.env,
    pathImpl = path,
  } = options;
  if (!pythonPath || !projectRoot || !scratchRoot || !platform) {
    throw new Error('backend import warmup requires pythonPath, projectRoot, scratchRoot, and platform');
  }

  const trustedPythonPath = [projectRoot, debuggerDir, pythonSitePackages]
    .filter(Boolean)
    .join(pathImpl.delimiter);
  const warmupEnv = {
    ...env,
    ENABLE_HOSTED_DEMO: '0',
    OPENSWARM_PACKAGED: '1',
    OPENSWARM_BACKEND_IMPORT_ONLY: '1',
    OPENSWARM_DISABLE_9ROUTER_AUTOSTART: '1',
    OPENSWARM_FREE_TRIAL_ENABLED: '0',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
    PYTHONPATH: trustedPythonPath,
    APPDATA: scratchRoot,
    LOCALAPPDATA: scratchRoot,
    HOME: scratchRoot,
    USERPROFILE: scratchRoot,
    XDG_DATA_HOME: scratchRoot,
  };
  delete warmupEnv.PYTHONHOME;

  return {
    file: pythonPath,
    args: ['-s', '-c', 'import backend.main; print("backend.main importable")'],
    options: {
      cwd: projectRoot,
      env: warmupEnv,
    },
  };
}

async function loadAuthToken(options) {
  const {
    tokenPath,
    fsImpl = fs,
    attempts = 20,
    retryMs = 100,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    logger = console,
  } = options;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const token = readAuthToken(tokenPath, fsImpl);
    if (token) {
      logger.log(`[auth] loaded token from ${tokenPath}`);
      return token;
    }
    await sleep(retryMs);
  }
  logger.warn(
    `[auth] FAILED to load auth token from ${tokenPath} after 2s — WS/HTTP will be rejected`,
  );
  return '';
}

function waitForBackend(port, options = {}) {
  const {
    process: backendProcess = null,
    httpImpl = http,
    now = Date.now,
    setTimeoutImpl = setTimeout,
    onStillStarting = () => {},
    onTakingTooLong = () => {},
  } = options;
  const start = now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let stillStartingNotified = false;
    let actionsShown = false;
    const finish = (complete, value) => {
      if (settled) return;
      settled = true;
      complete(value);
    };

    if (backendProcess) {
      backendProcess.once('exit', (code) => {
        if (code !== 0 && code !== null) {
          finish(reject, new Error(`Backend process exited with code ${code} during startup`));
        }
      });
      backendProcess.once('error', (error) => {
        finish(reject, new Error(`Backend failed to spawn: ${error && error.message || error}`));
      });
    }

    function check() {
      if (settled) return;
      const elapsed = now() - start;
      if (elapsed > 60_000 && !stillStartingNotified) {
        stillStartingNotified = true;
        onStillStarting();
      }
      if (elapsed > 180_000 && !actionsShown) {
        actionsShown = true;
        onTakingTooLong();
      }
      const request = httpImpl.get(`http://127.0.0.1:${port}/api/health/check`, (response) => {
        if (response.statusCode === 200) {
          finish(resolve);
        } else {
          setTimeoutImpl(check, 500);
        }
      });
      request.on('error', () => setTimeoutImpl(check, 500));
      request.setTimeout(2000, () => {
        request.destroy();
        setTimeoutImpl(check, 500);
      });
    }
    check();
  });
}

module.exports = {
  authTokenFilePath,
  createBackendImportWarmup,
  readAuthToken,
  loadAuthToken,
  waitForBackend,
};
