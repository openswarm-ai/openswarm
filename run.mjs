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
  await waitForHealth('http://localhost:8324/api/health/check', 'Backend', 120000);
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
    shell: isWindows,
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
