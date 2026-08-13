// Attach to a running packaged OpenSwarm over CDP and measure what the renderer actually painted.
//
// This exists because every other check in the packaged smoke is about the installer. Signature,
// install path, bundle contents, backend port: all can pass while the window shows a blank route
// or text nobody can read. Those are the failures users report and the smoke could not see.
//
// Node 22's global WebSocket, so the runner installs nothing.
//
// Exit 0 = every check passed. Exit 1 = at least one failed, with the numbers printed.

const HOST = process.env.SMOKE_CDP || '127.0.0.1:9222';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickTarget() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const targets = await (await fetch(`http://${HOST}/json`)).json();
    const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
    if (page && page.webSocketDebuggerUrl) return page;
    await wait(3000);
  }
  throw new Error('no page target exposed by the app');
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  });
  const ready = new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params) => new Promise((resolve) => {
    id += 1;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, ready, send };
}

// One expression, evaluated in the page: everything we want to know about the painted result.
const PROBE = `(() => {
  const lum = (c) => {
    const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const parse = (s) => {
    const m = (s || '').match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const a = m[1].split(',').map(Number);
    return { rgb: [a[0], a[1], a[2]], a: a.length > 3 ? a[3] : 1 };
  };
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.5) return c.rgb;
      n = n.parentElement;
    }
    const b = parse(getComputedStyle(document.body).backgroundColor);
    return b ? b.rgb : [255, 255, 255];
  };
  const fields = [];
  document.querySelectorAll('input:not([type=checkbox]):not([type=radio]),textarea').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 6) return;
    const fg = parse(getComputedStyle(el).color);
    if (!fg) return;
    const bg = bgOf(el);
    const l1 = lum(fg.rgb);
    const l2 = lum(bg);
    fields.push({
      name: (el.placeholder || el.getAttribute('aria-label') || el.name || el.type || '?').slice(0, 30),
      ratio: Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100,
    });
  });
  return JSON.stringify({
    route: location.hash.slice(0, 60),
    // A blank render is the ENG-207 boot wedge: chrome-less, on an empty route, one reload heals it.
    painted: document.body ? document.body.innerText.trim().length : 0,
    nodes: document.querySelectorAll('*').length,
    fields,
  });
})()`;

const main = async () => {
  const target = await pickTarget();
  const { ws, ready, send } = connect(target.webSocketDebuggerUrl);
  await ready;

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval threw');
    return r.result?.result?.value;
  };

  // Open Settings first. Without it the dashboard has no form fields, the contrast check runs over
  // an empty list, and the step reports PASS having measured nothing. A check that cannot fail is
  // worse than no check, so the field count is asserted below.
  const key = async (k, code, modifiers) => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: k, code, modifiers, windowsVirtualKeyCode: 75 });
    }
  };
  const fieldCount = async () => JSON.parse(await evaluate(PROBE)).fields.length;
  await evaluate('window.focus()');
  for (const mod of [2, 4]) {              // Ctrl on Windows, Meta on macOS
    await key('k', 'KeyK', mod);
    await wait(1000);
    await send('Input.insertText', { text: 'settings' });
    await wait(1000);
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', modifiers: 0 });
    await wait(3000);
    // Settings remembers its last tab, and several tabs have no inputs at all, so opening it is
    // not enough: land on General, which owns the system prompt, working directory and max turns.
    await evaluate(`(() => {
      const hit = [...document.querySelectorAll('button,[role=button],[role=tab],li')]
        .filter((e) => (e.textContent || '').trim() === 'General' && e.getBoundingClientRect().width > 0);
      if (hit.length) hit[0].click();
      return hit.length;
    })()`);
    await wait(2000);
    // Whether the palette opened is not something to detect with a guessed selector; the only
    // question that matters is whether form fields are now on screen, so just look.
    if (await fieldCount() > 0) break;
  }

  const data = JSON.parse(await evaluate(PROBE));
  const failures = [];

  console.log(`  route            ${data.route || '(none)'}`);
  console.log(`  DOM nodes        ${data.nodes}`);
  console.log(`  visible text     ${data.painted} chars`);
  console.log(`  fields measured  ${data.fields.length}`);

  // A booted app paints a real tree. The boot wedge lands at a handful of nodes and no text.
  if (data.nodes < 200) failures.push(`only ${data.nodes} DOM nodes: renderer never painted a real tree`);
  if (data.painted < 20) failures.push(`only ${data.painted} chars of visible text: blank render`);

  // ENG-281 on Windows. Black-on-black scores 1.0; WCAG AA wants 4.5.
  // The count assertion is the point: zero fields means the contrast loop measured nothing and
  // "no field failed" was true only because no field existed.
  const MIN_FIELDS = 3;
  if (data.fields.length < MIN_FIELDS) {
    failures.push(`only ${data.fields.length} field(s) rendered, need >= ${MIN_FIELDS}: the contrast check would pass vacuously`);
  }
  const unreadable = data.fields.filter((f) => f.ratio < 4.5);
  for (const f of data.fields) console.log(`    ${String(f.ratio).padStart(7)}:1  ${f.name}`);
  if (unreadable.length) {
    failures.push(`${unreadable.length} field(s) below AA contrast: ${unreadable.map((f) => `${f.name}=${f.ratio}:1`).join(', ')}`);
  }

  // An exception during boot is not visible in any other step of this smoke.
  const errors = await evaluate(`JSON.stringify((window.__smokeErrors || []).slice(0, 5))`);
  const parsedErrors = JSON.parse(errors || '[]');
  if (parsedErrors.length) failures.push(`${parsedErrors.length} renderer error(s): ${parsedErrors.join(' | ')}`);

  ws.close();

  if (failures.length) {
    console.log('\nFAIL');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nPASS  renderer painted a usable window and every field is readable');
};

main().catch((e) => { console.log(`FAIL  ${e.message}`); process.exit(1); });
