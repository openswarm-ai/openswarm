# Windows & Linux Dev-Mode Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenSwarm runnable in dev mode on Windows and Linux via cross-platform Node.js orchestration scripts and targeted platform fixes.

**Architecture:** Three new `.mjs` scripts (`run.mjs`, `backend/run.mjs`, `frontend/run.mjs`) replace the Bash `.sh` scripts with cross-platform Node.js equivalents. Existing `.sh` files are untouched. Platform-specific code in `electron/main.js` and `backend/apps/tools_lib/tools_lib.py` is patched to handle Windows paths and conventions.

**Tech Stack:** Node.js (ESM), child_process, http module, Python venv

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `frontend/run.mjs` | npm install + npm run dev |
| Create | `backend/run.mjs` | venv setup, pip install, uvicorn start |
| Create | `run.mjs` | Orchestrate backend, frontend, Electron; health checks; shutdown |
| Modify | `electron/main.js` | Windows Python path, cross-platform PATH delimiters |
| Modify | `electron/package.json` | Cross-platform dev/postinstall scripts |
| Modify | `backend/apps/tools_lib/tools_lib.py` | Windows bin dirs, chmod guard |
| Modify | `frontend/package.json` | Cross-platform clean script |

---

### Task 1: Create `frontend/run.mjs`

The simplest script — good place to establish the pattern.

**Files:**
- Create: `frontend/run.mjs`

- [ ] **Step 1: Create the script**

```javascript
// frontend/run.mjs
import { spawn } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: __dirname,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
      else resolve();
    });
  });
}

try {
  console.log('Installing dependencies...');
  await run(npmCmd, ['install']);

  console.log('Building with development mode...');
  await run(npmCmd, ['run', 'dev']);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
```

- [ ] **Step 2: Verify it works**

Run from the project root:
```bash
node frontend/run.mjs
```
Expected: npm install runs, then webpack dev server starts on `http://localhost:3000`. Ctrl+C stops it cleanly.

- [ ] **Step 3: Commit**

```bash
git add frontend/run.mjs
git commit -m "feat: add cross-platform frontend/run.mjs"
```

---

### Task 2: Create `backend/run.mjs`

Handles Python venv creation, activation (via PATH manipulation), pip install, and uvicorn startup.

**Files:**
- Create: `backend/run.mjs`

- [ ] **Step 1: Create the script**

```javascript
// backend/run.mjs
import { spawn, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join, delimiter } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const backendDir = __dirname;
const isWindows = process.platform === 'win32';

// --- Locate Python ---
function findPython() {
  const candidates = isWindows
    ? ['python', 'python3']
    : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      const version = execFileSync(cmd, ['--version'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      console.log(`Found ${version} (${cmd})`);
      return cmd;
    } catch {
      // not found, try next
    }
  }
  console.error(
    'Error: Python not found. Install Python 3.11+ and ensure it is on your PATH.'
  );
  process.exit(1);
}

const pythonCmd = findPython();

// --- Venv setup ---
const venvDir = join(backendDir, '.venv');
const venvBin = isWindows
  ? join(venvDir, 'Scripts')
  : join(venvDir, 'bin');
const venvPython = isWindows
  ? join(venvBin, 'python.exe')
  : join(venvBin, 'python3');
const venvPip = isWindows
  ? join(venvBin, 'pip.exe')
  : join(venvBin, 'pip3');

// Prepend venv bin to PATH so all child processes use the venv
const env = {
  ...process.env,
  PATH: venvBin + delimiter + (process.env.PATH || ''),
  VIRTUAL_ENV: venvDir,
};

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env,
      ...options,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0)
        reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
      else resolve();
    });
  });
}

try {
  // --- Create virtual environment if needed ---
  if (!existsSync(venvDir)) {
    console.log('Creating virtual environment...');
    await run(pythonCmd, ['-m', 'venv', venvDir], { env: process.env });
  }

  // --- Install debugger module if not installed ---
  const debuggerDir = join(projectRoot, 'debugger');
  try {
    await run(venvPip, ['show', 'debug'], { stdio: 'ignore' });
  } catch {
    console.log('Installing debugger module...');
    await run(venvPip, ['install', '-e', '.'], { cwd: debuggerDir });
  }

  // --- Install Python dependencies ---
  console.log('Installing dependencies...');
  await run(venvPip, ['install', '-r', join(backendDir, 'requirements.txt')], {
    cwd: backendDir,
  });

  // --- Start the backend server ---
  console.log('Starting backend server on http://0.0.0.0:8324 ...');
  await run(
    venvPython,
    [
      '-m', 'uvicorn', 'backend.main:app',
      '--host', '0.0.0.0',
      '--port', '8324',
      '--reload',
      '--reload-dir', backendDir,
      '--reload-exclude', '*.pyc',
    ],
    { cwd: projectRoot }
  );
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
```

- [ ] **Step 2: Verify venv creation and uvicorn start**

Run from the project root:
```bash
node backend/run.mjs
```
Expected: Creates `.venv` if missing, installs deps, starts uvicorn on port 8324. Ctrl+C stops it.

- [ ] **Step 3: Commit**

```bash
git add backend/run.mjs
git commit -m "feat: add cross-platform backend/run.mjs"
```

---

### Task 3: Create `run.mjs` (root orchestrator)

Spawns backend and frontend, health-checks both, launches Electron, handles graceful shutdown.

**Files:**
- Create: `run.mjs`

- [ ] **Step 1: Create the script**

```javascript
// run.mjs
import { spawn, execFileSync } from 'child_process';
import { get } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';

// --- Colors ---
const BLUE = '\x1b[1;34m';
const GREEN = '\x1b[1;32m';
const RED = '\x1b[1;31m';
const YELLOW = '\x1b[1;33m';
const MAGENTA = '\x1b[1;35m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let shuttingDown = false;
const children = [];

// --- Process tree kill ---
function killChild(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (isWindows) {
      // taskkill with /T kills the process tree, /F forces it
      // child.pid is a numeric PID from Node's child_process — safe to interpolate
      execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    // process already exited
  }
}

function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${YELLOW}${BOLD}Gracefully shutting down all services...${RESET}`);

  for (const child of children) {
    killChild(child);
  }

  // Force-kill after 5 seconds
  setTimeout(() => {
    for (const child of children) {
      if (child && child.exitCode === null) {
        try {
          if (isWindows) {
            execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
          } else {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch {
          // already dead
        }
      }
    }
    console.log(`${GREEN}${BOLD}All services stopped.${RESET}`);
    process.exit(0);
  }, 5000);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);

// --- Spawn with prefixed output ---
function spawnService(name, color, cmd, args, options = {}) {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // On Unix, create a process group so we can kill the whole tree
    detached: !isWindows,
    ...options,
  });
  children.push(child);

  const prefix = `${color}${BOLD}[${name}]${RESET} `;

  child.stdout.on('data', (data) => {
    for (const line of data.toString().split('\n')) {
      if (line) process.stdout.write(`${prefix}${line}\n`);
    }
  });
  child.stderr.on('data', (data) => {
    for (const line of data.toString().split('\n')) {
      if (line) process.stderr.write(`${prefix}${line}\n`);
    }
  });

  return child;
}

// --- Health check ---
function waitForHealth(url, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function check() {
      if (shuttingDown) return reject(new Error('shutting down'));
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`${label} did not become ready within ${timeoutMs / 1000}s`));
      }
      get(url, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve();
        } else {
          setTimeout(check, 2000);
        }
        res.resume();
      }).on('error', () => setTimeout(check, 2000));
    }
    check();
  });
}

// --- Main ---
try {
  // Start backend
  console.log(`${BLUE}${BOLD}[backend]${RESET}  Starting backend server...`);
  const backend = spawnService('backend', BLUE, process.execPath, [join(__dirname, 'backend', 'run.mjs')]);

  backend.on('exit', (code) => {
    if (!shuttingDown) {
      console.log(`${RED}${BOLD}Backend process exited unexpectedly (code ${code}). Shutting down...${RESET}`);
      cleanup();
    }
  });

  // Wait for backend health
  console.log(`${YELLOW}${BOLD}Waiting for backend (http://localhost:8324) to be ready...${RESET}`);
  await waitForHealth('http://localhost:8324/', 'Backend', 120000);
  console.log(`${GREEN}${BOLD}Backend is ready!${RESET}`);

  // Start frontend
  console.log(`${GREEN}${BOLD}[frontend]${RESET} Starting frontend dev server...`);
  const frontend = spawnService('frontend', GREEN, process.execPath, [join(__dirname, 'frontend', 'run.mjs')]);

  frontend.on('exit', (code) => {
    if (!shuttingDown) {
      console.log(`${RED}${BOLD}Frontend process exited unexpectedly (code ${code}). Shutting down...${RESET}`);
      cleanup();
    }
  });

  // Wait for frontend health
  console.log(`${YELLOW}${BOLD}Waiting for frontend (http://localhost:3000) to be ready...${RESET}`);
  await waitForHealth('http://localhost:3000/', 'Frontend', 60000);
  console.log(`${GREEN}${BOLD}Frontend is ready!${RESET}`);

  // Start Electron
  const npmCmd = isWindows ? 'npm.cmd' : 'npm';
  console.log(`${MAGENTA}${BOLD}[electron]${RESET} Launching Electron dev shell...`);
  const electron = spawnService('electron', MAGENTA, npmCmd, ['run', 'dev'], {
    cwd: join(__dirname, 'electron'),
    env: { ...process.env, ELECTRON_DEV: '1' },
  });

  electron.on('exit', (code) => {
    if (!shuttingDown) {
      console.log(`${YELLOW}${BOLD}Electron process exited (code ${code}). Shutting down...${RESET}`);
      cleanup();
    }
  });

  console.log('');
  console.log(`${BOLD}All services are running. Press Ctrl+C to stop.${RESET}`);
  console.log(`  Backend:  ${BLUE}http://localhost:8324${RESET}`);
  console.log(`  Frontend: ${GREEN}http://localhost:3000${RESET}`);
  console.log(`  Electron: ${MAGENTA}dev shell${RESET}`);
  console.log('');
} catch (err) {
  console.error(`${RED}${BOLD}${err.message}${RESET}`);
  cleanup();
}
```

- [ ] **Step 2: Verify full orchestration**

Run from the project root:
```bash
node run.mjs
```
Expected: Backend starts and becomes healthy, frontend starts and becomes healthy, Electron launches. Ctrl+C gracefully shuts down all three. On unexpected exit of any service, the others are torn down.

- [ ] **Step 3: Commit**

```bash
git add run.mjs
git commit -m "feat: add cross-platform run.mjs orchestrator"
```

---

### Task 4: Fix `electron/main.js` for Windows paths

**Files:**
- Modify: `electron/main.js:93` (PATH split)
- Modify: `electron/main.js:98` (PATH join)
- Modify: `electron/main.js:108-115` (getPythonPath)
- Modify: `electron/main.js:164` (PYTHONPATH join)
- Modify: `electron/main.js:289-300` (killBackend)

- [ ] **Step 1: Fix `getPythonPath()` to use Windows paths**

Change lines 108-115 from:

```javascript
function getPythonPath() {
  if (isPackaged) {
    const envPath = path.join(process.resourcesPath, 'python-env');
    return path.join(envPath, 'bin', 'python3');
  }
  const venvPython = path.join(__dirname, '..', 'backend', '.venv', 'bin', 'python3');
  return venvPython;
}
```

To:

```javascript
function getPythonPath() {
  if (isPackaged) {
    const envPath = path.join(process.resourcesPath, 'python-env');
    return process.platform === 'win32'
      ? path.join(envPath, 'Scripts', 'python.exe')
      : path.join(envPath, 'bin', 'python3');
  }
  return process.platform === 'win32'
    ? path.join(__dirname, '..', 'backend', '.venv', 'Scripts', 'python.exe')
    : path.join(__dirname, '..', 'backend', '.venv', 'bin', 'python3');
}
```

- [ ] **Step 2: Fix PATH separator on line 93**

Change line 93 from:

```javascript
  for (const d of [...fallbackDirs, ...systemPaths, ...(process.env.PATH || '').split(':')]) {
```

To:

```javascript
  for (const d of [...fallbackDirs, ...systemPaths, ...(process.env.PATH || '').split(path.delimiter)]) {
```

- [ ] **Step 3: Fix PATH join on line 98**

Change line 98 from:

```javascript
  return dirs.join(':');
```

To:

```javascript
  return dirs.join(path.delimiter);
```

- [ ] **Step 4: Fix PYTHONPATH join on line 164**

Change line 164 from:

```javascript
    env.PYTHONPATH = [projectRoot, debuggerDir, pythonEnvSitePackages].join(':');
```

To:

```javascript
    env.PYTHONPATH = [projectRoot, debuggerDir, pythonEnvSitePackages].join(path.delimiter);
```

- [ ] **Step 5: Fix `killBackend()` for Windows**

Change lines 289-300 from:

```javascript
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
```

To:

```javascript
function killBackend() {
  if (backendProcess) {
    console.log('Killing backend process...');
    if (process.platform === 'win32') {
      try {
        // PID is a numeric value from Node child_process — safe to pass as argument
        execFileSync('taskkill', ['/T', '/F', '/PID', String(backendProcess.pid)]);
      } catch { /* already exited */ }
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
```

Note: change the import on line 5 from `const { spawn, execFileSync } = require('child_process');` — `execFileSync` is already imported.

- [ ] **Step 6: Verify Electron launches in dev mode**

With backend and frontend already running (via `node backend/run.mjs` and `node frontend/run.mjs` in separate terminals):
```bash
cd electron && npx cross-env ELECTRON_DEV=1 npx electron .
```
Expected: Electron window opens, loads `http://localhost:3000`, no errors in console about Python paths.

- [ ] **Step 7: Commit**

```bash
git add electron/main.js
git commit -m "fix: make electron main.js cross-platform (Windows paths, delimiters, process kill)"
```

---

### Task 5: Fix `electron/package.json` scripts

**Files:**
- Modify: `electron/package.json`
- Create: `electron/scripts/postinstall.mjs`

- [ ] **Step 1: Install cross-env as a dev dependency**

```bash
cd electron && npm install --save-dev cross-env
```

- [ ] **Step 2: Update the `dev` and `postinstall` scripts**

Change the `"scripts"` section from:

```json
  "scripts": {
    "start": "electron .",
    "dev": "ELECTRON_DEV=1 electron .",
    "postinstall": "bash scripts/sign-vmp.sh",
    "sign-vmp": "bash scripts/sign-vmp.sh",
    "dist": "electron-builder --mac --publish never",
    "dist:publish": "electron-builder --mac --publish always",
    "dist:all": "electron-builder --mac --win --linux"
  },
```

To:

```json
  "scripts": {
    "start": "electron .",
    "dev": "cross-env ELECTRON_DEV=1 electron .",
    "postinstall": "node scripts/postinstall.mjs",
    "sign-vmp": "bash scripts/sign-vmp.sh",
    "dist": "electron-builder --mac --publish never",
    "dist:publish": "electron-builder --mac --publish always",
    "dist:all": "electron-builder --mac --win --linux"
  },
```

- [ ] **Step 3: Create `electron/scripts/postinstall.mjs`**

```javascript
// electron/scripts/postinstall.mjs
// Cross-platform postinstall — runs VMP signing on macOS only.
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const signScript = join(__dirname, 'sign-vmp.sh');

if (process.platform === 'darwin' && existsSync(signScript)) {
  try {
    execFileSync('bash', [signScript], { stdio: 'inherit' });
  } catch (err) {
    console.warn('[postinstall] VMP signing failed (non-fatal):', err.message);
  }
} else {
  console.log('[postinstall] Skipping VMP signing (macOS only)');
}
```

- [ ] **Step 4: Verify npm install works without error**

```bash
cd electron && npm install
```
Expected: On Windows/Linux, prints `[postinstall] Skipping VMP signing (macOS only)` and succeeds. On macOS, runs the existing sign-vmp.sh.

- [ ] **Step 5: Commit**

```bash
git add electron/package.json electron/scripts/postinstall.mjs
git commit -m "fix: make electron package.json scripts cross-platform"
```

---

### Task 6: Fix `backend/apps/tools_lib/tools_lib.py` for Windows

**Files:**
- Modify: `backend/apps/tools_lib/tools_lib.py:4` (add `sys` import)
- Modify: `backend/apps/tools_lib/tools_lib.py:291-314` (`_extra_bin_dirs`)
- Modify: `backend/apps/tools_lib/tools_lib.py:238` (`os.chmod`)

- [ ] **Step 1: Add `sys` import**

Add `import sys` after `import re` on line 4, so lines 3-5 become:

```python
import os
import re
import sys
import logging
```

- [ ] **Step 2: Fix `_extra_bin_dirs()` for Windows**

Change the `_extra_bin_dirs()` function (lines 291-314) from:

```python
def _extra_bin_dirs() -> list[str]:
    """Well-known user-local bin directories that may not be on PATH in packaged apps."""
    home = os.path.expanduser("~")
    dirs = [
        os.path.join(home, ".bun", "bin"),
        os.path.join(home, ".cargo", "bin"),
        os.path.join(home, ".local", "bin"),
        os.path.join(home, ".volta", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ]
    # nvm: pick the newest installed node version
    nvm_node = os.path.join(home, ".nvm", "versions", "node")
    try:
        if os.path.isdir(nvm_node):
            versions = sorted(os.listdir(nvm_node), reverse=True)
            if versions:
                dirs.insert(0, os.path.join(nvm_node, versions[0], "bin"))
    except OSError:
        pass
    # fnm
    fnm_bin = os.path.join(home, "Library", "Application Support", "fnm", "aliases", "default", "bin")
    if os.path.isdir(fnm_bin):
        dirs.insert(0, fnm_bin)
    return dirs
```

To:

```python
def _extra_bin_dirs() -> list[str]:
    """Well-known user-local bin directories that may not be on PATH in packaged apps."""
    home = os.path.expanduser("~")

    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", os.path.join(home, "AppData", "Roaming"))
        localappdata = os.environ.get("LOCALAPPDATA", os.path.join(home, "AppData", "Local"))
        dirs = [
            os.path.join(appdata, "npm"),
            os.path.join(home, ".cargo", "bin"),
            os.path.join(localappdata, "Programs", "Python"),
            os.path.join(home, "scoop", "shims"),
            os.path.join(home, ".bun", "bin"),
            os.path.join(home, ".volta", "bin"),
        ]
        # nvm-windows
        nvm_home = os.environ.get("NVM_HOME", "")
        if nvm_home and os.path.isdir(nvm_home):
            dirs.insert(0, os.environ.get("NVM_SYMLINK", nvm_home))
        return dirs

    dirs = [
        os.path.join(home, ".bun", "bin"),
        os.path.join(home, ".cargo", "bin"),
        os.path.join(home, ".local", "bin"),
        os.path.join(home, ".volta", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ]
    # nvm: pick the newest installed node version
    nvm_node = os.path.join(home, ".nvm", "versions", "node")
    try:
        if os.path.isdir(nvm_node):
            versions = sorted(os.listdir(nvm_node), reverse=True)
            if versions:
                dirs.insert(0, os.path.join(nvm_node, versions[0], "bin"))
    except OSError:
        pass
    # fnm
    fnm_bin = os.path.join(home, "Library", "Application Support", "fnm", "aliases", "default", "bin")
    if os.path.isdir(fnm_bin):
        dirs.insert(0, fnm_bin)
    return dirs
```

- [ ] **Step 3: Guard `os.chmod()` call**

Change line 238 from:

```python
            os.chmod(_XBIRD_CONFIG_PATH, 0o600)
```

To:

```python
            if sys.platform != "win32":
                os.chmod(_XBIRD_CONFIG_PATH, 0o600)
```

- [ ] **Step 4: Verify the backend starts without errors**

```bash
node backend/run.mjs
```
Expected: uvicorn starts, no import errors or platform-related crashes.

- [ ] **Step 5: Commit**

```bash
git add backend/apps/tools_lib/tools_lib.py
git commit -m "fix: make tools_lib bin dirs and chmod cross-platform"
```

---

### Task 7: Fix `frontend/package.json` clean script

**Files:**
- Modify: `frontend/package.json`

- [ ] **Step 1: Replace Unix-only `rm -rf` with cross-platform alternative**

Change the `"clean"` script from:

```json
    "clean": "rm -rf dist"
```

To:

```json
    "clean": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\""
```

- [ ] **Step 2: Verify clean works**

```bash
cd frontend && npm run clean
```
Expected: No error, `dist/` removed if it exists, no-op if it doesn't.

- [ ] **Step 3: Commit**

```bash
git add frontend/package.json
git commit -m "fix: make frontend clean script cross-platform"
```

---

### Task 8: End-to-end verification

- [ ] **Step 1: Full startup test**

From the project root:
```bash
node run.mjs
```

Verify:
1. Backend venv is created (if first run)
2. Backend dependencies install
3. Backend server starts on port 8324
4. Frontend dependencies install
5. Frontend dev server starts on port 3000
6. Electron window opens and loads the app
7. Ctrl+C gracefully stops all three processes

- [ ] **Step 2: Restart test**

Run `node run.mjs` again after Ctrl+C. Verify it starts cleanly (venv already exists, deps already installed, should be faster).

- [ ] **Step 3: Commit any final fixes**

If any fixes were needed during testing, commit them:
```bash
git add -A
git commit -m "fix: address issues found during cross-platform dev-mode testing"
```
