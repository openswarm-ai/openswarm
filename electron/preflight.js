'use strict';
// Runtime preflight: at first launch per app version, fans out parallel checks
// (OS, resources, write permission, security block, system libs, network, GPU,
// IPv4/v6, clock skew) under hard per-check timeouts, writes a verdict file
// keyed by version, and emits a [preflight] beacon line backend.log can pick up
// for fleet reporting. Subsequent launches read the cache and skip work.
// Every check is `check(env, opts) => {status, reason}` where env is injected
// so unit tests can drive every branch without touching real OS/network/spawn.

const path = require('path');

function defaultEnv() {
  return {
    fs: require('fs'),
    child_process: require('child_process'),
    dns: require('dns'),
    http: require('http'),
    https: require('https'),
    os: require('os'),
    now: () => Date.now(),
    platform: process.platform,
    arch: process.arch,
  };
}

// Wraps a check fn with a hard timeout + never-throw contract. Unknown after
// timeout is 'warn' (not 'fail') so transient hangs don't false-positive.
async function withTimeout(name, fn, timeoutMs) {
  const t0 = Date.now();
  let timer;
  const timeoutPromise = new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'warn', reason: `timeout ${timeoutMs}ms` }), timeoutMs); });
  let result;
  try {
    result = await Promise.race([
      Promise.resolve().then(() => fn()).catch((e) => ({ status: 'warn', reason: `threw: ${String((e && e.message) || e)}` })),
      timeoutPromise,
    ]);
  } catch (e) {
    result = { status: 'warn', reason: `wrapper-threw: ${String((e && e.message) || e)}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!result || !result.status) result = { status: 'warn', reason: 'no result returned' };
  return { name, status: result.status, reason: result.reason || '', durationMs: Date.now() - t0 };
}

async function checkOs(env) {
  const p = env.platform, a = env.arch;
  if (!['win32', 'darwin', 'linux'].includes(p)) return { status: 'fail', reason: `unsupported platform ${p}` };
  if (!['x64', 'arm64'].includes(a)) return { status: 'fail', reason: `unsupported arch ${a}` };
  let rel = '';
  try { rel = env.os.release(); } catch {}
  if (p === 'darwin') {
    const major = Number(String(rel).split('.')[0] || 0);
    if (major < 22) return { status: 'warn', reason: `macOS darwin ${rel} < 22 (macOS 13)` };
  }
  if (p === 'win32') {
    const major = Number(String(rel).split('.')[0] || 0);
    if (major < 10) return { status: 'fail', reason: `windows ${rel} < 10` };
  }
  return { status: 'ok', reason: `${p}/${a} release=${rel}` };
}

async function checkResources(env) {
  let total = 0, free = 0, cpus = 0;
  try { total = env.os.totalmem(); free = env.os.freemem(); cpus = (env.os.cpus() || []).length; }
  catch (e) { return { status: 'warn', reason: `os api: ${String(e)}` }; }
  if (total < 4 * 1024 ** 3) return { status: 'warn', reason: `total memory ${(total / 1073741824).toFixed(1)}GB < 4GB` };
  if (cpus < 2) return { status: 'warn', reason: `${cpus} cpu(s), recommended 2+` };
  if (typeof env.fs.statfsSync === 'function') {
    try {
      const stat = env.fs.statfsSync(env.os.homedir());
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      if (freeBytes < 2 * 1024 ** 3) return { status: 'warn', reason: `home dir free ${(freeBytes / 1073741824).toFixed(1)}GB < 2GB` };
    } catch (e) { return { status: 'warn', reason: `statfs threw: ${String(e)}` }; }
  }
  return { status: 'ok', reason: `mem=${(total / 1073741824).toFixed(1)}GB free=${(free / 1073741824).toFixed(1)}GB cpus=${cpus}` };
}

async function checkAppdataWritable(env, dataDir) {
  if (!dataDir) return { status: 'warn', reason: 'no dataDir provided' };
  try {
    env.fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, '.preflight-probe');
    env.fs.writeFileSync(probe, 'ok');
    env.fs.unlinkSync(probe);
    return { status: 'ok', reason: `writable: ${dataDir}` };
  } catch (e) {
    return { status: 'fail', reason: `write blocked at ${dataDir}: ${String((e && e.message) || e)}` };
  }
}

async function checkSecurityBlock(env) {
  // We're already running, so any platform-level launch block already fired.
  // This is a soft probe to surface "may prompt next launch" cases.
  if (env.platform === 'darwin') {
    return await new Promise((resolve) => {
      try {
        env.child_process.execFile('xattr', ['-l', process.execPath], { timeout: 1500 }, (err, stdout) => {
          if (err) return resolve({ status: 'warn', reason: `xattr failed: ${String(err.message || err)}` });
          if (/com\.apple\.quarantine/.test(String(stdout || ''))) return resolve({ status: 'warn', reason: 'app has com.apple.quarantine flag' });
          resolve({ status: 'ok', reason: 'no quarantine flag' });
        });
      } catch (e) { resolve({ status: 'warn', reason: `xattr threw: ${String(e)}` }); }
    });
  }
  if (env.platform === 'win32') {
    return await new Promise((resolve) => {
      try {
        env.child_process.execFile('powershell.exe', ['-NoProfile', '-Command', '(Get-MpComputerStatus).AntivirusEnabled'], { timeout: 1800 }, (err, stdout) => {
          if (err) return resolve({ status: 'warn', reason: `Get-MpComputerStatus failed: ${String(err.message || err)}` });
          resolve({ status: 'ok', reason: `defender antivirus=${String(stdout || '').trim()}` });
        });
      } catch (e) { resolve({ status: 'warn', reason: `pwsh threw: ${String(e)}` }); }
    });
  }
  return { status: 'ok', reason: 'linux: no os-level launch gate' };
}

async function checkSystemLibs(env) {
  // We're a running Electron process; CRT/dyld/glibc are loaded by definition.
  // The detailed VCRedist/dyld probe lives in verify-python-health which spawns
  // the bundled interpreter; here we just attest we made it this far.
  return { status: 'ok', reason: `${env.platform} libs loaded (process is running)` };
}

// Pick the module that matches the URL scheme; http rigs in tests should not
// require https, and a malformed URL should warn cleanly rather than throw.
function pickHttpModule(env, url) {
  return /^https:/i.test(url) ? env.https : /^http:/i.test(url) ? env.http : null;
}

async function checkNetwork(env, opts = {}) {
  const url = opts.url || 'https://api.openswarm.com/';
  const timeoutMs = opts.timeoutMs || 4000;
  const mod = pickHttpModule(env, url);
  if (!mod) return { status: 'warn', reason: `unsupported URL scheme: ${url}` };
  return await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    try {
      const req = mod.get(url, (res) => { res.resume(); const sc = res.statusCode; finish({ status: sc >= 500 ? 'warn' : 'ok', reason: `${url} HTTP ${sc}` }); });
      req.on('error', (e) => finish({ status: 'warn', reason: `${url} error: ${String((e && e.message) || e)}` }));
      req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} finish({ status: 'warn', reason: `${url} timed out at ${timeoutMs}ms` }); });
    } catch (e) { finish({ status: 'warn', reason: `${url} threw: ${String(e)}` }); }
  });
}

async function checkGpu(env, opts = {}) {
  const app = opts.app;
  if (!app || typeof app.getGPUFeatureStatus !== 'function') return { status: 'warn', reason: 'no app handle (electron not in main proc)' };
  try {
    const status = app.getGPUFeatureStatus() || {};
    const compositing = status['compositing'] || 'unknown';
    if (/disabled|software/i.test(String(compositing))) return { status: 'warn', reason: `gpu compositing=${compositing}` };
    return { status: 'ok', reason: `gpu compositing=${compositing}` };
  } catch (e) { return { status: 'warn', reason: `gpu probe threw: ${String(e)}` }; }
}

async function checkDualStack(env, opts = {}) {
  const host = opts.host || 'api.openswarm.com';
  const timeoutMs = opts.timeoutMs || 3000;
  const lookup = (family) => new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
    try {
      env.dns.lookup(host, { family }, (err, addr) => { if (done) return; done = true; clearTimeout(t); resolve(err ? null : addr); });
    } catch { if (!done) { done = true; clearTimeout(t); resolve(null); } }
  });
  const [v4, v6] = await Promise.all([lookup(4), lookup(6)]);
  if (!v4 && !v6) return { status: 'warn', reason: `dns failed for both families on ${host}` };
  return { status: 'ok', reason: `v4=${!!v4} v6=${!!v6}` };
}

async function checkClock(env, opts = {}) {
  const url = opts.url || 'https://www.google.com';
  const timeoutMs = opts.timeoutMs || 3000;
  const mod = pickHttpModule(env, url);
  if (!mod) return { status: 'warn', reason: `unsupported URL scheme: ${url}` };
  return await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    try {
      const req = mod.request(url, { method: 'HEAD' }, (res) => {
        const remote = res.headers['date'];
        if (!remote) return finish({ status: 'warn', reason: 'no Date header on response' });
        const remoteMs = Date.parse(remote);
        const skewMs = Math.abs(env.now() - remoteMs);
        if (skewMs > 5 * 60 * 1000) return finish({ status: 'warn', reason: `clock skew ${(skewMs / 60000).toFixed(1)}min vs ${url}` });
        finish({ status: 'ok', reason: `clock skew ${skewMs}ms` });
      });
      req.on('error', (e) => finish({ status: 'warn', reason: `${url} error: ${String((e && e.message) || e)}` }));
      req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} finish({ status: 'warn', reason: `${url} timed out` }); });
      req.end();
    } catch (e) { finish({ status: 'warn', reason: `clock probe threw: ${String(e)}` }); }
  });
}

async function run(env, opts = {}) {
  env = env || defaultEnv();
  const tasks = [
    withTimeout('os', () => checkOs(env), 500),
    withTimeout('resources', () => checkResources(env), 2000),
    withTimeout('appdata-writable', () => checkAppdataWritable(env, opts.dataDir), 2000),
    withTimeout('security-block', () => checkSecurityBlock(env), 2200),
    withTimeout('system-libs', () => checkSystemLibs(env), 500),
    withTimeout('network', () => checkNetwork(env, opts.network), 4500),
    withTimeout('gpu', () => checkGpu(env, opts.gpu), 1500),
    withTimeout('dual-stack', () => checkDualStack(env, opts.dualStack), 3500),
    withTimeout('clock', () => checkClock(env, opts.clock), 3500),
  ];
  const results = await Promise.all(tasks);
  const verdict = results.some((r) => r.status === 'fail') ? 'fail' : results.some((r) => r.status === 'warn') ? 'warn' : 'ok';
  return { verdict, results, totalMs: Math.max(...results.map((r) => r.durationMs)), startedAt: env.now() };
}

function cachePath(dataDir, appVersion) { return path.join(dataDir, `preflight-${appVersion}.json`); }

function readCache(env, dataDir, appVersion) {
  try {
    const raw = JSON.parse(env.fs.readFileSync(cachePath(dataDir, appVersion), 'utf8'));
    if (raw && raw.appVersion === appVersion && raw.verdict === 'ok') return raw;
  } catch {}
  return null;
}

function writeCache(env, dataDir, appVersion, payload) {
  try {
    env.fs.mkdirSync(dataDir, { recursive: true });
    env.fs.writeFileSync(cachePath(dataDir, appVersion), JSON.stringify({ appVersion, ...payload }, null, 2));
    return true;
  } catch { return false; }
}

function pruneOldCaches(env, dataDir, currentVersion) {
  try {
    for (const f of env.fs.readdirSync(dataDir)) {
      const m = /^preflight-(.+)\.json$/.exec(f);
      if (m && m[1] !== currentVersion) { try { env.fs.unlinkSync(path.join(dataDir, f)); } catch {} }
    }
  } catch {}
}

module.exports = {
  defaultEnv, withTimeout,
  checkOs, checkResources, checkAppdataWritable, checkSecurityBlock, checkSystemLibs,
  checkNetwork, checkGpu, checkDualStack, checkClock,
  run, cachePath, readCache, writeCache, pruneOldCaches,
};
