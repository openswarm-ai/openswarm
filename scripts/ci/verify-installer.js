#!/usr/bin/env node
// Verifies the Windows NSIS installer: default safely observes an existing install (dir, an uninstaller that exists, shortcuts); --destructive runs install->verify->uninstall but refuses to clobber an existing install unless --force (clean machine / CI).

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const h = require('./lib/app-harness');

function parseArgs(argv) {
  const out = { setup: null, destructive: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--setup') out.setup = argv[++i];
    else if (argv[i] === '--destructive') out.destructive = true;
    else if (argv[i] === '--force') out.force = true;
  }
  return out;
}

const INSTALL_DIR = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenSwarm');
const DATA_DIR = path.join(process.env.APPDATA || '', 'OpenSwarm');
const failures = [];
const ok = (m) => process.stdout.write(`  ok   ${m}\n`);
const bad = (m) => { failures.push(m); process.stdout.write(`  FAIL ${m}\n`); };
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } }

function defaultSetup() {
  const p = path.join(h.REPO_ROOT, 'electron', 'dist', 'OpenSwarm-Setup-x64.exe');
  return exists(p) ? p : null;
}

// The shipped installer must be a real, complete PE (catch a 0-byte stub or truncated upload).
function checkSetupArtifact(setup) {
  process.stdout.write(`Setup.exe: ${setup}\n`);
  if (!exists(setup)) { bad(`Setup.exe missing at ${setup}`); return; }
  const size = fs.statSync(setup).size;
  if (size < 50 * 1024 * 1024) bad(`Setup.exe is only ${size} bytes (truncated? expected >50MB)`);
  else ok(`Setup.exe size ${(size / 1048576).toFixed(0)} MB`);
  const fd = fs.openSync(setup, 'r'); const b = Buffer.alloc(2); fs.readSync(fd, b, 0, 2, 0); fs.closeSync(fd);
  if (b.toString('latin1') !== 'MZ') bad('Setup.exe is not a valid PE (no MZ header)'); else ok('valid PE (MZ) header');
}

function regUninstall() {
  try {
    const ps = `$ErrorActionPreference='SilentlyContinue'; Get-ChildItem 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | ForEach-Object { $p=Get-ItemProperty $_.PSPath; if ($p.DisplayName -like '*OpenSwarm*') { $p.DisplayName + '|' + $p.QuietUninstallString } }`;
    return execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

function uninstallerPathFromReg(reg) {
  const m = reg.match(/"([^"]*Uninstall OpenSwarm\.exe)"/i) || reg.match(/([A-Za-z]:\\[^|]*Uninstall OpenSwarm\.exe)/i);
  return m ? m[1] : null;
}

function findShortcuts() {
  const dirs = [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(os.homedir(), 'Desktop'),
    path.join(process.env.USERPROFILE || '', 'OneDrive', 'Desktop'),
  ];
  const found = [];
  for (const d of dirs) {
    try { for (const f of fs.readdirSync(d)) if (/openswarm.*\.lnk/i.test(f)) found.push(path.join(d, f)); } catch { /* */ }
  }
  return found;
}

// Assert the on-disk + registry state a correct install produces (used by both observe and destructive).
function assertInstalled() {
  if (!exists(INSTALL_DIR)) { bad(`install dir missing: ${INSTALL_DIR}`); return; }
  ok(`install dir present: ${INSTALL_DIR}`);
  for (const f of ['OpenSwarm.exe', 'resources', 'locales']) {
    if (exists(path.join(INSTALL_DIR, f))) ok(`contains ${f}`); else bad(`install dir missing ${f}`);
  }
  const reg = regUninstall();
  if (!/OpenSwarm/i.test(reg)) bad('no OpenSwarm uninstall entry in HKCU registry');
  else {
    ok(`uninstall registry entry: ${reg.split('|')[0]}`);
    const up = uninstallerPathFromReg(reg);
    // A registered uninstaller whose target is missing is an orphaned "can't uninstall" bug, so assert it exists.
    if (!up) bad('uninstall entry has no parseable uninstaller path');
    else if (!exists(up)) bad(`uninstaller registered but missing on disk: ${up}`);
    else ok(`uninstaller exists: ${up}`);
  }
  const sc = findShortcuts();
  if (sc.length) ok(`shortcut(s): ${sc.join(', ')}`);
  else process.stdout.write('  warn shortcuts not found (location varies; non-fatal)\n');
}

function killRunning() {
  try { execSync('taskkill /IM OpenSwarm.exe /T /F', { stdio: 'ignore' }); } catch { /* none */ }
}

function runDestructive(setup) {
  if (exists(INSTALL_DIR) && !process.argv.includes('--force')) {
    bad(`refusing --destructive: an install already exists at ${INSTALL_DIR}. Running would clobber it. Use a clean machine/CI, or --force if you really mean it.`);
    return;
  }
  process.stdout.write('\n[destructive] installing silently...\n');
  killRunning();
  const installedExe = path.join(INSTALL_DIR, 'OpenSwarm.exe');
  // Blocking: spawnSync returns only once the installer has fully finished
  // (files + registry uninstall entry + shortcuts are all written, the last of
  // which assertInstalled checks). The timeout is the safety net: the silent
  // path now skips the unbounded --prewarm step (see installer-recovery.nsh), so
  // a clean extract finishes well inside this, but if a future installer change
  // reintroduces a synchronous stall this fails the gate in minutes instead of
  // hanging the whole job until it is force-cancelled.
  const inst = spawnSync(setup, ['/S'], { stdio: 'inherit', timeout: 300000 });
  if (inst.error) bad(`Setup.exe /S did not complete: ${inst.error.message}`);
  else if (inst.status !== 0 && inst.status !== null) bad(`Setup.exe /S exited ${inst.status}`);
  // oneClick installer can return microseconds before the exe handle settles.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !exists(installedExe)) { execSync('powershell -NoProfile -Command "Start-Sleep -Milliseconds 1000"'); }
  killRunning();   // defensive: ensure nothing the installer launched is holding the dir
  assertInstalled();

  // Launch the INSTALLED exe through the full gate (boot/serve/provenance/etc.).
  if (exists(installedExe)) {
    process.stdout.write('\n[destructive] verifying the INSTALLED app...\n');
    const v = spawnSync(process.execPath, [path.join(__dirname, 'verify-all.js'), '--app', installedExe], { stdio: 'inherit' });
    if (v.status !== 0) bad('verify-all against the installed app failed');
  }

  process.stdout.write('\n[destructive] uninstalling silently...\n');
  killRunning();
  const reg = regUninstall();
  const up = uninstallerPathFromReg(reg);
  if (up && exists(up)) { const un = spawnSync(up, ['/currentuser', '/S'], { stdio: 'inherit' }); if (un.status) bad(`uninstaller exited ${un.status}`); }
  else bad('could not find the uninstaller to run');
  const delDeadline = Date.now() + 60000;
  while (Date.now() < delDeadline && exists(path.join(INSTALL_DIR, 'OpenSwarm.exe'))) { execSync('powershell -NoProfile -Command "Start-Sleep -Milliseconds 1000"'); }
  if (exists(path.join(INSTALL_DIR, 'OpenSwarm.exe'))) bad('uninstall left OpenSwarm.exe behind');
  else ok('uninstall removed the app');
  // deleteAppDataOnUninstall:false - user data MUST survive an uninstall.
  if (exists(DATA_DIR)) ok(`user data preserved across uninstall: ${DATA_DIR}`);
  else process.stdout.write('  warn no data dir to check (app may never have run here)\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.platform !== 'win32') { process.stdout.write('SKIP: NSIS installer check is Windows-only.\n'); process.exit(0); }
  const setup = args.setup || defaultSetup();
  if (!setup) { process.stderr.write('INSTALLER FAIL: no Setup.exe found; build first or pass --setup.\n'); process.exit(1); }

  checkSetupArtifact(setup);

  if (args.destructive) {
    runDestructive(setup);
  } else if (exists(INSTALL_DIR)) {
    process.stdout.write('\nObserving existing install (safe; no changes):\n');
    assertInstalled();
  } else {
    process.stdout.write('\nNo install present to observe. Run with --destructive on a CLEAN machine/CI for the full install->verify->uninstall cycle.\n');
  }

  if (failures.length) { process.stderr.write(`\nINSTALLER FAIL: ${failures.length} problem(s).\n`); process.exit(1); }
  process.stdout.write('\nINSTALLER PASS.\n');
  process.exit(0);
}

main();
