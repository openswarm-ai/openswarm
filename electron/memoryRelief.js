// Memory pressure stops being a telemetry event and starts being ACTED on (ENG-320).
//
// The sensor next door has watched sessions climb to 3-4GB for weeks and only ever reported it:
// 18 of 57 active users tripped it in one day, and the observed end state is macOS killing the
// app with NO trace at all (one such death was caught live mid-capturePage under heavy webviews).
// A silent kill costs the whole session; everything this module gives up under pressure is
// re-fetchable or cosmetic, which is the whole trade.
//
// Levers, in order of engagement when the cap is crossed:
//   1. thumbnails stop:   capture-page composites GPU surfaces (big transient allocations, and the
//                         last logged act before the observed silent death); callers already treat
//                         null as "keep the last preview", so this degrades invisibly
//   2. HTTP caches drop:  refetchable bytes, same clear the ENG-247 boot sweep does
//
// Hysteresis mirrors the sensor: enter at the cap, exit below 80% of it, one action set per
// episode so a session hovering at the line cannot thrash the caches.
'use strict';

let p_underPressure = false;
let p_episodes = 0;
let p_actions = null;

/** Wire the action set once at boot; separated for tests and so this file stays require-clean. */
function initMemoryRelief(actions) {
  p_actions = actions || null;
}

/** Called by the sensor with every sample. Returns true when the pressure state CHANGED. */
function updateMemoryPressure(totalMb, capMb) {
  if (!p_underPressure && totalMb >= capMb) {
    p_underPressure = true;
    p_episodes += 1;
    try { console.error('[memory-relief] entering pressure mode at', totalMb, 'MB (episode', p_episodes + ')'); } catch (_) {}
    if (p_actions) {
      try { p_actions.clearCaches && p_actions.clearCaches(); } catch (_) {}
    }
    return true;
  }
  if (p_underPressure && totalMb < capMb * 0.8) {
    p_underPressure = false;
    try { console.error('[memory-relief] pressure cleared at', totalMb, 'MB'); } catch (_) {}
    return true;
  }
  return false;
}

/** The capture-page gate: while under pressure, thumbnails yield rather than composite. */
function underMemoryPressure() {
  return p_underPressure;
}

/** Test hook. */
function resetMemoryRelief() {
  p_underPressure = false;
  p_episodes = 0;
  p_actions = null;
}

module.exports = { initMemoryRelief, updateMemoryPressure, underMemoryPressure, resetMemoryRelief };
