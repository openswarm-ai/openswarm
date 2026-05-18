// First-launch affiliate ref capture: opens welcome page, polls cloud lookup, persists to install.json.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_LANDING_URL = "https://openswarm.com";
const DEFAULT_CLOUD_URL = "https://api.openswarm.com";

// 12 attempts * 5s = 60s window; env-overridable for tests.
const POLL_INTERVAL_MS = Number(process.env.OPENSWARM_AFFILIATE_POLL_INTERVAL_MS) || 5000;
const POLL_MAX_ATTEMPTS = Number(process.env.OPENSWARM_AFFILIATE_POLL_MAX_ATTEMPTS) || 12;

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
    // Atomic write so kill mid-write doesn't brick first-launch detection.
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, p);
  } catch (err) {
    console.warn("[affiliate] failed to write install.json:", err && err.message);
  }
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
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
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

/** Run once from app.whenReady(); idempotent across launches. */
async function maybeRunFirstLaunchHandshake({ shell, userDataDir, isDev, isPackaged }) {
  if (isDev && process.env.OPENSWARM_AFFILIATE_FORCE !== "1") {
    return;
  }

  const state = readState(userDataDir);
  if (state.first_launch_at) {
    // Re-poll on returning launches only within a 24h grace; don't spam old installs.
    const ageMs = Date.now() - Number(state.first_launch_at || 0);
    const stillInGracePeriod = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000;
    if (state.ref || !stillInGracePeriod || !state.app_install_id) {
      return;
    }
    pollUntilBound({
      cloudUrl: urlsFromEnv().cloudUrl,
      appInstallId: state.app_install_id,
      userDataDir,
    }).catch(() => {});
    return;
  }

  const appInstallId = crypto.randomUUID();
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
  const welcomeUrl = `${landingUrl}/welcome?app_install_id=${encodeURIComponent(appInstallId)}`;

  console.log(`[affiliate] first launch: opening ${welcomeUrl}`);
  try {
    if (shell && typeof shell.openExternal === "function") {
      await shell.openExternal(welcomeUrl);
    }
  } catch (err) {
    console.warn("[affiliate] failed to open welcome URL:", err && err.message);
  }

  pollUntilBound({ cloudUrl, appInstallId, userDataDir }).catch((err) => {
    console.warn("[affiliate] poll loop crashed:", err && err.message);
  });
}

module.exports = {
  maybeRunFirstLaunchHandshake,
  _readState: readState,
  _writeState: writeState,
  _getStateFilePath: getStateFilePath,
  _pollLookupOnce: pollLookupOnce,
};
