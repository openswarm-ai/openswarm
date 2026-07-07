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

  // mac: sign the .app bundle; win: sign the unpacked dir holding the exe + framework.
  const target = electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`)
    : appOutDir;
  const py = process.platform === 'win32' ? 'python' : 'python3';

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

exports.default = async function afterPack(context) {
  stageRouterNodeModules(context);
  // VMP signing runs last and unconditionally, after every file is staged, so the
  // OS code-sign that electron-builder runs next seals the VMP signature too.
  signVmp(context);
};
