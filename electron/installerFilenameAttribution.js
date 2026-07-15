// Recovers the affiliate hash stamped into the installer's FILENAME (OpenSwarm-<arch>-<hash>.dmg/exe/AppImage), so attribution survives a different-browser or late first launch that the welcome-page cookie flow loses. Scans Downloads/Desktop for a recent stamped installer; anything other than exactly one match falls back to the welcome flow.

const fs = require("fs");
const path = require("path");
const os = require("os");

const FILENAME_ATTRIBUTION_WINDOW_MS =
  Number(process.env.OPENSWARM_AFFILIATE_FILENAME_WINDOW_MS) || 30 * 24 * 60 * 60 * 1000;
const INSTALLER_HASH_RE =
  /^OpenSwarm(?:-Setup)?-(?:arm64|x64)-([A-Za-z0-9_-]{16,32})(?: \([0-9]+\))?\.(dmg|exe|AppImage)$/i;
// Allow clock skew so a fresh installer is not discarded after an NTP adjustment.
const FUTURE_MTIME_TOLERANCE_MS = 60 * 1000;

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

module.exports = {
  findAffiliateHashFromInstaller,
  hashFromInstallerBasename,
};
