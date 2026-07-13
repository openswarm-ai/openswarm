const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const DEFAULT_LANDING_URL = "https://openswarm.com";
const DEFAULT_CLOUD_URL = "https://api.openswarm.com";

const POLL_INTERVAL_MS = Number(process.env.OPENSWARM_AFFILIATE_POLL_INTERVAL_MS) || 5000;
const POLL_MAX_ATTEMPTS = Number(process.env.OPENSWARM_AFFILIATE_POLL_MAX_ATTEMPTS) || 12;
const FILENAME_ATTRIBUTION_WINDOW_MS =
  Number(process.env.OPENSWARM_AFFILIATE_FILENAME_WINDOW_MS) || 30 * 24 * 60 * 60 * 1000;
const INSTALLER_HASH_RE =
  /^OpenSwarm(?:-Setup)?-(?:arm64|x64)-([A-Za-z0-9_-]{16,32})(?: \([0-9]+\))?\.(dmg|exe|AppImage)$/i;
// Allow clock skew so a fresh installer is not discarded after an NTP adjustment.
const FUTURE_MTIME_TOLERANCE_MS = 60 * 1000;

function getStateFilePath(userDataDir) {
  return path.join(userDataDir, "install.json");
}

function readState(userDataDir) {
  const p = getStateFilePath(userDataDir);
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  return {};
}

function writeState(userDataDir, state) {
  const p = getStateFilePath(userDataDir);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Rename a complete temp file so termination cannot leave invalid JSON.
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, p);
  } catch (err) {
    console.warn("[affiliate] failed to write install.json:", err && err.message);
  }
}

const INSTALL_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

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
  } catch {}

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
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json();
    if (body && typeof body.ref === "string" && body.ref) return body.ref;
    return null;
  } catch {
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
  } catch {
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
  } catch {
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
      if (ageMs < -FUTURE_MTIME_TOLERANCE_MS || ageMs > FILENAME_ATTRIBUTION_WINDOW_MS) continue;
      out.push({ hash, path: fullPath, mtimeMs: st.mtimeMs });
    } catch {}
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
  p_readState: readState,
  p_writeState: writeState,
  p_hashFromInstallerBasename: hashFromInstallerBasename,
  p_findAffiliateHashFromInstaller: findAffiliateHashFromInstaller,
};
