function createBootTelemetry(options = {}) {
  const {
    launchTime = Date.now(),
    now = Date.now,
    logger = console,
    schedule = setTimeout,
    onBeaconReady = () => {},
    beaconDelayMs = 1500,
    stderrLimit = 60,
  } = options;

  const perfSeen = new Set();
  const perfValues = {};
  const backendStderr = [];
  let preflightInfo = {};
  let preflightVerdict = null;
  let preflightPendingCache = null;
  let beaconScheduled = false;

  function markPerformance(name) {
    if (perfSeen.has(name)) return false;
    perfSeen.add(name);
    const elapsed = now() - launchTime;
    perfValues[name] = elapsed;
    try { logger.log(`[perf] ${name} t=${elapsed}`); } catch (_) {}
    return true;
  }

  function appendBackendStderr(text) {
    backendStderr.push(text);
    while (backendStderr.length > stderrLimit) backendStderr.shift();
  }

  function recentBackendStderr(count) {
    return backendStderr.slice(-count).join('');
  }

  function setPreflightInfo(info) {
    preflightInfo = info;
  }

  function setPreflightVerdict(verdict) {
    preflightVerdict = verdict;
  }

  function commitPreflightCacheIfReady() {
    if (!preflightPendingCache) return false;
    if (perfValues['backend-http-ready'] == null) return false;
    const { pf, dataDir, version, result } = preflightPendingCache;
    preflightPendingCache = null;
    try {
      pf.writeCache(pf.defaultEnv(), dataDir, version, result);
      logger.log(`[preflight2] cache committed for v${version}`);
    } catch (error) {
      logger.log(`[preflight2] cache write failed: ${error && error.message}`);
    }
    return true;
  }

  function stagePreflightCache(pendingCache) {
    preflightPendingCache = pendingCache;
    commitPreflightCacheIfReady();
  }

  function scheduleBeaconIfReady() {
    if (beaconScheduled) return false;
    if (perfValues['first-paint'] == null || perfValues['backend-http-ready'] == null) {
      return false;
    }
    beaconScheduled = true;
    schedule(onBeaconReady, beaconDelayMs);
    return true;
  }

  function beaconSnapshot() {
    return {
      perf: { ...perfValues },
      preflight: { ...preflightInfo },
      preflight2: preflightVerdict ? {
        verdict: preflightVerdict.verdict,
        totalMs: preflightVerdict.totalMs,
        names: (preflightVerdict.results || []).map((result) => `${result.name}:${result.status}`),
      } : null,
    };
  }

  return {
    markPerformance,
    appendBackendStderr,
    recentBackendStderr,
    setPreflightInfo,
    setPreflightVerdict,
    stagePreflightCache,
    commitPreflightCacheIfReady,
    scheduleBeaconIfReady,
    beaconSnapshot,
  };
}

module.exports = { createBootTelemetry };
