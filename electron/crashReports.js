// ENG-102: a crash without a report blinds every other crash bug. Each fatal signal writes one
// JSON report (metadata + the backend log tail) into userData/crash-reports and, when possible,
// tells the user where it landed. Renderer/GPU deaths and main-process throws all route here.
const path = require('path');
const fs = require('fs');

const MAX_REPORTS = 30;
const LOG_TAIL_BYTES = 64 * 1024;
// A fault that repeats is the normal case, not the rare one, and each report costs a 64KB log read
// plus a 68KB write. Without these two caps one stuck fault turns the reporter into a disk hog: a
// live 1.7.6-exp2 loop wrote 30 identical reports in 36ms. Same fault inside the window is counted,
// not rewritten, and a session can never spend more than CAP reports total.
const DEDUPE_WINDOW_MS = 60_000;
const MAX_REPORTS_PER_SESSION = 20;

let p_app = null;
let p_notify = null;
let p_written = 0;
const p_lastByFingerprint = new Map();

function init(app, notifyFn) {
  p_app = app;
  p_notify = notifyFn || null;
  p_written = 0;
  p_lastByFingerprint.clear();
}

function reportsDir() {
  const dir = path.join(p_app.getPath('userData'), 'crash-reports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function backendLogTail() {
  try {
    const logPath = path.join(p_app.getPath('userData'), 'data', 'backend.log');
    const size = fs.statSync(logPath).size;
    const fd = fs.openSync(logPath, 'r');
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (_) {
    return '';
  }
}

function prune(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    while (files.length > MAX_REPORTS) fs.unlinkSync(path.join(dir, files.shift()));
  } catch (_) {}
}

// Kind plus the first stack frame: enough to tell two different faults apart, stable across laps of
// the same one (the timestamps and line noise below it are not).
function fingerprint(kind, details) {
  const stack = details && typeof details === 'object' ? String(details.stack || details.message || '') : String(details || '');
  return kind + '|' + stack.split('\n').slice(0, 2).join('|').slice(0, 300);
}

// Why a crash report was NOT written. Silence here is what made ENG-265 undiagnosable: four real
// renderer crashes produced no file and no line, so nobody could tell a suppressed report from a
// handler that never ran. Never throws: the logging path is exactly what may already be broken.
function p_declineLog(reason, detail) {
  try { console.warn(`[crash-reports] declined (${reason}): ${detail}`); } catch (_) { /* stdout is gone */ }
}

function writeCrashReport(kind, details) {
  const now = Date.now();
  const fp = fingerprint(kind, details);
  const seen = p_lastByFingerprint.get(fp);
  if (seen && now - seen.at < DEDUPE_WINDOW_MS) {
    seen.count += 1;
    p_declineLog('deduped', `${fp} seen ${seen.count}x within ${DEDUPE_WINDOW_MS}ms`);
    return null;
  }
  if (p_written >= MAX_REPORTS_PER_SESSION) {
    p_declineLog('capped', `${p_written} reports already written this session`);
    return null;
  }
  p_lastByFingerprint.set(fp, { at: now, count: 1 });
  p_written += 1;
  try {
    const dir = reportsDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `crash-${stamp}-${kind}.json`);
    const report = {
      kind,
      at: new Date().toISOString(),
      appVersion: p_app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      details,
      // How many identical faults this report stands for, so dedupe hides nothing.
      repeats: (p_lastByFingerprint.get(fp) || {}).count || 1,
      backendLogTail: backendLogTail(),
    };
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    prune(dir);
    if (p_notify) {
      p_notify({
        title: 'OpenSwarm hit a problem',
        body: 'A crash report was saved. Help > Report a bug attaches it automatically.',
      });
    }
    return file;
  } catch (err) {
    // Logging is exactly what may have failed upstream, so it cannot be allowed to throw from here.
    try { console.error('[crash-reports] failed to write report:', err && err.message); } catch (_) {}
    return null;
  }
}

// Reports written since the previous launch; the renderer surfaces "last session crashed".
function unseenReports() {
  try {
    const dir = reportsDir();
    const marker = path.join(dir, '.last-seen');
    let last = 0;
    try { last = fs.statSync(marker).mtimeMs; } catch (_) {}
    const fresh = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(dir, f))
      .filter((p) => { try { return fs.statSync(p).mtimeMs > last; } catch (_) { return false; } });
    fs.writeFileSync(marker, String(Date.now()));
    return fresh;
  } catch (_) {
    return [];
  }
}

module.exports = { init, writeCrashReport, unseenReports, DEDUPE_WINDOW_MS, MAX_REPORTS_PER_SESSION };
