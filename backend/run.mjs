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
function getPythonVersion(cmd, args = ['--version']) {
  try {
    const output = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // Extract version number from "Python X.Y.Z"
    const match = output.match(/Python (\d+)\.(\d+)/);
    if (match) {
      return { cmd, args: args.length > 1 ? args.slice(0, -1) : [], major: parseInt(match[1]), minor: parseInt(match[2]), output };
    }
  } catch {
    // not found
  }
  return null;
}

function findPython() {
  const found = [];

  if (isWindows) {
    // Windows py launcher — try specific compatible versions first
    for (const ver of ['3.13', '3.12', '3.11']) {
      const result = getPythonVersion('py', [`-${ver}`, '--version']);
      if (result) {
        found.push({ cmd: 'py', args: [`-${ver}`], ...result });
      }
    }
  }

  // Generic commands
  const candidates = isWindows
    ? ['python', 'python3']
    : ['python3', 'python'];
  for (const cmd of candidates) {
    const result = getPythonVersion(cmd);
    if (result) {
      found.push({ cmd, args: [], ...result });
    }
  }

  // Prefer 3.11-3.13 (known compatible), then any 3.11+
  const compatible = found.filter(p => p.major === 3 && p.minor >= 11 && p.minor <= 13);
  const selected = compatible[0] || found.find(p => p.major === 3 && p.minor >= 11);

  if (selected) {
    const fullCmd = selected.args.length ? `${selected.cmd} ${selected.args.join(' ')}` : selected.cmd;
    console.log(`Found ${selected.output} (${fullCmd})`);
    return { cmd: selected.cmd, args: selected.args };
  }

  if (found.length > 0) {
    const p = found[0];
    console.warn(`Warning: Found Python ${p.major}.${p.minor} but 3.11-3.13 is recommended.`);
    console.warn('Some dependencies may not have pre-built wheels for this version.');
    return { cmd: p.cmd, args: p.args };
  }

  console.error(
    'Error: Python not found. Install Python 3.11-3.13 and ensure it is on your PATH.'
  );
  process.exit(1);
}

const python = findPython();

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
  // Force UTF-8 on Windows so open() without encoding= matches macOS/Linux behavior
  ...(isWindows ? { PYTHONUTF8: '1' } : {}),
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
    await run(python.cmd, [...python.args, '-m', 'venv', venvDir], { env: process.env });
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
      '--log-level', 'info',
      '--reload',
      // On Windows, uvicorn's default loop factory picks SelectorEventLoop when
      // --reload is active, which cannot spawn subprocesses (needed by claude_agent_sdk).
      // '--loop none' tells uvicorn to skip its factory and use Python's default event
      // loop (ProactorEventLoop on Windows), which supports subprocesses.
      ...(isWindows ? ['--loop', 'none'] : []),
      '--reload-dir', backendDir,
      '--reload-exclude', '*.pyc',
    ],
    { cwd: projectRoot }
  );
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
