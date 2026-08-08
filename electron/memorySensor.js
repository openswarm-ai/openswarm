// Memory/compute overload sensor: the quiet death nobody reports, where RSS climbs until macOS
// kills a renderer or the fans spin up. Idle-scheduled, unref'd, and it EMITS ONLY on threshold
// crossings, so a healthy session ships nothing at all.
'use strict';

// Overridable so support can ask a user to run with a tighter cap, and so the wire is testable
// without allocating gigabytes on someone's machine.
const SAMPLE_MS = Number(process.env.OSW_MEM_SAMPLE_MS || 60_000);
// Crossed once, reported once: a leak is a trend, not a per-minute alarm.
const TOTAL_MB_CAP = Number(process.env.OSW_MEM_CAP_MB || 3000);
const GROWTH_MB_PER_MIN = Number(process.env.OSW_MEM_GROWTH_MB || 40);
const GROWTH_WINDOW = 10;

let p_timer = null;
let p_history = [];
let p_capReported = false;
let p_growthReported = false;

function totalMb(metrics) {
  let kb = 0;
  for (const m of metrics) kb += (m.memory && m.memory.workingSetSize) || 0;
  return Math.round(kb / 1024);
}

/** Least-squares slope in MB/min over the sample window; a straight climb is the leak signature. */
function slopeMbPerMin(history) {
  const n = history.length;
  if (n < 4) return 0;
  const meanX = (n - 1) / 2;
  const meanY = history.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - meanX) * (history[i] - meanY);
    den += (i - meanX) * (i - meanX);
  }
  return den === 0 ? 0 : num / den;
}

function startMemorySensor(app, getMainWindow) {
  if (p_timer) return;
  p_timer = setInterval(() => {
    let metrics;
    try { metrics = app.getAppMetrics(); } catch (_) { return; }
    const mb = totalMb(metrics);
    p_history.push(mb);
    if (p_history.length > GROWTH_WINDOW) p_history.shift();
    const slope = slopeMbPerMin(p_history);
    const send = (reason, extra) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('diag:memory', { reason, total_mb: mb, procs: metrics.length, slope_mb_min: Math.round(slope), ...extra }); } catch (_) {}
      }
      console.error('[diag][memory]', reason, 'total_mb=' + mb, 'procs=' + metrics.length, 'slope=' + Math.round(slope));
    };
    if (!p_capReported && mb >= TOTAL_MB_CAP) { p_capReported = true; send('cap_crossed', {}); }
    if (p_capReported && mb < TOTAL_MB_CAP * 0.8) p_capReported = false;
    if (!p_growthReported && p_history.length >= GROWTH_WINDOW && slope >= GROWTH_MB_PER_MIN) {
      p_growthReported = true;
      send('growth_suspect', { window_min: GROWTH_WINDOW });
    }
  }, SAMPLE_MS);
  p_timer.unref?.();
}

function stopMemorySensor() {
  if (p_timer) { clearInterval(p_timer); p_timer = null; }
  p_history = [];
}

module.exports = { startMemorySensor, stopMemorySensor, slopeMbPerMin, totalMb, TOTAL_MB_CAP, GROWTH_MB_PER_MIN };
