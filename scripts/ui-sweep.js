/**
 * Dead-control sweep: clicks every interactive control on a surface with REAL mouse events and
 * asserts something actually happened.
 *
 * This exists because of the dictation shortcut chip (ENG-183): the handler was attached, the
 * hit-test landed inside the element, every native event fired, nothing stopped propagation, and
 * the control was still dead because React never dispatched. Nothing in tsc, the linter, unit tests,
 * or a screenshot can see that. Only clicking it can.
 *
 * Two rules it enforces on itself, both learned by getting them wrong:
 *   1. Confirm the hit point with elementFromPoint BEFORE dispatching. Locating a control by DOM
 *      scan hands you elements that something else is painting over.
 *   2. A control is only "alive" if the click causes an OBSERVABLE change (DOM mutation, focus move,
 *      or a React handler firing). "It didn't throw" is not evidence.
 *
 *   node scripts/ui-sweep.js <cdp-port> [surfaceName] [restoreScriptPath]
 *
 * restoreScriptPath is a file holding a JS expression that puts the surface back in its canonical
 * state. It is needed because clicking a control can navigate away, and every control after that
 * would otherwise be scored against the wrong screen.
 */

const WS_PATH = require('path').join(__dirname, '..', 'frontend', 'node_modules', 'ws');
const WebSocket = require(WS_PATH);
const http = require('http');

const PORT = process.argv[2] || '9223';
const SURFACE = process.argv[3] || 'current';
const RESTORE = process.argv[4] ? require('fs').readFileSync(process.argv[4], 'utf8') : '';

function targets() {
  return new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${PORT}/json/list`, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

// Records, for one control: did the DOM change, did focus move, did a React handler run.
const INSTRUMENT = `(function(){
  window.__SWEEP__ = window.__SWEEP__ || {};
  window.__SWEEP__.find = function(tag, label, ord){
    var sel = 'button,[role=button],[tabindex="0"],input,select,textarea,[role=tab],[role=switch],[role=menuitem]';
    var seen = 0;
    var all = document.querySelectorAll(sel);
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (n.tagName !== tag) continue;
      var l = (n.getAttribute('aria-label') || n.innerText || n.value || '').trim().replace(/\s+/g,' ').slice(0,34);
      if (l !== label) continue;
      seen++;
      if (seen === ord) return n;
    }
    return null;
  };
  window.__SWEEP__.arm = function(el){
    var s = { mutated:false, focusMoved:false, reactFired:false, nativeFired:false };
    window.__SWEEP__.state = s;
    var before = document.activeElement;
    var obs = new MutationObserver(function(){ s.mutated = true; });
    obs.observe(document.body, { subtree:true, childList:true, attributes:true, characterData:true });
    window.__SWEEP__.stop = function(){
      obs.disconnect();
      s.focusMoved = document.activeElement !== before;
      return s;
    };
    el.addEventListener('click', function(){ s.nativeFired = true; }, { once:true, capture:true });
    var pk = Object.keys(el).find(function(k){ return k.indexOf('__reactProps$') === 0; });
    if (pk && el[pk] && typeof el[pk].onClick === 'function') {
      var orig = el[pk].onClick;
      el[pk].onClick = function(){ s.reactFired = true; return orig.apply(this, arguments); };
      s.hasReactOnClick = true;
    } else {
      s.hasReactOnClick = false;
    }
    return true;
  };
  return 1;
})()`;

// Interactive = something a user would expect to respond. Filtered in CSS px because canvas cards
// are zoom-scaled and an on-screen size filter silently skips small-but-real controls.
const ENUM = `(function(){
  var out = [], keep = [];
  var sel = 'button,[role=button],[tabindex="0"],input,select,textarea,[role=tab],[role=switch],[role=menuitem]';
  document.querySelectorAll(sel).forEach(function(n){
    if (n.disabled) return;
    var r = n.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    if (r.bottom < 4 || r.top > innerHeight - 4 || r.right < 4 || r.left > innerWidth - 4) return;
    var cs = getComputedStyle(n);
    if (cs.visibility === 'hidden' || cs.pointerEvents === 'none' || parseFloat(cs.opacity) < 0.05) return;
    var x = Math.round(r.left + r.width/2), y = Math.round(r.top + r.height/2);
    var hit = document.elementFromPoint(x, y);
    var reachable = !!(hit && (n.contains(hit) || n === hit));
    keep.push(n);
    out.push({
      i: keep.length - 1, x: x, y: y, reachable: reachable,
      tag: n.tagName, role: n.getAttribute('role') || '',
      label: (n.getAttribute('aria-label') || n.innerText || n.value || '').trim().replace(/\\s+/g,' ').slice(0, 34),
      ord: (function(){ var c=0; for (var k=0;k<keep.length;k++){ var m=keep[k];
             if (m.tagName===n.tagName && ((m.getAttribute('aria-label')||m.innerText||m.value||'').trim().replace(/\\s+/g,' ').slice(0,34))===((n.getAttribute('aria-label')||n.innerText||n.value||'').trim().replace(/\\s+/g,' ').slice(0,34))) c++; } return c; })(),
      occludedBy: reachable ? '' : (hit ? hit.tagName + '.' + String(hit.className||'').slice(0,26) : 'nothing')
    });
  });
  window.__SWEEP__.nodes = keep;
  return JSON.stringify(out);
})()`;

(async () => {
  const list = await targets();
  const page = list.find((t) => t.type === 'page' && t.url.includes(':3000'));
  if (!page) { console.log('no :3000 page'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  let id = 0; const pend = new Map();
  ws.on('message', (m) => { const g = JSON.parse(m); if (g.id && pend.has(g.id)) { pend.get(g.id)(g); pend.delete(g.id); } });
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await ev(INSTRUMENT);
  const controls = JSON.parse(await ev(ENUM) || '[]');
  console.log(`\nUI sweep: ${SURFACE} -- ${controls.length} interactive controls on screen\n`);

  const dead = [], occluded = [], alive = [], stale = [];
  for (const ctl of controls) {
    if (!ctl.reachable) { occluded.push(ctl); continue; }
    // Park the pointer and clear transients first: a tooltip left hovering over the previous control
    // covers the next one, and a modal opened by an earlier click hides the whole surface behind it.
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(220);
    // Re-resolve position at click time. Coordinates captured during enumeration go stale the moment
    // an earlier click re-renders, and a click into empty space reads exactly like a dead control.
    const fresh = JSON.parse(await ev(`(function(){
      var n = window.__SWEEP__.find(${JSON.stringify(ctl.tag)}, ${JSON.stringify(ctl.label)}, ${ctl.ord});
      if (!n || !n.isConnected) return JSON.stringify({gone:true});
      window.__SWEEP__.current = n;
      var r = n.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return JSON.stringify({gone:true});
      var x = Math.round(r.left + r.width/2), y = Math.round(r.top + r.height/2);
      if (x < 2 || y < 2 || x > innerWidth - 2 || y > innerHeight - 2) return JSON.stringify({offscreen:true});
      var hit = document.elementFromPoint(x, y);
      return JSON.stringify({ x:x, y:y, ok: !!(hit && (n.contains(hit) || n === hit)),
                              cover: hit ? hit.tagName + '.' + String(hit.className||'').slice(0,26) : 'nothing' });
    })()`) || '{"gone":true}');
    if (fresh.gone) { stale.push({ ...ctl, why: 'unmounted before its turn' }); continue; }
    if (fresh.offscreen) { stale.push({ ...ctl, why: 'scrolled off screen before its turn' }); continue; }
    if (!fresh.ok) { occluded.push({ ...ctl, x: fresh.x, y: fresh.y, occludedBy: fresh.cover }); continue; }
    await ev('window.__SWEEP__.arm(window.__SWEEP__.current)');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fresh.x, y: fresh.y, button: 'left', clickCount: 1 });
    await sleep(40);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fresh.x, y: fresh.y, button: 'left', clickCount: 1 });
    await sleep(260);
    const s = await ev('JSON.stringify(window.__SWEEP__.stop())');
    const st = JSON.parse(s || '{}');
    const responded = st.mutated || st.focusMoved || st.reactFired;
    // A click can navigate; without putting the surface back, every later control is judged against
    // the wrong screen and lands in "inconclusive".
    if (RESTORE) { await ev(RESTORE); await sleep(600); }
    // A control with a React onClick that never fires on a real click is the ENG-183 signature.
    // nativeFired false means the click never even reached the node: that is a harness miss, not a
    // dead control, and reporting it as a bug is how you cry wolf.
    if (!st.nativeFired) { stale.push({ ...ctl, why: 'click did not land (moved mid-sweep)' }); continue; }
    if (!responded) dead.push({ ...ctl, ...st });
    else alive.push(ctl);
  }

  console.log(`alive: ${alive.length}   dead: ${dead.length}   occluded: ${occluded.length}   inconclusive: ${stale.length}\n`);
  if (dead.length) {
    console.log('DEAD CONTROLS (clicked, nothing observable happened):');
    for (const d of dead) {
      console.log(`  ${d.tag}${d.role ? '[' + d.role + ']' : ''} "${d.label}" @(${d.x},${d.y})` +
                  `  reactOnClick=${d.hasReactOnClick} reactFired=${d.reactFired} nativeFired=${d.nativeFired}`);
    }
    console.log('');
  }
  if (occluded.length) {
    console.log('OCCLUDED (a user cannot click these where they are painted):');
    for (const o of occluded) console.log(`  ${o.tag} "${o.label}" @(${o.x},${o.y}) covered by ${o.occludedBy}`);
    console.log('');
  }
  ws.close();
  process.exit(dead.length ? 1 : 0);
})().catch((e) => { console.log('sweep error: ' + e.message); process.exit(2); });
