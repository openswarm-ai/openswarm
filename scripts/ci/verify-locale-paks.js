#!/usr/bin/env node
// Guards the empty-locale crashes on BOTH platforms. A packaged build MUST ship
// Chromium's locale .pak files.
// Windows: missing locales/en-US.pak launches the renderer with an EMPTY --lang
// and Blink's LCIDFromLocaleInternal null-derefs (STATUS_ACCESS_VIOLATION
// 0xC0000005) the instant a text/agent/webview surface mounts.
// macOS: missing en.lproj/locale.pak makes EVERY l10n_util string come back
// empty; the WebAuthn Touch ID path then passes that empty string as
// localizedReason to -[LAContext evaluateAccessControl:...], which raises an
// uncaught NSException and kills the whole app on any passkey prompt (the
// 1.5.3 "OS suicide"). electronLanguages naming is per-platform ("en" for mac
// .lproj dirs, "en-US" for win .pak files) and electron-builder silently
// deletes EVERYTHING when the name doesn't match, so we assert the artifact
// explicitly rather than trust the packager.

'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./lib/app-harness');

// The build intentionally trims locales to en-US via electronLanguages, so the
// count is small by design - the only thing that matters is that the locale the
// renderer resolves to (en-US.pak) is actually present. Zero paks / a missing
// en-US.pak is the crash condition.
const REQUIRED = 'en-US.pak';

function parseArgs(argv) {
  const out = { app: null };
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--app') out.app = argv[++i];
  return out;
}

function pakCount(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pak')); }
  catch { return null; }
}

function checkWinLinux(exe) {
  const dir = path.join(path.dirname(exe), 'locales');
  const paks = pakCount(dir);
  if (paks === null) return { ok: false, msg: `locales/ dir missing at ${dir}` };
  const hasReq = paks.some((p) => p.toLowerCase() === REQUIRED.toLowerCase());
  process.stdout.write(`  ${dir}: ${paks.length} paks, en-US.pak=${hasReq}\n`);
  if (!hasReq) return { ok: false, msg: `${REQUIRED} missing from ${dir} (${paks.length} paks present)` };
  return { ok: true, msg: `${paks.length} paks incl ${REQUIRED}` };
}

function checkMac(exe) {
  // mac stores locale paks as <lang>.lproj/locale.pak inside the Electron
  // Framework; chrome_100_percent/resources.pak do NOT count (they survive the
  // language strip that causes the crash), so require a real locale.pak.
  const appRoot = exe.slice(0, exe.indexOf('.app') + 4);
  const found = [];
  (function walk(d, depth) {
    if (depth > 8) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.toLowerCase() === 'locale.pak') found.push(full);
    }
  })(appRoot, 0);
  const hasEn = found.some((p) => path.basename(path.dirname(p)).toLowerCase() === 'en.lproj');
  process.stdout.write(`  mac: ${found.length} locale.pak file(s), en.lproj=${hasEn}\n`);
  if (!hasEn) return { ok: false, msg: `en.lproj/locale.pak missing (${found.length} locale paks under the bundle)` };
  return { ok: true, msg: `${found.length} locale paks incl en.lproj` };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const exe = h.packagedAppPath(args.app);
  const res = process.platform === 'darwin' ? checkMac(exe) : checkWinLinux(exe);
  if (res.ok) { process.stdout.write(`PASS  locale paks present (${res.msg})\n`); process.exit(0); }
  process.stderr.write(
    `FAIL  packaged build is MISSING Chromium locale paks: ${res.msg}\n` +
    `      Windows: renderer launches with an empty --lang and crashes in Blink's\n` +
    `      LCIDFromLocaleInternal (0xC0000005) on the first text/agent/webview mount.\n` +
    `      macOS: every l10n string is empty and the WebAuthn Touch ID prompt kills\n` +
    `      the whole app with an uncaught NSException (empty localizedReason).\n` +
    `      Fix: electronLanguages must list BOTH "en" (mac .lproj) and "en-US"\n` +
    `      (win locales/*.pak); a name miss makes electron-builder delete them all.\n`);
  process.exit(1);
}

main();
