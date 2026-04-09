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
