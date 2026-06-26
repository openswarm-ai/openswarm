// key-probe.js: inspect keyboard events INSIDE a game's guest webview.
//
// Why: the open question on the keyboard fix is whether tool-issued
// sendInputEvent delivers correct key codes once the guest is focused, or
// whether it arrives with an empty `code` / keyCode:0 (which games ignore) and
// we must switch to CDP Input.dispatchKeyEvent. This probe answers it directly
// instead of inferring from whether the sprite moved.
//
// Usage:
//   1. Right-click the game webview -> Inspect -> Console (this is the GUEST
//      console, http://127.0.0.1:<port>/..., NOT the host app devtools).
//   2. Paste this whole file and hit Enter. You'll see "[key-probe] armed".
//   3. Fire one tool-issued press_key, e.g. { key: "ArrowRight", hold_ms: 800 }.
//   4. Read the logged lines, or call __keyProbe.dump() for a table.
//
// What to look for per event:
//   - isTrusted: should be true (native OS-level event). false = a JS
//     dispatchEvent, not our native path.
//   - code: should be e.g. "ArrowRight". EMPTY string is the failure signal.
//   - keyCode/which: should be e.g. 39. 0 is the failure signal.
//   - holdMs (on keyup): wall-clock ms the key was held. ~0 means the hold
//     collapsed to an instant tap (down+up same tick); ~800 means hold worked.
// Decision: clean code + nonzero keyCode -> stay on sendInputEvent. Empty
// code / keyCode 0 -> move the keyboard path to CDP Input.dispatchKeyEvent.

(function () {
  if (window.__keyProbe) {
    try { window.__keyProbe.disarm(); } catch (_) {}
  }
  var events = [];
  var downAt = Object.create(null); // key -> timestamp, to measure hold duration

  function row(e) {
    var now = (performance && performance.now) ? performance.now() : Date.now();
    var holdMs = null;
    if (e.type === 'keydown') {
      downAt[e.code || e.key] = now;
    } else if (e.type === 'keyup') {
      var k = e.code || e.key;
      if (downAt[k] != null) { holdMs = Math.round(now - downAt[k]); delete downAt[k]; }
    }
    var r = {
      type: e.type,
      key: e.key,
      code: e.code,            // EMPTY = failure signal
      keyCode: e.keyCode,      // 0 = failure signal
      which: e.which,
      isTrusted: e.isTrusted,  // true = native; false = synthetic JS
      repeat: e.repeat,
      target: (e.target && (e.target.tagName || e.target.nodeName)) || '(none)',
      holdMs: holdMs,          // only set on keyup
    };
    events.push(r);
    var warn = (r.code === '' || r.code == null) ? '  <-- EMPTY code'
             : (r.keyCode === 0) ? '  <-- keyCode 0' : '';
    console.log('[key-probe]', r.type, JSON.stringify(r) + warn);
  }

  // Capture phase + on window so we see the event even if the game stops
  // propagation on its own listener.
  var types = ['keydown', 'keyup', 'keypress'];
  types.forEach(function (t) { window.addEventListener(t, row, true); });

  window.__keyProbe = {
    events: events,
    dump: function () { try { console.table(events); } catch (_) { console.log(events); } return events; },
    clear: function () { events.length = 0; for (var k in downAt) delete downAt[k]; console.log('[key-probe] cleared'); },
    disarm: function () { types.forEach(function (t) { window.removeEventListener(t, row, true); }); console.log('[key-probe] disarmed'); },
  };

  console.log('[key-probe] armed on', location.href, '- fire a press_key, then __keyProbe.dump(). document.activeElement =', document.activeElement && (document.activeElement.tagName || document.activeElement.nodeName));
})();
