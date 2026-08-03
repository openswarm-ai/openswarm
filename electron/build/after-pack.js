'use strict';
// electron-builder 26 special-excludes node_modules from extraResources (25 did
// not), so the bundled 9Router - a Next.js standalone whose server.js does
// require('next') - ships WITHOUT its deps. The result: 9Router dies with
// "Cannot find module 'next'", never binds :20128, and the Models tab spins on
// "Starting subscription service..." forever. We copy router/node_modules into
// the packed app HERE rather than after electron-builder finishes, because
// afterPack runs BEFORE code-signing: on macOS the whole .app is sealed by the
// signature, so injecting files post-sign would invalidate it. The .next dotdir
// is handled by the package.json extraResources filter; only node_modules needs
// this rescue.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Widevine VMP signing of the PACKAGED app. Has to happen here in afterPack, not
// at npm-install time on node_modules: the OS code-sign electron-builder runs
// right after this seals the VMP signature into the bundle, so signing the source
// electron earlier gets stripped/relocated and Spotify's license server then 500s.
// Lenient by default (a dev `npm run dist` without an EVS account still produces an
// app, just with limited DRM); VMP_REQUIRE_SIGN=1 (set by the signed release paths)
// turns a missing/failed signature into a hard build failure so prod never ships
// an unsigned-for-DRM client silently.
// The EVS client is a pip package, and a system python3 on a modern Mac refuses to install into
// itself (PEP 668). scripts/setup-evs.sh therefore puts it in its own venv, so look there before
// falling back to whatever `python3` means today. Without this the creds can be perfectly correct
// and the sign still dies on ModuleNotFoundError, ten minutes into a release build.
function resolveEvsPython() {
  if (process.platform === 'win32') return 'python';
  const venv = path.join(os.homedir(), '.openswarm-evs-venv', 'bin', 'python');
  if (fs.existsSync(venv)) {
    try {
      execFileSync(venv, ['-c', 'import castlabs_evs'], { stdio: 'ignore' });
      return venv;
    } catch { /* venv exists but lacks the package; fall through */ }
  }
  return 'python3';
}

function signVmp(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const required = process.env.VMP_REQUIRE_SIGN === '1';
  const acct = process.env.EVS_ACCOUNT_NAME;
  const pass = process.env.EVS_PASSWD;

  if (!acct || !pass) {
    if (required) {
      throw new Error('[afterPack] VMP_REQUIRE_SIGN=1 but EVS_ACCOUNT_NAME/EVS_PASSWD are absent — refusing to ship a release whose Widevine DRM (Spotify/Netflix) would be dead');
    }
    console.warn('[afterPack] EVS creds absent — skipping VMP signing; DRM playback will be limited (dev build)');
    return;
  }

  // Both platforms: hand it the CONTAINING directory, never the .app itself. sign-pkg globs
  // `<dir>/*.app`, so pointing at the bundle makes it search inside for a nested one and die with
  // "No matching executable found" while the app sits right there.
  const target = appOutDir;
  const py = resolveEvsPython();

  try {
    console.log(`[afterPack] VMP-signing ${target}`);
    // Creds go via the environment (EVS reads EVS_ACCOUNT_NAME/EVS_PASSWD), never on
    // the argv — a password in a command line is readable by any `ps` on the host.
    // --no-ask is a GLOBAL castlabs flag; it must precede the subcommand or vmp.py rejects it (killed the first 1.5.5 release run).
    execFileSync(py, ['-m', 'castlabs_evs.vmp', '--no-ask', 'sign-pkg', target], {
      stdio: 'inherit',
      env: { ...process.env, EVS_ACCOUNT_NAME: acct, EVS_PASSWD: pass },
    });
    console.log('[afterPack] VMP signing successful — full DRM playback enabled');
  } catch (err) {
    if (required) {
      throw new Error(`[afterPack] VMP signing failed (release would have broken DRM): ${err && err.message}`);
    }
    console.warn(`[afterPack] VMP signing failed (non-fatal in dev): ${err && err.message}`);
  }
}

function stageRouterNodeModules(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const src = path.join(__dirname, '..', 'build-staging', 'router', 'node_modules');
  if (!fs.existsSync(src)) return; // dev/no-router build; nothing to do

  let routerDir;
  if (electronPlatformName === 'darwin') {
    const appName = packager.appInfo.productFilename; // "OpenSwarm"
    routerDir = path.join(appOutDir, `${appName}.app`, 'Contents', 'Resources', 'router');
  } else {
    routerDir = path.join(appOutDir, 'resources', 'router');
  }
  if (!fs.existsSync(routerDir)) return; // router not staged into this target

  const dest = path.join(routerDir, 'node_modules');
  if (!fs.existsSync(dest)) {
    fs.cpSync(src, dest, { recursive: true });
  }
  if (!fs.existsSync(path.join(dest, 'next'))) {
    throw new Error(`afterPack: 9Router node_modules/next missing in ${routerDir} after copy`);
  }
  console.log(`[afterPack] staged 9Router node_modules into ${routerDir}`);
}

// prebuildify packages (uiohook-napi and friends) ship a .node for EVERY platform+arch they support.
// Six of the seven are dead weight in any one build, and on macOS an x86_64 Mach-O sitting inside an
// arm64 bundle is what makes the OS put up its Intel-deprecation dialog. node-gyp-build only ever
// looks in prebuilds/<platform>-<arch>, so deleting the rest is invisible to the app. Runs here in
// afterPack because code-signing comes next and seals the bundle; a later delete breaks the seal.
function pruneForeignPrebuilds(context) {
  const { appOutDir, electronPlatformName, arch } = context;
  // Read the arch name off electron-builder's own enum rather than hardcoding its numbering.
  const archName = require('builder-util').Arch[arch];
  const root = electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');
  let removed = 0;

  (function walk(dir, depth) {
    if (depth > 12) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name !== 'prebuilds') { walk(full, depth + 1); continue; }
      for (const tuple of fs.readdirSync(full, { withFileTypes: true })) {
        // prebuildify names dirs "<platform>-<arch>", sometimes fat: "darwin-x64+arm64".
        const [tuplePlatform, archPart] = tuple.name.split('-');
        const covers = tuplePlatform === electronPlatformName && String(archPart || '').split('+').includes(archName);
        if (covers) continue;
        fs.rmSync(path.join(full, tuple.name), { recursive: true, force: true });
        removed += 1;
      }
    }
  })(root, 0);

  console.log(`[afterPack] pruned ${removed} foreign prebuild dir(s), kept ${electronPlatformName}-${archName}`);
}

exports.default = async function afterPack(context) {
  stageRouterNodeModules(context);
  pruneForeignPrebuilds(context);
  // VMP signing runs last and unconditionally, after every file is staged, so the
  // OS code-sign that electron-builder runs next seals the VMP signature too.
  signVmp(context);
};
