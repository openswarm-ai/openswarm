// Affiliate / referral install tracking on the desktop side.
//
// On first launch the app opens https://openswarm.com/welcome?app_install_id=…
// in the user's default browser and polls the cloud's /api/install/lookup
// endpoint until a referral binding shows up (or we time out). The browser
// page is what actually performs the bind: it reads the install_token that
// the landing page stashed in localStorage / cookie when the user clicked
// Download, and POSTs it to the cloud paired with our app_install_id.
//
// State lives in `<userData>/install.json`. The shape:
//   {
//     app_install_id: "uuid",          // unified install id, see resolveInstallId()
//     first_launch_at: 1700000000000,  // unix ms; presence = "this isn't first launch"
//     ref: "haik" | null,              // populated once lookup succeeds
//     ref_bound_at: 1700000000000 | null,
//     ref_bind_method: "affiliate_filename_hash" | null,
//     attempts: 0                       // last polling attempt count, for debugging
//   }
//
// Skipped entirely in dev unless OPENSWARM_AFFILIATE_FORCE=1 is set, so
// `bash run.sh` doesn't pop a browser tab on every restart.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const DEFAULT_LANDING_URL = "https://openswarm.com";
const DEFAULT_CLOUD_URL = "https://api.openswarm.com";

// Polling: 12 attempts, 5s apart = 60s window. Generous enough for the user
// to actually click through the welcome page; small enough that a stuck
// poll doesn't sit around all day. The page itself is fast (single POST)
// so most binds land in the first one or two ticks.
//
// Both knobs are overridable via env so tests can drive a 200ms × 5
// poll window instead of 60s.
const POLL_INTERVAL_MS = Number(process.env.OPENSWARM_AFFILIATE_POLL_INTERVAL_MS) || 5000;
const POLL_MAX_ATTEMPTS = Number(process.env.OPENSWARM_AFFILIATE_POLL_MAX_ATTEMPTS) || 12;
const FILENAME_ATTRIBUTION_WINDOW_MS =
  Number(process.env.OPENSWARM_AFFILIATE_FILENAME_WINDOW_MS) || 30 * 24 * 60 * 60 * 1000;
const INSTALLER_HASH_RE =
  /^OpenSwarm(?:-Setup)?-(?:arm64|x64)-([A-Za-z0-9_-]{16,32})(?: \([0-9]+\))?\.(dmg|exe|AppImage)$/i;

function getStateFilePath(userDataDir) {
  return path.join(userDataDir, "install.json");
}

function readState(userDataDir) {
  const p = getStateFilePath(userDataDir);
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (_) {}
  return {};
}

function writeState(userDataDir, state) {
  const p = getStateFilePath(userDataDir);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Atomic-ish write: temp file + rename. Avoids leaving a half-written
    // install.json if the process is killed mid-write (which would brick
    // first-launch detection on the next start).
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, p);
  } catch (err) {
    console.warn("[affiliate] failed to write install.json:", err && err.message);
  }
}

// --------------------------------------------------------------------------
// Unified install identity.
//
// The desktop historically had TWO per-install ids that never met: this
// module's app_install_id (install.json, affiliate handshake) and the Python
// backend's settings.installation_id (analytics envelope). Affiliate data
// could therefore only join to analytics through a signed-in user — and
// sign-in is optional. resolveInstallId collapses them into one value:
// main.js calls it BEFORE spawning the backend and exports the result as
// OPENSWARM_INSTALLATION_ID, so install_tokens.app_install_id in the cloud
// and the analytics install_id carry the same id and affiliate refs join
// directly to telemetry with no sign-in required.
//
// Resolution order (first hit wins):
//   1. install.json app_install_id — continuity for installs that already
//      ran the affiliate handshake
//   2. python settings.json installation_id — upgrades adopt the existing
//      analytics identity instead of minting a second one
//   3. fresh crypto.randomUUID(), persisted to install.json immediately so
//      every later reader (handshake, renderer, next boot) agrees on it

const INSTALL_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

// Mirrors backend/config/paths.py: packaged data root is per-OS app support;
// dev is <projectRoot>/backend/data.
function pythonSettingsFile({ isPackaged, projectRoot, platform, env, homeDir }) {
  if (!isPackaged) {
    return path.join(projectRoot, "backend", "data", "settings", "settings.json");
  }
  let appSupport;
  if (platform === "darwin") {
    appSupport = path.join(homeDir, "Library", "Application Support", "OpenSwarm");
  } else if (platform === "win32") {
    appSupport = path.join(env.APPDATA || homeDir, "OpenSwarm");
  } else {
    appSupport = path.join(env.XDG_DATA_HOME || path.join(homeDir, ".local", "share"), "OpenSwarm");
  }
  return path.join(appSupport, "data", "settings", "settings.json");
}

function resolveInstallId({
  userDataDir,
  isPackaged,
  projectRoot,
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
}) {
  const state = readState(userDataDir);
  if (typeof state.app_install_id === "string" && INSTALL_ID_RE.test(state.app_install_id)) {
    return state.app_install_id;
  }

  try {
    const settingsPath = pythonSettingsFile({ isPackaged, projectRoot, platform, env, homeDir });
    const iid = JSON.parse(fs.readFileSync(settingsPath, "utf8")).installation_id;
    if (typeof iid === "string" && INSTALL_ID_RE.test(iid)) {
      writeState(userDataDir, { ...state, app_install_id: iid });
      return iid;
    }
  } catch (_) {}

  const freshId = crypto.randomUUID();
  writeState(userDataDir, { ...state, app_install_id: freshId });
  return freshId;
}

function urlsFromEnv() {
  return {
    landingUrl: (process.env.OPENSWARM_AFFILIATE_LANDING_URL || DEFAULT_LANDING_URL).replace(/\/$/, ""),
    cloudUrl: (process.env.OPENSWARM_AFFILIATE_CLOUD_URL || DEFAULT_CLOUD_URL).replace(/\/$/, ""),
  };
}

async function pollLookupOnce(cloudUrl, appInstallId) {
  const url = `${cloudUrl}/api/install/lookup?app_install_id=${encodeURIComponent(appInstallId)}`;
  // Node 18+ ships global fetch; Electron 40 is on a Chromium that has it.
  // Defensive timeout via AbortSignal.timeout (Node 17+).
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json();
    if (body && typeof body.ref === "string" && body.ref) return body.ref;
    return null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function bindAffiliateHashOnce(cloudUrl, appInstallId, affiliateHash) {
  const url = `${cloudUrl}/api/install/bind`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ affiliate_hash: affiliateHash, app_install_id: appInstallId }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body && typeof body.ref === "string" && body.ref) return body.ref;
    return null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function hashFromInstallerBasename(filePath) {
  const base = path.basename(String(filePath || ""));
  const m = INSTALLER_HASH_RE.exec(base);
  return m ? m[1] : null;
}

function likelyDownloadDirs(homeDir) {
  if (!homeDir) return [];
  return [path.join(homeDir, "Downloads"), path.join(homeDir, "Desktop")];
}

function recentInstallerHashesInDir(dir, nowMs) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const hash = hashFromInstallerBasename(entry.name);
    if (!hash) continue;
    const fullPath = path.join(dir, entry.name);
    try {
      const st = fs.statSync(fullPath);
      const ageMs = nowMs - st.mtimeMs;
      if (ageMs < 0 || ageMs > FILENAME_ATTRIBUTION_WINDOW_MS) continue;
      out.push({ hash, path: fullPath, mtimeMs: st.mtimeMs });
    } catch (_) {}
  }
  return out;
}

function findAffiliateHashFromInstaller({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  nowMs = Date.now(),
} = {}) {
  if (platform === "linux") {
    return hashFromInstallerBasename(env.APPIMAGE);
  }

  if (platform !== "darwin" && platform !== "win32") {
    return null;
  }

  const matches = [];
  for (const dir of likelyDownloadDirs(homeDir)) {
    matches.push(...recentInstallerHashesInDir(dir, nowMs));
  }
  if (matches.length !== 1) {
    if (matches.length > 1) {
      console.log("[affiliate] multiple stamped installers found; falling back to welcome flow");
    }
    return null;
  }
  return matches[0].hash;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntilBound({ cloudUrl, appInstallId, userDataDir }) {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await delay(POLL_INTERVAL_MS);
    const ref = await pollLookupOnce(cloudUrl, appInstallId);
    const state = readState(userDataDir);
    state.attempts = i + 1;
    if (ref) {
      state.ref = ref;
      state.ref_bound_at = Date.now();
      writeState(userDataDir, state);
      console.log(`[affiliate] bound ref=${ref} after ${i + 1} attempt(s)`);
      return ref;
    }
    writeState(userDataDir, state);
  }
  console.log("[affiliate] no bind after polling window; giving up silently");
  return null;
}

// Public entry: call once from app.whenReady() after backend is up. Safe to
// call on every launch — internal first-launch check makes subsequent calls
// a no-op. `shell` is electron's shell module, passed in to avoid this
// module needing to require electron at the top (keeps it test-friendly).
async function maybeRunFirstLaunchHandshake({
  shell,
  userDataDir,
  isDev,
  isPackaged,
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
}) {
  // Skip in dev to avoid spawning a browser tab on every `bash run.sh`.
  // OPENSWARM_AFFILIATE_FORCE=1 lets us actually exercise the flow against
  // a local landing page + local cloud during integration testing.
  if (isDev && process.env.OPENSWARM_AFFILIATE_FORCE !== "1") {
    return;
  }

  const state = readState(userDataDir);
  if (state.first_launch_at) {
    // Returning launch. If we never managed to bind a ref, optionally try
    // again — but only for a short grace window after the original launch
    // (24h) so we don't pop a browser tab on someone who's been using the
    // app for a month.
    const ageMs = Date.now() - Number(state.first_launch_at || 0);
    const stillInGracePeriod = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000;
    if (state.ref || !stillInGracePeriod || !state.app_install_id) {
      return;
    }
    // Within grace window and still no ref — silently re-poll (no second
    // browser pop-up) in case the user hasn't completed the welcome page
    // handshake yet.
    pollUntilBound({
      cloudUrl: urlsFromEnv().cloudUrl,
      appInstallId: state.app_install_id,
      userDataDir,
    }).catch(() => {});
    return;
  }

  // First launch. Reuse the id resolveInstallId persisted before the backend
  // spawned (the unified install id); only generate here if main.js never
  // resolved one (e.g. direct module use in tests).
  const appInstallId =
    typeof state.app_install_id === "string" && INSTALL_ID_RE.test(state.app_install_id)
      ? state.app_install_id
      : crypto.randomUUID();
  const now = Date.now();
  const fresh = {
    app_install_id: appInstallId,
    first_launch_at: now,
    ref: null,
    ref_bound_at: null,
    attempts: 0,
  };
  writeState(userDataDir, fresh);

  const { landingUrl, cloudUrl } = urlsFromEnv();
  const affiliateHash = findAffiliateHashFromInstaller({ platform, env, homeDir });
  if (affiliateHash) {
    const ref = await bindAffiliateHashOnce(cloudUrl, appInstallId, affiliateHash);
    if (ref) {
      const bound = {
        ...fresh,
        ref,
        ref_bound_at: Date.now(),
        ref_bind_method: "affiliate_filename_hash",
      };
      writeState(userDataDir, bound);
      console.log(`[affiliate] bound filename hash ref=${ref}; skipping welcome URL`);
      return;
    }
    console.log("[affiliate] filename hash bind failed; falling back to welcome flow");
  }

  const welcomeUrl = `${landingUrl}/welcome?app_install_id=${encodeURIComponent(appInstallId)}`;

  console.log(`[affiliate] first launch: opening ${welcomeUrl}`);
  try {
    if (shell && typeof shell.openExternal === "function") {
      await shell.openExternal(welcomeUrl);
    }
  } catch (err) {
    console.warn("[affiliate] failed to open welcome URL:", err && err.message);
  }

  // Fire-and-forget the polling loop. We intentionally don't await it from
  // app.whenReady() so backend / window startup stays unblocked.
  pollUntilBound({ cloudUrl, appInstallId, userDataDir }).catch((err) => {
    console.warn("[affiliate] poll loop crashed:", err && err.message);
  });
}

module.exports = {
  maybeRunFirstLaunchHandshake,
  resolveInstallId,
  // Exported for tests + IPC handlers.
  _readState: readState,
  _writeState: writeState,
  _getStateFilePath: getStateFilePath,
  _pollLookupOnce: pollLookupOnce,
  _bindAffiliateHashOnce: bindAffiliateHashOnce,
  _hashFromInstallerBasename: hashFromInstallerBasename,
  _findAffiliateHashFromInstaller: findAffiliateHashFromInstaller,
};
