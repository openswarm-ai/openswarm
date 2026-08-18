const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createRuntimePaths(options) {
  const {
    isPackaged,
    isDev,
    platform,
    arch,
    resourcesPath,
    electronDir,
    env,
    homedir = os.homedir,
    fsImpl = fs,
    pathImpl = path,
    execFileSyncImpl = execFileSync,
  } = options;
  const projectDir = pathImpl.resolve(electronDir, '..');

  function resourcePath(...segments) {
    return isPackaged
      ? pathImpl.join(resourcesPath, ...segments)
      : pathImpl.join(projectDir, ...segments);
  }

  function pythonExecutable() {
    // python-build-standalone layout differs by OS:
    //   macOS / Linux: <env>/bin/python3
    //   Windows:       <env>\python.exe   (no bin/, no python3)
    // macOS extra: prefer Python.app/Contents/MacOS/python3 so LaunchServices reads LSUIElement=1
    // from the wrapper bundle and skips the Dock entry (the bare binary bounces in the Dock for the
    // whole boot on fresh Macs). Falls back to the bare binary if the wrapper is missing, so boot
    // still succeeds and only the Dock suppression is lost. See scripts/build-python-env.sh.
    if (isPackaged) {
      const environment = pathImpl.join(resourcesPath, 'python-env');
      if (platform === 'win32') return pathImpl.join(environment, 'python.exe');
      if (platform === 'darwin') {
        const wrapped = pathImpl.join(environment, 'Python.app', 'Contents', 'MacOS', 'python3');
        if (fsImpl.existsSync(wrapped)) return wrapped;
      }
      return pathImpl.join(environment, 'bin', 'python3');
    }
    return platform === 'win32'
      ? pathImpl.join(projectDir, 'backend', '.venv', 'Scripts', 'python.exe')
      : pathImpl.join(projectDir, 'backend', '.venv', 'bin', 'python3');
  }

  function bundledNodeExecutable() {
    if (!isPackaged || !['x64', 'arm64'].includes(arch)) return null;
    const candidate = platform === 'win32'
      ? pathImpl.join(resourcesPath, 'node', arch, 'node.exe')
      : pathImpl.join(resourcesPath, 'node', arch, 'bin', 'node');
    return fsImpl.existsSync(candidate) ? candidate : null;
  }

  function pythonSitePackages() {
    if (!isPackaged) return null;
    if (platform === 'win32') {
      return pathImpl.join(resourcesPath, 'python-env', 'Lib', 'site-packages');
    }

    // The bundled interpreter's minor version is a build input, not something main.js should
    // pin: discover the one lib/python3.N dir the env ships with, and fail loud on none/several.
    const libDir = pathImpl.join(resourcesPath, 'python-env', 'lib');
    let candidates = [];
    try {
      candidates = fsImpl.readdirSync(libDir).filter((name) => /^python3\.\d+$/.test(name));
    } catch {}
    if (candidates.length !== 1) {
      throw new Error(`Expected exactly one bundled python3.N lib dir under ${libDir}, found: ${candidates.join(', ') || 'none'}`);
    }
    return pathImpl.join(libDir, candidates[0], 'site-packages');
  }

  function shellPath() {
    if (platform !== 'darwin' || isDev) return env.PATH || '';
    const home = homedir();
    try {
      const userShell = env.SHELL || '/bin/zsh';
      const result = execFileSyncImpl(userShell, ['-ilc', 'echo $PATH'], {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...env, HOME: home },
      });
      const resolved = result.trim();
      if (resolved) return resolved;
    } catch {}

    const systemPaths = [];
    try {
      appendLines(systemPaths, fsImpl.readFileSync('/etc/paths', 'utf8'));
    } catch {}
    try {
      const directory = '/etc/paths.d';
      if (fsImpl.existsSync(directory)) {
        for (const file of fsImpl.readdirSync(directory).sort()) {
          appendLines(systemPaths, fsImpl.readFileSync(pathImpl.join(directory, file), 'utf8'));
        }
      }
    } catch {}

    const fallback = [
      pathImpl.join(home, '.local/bin'),
      pathImpl.join(home, '.volta/bin'),
      pathImpl.join(home, '.fnm/aliases/default/bin'),
      pathImpl.join(home, '.bun/bin'),
      pathImpl.join(home, '.cargo/bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ];
    const nvmDir = pathImpl.join(home, '.nvm/versions/node');
    try {
      if (fsImpl.existsSync(nvmDir)) {
        const versions = fsImpl.readdirSync(nvmDir).sort().reverse();
        if (versions.length) fallback.unshift(pathImpl.join(nvmDir, versions[0], 'bin'));
      }
    } catch {}

    const seen = new Set();
    const resolved = [];
    for (const directory of [...fallback, ...systemPaths, ...(env.PATH || '').split(':')]) {
      if (!directory || seen.has(directory)) continue;
      seen.add(directory);
      try {
        if (fsImpl.statSync(directory).isDirectory()) resolved.push(directory);
      } catch {}
    }
    return resolved.join(':');
  }

  return {
    resourcePath,
    projectRoot: () => isPackaged ? resourcesPath : projectDir,
    pythonExecutable,
    bundledNodeExecutable,
    pythonSitePackages,
    shellPath,
  };
}

function appendLines(target, contents) {
  for (const line of contents.split('\n')) {
    const entry = line.trim();
    if (entry) target.push(entry);
  }
}

module.exports = { createRuntimePaths };
