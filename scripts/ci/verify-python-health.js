#!/usr/bin/env node
// Asserts the bundled python interpreter actually runs. Missing VCRedist DLL on Windows, a broken framework bundle on mac, or a truncated python-env mid-build all give "renderer up, backend never connects" with no clear cause. Running --version + a tiny import smoke catches it before the build ships.

'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const h = require('./lib/app-harness');

function parseArgs(argv) {
  const out = { app: null };
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--app') out.app = argv[++i];
  return out;
}

// Resolve the bundled python binary relative to the packaged app root.
function pythonBin(appExe) {
  if (process.platform === 'win32') {
    return path.join(path.dirname(appExe), 'resources', 'python-env', 'python.exe');
  }
  if (process.platform === 'darwin') {
    // Inside the .app bundle: Contents/Resources/python-env/bin/python3
    const i = appExe.indexOf('.app');
    const appRoot = i === -1 ? appExe : appExe.slice(0, i + 4);
    return path.join(appRoot, 'Contents', 'Resources', 'python-env', 'bin', 'python3');
  }
  return path.join(path.dirname(appExe), 'resources', 'python-env', 'bin', 'python3');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const appExe = h.packagedAppPath(args.app);
  const py = pythonBin(appExe);
  process.stdout.write(`Bundled python: ${py}\n`);

  if (!fs.existsSync(py)) { process.stderr.write(`\nPYTHON-HEALTH FAIL: ${py} not found (build did not stage python-env, or wrong path)\n`); process.exit(1); }

  // 1) --version: catches DLL/dyld load failures instantly.
  const v = spawnSync(py, ['--version'], { encoding: 'utf8', timeout: 30000 });
  if (v.status !== 0) {
    process.stderr.write(`\nPYTHON-HEALTH FAIL: python --version exited ${v.status}\n`);
    process.stderr.write(`  stdout: ${(v.stdout || '').trim()}\n`);
    process.stderr.write(`  stderr: ${(v.stderr || '').trim()}\n`);
    process.exit(1);
  }
  // Output goes to stdout or stderr depending on python version; treat both.
  const versionLine = ((v.stdout || '') + (v.stderr || '')).trim();
  const m = versionLine.match(/Python (\d+)\.(\d+)\.(\d+)/);
  if (!m) { process.stderr.write(`\nPYTHON-HEALTH FAIL: could not parse version from "${versionLine}"\n`); process.exit(1); }
  const [, maj, min] = m;
  if (Number(maj) !== 3 || Number(min) < 13) {
    process.stderr.write(`\nPYTHON-HEALTH FAIL: bundled python is ${maj}.${min}, expected 3.13+ (backend requires 3.13 features)\n`);
    process.exit(1);
  }
  process.stdout.write(`  ok python ${versionLine}\n`);

  // 1b) macOS: the bundled python's arch slices must cover the app's. An arm64
  // python inside the x64 app RUNS on an arm64 build host (native, not Rosetta),
  // so --version alone can never catch the cross-arch bundle bug that bricked
  // every Intel Mac. lipo compares what the file IS, not what the host can run.
  if (process.platform === 'darwin') {
    const i = appExe.indexOf('.app');
    const appRoot = i === -1 ? appExe : appExe.slice(0, i + 4);
    const mainBin = path.join(appRoot, 'Contents', 'MacOS', path.basename(appRoot, '.app'));
    const archsOf = (bin) => {
      const r = spawnSync('lipo', ['-archs', bin], { encoding: 'utf8', timeout: 15000 });
      if (r.status !== 0) return null;
      return (r.stdout || '').trim().split(/\s+/).filter(Boolean);
    };
    const appArchs = archsOf(mainBin);
    const pyArchs = archsOf(fs.realpathSync(py));
    if (!appArchs || !pyArchs) {
      process.stderr.write(`\nPYTHON-HEALTH FAIL: lipo could not read archs (app=${appArchs}, python=${pyArchs})\n`);
      process.exit(1);
    }
    const missing = appArchs.filter((a) => !pyArchs.includes(a));
    if (missing.length > 0) {
      process.stderr.write(`\nPYTHON-HEALTH FAIL: app is [${appArchs}] but bundled python is [${pyArchs}] (missing ${missing}). This build would brick ${missing.join('/')} Macs.\n`);
      process.exit(1);
    }
    process.stdout.write(`  ok arch match (app [${appArchs}] / python [${pyArchs}])\n`);
  }

  // 2) Import smoke: load the heaviest deps to catch a half-extracted site-packages tree (rare but lethal).
  const smoke = spawnSync(py, ['-c', 'import sys, fastapi, anthropic, pydantic, httpx, jsonschema; print(sys.version_info[:3])'], { encoding: 'utf8', timeout: 30000 });
  if (smoke.status !== 0) {
    process.stderr.write(`\nPYTHON-HEALTH FAIL: import smoke exited ${smoke.status}\n`);
    process.stderr.write(`  stderr: ${(smoke.stderr || '').trim()}\n`);
    process.exit(1);
  }
  process.stdout.write(`  ok backend deps importable (${(smoke.stdout || '').trim()})\n`);

  process.stdout.write('\nPYTHON-HEALTH PASS: bundled interpreter runs and the backends heaviest deps import cleanly.\n');
  process.exit(0);
}

main();
