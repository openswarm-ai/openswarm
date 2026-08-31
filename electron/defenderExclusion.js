// ENG-422: the Windows Defender exclusion, wired at last.
//
// Antivirus quarantining the bundled agent runtime left 22 of 25 affected installs permanently
// broken, and a real user answered the old card with "don't know how to take a file out of
// quarantine". The self-heal restores the file from the Squirrel package cache; an exclusion is
// what makes that restore STAY (the repair reports `retaken` when it does not).
//
// The rules this surface has to hold, all of them from the script's own .SECURITY block:
//   - Windows only. On any other platform this is not offered and cannot be invoked.
//   - OFF by default, and only ever flipped by the user in Settings. Never auto-run, never a
//     startup prompt, never a banner. Excluding a folder from Defender reduces AV coverage of it,
//     so the user owns that call.
//   - Fully reversible: turning it off runs the same script with -Remove.
//   - The elevation is Windows' own UAC dialog (Start-Process -Verb RunAs). We never ask for a
//     password and never hold one.

'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const SCRIPT_REL = path.join('backend', 'scripts', 'add-defender-exclusion.ps1');

// The script ships as a real file under Resources/backend (the whole backend tree is copied there),
// NOT inside app.asar: PowerShell cannot execute a path inside an asar archive.
function scriptPath(resourcesPath, devRoot) {
  const packaged = path.join(resourcesPath || '', SCRIPT_REL);
  if (resourcesPath && fs.existsSync(packaged)) return packaged;
  const dev = path.join(devRoot || '', SCRIPT_REL);
  return fs.existsSync(dev) ? dev : null;
}

// The argv handed to powershell.exe. Split out so a test can assert the exact shape without
// spawning anything: -Verb RunAs is what raises UAC, and the inner script gets exactly one switch.
function buildArgs(script, enable) {
  const inner = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', script,
    enable ? '-Apply' : '-Remove',
  ];
  // Quote for the nested PowerShell that Start-Process parses, and double any embedded quote so a
  // path with one in it cannot end the argument early.
  const quoted = inner.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
  return [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-Command',
    `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList ${quoted}`,
  ];
}

// Returns { ok, detail }. Never throws: a failed exclusion must leave the app working, and the
// toggle reverting is the honest signal that nothing was changed.
function applyDefenderExclusion({ enable, platform, resourcesPath, devRoot, spawnFn } = {}) {
  if (platform !== 'win32') {
    return Promise.resolve({ ok: false, detail: 'the Defender exclusion is a Windows-only setting' });
  }
  const script = scriptPath(resourcesPath, devRoot);
  if (!script) {
    return Promise.resolve({ ok: false, detail: 'the exclusion script is missing from this install' });
  }
  const run = spawnFn || spawn;
  return new Promise((resolve) => {
    let child;
    try {
      child = run('powershell.exe', buildArgs(script, enable), { windowsHide: true });
    } catch (e) {
      resolve({ ok: false, detail: `could not start PowerShell: ${e && e.message}` });
      return;
    }
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    child.on('error', (e) => done({ ok: false, detail: `PowerShell failed: ${e && e.message}` }));
    child.on('exit', (code) => done(
      code === 0
        ? { ok: true, detail: enable ? 'exclusion added' : 'exclusion removed' }
        // A non-zero exit is almost always the user declining UAC, which is a legitimate answer.
        : { ok: false, detail: 'the change was not approved, so nothing was altered' },
    ));
  });
}

module.exports = { applyDefenderExclusion, buildArgs, scriptPath, SCRIPT_REL };
