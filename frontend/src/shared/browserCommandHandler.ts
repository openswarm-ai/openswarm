import { getWebview, type BrowserWebview } from './browserRegistry';
import { store } from './state/store';
import { resumeBrowserCard } from './state/dashboardLayoutSlice';
import { dashboardWs } from './ws/WebSocketManager';
import { resolveInput } from './resolveUrl';
import { rankAndCapInteractives, type RankItem } from './interactiveRanking';
import { shouldStopWaiting, SETTLE_POLL_MS, settleProbeJs } from './browserSettle';

let initialized = false;

export type BrowserAction = 'screenshot' | 'get_text' | 'get_console' | 'navigate' | 'click' | 'type' | 'evaluate' | 'get_elements' | 'scroll' | 'wait' | 'press_key' | 'list_interactives' | 'click_index' | 'batch' | 'detect_webmcp' | 'list_routes' | 'replay_route' | 'click_by_name';

export interface BrowserActivity {
  action: BrowserAction;
  detail?: string;
  coords?: { xPercent: number; yPercent: number };
}

type ActivityListener = (browserId: string, activity: BrowserActivity | null) => void;

const activityMap = new Map<string, BrowserActivity>();
const listeners = new Set<ActivityListener>();

// A webview keeps churning for a beat after an action lands; capturing it into the
// dashboard snapshot during that churn is what crashes the renderer (SharedImage
// 'non-existent mailbox' -> V8 ToLocalChecked), so we hold "busy" this long past
// the last command before letting the thumbnail capture run again.
const BUSY_COOLDOWN_MS = 1500;
let lastActivityAt = 0;

function setActivity(browserId: string, activity: BrowserActivity | null) {
  lastActivityAt = Date.now();
  if (activity) {
    activityMap.set(browserId, activity);
  } else {
    activityMap.delete(browserId);
  }
  listeners.forEach((fn) => fn(browserId, activity));
}

export function getActivity(browserId: string): BrowserActivity | null {
  return activityMap.get(browserId) ?? null;
}

// True while an agent is actively driving any browser webview (a command is in
// flight, or one finished within the cooldown). The dashboard thumbnail capture
// checks this and skips rather than screenshot a live, churning webview.
export function isAnyBrowserBusy(): boolean {
  if (activityMap.size > 0) return true;
  return Date.now() - lastActivityAt < BUSY_COOLDOWN_MS;
}

export function subscribeActivity(fn: ActivityListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const ACTION_LABELS: Record<string, string> = {
  screenshot: 'Capturing...',
  get_text: 'Reading...',
  navigate: 'Navigating...',
  click: 'Clicking...',
  type: 'Typing...',
  evaluate: 'Evaluating...',
  get_elements: 'Inspecting...',
  scroll: 'Scrolling...',
  wait: 'Waiting...',
  press_key: 'Pressing key...',
  list_interactives: 'Reading page structure...',
  click_index: 'Clicking element...',
  click_by_name: 'Clicking element...',
  batch: 'Running batch...',
};

export function getActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? 'Working...';
}

// Draw each cached element's index as a colored chip on the live page right
// before capture (browser-use's trick): the screenshot then speaks the same
// numbers as BrowserListInteractives, so the vision side can act by index.
const _ANNOTATION_COLORS = ['#e5484d', '#0091ff', '#30a46c', '#f76b15', '#8e4ec6', '#00a2c7'];
const _ANNOTATE_BUDGET_MS = 1500;

// One unsettled CDP bridge promise must never hang the screenshot; race each call.
function _cdpTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('cdp call timed out')), ms))]);
}

async function annotateElements(wv: BrowserWebview): Promise<number> {
  const cacheBridge = (window as any).openswarm?.cdpCacheGet;
  const cached = cacheBridge ? await _cdpTimeout(cacheBridge(wv.getWebContentsId()), 500) : null;
  if (!cached || typeof cached !== 'object') return 0;
  const deadline = Date.now() + _ANNOTATE_BUDGET_MS;
  const drawOne = async (idxStr: string, entry: any): Promise<boolean> => {
    const backendNodeId = typeof entry === 'number' ? entry : entry?.backendNodeId;
    // v1 is root-frame only: OOPIF rects are frame-local and would land wrong
    if (!backendNodeId || entry?.sessionId) return false;
    try {
      const t = await _cdpTimeout(sendCdp(wv, 'DOM.resolveNode', { backendNodeId }), 300);
      const r = await _cdpTimeout(sendCdp(wv, 'Runtime.callFunctionOn', {
        objectId: t.object.objectId,
        functionDeclaration:
          'function(idx, color) {'
          + ' const r = this.getBoundingClientRect();'
          + ' if (r.width <= 0 || r.height <= 0) return false;'
          + ' if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;'
          + ' let c = document.getElementById("__osw_annotations__");'
          + ' if (!c) { c = document.createElement("div"); c.id = "__osw_annotations__";'
          + '   c.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";'
          + '   document.documentElement.appendChild(c); }'
          + ' const box = document.createElement("div");'
          + ' box.style.cssText = "position:fixed;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px;border:2px solid " + color + ";box-sizing:border-box;";'
          + ' const tag = document.createElement("span");'
          + ' tag.textContent = String(idx);'
          + ' tag.style.cssText = "position:absolute;left:-2px;top:-16px;background:" + color + ";color:#fff;font:bold 11px/14px monospace;padding:0 4px;border-radius:2px;";'
          + ' if (r.top < 18) { tag.style.top = "-2px"; }'
          + ' box.appendChild(tag); c.appendChild(box); return true;'
          + ' }',
        arguments: [{ value: Number(idxStr) }, { value: _ANNOTATION_COLORS[Number(idxStr) % _ANNOTATION_COLORS.length] }],
        returnByValue: true,
      }), 300);
      return r?.result?.value === true;
    } catch { return false; } // node gone or call timed out; skip
  };
  let drawn = 0;
  const entries = Object.entries(cached);
  const CHUNK = 10;
  for (let i = 0; i < entries.length && Date.now() < deadline; i += CHUNK) {
    const results = await Promise.allSettled(
      entries.slice(i, i + CHUNK).map(([idxStr, e]) => drawOne(idxStr, e)),
    );
    drawn += results.filter((r) => r.status === 'fulfilled' && r.value === true).length;
  }
  return drawn;
}

async function removeAnnotations(wv: BrowserWebview): Promise<void> {
  try {
    await _cdpTimeout(sendCdp(wv, 'Runtime.evaluate', {
      expression: 'document.getElementById("__osw_annotations__")?.remove()',
    }), 800);
  } catch { /* page navigated mid-capture; the overlay died with it */ }
}

async function handleScreenshot(wv: BrowserWebview, params?: Record<string, any>): Promise<Record<string, any>> {
  if (params?.annotate !== false) {
    let drawn = 0;
    try {
      drawn = await annotateElements(wv);
      if (drawn > 0) {
        const shot = await captureRetry(wv);
        if (shot.image) shot.text = `Screenshot with ${drawn} numbered boxes matching your element list (pass annotate:false for a clean shot).`;
        return shot;
      }
    } catch { /* annotation is decoration; a plain shot always beats an error */
    } finally {
      if (drawn > 0) await removeAnnotations(wv);
    }
  }
  return captureRetry(wv);
}

async function captureRetry(wv: BrowserWebview): Promise<Record<string, any>> {
  // capturePage throws UnknownVizError if the webview hasn't composited a frame
  // yet (the Viz compositor races the first paint, reliably bit turn-0 captures).
  // Retry a few times with a short backoff so a cold first screenshot succeeds
  // instead of burning a whole agent turn on a transient error.
  let lastErr: any;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const nativeImage = await wv.capturePage();
      if (!nativeImage.isEmpty()) {
        // Stable PNG capture. The resize()+toJPEG() variant was reverted: it's the
        // prime suspect for the renderer "V8 Empty MaybeLocal" crash, NativeImage's
        // JPEG codec returns an empty image on some retina captures, which is the
        // shape of that native fault. A stable app beats a faster screenshot.
        const dataUrl = nativeImage.toDataURL();
        const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
        return { image: base64, url: wv.getURL(), title: wv.getTitle() };
      }
      lastErr = new Error('capturePage returned an empty image (frame not painted yet)');
    } catch (err: any) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  return { error: `Screenshot failed after retries: ${lastErr?.message || String(lastErr)}` };
}

// Count the safe (GET) API endpoints captured for this site so the backend can
// nudge the agent toward the fast network path. Best-effort, never throws.
async function countSafeRoutes(wv: BrowserWebview): Promise<number> {
  try {
    const bridge = (window as any).openswarm?.cdpRoutesGet as
      | ((id: number, origin?: string) => Promise<any[]>) | undefined;
    if (!bridge) return 0;
    let origin = '';
    try { origin = new URL(wv.getURL()).origin; } catch {}
    const routes = (await bridge(wv.getWebContentsId(), origin)) || [];
    return routes.filter((r) => r && r.safe).length;
  } catch { return 0; }
}

async function handleGetText(wv: BrowserWebview): Promise<Record<string, any>> {
  const text: string = await wv.executeJavaScript(
    'document.body.innerText.substring(0, 15000)'
  );
  // Sampled HERE (on a read), not on navigate: by the time the agent reads the
  // page, the SPA's XHR/fetch have fired, so routes are actually captured.
  const routes_available = await countSafeRoutes(wv);
  return { text, url: wv.getURL(), title: wv.getTitle(), routes_available };
}

// Recent warn+error console output for this webview (captured in main.js). Lets a
// stuck agent see the page's OWN errors (JS exceptions, failed loads) instead of
// guessing. Read-only, fail-safe: any miss returns an empty, honest result.
async function handleGetConsole(wv: BrowserWebview): Promise<Record<string, any>> {
  try {
    const bridge = (window as any).openswarm?.getWebviewConsole as
      | ((id: number) => Promise<Array<{ level: string; message: string; source?: string; line?: number }>>)
      | undefined;
    if (!bridge) return { text: 'Console capture is unavailable here.', errors: [] };
    const errors = (await bridge(wv.getWebContentsId())) || [];
    if (errors.length === 0) {
      return { text: 'No console warnings or errors recorded on this page.', errors: [], url: wv.getURL() };
    }
    const lines = errors.map(
      (e) => `[${e.level}] ${e.message}${e.source ? ` (${e.source}:${e.line ?? '?'})` : ''}`,
    );
    return {
      text: `Page console, ${errors.length} recent warning(s)/error(s), newest last:\n${lines.join('\n')}`,
      errors,
      url: wv.getURL(),
    };
  } catch (err: any) {
    return { text: `Could not read console: ${err?.message || String(err)}`, errors: [] };
  }
}

async function handleNavigate(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const raw = params.url as string;
  if (!raw) return { error: 'url parameter is required' };
  const url = resolveInput(raw);
  // loadURL resolves only on the full 'load' event, which heavy SPAs (LinkedIn,
  // Gmail) hold open with persistent connections long past our timeout even though
  // the page is usable in a second. Return the moment the DOM is ready and let the
  // agent's next wait settle the rest, the way a person clicks before every
  // background request has finished.
  let removeReady = () => {};
  const domReady = new Promise<void>((resolve) => {
    const onReady = () => resolve();
    wv.addEventListener('dom-ready', onReady, { once: true });
    removeReady = () => wv.removeEventListener('dom-ready', onReady);
  });
  const fullyLoaded = wv.loadURL(url).catch((err: any) => {
    // A superseded navigation aborts the old load; that's normal, not a failure.
    if (err?.message?.includes('ERR_ABORTED')) return;
    throw err;
  });
  fullyLoaded.catch(() => {}); // a late load failure shouldn't throw once dom-ready returned
  try {
    await Promise.race([fullyLoaded, domReady]);
  } finally {
    removeReady();
  }
  // Route-count is sampled on the next READ (handleGetText), not here: at
  // navigate-return the SPA's XHRs haven't fired yet, so this would always be ~0.
  return { text: `Navigated to ${url}`, url };
}

async function handleClick(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const selector = params.selector as string;
  if (!selector) return { error: 'selector parameter is required' };
  const safeSelector = JSON.stringify(selector);
  const code = `(()=>{
    const el = document.querySelector(${safeSelector});
    if (!el) return { error: 'Element not found: ' + ${safeSelector} };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return {
      text: 'Clicked element: ' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
      url: location.href,
      clickX: window.innerWidth > 0 ? x / window.innerWidth : 0.5,
      clickY: window.innerHeight > 0 ? y / window.innerHeight : 0.5,
    };
  })()`;
  const result = await wv.executeJavaScript(code);
  return result;
}

async function handleType(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const selector = params.selector as string;
  const text = params.text as string;
  if (!selector) return { error: 'selector parameter is required' };
  if (text == null) return { error: 'text parameter is required' };
  const safeSelector = JSON.stringify(selector);
  const safeText = JSON.stringify(text);
  const code = `(async ()=>{
    const el = document.querySelector(${safeSelector});
    if (!el) return { error: 'Element not found: ' + ${safeSelector} };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    if (el.select) el.select();
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    document.execCommand('insertText', false, ${safeText});
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: ${safeText},
    }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      text: 'Typed into: ' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
    };
  })()`;
  const result = await wv.executeJavaScript(code);
  return result;
}

// Electron sendInputEvent expects names like 'Up', 'Enter', 'Space', not 'ArrowUp'/' '/'Esc'.
const KEY_NAME_MAP: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
  Spacebar: 'Space',
  Esc: 'Escape',
  Del: 'Delete',
};

async function handlePressKey(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const rawKey = (params.key as string) || '';
  if (!rawKey) return { error: 'key parameter is required' };
  const keyCode = KEY_NAME_MAP[rawKey] || rawKey;
  await wv.executeJavaScript('document.body && document.body.focus && document.body.focus(); true');
  // Native OS-level key events have isTrusted=true, so hostile sites' keyboard handlers respect them.
  wv.sendInputEvent({ type: 'keyDown', keyCode });
  wv.sendInputEvent({ type: 'char', keyCode });
  wv.sendInputEvent({ type: 'keyUp', keyCode });
  return { text: `Pressed ${rawKey}` };
}

// CDP Accessibility.getFullAXTree sees computed roles/names even on hostile sites with unlabeled DOMs.
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'checkbox', 'menuitem',
  'tab', 'switch', 'searchbox', 'slider', 'listbox', 'option',
  'radio', 'menuitemcheckbox', 'menuitemradio', 'spinbutton', 'treeitem',
]);

interface InteractiveElement {
  index: number;
  role: string;
  name: string;
  backendNodeId: number;
  sessionId?: string;
  value?: string;
}

function extractAxValue(prop: any): string {
  if (!prop) return '';
  if (typeof prop === 'string') return prop;
  if (prop.value !== undefined) {
    if (typeof prop.value === 'string') return prop.value;
    if (typeof prop.value === 'object' && prop.value && 'value' in prop.value) {
      return String(prop.value.value || '');
    }
  }
  return '';
}

interface CdpResult { ok: boolean; result?: any; error?: string }

// sessionId undefined => root frame; a child-frame sessionId => that OOPIF.
async function sendCdp(wv: BrowserWebview, method: string, params?: Record<string, any>, sessionId?: string): Promise<any> {
  const wcId = wv.getWebContentsId();
  const bridge = (window as any).openswarm?.sendCdpCommand as
    | ((id: number, m: string, p?: any, s?: string) => Promise<CdpResult>)
    | undefined;
  if (!bridge) throw new Error('CDP bridge not available, restart the app');
  const resp = await bridge(wcId, method, params, sessionId);
  if (!resp || !resp.ok) {
    throw new Error(resp?.error || `CDP ${method} failed`);
  }
  return resp.result;
}

interface ChildSession { sessionId: string; frameId: string; parentSessionId: string | null; url: string }

async function getChildSessions(wv: BrowserWebview): Promise<ChildSession[]> {
  const bridge = (window as any).openswarm?.cdpChildSessionsGet as
    | ((id: number) => Promise<ChildSession[]>) | undefined;
  if (!bridge) return [];
  try {
    return (await bridge(wv.getWebContentsId())) || [];
  } catch {
    return [];
  }
}

// Roles whose name is useful as disambiguating context for a nearby control
// (the person's name above a "Message" button, the section heading of a form).
const _CONTEXT_ROLES = new Set(['heading', 'statictext', 'link']);
const _CONTEXT_MAX_CHARS = 60;
const _CONTEXT_LOOKBACK = 30;

function axNodesToCandidates(nodes: any[], sessionId?: string): RankItem[] {
  const byId = new Map<string, any>();
  const parentOf = new Map<string, string>();
  const orderOf = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.nodeId != null) {
      byId.set(String(node.nodeId), node);
      orderOf.set(String(node.nodeId), i);
    }
  }
  for (const node of nodes) {
    for (const c of node.childIds || []) parentOf.set(String(c), String(node.nodeId));
  }
  const isCandidate = (n: any): boolean => {
    if (!n || n.ignored || n.backendDOMNodeId == null) return false;
    return INTERACTIVE_ROLES.has(extractAxValue(n.role));
  };
  // Which card/section does this control sit in? Nearest named non-interactive
  // ancestor wins (a listitem's name aggregates its card text); else the nearest
  // preceding heading/text/link in document order (browser-use's trick). This is
  // what tells "Message" for Tyler apart from "Message" for everyone else.
  const contextOf = (node: any, ownName: string): string => {
    let p = parentOf.get(String(node.nodeId));
    for (let hops = 0; p && hops < 12; hops++) {
      const anc = byId.get(p);
      if (anc && !anc.ignored && !isCandidate(anc)) {
        const ancName = extractAxValue(anc.name).trim();
        if (ancName && ancName !== ownName) return ancName.slice(0, _CONTEXT_MAX_CHARS);
      }
      p = parentOf.get(p);
    }
    const pos = orderOf.get(String(node.nodeId));
    if (pos == null) return '';
    for (let i = pos - 1; i >= 0 && i >= pos - _CONTEXT_LOOKBACK; i--) {
      const prev = nodes[i];
      if (!prev || prev.ignored) continue;
      if (!_CONTEXT_ROLES.has(extractAxValue(prev.role).toLowerCase())) continue;
      const prevName = extractAxValue(prev.name).trim();
      if (prevName && prevName !== ownName && prevName.length >= 3) {
        return prevName.slice(0, _CONTEXT_MAX_CHARS);
      }
    }
    return '';
  };
  // A same-named interactive ancestor owns this hit target (a link inside a
  // button, an icon twin inside its labeled wrapper); listing both just gives
  // the model two indexes for one click. Names must match so a menu never
  // swallows its menuitems.
  const twinOfAncestor = (node: any, name: string): boolean => {
    if (!name) return false;
    let p = parentOf.get(String(node.nodeId));
    while (p) {
      const anc = byId.get(p);
      if (isCandidate(anc)) return extractAxValue(anc.name).slice(0, 80) === name;
      p = parentOf.get(p);
    }
    return false;
  };
  const out: RankItem[] = [];
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = extractAxValue(node.role);
    if (!INTERACTIVE_ROLES.has(role)) continue;
    const name = extractAxValue(node.name);
    if (!name && role !== 'textbox' && role !== 'searchbox' && role !== 'combobox') continue;
    const backendNodeId = node.backendDOMNodeId;
    if (backendNodeId == null) continue;
    const shortName = name.slice(0, 80);
    if (twinOfAncestor(node, shortName)) continue;
    let value = '';
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
      const isProtected = (node.properties || []).some(
        (p: any) => p?.name === 'protected' && p?.value?.value === true,
      );
      value = isProtected ? '' : extractAxValue(node.value).slice(0, 60);
    }
    out.push({ role, name: shortName, backendNodeId, sessionId, context: contextOf(node, name), value });
  }
  return out;
}

// Cumulative top-left offset of a frame within the root viewport: climb the
// session chain adding each owning <iframe>'s top-left. Used ONLY to place the
// cosmetic click ripple; the click itself dispatches in the element's own
// frame, so this is best-effort. Verified getFrameOwner works through Electron.
async function frameOffset(
  wv: BrowserWebview, sessionId: string | undefined, children: ChildSession[],
): Promise<{ dx: number; dy: number }> {
  let dx = 0, dy = 0;
  const byId = new Map(children.map((c) => [c.sessionId, c]));
  const seen = new Set<string>();
  let s: string | null | undefined = sessionId;
  while (s && !seen.has(s)) {
    seen.add(s);
    const info = byId.get(s);
    if (!info) break;
    const parent = info.parentSessionId || undefined; // undefined => root
    const owner = await sendCdp(wv, 'DOM.getFrameOwner', { frameId: info.frameId }, parent);
    const ownerBox = await sendCdp(wv, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, parent);
    const oc = ownerBox?.model?.content;
    if (!Array.isArray(oc) || oc.length < 8) break;
    dx += oc[0];
    dy += oc[1];
    s = info.parentSessionId;
  }
  return { dx, dy };
}

// Enumerate interactive elements across the root frame + every attached OOPIF
// child frame. Shared by list_interactives (numbered list) and click_by_name
// (stable re-resolution for replay), so both see the exact same surface.
// Root gets a generous budget (a big real page legitimately takes a few seconds);
// only a genuinely hung renderer exceeds it. Child frames (usually tracker/ad OOPIFs
// on heavy sites) must be quick or they're skipped, and we cap how many we walk so an
// ad-heavy page can't multiply full-tree calls. The page's own content is in the root
// tree (the about:blank compose iframe is same-process, so it's in the root too).
const _AX_ROOT_TIMEOUT_MS = 8000;
const _AX_CHILD_TIMEOUT_MS = 2500;
const _MAX_AX_CHILD_FRAMES = 6;
const _PAGE_TREE_TIMEOUT_MS = 1500;
const _MAX_TOTAL_FRAMES = 12;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  p.catch(() => {}); // swallow a late rejection if the timeout wins the race first
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function flattenFrameTree(tree: any, out: string[] = []): string[] {
  if (!tree) return out;
  const id = tree?.frame?.id;
  if (id) out.push(id);
  for (const c of tree.childFrames || []) flattenFrameTree(c, out);
  return out;
}

async function enumerateCandidates(wv: BrowserWebview): Promise<RankItem[]> {
  const candidates: RankItem[] = [];
  let framesWalked = 0;
  let framesDropped = 0;

  const walkSession = async (
    sessionId: string | undefined, budgetMs: number, label: string,
  ): Promise<{ ok: boolean; lastErr?: any }> => {
    const sessionStart = Date.now();
    const remaining = () => Math.max(1, budgetMs - (Date.now() - sessionStart));

    let frameIds: string[] = [];
    try {
      const tree = await withTimeout(
        sendCdp(wv, 'Page.getFrameTree', {}, sessionId),
        Math.min(_PAGE_TREE_TIMEOUT_MS, remaining()), `${label} frame tree`);
      frameIds = flattenFrameTree(tree?.frameTree);
    } catch { /* fall through to a single AX call below */ }

    if (frameIds.length === 0) {
      if (framesWalked >= _MAX_TOTAL_FRAMES) { framesDropped++; return { ok: true }; }
      try {
        const ax = await withTimeout(
          sendCdp(wv, 'Accessibility.getFullAXTree', {}, sessionId), remaining(), label);
        candidates.push(...axNodesToCandidates(ax?.nodes || [], sessionId));
        framesWalked++;
        return { ok: true };
      } catch (err: any) {
        return { ok: false, lastErr: err };
      }
    }

    let lastErr: any;
    let anySuccess = false;
    for (const frameId of frameIds) {
      if (framesWalked >= _MAX_TOTAL_FRAMES) { framesDropped++; continue; }
      if (remaining() <= 1) { framesDropped++; continue; }
      try {
        const ax = await withTimeout(
          sendCdp(wv, 'Accessibility.getFullAXTree', { frameId }, sessionId), remaining(), label);
        candidates.push(...axNodesToCandidates(ax?.nodes || [], sessionId));
        anySuccess = true;
      } catch (err: any) { lastErr = err; }
      framesWalked++;
    }
    return { ok: anySuccess, lastErr };
  };

  const root = await walkSession(undefined, _AX_ROOT_TIMEOUT_MS, 'page perception');
  if (!root.ok) {
    // A saturated/hung renderer can't answer; surface a clear, actionable signal
    // instead of silently blocking to the hard command timeout, so the agent can
    // wait a beat and retry (the freeze is often intermittent) rather than abort.
    throw new Error(
      `the page is too busy to read right now (${root.lastErr?.message || 'timed out'}); `
      + 'wait a moment with BrowserWait and try again, or reload the page.');
  }
  const children = (await getChildSessions(wv)).slice(0, _MAX_AX_CHILD_FRAMES);
  for (const child of children) {
    if (framesWalked >= _MAX_TOTAL_FRAMES) { framesDropped++; continue; }
    await walkSession(child.sessionId, _AX_CHILD_TIMEOUT_MS, 'child frame');
  }
  if (framesDropped > 0) {
    console.log(`[cdp] enumerateCandidates capped at ${_MAX_TOTAL_FRAMES} frames; dropped ${framesDropped}`);
  }
  return candidates;
}

// Resolve + click a specific backend node (revalidate, frame-local box model,
// OS-level dispatch in the element's own frame, cosmetic top-level ripple).
// Shared by click_index (cache lookup) and click_by_name (fresh resolution).
async function clickBackendNode(
  wv: BrowserWebview, backendNodeId: number, sessionId: string | undefined, label: string,
  opts: { role?: string; text?: string } = {},
): Promise<Record<string, any>> {
  let resolvedObjectId: string | undefined;
  try {
    const resolved = await sendCdp(wv, 'DOM.resolveNode', { backendNodeId }, sessionId);
    resolvedObjectId = resolved?.object?.objectId;
  } catch (err: any) {
    return { error: `${label} is no longer valid (${err.message || 'node not found'}). The page may have changed.` };
  }

  // Brief outline pulse on the element the agent chose, so a watching user
  // sees WHAT is being acted on, not just a ripple somewhere on the page.
  if (resolvedObjectId) {
    sendCdp(wv, 'Runtime.callFunctionOn', {
      objectId: resolvedObjectId,
      functionDeclaration:
        'function() {'
        + ' const o = this.style.outline, f = this.style.outlineOffset;'
        + ' this.style.outline = "3px solid rgba(77,163,255,0.9)"; this.style.outlineOffset = "2px";'
        + ' setTimeout(() => { this.style.outline = o; this.style.outlineOffset = f; }, 450);'
        + ' }',
    }, sessionId).catch(() => {});
  }

  // A text box is focused DIRECTLY by node id, never by screen coordinates. Inside an
  // about:blank compose iframe (LinkedIn/Gmail messaging) the coordinate path lands on
  // the wrong element (the box model is frame-local but the click dispatches in the root
  // frame), while DOM.focus reaches the node in any frame. With a `text` arg we then
  // insert the whole string at once, no clicking, no character-by-character typing.
  const _role = opts.role || '';
  const _wantsText = typeof opts.text === 'string' && opts.text.length > 0;
  if (/\b(textbox|searchbox)\b/i.test(_role) || (/\bcombobox\b/i.test(_role) && _wantsText)) {
    try {
      await sendCdp(wv, 'DOM.focus', { backendNodeId }, sessionId);
    } catch (err: any) {
      return { error: `${label} could not be focused (${err?.message || 'focus failed'}); it may be disabled or hidden.` };
    }
    if (typeof opts.text === 'string' && opts.text.length > 0) {
      // Read the text back from the node itself; "insert reported OK" is not
      // "the box has the text" (rich-text editors can swallow synthetic input).
      // Returns the box's actual content (or null on miss) so the result can
      // echo the OBSERVED state; a bare "typed it" claim loses to a wrongly
      // pessimistic expect-confirm and provokes a double-fill.
      const readBack = async (): Promise<string | null> => {
        try {
          const t = await sendCdp(wv, 'DOM.resolveNode', { backendNodeId }, sessionId);
          const r = await sendCdp(wv, 'Runtime.callFunctionOn', {
            objectId: t.object.objectId,
            functionDeclaration:
              'function(s) { const v = (this.value !== undefined ? this.value : this.textContent) || ""; return v.includes(s) ? v.slice(0, 120) : null; }',
            arguments: [{ value: opts.text }],
            returnByValue: true,
          }, sessionId);
          return typeof r?.result?.value === 'string' ? r.result.value : null;
        } catch { return opts.text ?? ''; } // unverifiable beats a false alarm
      };
      const landedMsg = (got: string, via = '') =>
        ({ text: `Focused ${label} and typed the text in${via}. Verified: the box now contains "${got}". Do NOT type it again.` });
      try {
        await sendCdp(wv, 'Input.insertText', { text: opts.text }, sessionId);
      } catch (err: any) {
        return { error: `Focused ${label} but could not type into it: ${err?.message || String(err)}` };
      }
      let got = await readBack();
      if (got !== null) return landedMsg(got);
      try {
        const t = await sendCdp(wv, 'DOM.resolveNode', { backendNodeId }, sessionId);
        await sendCdp(wv, 'Runtime.callFunctionOn', {
          objectId: t.object.objectId,
          functionDeclaration:
            'function(s) { this.focus(); document.execCommand("insertText", false, s); }',
          arguments: [{ value: opts.text }],
        }, sessionId);
      } catch { /* verified below; the honest error covers this failing too */ }
      got = await readBack();
      if (got !== null) return landedMsg(got, ' (via editor command)');
      return { error: `Focused ${label} but the text did not register; the box may be a custom editor. Try BrowserPressKey per character or a different element.` };
    }
    return { text: `Focused ${label}; the cursor is in it now (type with BrowserPressKey, or pass a text arg to fill it in one call).` };
  }

  try {
    await sendCdp(wv, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }, sessionId);
  } catch { /* not scrollable or already visible; the box model below decides */ }
  let boxModel;
  try {
    boxModel = await sendCdp(wv, 'DOM.getBoxModel', { backendNodeId }, sessionId);
  } catch (err: any) {
    return { error: `${label} has no box model (likely off-screen or hidden). Try scrolling first.` };
  }
  const content = boxModel?.model?.content;
  if (!Array.isArray(content) || content.length < 8) {
    return { error: `${label} has no valid bounding rect.` };
  }
  const lx = (content[0] + content[4]) / 2;
  const ly = (content[1] + content[5]) / 2;

  // Hit-test before dispatching: a sticky banner or header twin can cover the
  // element's center, and a blind coordinate click lands on the overlay instead
  // (the "Reactivate Premium" misfire). If covered, click the chosen node itself.
  let covered = false;
  let targetObjectId: string | undefined;
  try {
    const t = await sendCdp(wv, 'DOM.resolveNode', { backendNodeId }, sessionId);
    targetObjectId = t?.object?.objectId;
    if (targetObjectId) {
      const rel = await sendCdp(wv, 'Runtime.callFunctionOn', {
        objectId: targetObjectId,
        functionDeclaration:
          'function(x, y) { const r = this.getRootNode(); const h = (r.elementFromPoint ? r : document).elementFromPoint(x, y); return h ? (this === h || this.contains(h)) : true; }',
        arguments: [{ value: lx }, { value: ly }],
        returnByValue: true,
      }, sessionId);
      covered = rel?.result?.value === false;
    }
  } catch { /* hit-test is best-effort; fall through to the coordinate click */ }

  let rx = lx, ry = ly;
  if (sessionId) {
    try {
      const children = await getChildSessions(wv);
      const { dx, dy } = await frameOffset(wv, sessionId, children);
      rx = lx + dx; ry = ly + dy;
    } catch { /* fall back to frame-local for the ripple */ }
  }
  const ripple = { clickX: rx / wv.clientWidth * 100, clickY: ry / wv.clientHeight * 100 };

  if (covered && targetObjectId) {
    try {
      await sendCdp(wv, 'Runtime.callFunctionOn', {
        objectId: targetObjectId,
        functionDeclaration:
          'function() { if (this.click) { this.click(); } else { this.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); } }',
      }, sessionId);
      return { text: `Clicked ${label} via its element (another element covers its screen position).`, ...ripple };
    } catch (err: any) {
      return { error: `${label} is covered by another element and could not be clicked (${err?.message || String(err)}). Scroll, or pick a different element.` };
    }
  }

  try {
    await sendCdp(wv, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: lx, y: ly, button: 'left', clickCount: 1 }, sessionId);
    await sendCdp(wv, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: lx, y: ly, button: 'left', clickCount: 1 }, sessionId);
  } catch (err: any) {
    return { error: `Click failed: ${err.message || String(err)}` };
  }
  return {
    text: `Clicked ${label} at (${Math.round(rx)}, ${Math.round(ry)})`,
    ...ripple,
  };
}

// Drop list rows the user literally cannot click: zero-size nodes and ones
// whose center hits a DIFFERENT element (modal backdrop, sticky header, cookie
// banner). Ground truth via elementFromPoint, the same predicate the click
// path trusts. Offscreen-but-scrollable elements are kept; the page-wide list
// is deliberately wider than the viewport. Chunked with a hard budget so a
// heavy page degrades to an unfiltered list, never a stall.
const _OCCLUSION_BUDGET_MS = 1500;
const _OCCLUSION_CHUNK = 10;
async function dropCoveredElements(
  wv: BrowserWebview, items: RankItem[],
): Promise<{ kept: RankItem[]; dropped: number }> {
  const deadline = Date.now() + _OCCLUSION_BUDGET_MS;
  const kept: RankItem[] = [];
  let dropped = 0;
  for (let i = 0; i < items.length; i += _OCCLUSION_CHUNK) {
    const chunk = items.slice(i, i + _OCCLUSION_CHUNK);
    if (Date.now() > deadline) {
      kept.push(...items.slice(i));
      break;
    }
    const verdicts = await Promise.all(chunk.map(async (el) => {
      try {
        const t = await sendCdp(wv, 'DOM.resolveNode', { backendNodeId: el.backendNodeId }, el.sessionId);
        const objectId = t?.object?.objectId;
        if (!objectId) return 'clear';
        const r = await sendCdp(wv, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration:
            'function() {'
            + ' const rect = this.getBoundingClientRect();'
            + ' if (rect.width === 0 || rect.height === 0) return "hidden";'
            + ' const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;'
            + ' if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return "offscreen";'
            + ' const root = this.getRootNode();'
            + ' const h = (root.elementFromPoint ? root : document).elementFromPoint(cx, cy);'
            + ' if (!h) return "clear";'
            + ' return (this === h || this.contains(h) || h.contains(this)) ? "clear" : "covered";'
            + ' }',
          returnByValue: true,
        }, el.sessionId);
        return r?.result?.value || 'clear';
      } catch {
        return 'clear';
      }
    }));
    chunk.forEach((el, j) => {
      if (verdicts[j] === 'covered' || verdicts[j] === 'hidden') dropped += 1;
      else kept.push(el);
    });
  }
  return { kept, dropped };
}

async function handleListInteractives(wv: BrowserWebview, params: Record<string, any> = {}): Promise<Record<string, any>> {
  let candidates: RankItem[];
  try {
    candidates = await enumerateCandidates(wv);
  } catch (err: any) {
    return { error: `getFullAXTree failed: ${err.message || String(err)}` };
  }

  // Dedupe twins, rank what a human acts on first (and the current goal
  // highest), cap the long tail.
  const goal = typeof params?.goal === 'string' ? params.goal : '';
  const { shown: ranked, truncated } = rankAndCapInteractives(candidates, { goal });
  const { kept: shown, dropped: covered } = await dropCoveredElements(wv, ranked);

  // The previous look's cache feeds two things: * markers for brand-new
  // elements, and STABLE indices so the same element keeps the same number
  // across looks (the model can act on a remembered index without re-reading
  // the whole list, browser-use's stable-hash trick on our node ids).
  let prevIds: Set<string> | null = null;
  const prevIndexByKey = new Map<string, number>();
  try {
    const cacheBridge = (window as any).openswarm?.cdpCacheGet;
    const prev = cacheBridge ? await cacheBridge(wv.getWebContentsId()) : null;
    if (prev && typeof prev === 'object') {
      for (const [idxStr, e] of Object.entries(prev)) {
        const key = `${(typeof e === 'object' && (e as any)?.sessionId) || ''}:${typeof e === 'number' ? e : (e as any)?.backendNodeId}`;
        prevIndexByKey.set(key, Number(idxStr));
      }
      prevIds = new Set(prevIndexByKey.keys());
    }
  } catch { /* no previous list; fresh numbering, no markers */ }
  const keyOf = (el: RankItem) => `${el.sessionId || ''}:${el.backendNodeId}`;
  const isNew = (el: RankItem) => !!prevIds && prevIds.size > 0 && !prevIds.has(keyOf(el));

  // Sticky only while some elements carried over; full turnover (a navigation,
  // node ids all changed) or runaway numbering restarts cleanly at 1.
  const matchedPrev = shown.filter((el) => prevIndexByKey.has(keyOf(el))).length;
  let nextFree = prevIndexByKey.size > 0 ? Math.max(...prevIndexByKey.values()) + 1 : 1;
  const sticky = matchedPrev > 0 && nextFree + shown.length < 1000;
  const used = new Set<number>();
  const interactives: (InteractiveElement & { isNew: boolean; context?: string })[] = shown.map((el, i) => {
    let index = sticky ? prevIndexByKey.get(keyOf(el)) : undefined;
    if (index == null || used.has(index)) index = sticky ? nextFree++ : i + 1;
    used.add(index);
    return {
      index,
      role: el.role,
      name: el.name,
      backendNodeId: el.backendNodeId,
      sessionId: el.sessionId,
      value: el.value,
      isNew: isNew(el),
      context: el.context,
    };
  });

  // Cache in main-process so click_index can resolve across separate WS commands.
  // role+name ride along so click_index can report WHAT it clicked (the agent
  // loop records that as a stable, replayable click-by-name step).
  const indexMap: Record<number, { backendNodeId: number; sessionId?: string; role?: string; name?: string }> = {};
  for (const el of interactives) {
    indexMap[el.index] = { backendNodeId: el.backendNodeId, sessionId: el.sessionId, role: el.role, name: el.name };
  }
  try {
    const cacheBridge = (window as any).openswarm?.cdpCacheSet;
    if (cacheBridge) await cacheBridge(wv.getWebContentsId(), indexMap);
  } catch {
    // best-effort; click_index falls back to re-listing.
  }

  // ctx only where it disambiguates: rows whose role+name appear more than
  // once (eight "Message" buttons). Unique rows skip it to keep tokens lean.
  const nameCounts = new Map<string, number>();
  for (const el of interactives) {
    const k = `${el.role}|${el.name}`;
    nameCounts.set(k, (nameCounts.get(k) || 0) + 1);
  }
  const lines = interactives.map((el) => {
    const dup = (nameCounts.get(`${el.role}|${el.name}`) || 0) > 1;
    const ctx = dup && el.context ? ` ctx="${el.context}"` : '';
    const val = el.value ? ` value="${el.value}"` : '';
    return `[${el.index}]${el.isNew ? '*' : ''}<${el.role} "${el.name}"${ctx}${val}>`;
  });
  let text: string;
  if (lines.length === 0) {
    text = 'No interactive elements found on this page.';
  } else {
    text = `${lines.length} interactive elements (* = new since your last look; same number = same element as before):\n${lines.join('\n')}`;
    if (truncated > 0) {
      text += `\n... ${truncated} more not shown; scroll or scope with BrowserGetElements to reach them.`;
    }
    if (covered > 0) {
      text += `\n(${covered} elements hidden behind overlays were omitted; close the overlay to reach them.)`;
    }
  }

  return {
    text,
    elements: interactives.map((el) => ({ index: el.index, role: el.role, name: el.name })),
    url: wv.getURL(),
  };
}

async function handleClickIndex(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const idx = Number(params.index);
  if (!Number.isFinite(idx) || idx < 1) {
    return { error: 'index parameter is required and must be a positive integer' };
  }

  let backendNodeId: number | undefined;
  let sessionId: string | undefined;
  let role: string | undefined;
  let name: string | undefined;
  try {
    const cacheBridge = (window as any).openswarm?.cdpCacheGet;
    if (cacheBridge) {
      const cached = await cacheBridge(wv.getWebContentsId());
      const entry = cached && cached[idx];
      if (typeof entry === 'number') {
        backendNodeId = entry; // legacy cache shape
      } else if (entry && typeof entry === 'object' && entry.backendNodeId != null) {
        backendNodeId = Number(entry.backendNodeId);
        sessionId = entry.sessionId || undefined;
        role = entry.role; name = entry.name;
      }
    }
  } catch {
    // fall through to error path below
  }

  if (backendNodeId == null) {
    return {
      error: `Index ${idx} is not in the cached element map. Call BrowserListInteractives first to refresh the index, then try again.`,
    };
  }

  const result = await clickBackendNode(wv, backendNodeId, sessionId, `index ${idx}`,
    { role, text: typeof params.text === 'string' ? params.text : undefined });
  // Surface what was clicked so the agent loop can record a stable,
  // replayable click-by-name step (indices are ephemeral; names aren't).
  if (!result.error) {
    result.clickedRole = role || '';
    result.clickedName = name || '';
  }
  return result;
}

// Robust click for REPLAY: re-resolve the target fresh by (role, name) instead
// of a stale index, so a recorded skill survives index shifts between runs.
async function handleClickByName(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const wantName = String(params.name || '').trim();
  const wantRole = String(params.role || '').trim();
  if (!wantName && !wantRole) return { error: 'click_by_name needs a name and/or role' };
  let candidates: RankItem[];
  try {
    candidates = await enumerateCandidates(wv);
  } catch (err: any) {
    return { error: `enumerate failed: ${err.message || String(err)}` };
  }
  const norm = (s: string) => s.trim().toLowerCase();
  // Exact (role,name) first, then name-only, so we click the most specific match.
  // Long names are card blobs whose SUFFIX mutates between visits (feed snippets,
  // counters) while the prefix stays stable; fall back to a 40-char prefix match
  // so a replayed click survives the churn.
  const wantPrefix = norm(wantName).slice(0, 40);
  const match =
    candidates.find((c) => (!wantRole || norm(c.role) === norm(wantRole)) && norm(c.name) === norm(wantName)) ||
    candidates.find((c) => norm(c.name) === norm(wantName)) ||
    (wantName.length > 40
      ? candidates.find((c) => (!wantRole || norm(c.role) === norm(wantRole)) && norm(c.name).startsWith(wantPrefix))
      : undefined);
  if (!match) {
    return { error: `No element matching role="${wantRole}" name="${wantName}" on this page.` };
  }
  return clickBackendNode(wv, match.backendNodeId, match.sessionId, `${match.role} "${match.name}"`,
    { role: match.role });
}

// Sequential sub-actions; aborts mid-batch if URL changes (indices/selectors go stale on navigation).
const MAX_BATCH_ACTIONS = 5;

type SubActionType =
  | 'click_index' | 'press_key' | 'type' | 'wait'
  | 'scroll' | 'navigate' | 'click' | 'list_interactives';

const BATCH_DISPATCH: Record<SubActionType, (wv: BrowserWebview, p: Record<string, any>) => Promise<Record<string, any>>> = {
  click_index: handleClickIndex,
  press_key: handlePressKey,
  type: handleType,
  wait: handleWait,
  scroll: handleScroll,
  navigate: handleNavigate,
  click: handleClick,
  // Allowed as the LAST sub-action so a click->wait->read folds into one turn.
  list_interactives: handleListInteractives,
};

async function handleBatch(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const actions: any[] = Array.isArray(params.actions) ? params.actions : [];
  if (actions.length === 0) {
    return { error: 'actions parameter must be a non-empty array' };
  }
  if (actions.length > MAX_BATCH_ACTIONS) {
    return {
      error: `Batch too large: ${actions.length} actions (max ${MAX_BATCH_ACTIONS}). Split into smaller batches.`,
    };
  }

  const results: Array<Record<string, any>> = [];
  let aborted_at: number | null = null;
  let abort_reason: string | null = null;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const subType = action?.type as SubActionType;
    const subParams = action?.params || {};

    if (!subType || !(subType in BATCH_DISPATCH)) {
      results.push({ index: i, type: subType, error: `Unknown sub-action type: ${subType}` });
      // per-action failures don't abort the batch
      continue;
    }

    const urlBefore = wv.getURL();
    let subResult: Record<string, any>;
    try {
      subResult = await BATCH_DISPATCH[subType](wv, subParams);
    } catch (err: any) {
      subResult = { error: `Sub-action failed: ${err?.message || String(err)}` };
    }
    results.push({ index: i, type: subType, ...subResult });

    // A failed sub-action means every later one is operating on a page that
    // isn't in the state it assumed, so stop instead of compounding the error
    // (browser-use's multi_act breaks the same way). The terminal read is the
    // last action, so a read failure never trips this.
    if (subResult.error && i < actions.length - 1) {
      aborted_at = i + 1;
      abort_reason = `Sub-action ${i + 1} (${subType}) failed: ${subResult.error}; remaining ${actions.length - i - 1} action(s) skipped`;
      break;
    }

    // URL changed: selectors and indices are stale on the half-loaded page; abort.
    const urlAfter = wv.getURL();
    if (urlAfter !== urlBefore && i < actions.length - 1) {
      aborted_at = i + 1;
      abort_reason = `URL changed mid-batch from ${urlBefore} to ${urlAfter}; remaining ${actions.length - i - 1} action(s) skipped`;
      break;
    }
  }

  const summary_lines = results.map((r, i) => {
    const status = r.error ? `FAIL (${r.error})` : 'OK';
    return `  ${i + 1}. ${r.type}: ${status}`;
  });
  const text = [
    `Batch executed ${results.length}/${actions.length} actions`,
    ...summary_lines,
    aborted_at !== null ? `\nABORTED at action ${aborted_at}: ${abort_reason}` : '',
  ].filter(Boolean).join('\n');

  return {
    text,
    results,
    aborted_at,
    abort_reason,
    url: wv.getURL(),
  };
}

async function handleScroll(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const direction = (params.direction as string) || 'down';
  const amount = (params.amount as number) || 500;
  const code = `(() => {
    function findScrollable() {
      const candidates = document.querySelectorAll(
        '[class*="scroller"], [class*="scroll-container"], [class*="content"], '
        + 'main, [role="main"], article, .notion-scroller, .notion-frame'
      );
      for (const el of candidates) {
        const s = window.getComputedStyle(el);
        const isScrollable = (s.overflow === 'auto' || s.overflow === 'scroll'
          || s.overflowY === 'auto' || s.overflowY === 'scroll');
        if (isScrollable && el.scrollHeight > el.clientHeight + 10) return el;
      }
      const all = document.querySelectorAll('*');
      for (const el of all) {
        if (el === document.body || el === document.documentElement) continue;
        const s = window.getComputedStyle(el);
        const isScrollable = (s.overflow === 'auto' || s.overflow === 'scroll'
          || s.overflowY === 'auto' || s.overflowY === 'scroll');
        if (isScrollable && el.scrollHeight > el.clientHeight + 50
            && el.clientHeight > 200) return el;
      }
      return null;
    }
    const dy = ${JSON.stringify(direction)} === 'up' ? -${amount} : ${amount};
    const container = findScrollable();
    if (container) {
      const before = container.scrollTop;
      container.scrollBy({ top: dy, behavior: 'instant' });
      const after = container.scrollTop;
      return {
        scrolled: Math.abs(after - before),
        scrollTop: after,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        atTop: after <= 0,
        atBottom: after + container.clientHeight >= container.scrollHeight - 5,
        target: 'container',
      };
    }
    const before = window.scrollY;
    window.scrollBy({ top: dy, behavior: 'instant' });
    const after = window.scrollY;
    return {
      scrolled: Math.abs(after - before),
      scrollTop: after,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: window.innerHeight,
      atTop: after <= 0,
      atBottom: after + window.innerHeight >= document.documentElement.scrollHeight - 5,
      target: 'window',
    };
  })()`;
  try {
    const result = await wv.executeJavaScript(code);
    const status = result.atBottom ? ' (reached bottom)' : result.atTop ? ' (reached top)' : '';
    return {
      text: `Scrolled ${direction} by ${result.scrolled}px${status}. Position: ${result.scrollTop}/${result.scrollHeight - result.clientHeight}px`,
      ...result,
      url: wv.getURL(),
    };
  } catch (err: any) {
    return { error: `Scroll failed: ${err?.message || String(err)}` };
  }
}

async function handleWait(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const ms = Math.min(Math.max((params.milliseconds as number) || 1000, 100), 10000);
  const until = typeof params.until === 'string' ? params.until : '';
  const probeJs = settleProbeJs(until);
  const start = Date.now();
  let settled = false;
  let found = false;
  let probeErrors = 0;
  let lastElems: number | null = null;
  let elemsChangedAt = start; // DOM-settle clock
  while (Date.now() - start < ms) {
    const remaining = ms - (Date.now() - start);
    await new Promise((resolve) => setTimeout(resolve, Math.min(SETTLE_POLL_MS, Math.max(0, remaining))));
    const elapsed = Date.now() - start;
    if (elapsed >= ms) break;
    try {
      const probe = JSON.parse(await wv.executeJavaScript(probeJs));
      probeErrors = 0;
      if (probe.elems !== lastElems) { lastElems = probe.elems; elemsChangedAt = Date.now(); }
      const domStable = Date.now() - elemsChangedAt;
      if (shouldStopWaiting(probe.ready, probe.quiet || 0, domStable, !!probe.found, elapsed)) {
        settled = true; found = !!probe.found; break;
      }
    } catch {
      // Mid-navigation pages aren't evaluable yet; a few misses is normal, but a
      // wedged tab shouldn't make us burn the whole cap, so bail after a short streak.
      if (++probeErrors >= 3) break;
    }
  }
  const waited = Date.now() - start;
  const state = found ? 'found target' : settled ? 'page settled' : 'reached cap';
  return {
    text: `Waited ${waited}ms (${state}). Current URL: ${wv.getURL()}`,
    url: wv.getURL(),
    title: wv.getTitle(),
  };
}

async function handleGetElements(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const scope = (params.selector as string) || 'body';
  const safeScope = JSON.stringify(scope);
  const code = `(() => {
    const scope = document.querySelector(${safeScope}) || document.body;
    const interactive = scope.querySelectorAll(
      'a[href], button, input, textarea, select, [role="button"], [role="link"], '
      + '[role="textbox"], [role="searchbox"], [role="menuitem"], [role="tab"], '
      + '[role="checkbox"], [role="switch"], [role="option"], '
      + '[onclick], [tabindex]:not([tabindex="-1"]), '
      + '[data-block-id], [contenteditable="true"]'
    );
    const seen = new Set();
    const results = [];
    for (const el of interactive) {
      if (results.length >= 80) break;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (style.opacity === '0') continue;

      let selector = el.tagName.toLowerCase();
      if (el.id) {
        selector = '#' + CSS.escape(el.id);
      } else if (el.getAttribute('data-block-id')) {
        selector = '[data-block-id="' + el.getAttribute('data-block-id') + '"]';
      } else if (el.getAttribute('name')) {
        selector = el.tagName.toLowerCase() + '[name="' + CSS.escape(el.getAttribute('name')) + '"]';
      } else if (el.getAttribute('aria-label')) {
        selector = el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(el.getAttribute('aria-label')) + '"]';
      } else if (el.getAttribute('type') && el.tagName === 'INPUT') {
        selector = 'input[type="' + el.getAttribute('type') + '"]';
        if (el.getAttribute('placeholder'))
          selector += '[placeholder="' + CSS.escape(el.getAttribute('placeholder')) + '"]';
      } else if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\\s+/)[0];
        if (cls && cls.length < 60)
          selector = el.tagName.toLowerCase() + '.' + CSS.escape(cls);
      }

      if (seen.has(selector)) {
        const parent = el.parentElement;
        if (parent && parent.id) {
          selector = '#' + CSS.escape(parent.id) + ' > ' + selector;
        } else {
          const siblings = parent ? Array.from(parent.children) : [];
          const idx = siblings.indexOf(el);
          if (idx >= 0) selector += ':nth-child(' + (idx + 1) + ')';
        }
      }
      seen.add(selector);

      results.push({
        selector,
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        text: (el.textContent || '').trim().substring(0, 120) || null,
        placeholder: el.placeholder || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        role: el.getAttribute('role') || null,
        href: el.href && el.href !== location.href ? el.href : null,
      });
    }
    return { elements: results, total: interactive.length, url: location.href, title: document.title };
  })()`;
  try {
    const result = await wv.executeJavaScript(code);
    return { text: JSON.stringify(result, null, 2), url: wv.getURL() };
  } catch (err: any) {
    return { error: `Failed to get elements: ${err?.message || String(err)}` };
  }
}

// Tier 1: detect a site's declared WebMCP tools (navigator.modelContext). When a
// site exposes its own tools the agent can prefer them over scraping the UI. The
// API is a Chrome 149 origin-trial standard; this Electron's Chromium predates it
// so real pages return "not present" today, this is forward-compatible probing,
// also covers the MCP-B convention (getRegisteredTools/listTools/tools array).
async function handleDetectWebMCP(wv: BrowserWebview): Promise<Record<string, any>> {
  const code = `(() => {
    const mc = navigator.modelContext;
    if (!mc) return { present: false, tools: [] };
    let raw = [];
    try {
      if (typeof mc.getRegisteredTools === 'function') raw = mc.getRegisteredTools() || [];
      else if (typeof mc.listTools === 'function') raw = mc.listTools() || [];
      else if (Array.isArray(mc.tools)) raw = mc.tools;
    } catch (e) {}
    const tools = (raw || []).map(t => ({
      name: String((t && t.name) || ''),
      description: String((t && t.description) || '').slice(0, 200),
    })).filter(t => t.name);
    return { present: true, tools };
  })()`;
  try {
    const r = await wv.executeJavaScript(code);
    if (!r || !r.present) {
      return { text: 'No WebMCP on this page (navigator.modelContext not present). Use the normal browser tools.', url: wv.getURL() };
    }
    if (!r.tools.length) {
      return { text: 'WebMCP is present but exposes no callable tools. Use the normal browser tools.', url: wv.getURL() };
    }
    const lines = r.tools.map((t: any) => `- ${t.name}: ${t.description}`).join('\n');
    return { text: `WebMCP tools declared by this page:\n${lines}`, tools: r.tools, url: wv.getURL() };
  } catch (err: any) {
    return { error: `WebMCP detection failed: ${err?.message || String(err)}` };
  }
}

// Tier 2: the safe GET routes captured for the current site, so the agent can
// fetch data directly instead of re-scraping the UI. Only same-origin GET/HEAD
// routes are listed; those are all that replay_route will run.
async function handleListRoutes(wv: BrowserWebview): Promise<Record<string, any>> {
  const bridge = (window as any).openswarm?.cdpRoutesGet as
    | ((id: number, origin?: string) => Promise<any[]>) | undefined;
  if (!bridge) return { error: 'Route capture not available, restart the app.' };
  let origin = '';
  try { origin = new URL(wv.getURL()).origin; } catch {}
  let routes: any[] = [];
  try { routes = (await bridge(wv.getWebContentsId(), origin)) || []; } catch {}
  const safe = routes.filter((r) => r && r.safe);
  if (!safe.length) {
    return { text: 'No replayable (GET) API routes captured for this site yet. Use the page first so they get recorded, then try again.', url: wv.getURL() };
  }
  const lines = safe.slice(0, 40).map((r) => `${r.method} ${r.example || r.template} (seen ${r.hits}x)`);
  return {
    text: `Replayable API routes for this site (safe GETs). To READ the same kind of `
      + `data for many inputs fast: swap the varying value in the URL with {{value}} `
      + `and use a replay_route step in BrowserRepeatFlow (or call BrowserReplayRoute `
      + `per item). Far cheaper than navigating + scraping each page:\n${lines.join('\n')}`,
    routes: safe.slice(0, 40),
    url: wv.getURL(),
  };
}

// Tier 2: replay a captured endpoint directly. GET/HEAD only (idempotent) and
// same-origin only; the fetch runs IN the page so cookies/CSRF come for free.
// Mutating methods are intentionally refused, those must go through the UI.
async function handleReplayRoute(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const rawUrl = params.url as string;
  const method = String(params.method || 'GET').toUpperCase();
  if (!rawUrl) return { error: 'url parameter is required' };
  if (method !== 'GET' && method !== 'HEAD') {
    return { error: `BrowserReplayRoute only runs safe GET/HEAD requests. ${method} changes data, do that through the UI (click the button) instead.` };
  }
  let absUrl: string;
  let pageOrigin: string;
  try {
    pageOrigin = new URL(wv.getURL()).origin;
    absUrl = new URL(rawUrl, wv.getURL()).href;
  } catch {
    return { error: 'invalid url' };
  }
  if (new URL(absUrl).origin !== pageOrigin) {
    return { error: "BrowserReplayRoute can only call the current site's own API (same origin)." };
  }
  const code = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(absUrl)}, { method: ${JSON.stringify(method)}, credentials: 'include' });
      const body = await r.text();
      return { status: r.status, body: body.slice(0, 15000) };
    } catch (e) { return { error: String((e && e.message) || e) }; }
  })()`;
  try {
    const res = await wv.executeJavaScript(code);
    if (res.error) return { error: `Replay failed: ${res.error}` };
    return { text: `${method} ${absUrl} -> HTTP ${res.status}\n${res.body}`, status: res.status, url: wv.getURL() };
  } catch (err: any) {
    return { error: `Replay failed: ${err?.message || String(err)}` };
  }
}

async function handleEvaluate(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const expression = params.expression as string;
  if (!expression) return { error: 'expression parameter is required' };
  try {
    const result = await wv.executeJavaScript(expression);
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    // evaluate is the agent's main read path; sample routes here too (XHRs have
    // fired by now) so the backend can surface the fast network tier once.
    const routes_available = await countSafeRoutes(wv);
    return { text: text ?? 'undefined', url: wv.getURL(), routes_available };
  } catch (err: any) {
    return { error: `JS evaluation error: ${err?.message || String(err)}` };
  }
}

// The registry is renderer-local and a card briefly unregisters on remount /
// tab-switch; a command landing in that gap shouldn't hard-fail. Wait a bounded
// window for (re)registration before giving up, so the error stays a real
// "card is gone" signal rather than a transient race.
async function awaitWebview(browserId: string, tabId?: string): Promise<BrowserWebview | undefined> {
  // A suspended (snapshot-swapped) card has no webview at all; wake it and
  // wait out the remount + page reload before the command touches it.
  const wasSuspended = !!store.getState().dashboardLayout.suspendedBrowserCards[browserId];
  if (wasSuspended) store.dispatch(resumeBrowserCard(browserId));
  const deadline = Date.now() + (wasSuspended ? 12000 : 2000);
  let wv = getWebview(browserId, tabId);
  while (!wv && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    wv = getWebview(browserId, tabId);
  }
  if (wasSuspended && wv) {
    while (Date.now() < deadline) {
      try {
        if (!wv.isLoading() && wv.getURL() !== 'about:blank') break;
      } catch {
        // mid-mount hiccup; keep waiting
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return wv;
}

// The backend re-broadcasts unanswered commands to heal a dead-socket gap, so
// a duplicate request_id must never run twice (a re-sent click would double-click).
const inflightCommands = new Set<string>();
const completedCommands = new Map<string, Record<string, any>>();
const _COMPLETED_CACHE_MAX = 50;

async function handleBrowserCommand(data: Record<string, any>) {
  const { request_id, action, browser_id, tab_id, params = {} } = data;
  if (!request_id) return;
  if (inflightCommands.has(request_id)) return;
  const cached = completedCommands.get(request_id);
  if (cached) {
    dashboardWs.send('browser:result', { request_id, ...cached });
    return;
  }
  inflightCommands.add(request_id);
  try {
    await runBrowserCommand(request_id, action, browser_id, tab_id, params);
  } finally {
    inflightCommands.delete(request_id);
  }
}

async function runBrowserCommand(
  request_id: string, action: string, browser_id: string, tab_id: string | undefined,
  params: Record<string, any>,
) {
  const wv = await awaitWebview(browser_id, tab_id || undefined);
  if (!wv) {
    dashboardWs.send('browser:result', {
      request_id,
      error: `Browser card '${browser_id}'${tab_id ? ` tab '${tab_id}'` : ''} not found or not an Electron webview`,
    });
    return;
  }

  const detail = params.url || params.selector || params.expression || undefined;
  setActivity(browser_id, { action: action as BrowserAction, detail });

  let result: Record<string, any>;
  try {
    switch (action) {
      case 'screenshot':
        result = await handleScreenshot(wv, params);
        break;
      case 'get_text':
        result = await handleGetText(wv);
        break;
      case 'get_console':
        result = await handleGetConsole(wv);
        break;
      case 'navigate':
        result = await handleNavigate(wv, params);
        break;
      case 'click':
        result = await handleClick(wv, params);
        if (result.clickX != null && result.clickY != null) {
          setActivity(browser_id, {
            action: 'click',
            detail,
            coords: { xPercent: result.clickX, yPercent: result.clickY },
          });
        }
        break;
      case 'type':
        result = await handleType(wv, params);
        break;
      case 'evaluate':
        result = await handleEvaluate(wv, params);
        break;
      case 'get_elements':
        result = await handleGetElements(wv, params);
        break;
      case 'scroll':
        result = await handleScroll(wv, params);
        break;
      case 'wait':
        result = await handleWait(wv, params);
        break;
      case 'press_key':
        result = await handlePressKey(wv, params);
        break;
      case 'list_interactives':
        result = await handleListInteractives(wv, params);
        break;
      case 'click_index':
        result = await handleClickIndex(wv, params);
        if (result.clickX != null && result.clickY != null) {
          setActivity(browser_id, {
            action: 'click_index',
            detail,
            coords: { xPercent: result.clickX, yPercent: result.clickY },
          });
        }
        break;
      case 'batch':
        result = await handleBatch(wv, params);
        break;
      case 'detect_webmcp':
        result = await handleDetectWebMCP(wv);
        break;
      case 'list_routes':
        result = await handleListRoutes(wv);
        break;
      case 'click_by_name':
        result = await handleClickByName(wv, params);
        if (result.clickX != null && result.clickY != null) {
          setActivity(browser_id, { action: 'click_by_name', detail, coords: { xPercent: result.clickX, yPercent: result.clickY } });
        }
        break;
      case 'replay_route':
        result = await handleReplayRoute(wv, params);
        break;
      default:
        result = { error: `Unknown browser action: ${action}` };
    }
  } catch (err: any) {
    result = { error: `Browser command failed: ${err?.message || String(err)}` };
  }

  setActivity(browser_id, null);
  completedCommands.set(request_id, result);
  if (completedCommands.size > _COMPLETED_CACHE_MAX) {
    completedCommands.delete(completedCommands.keys().next().value as string);
  }
  dashboardWs.send('browser:result', { request_id, ...result });
}

export function initBrowserCommandHandler(): () => void {
  if (initialized) return () => {};
  initialized = true;
  const unsub = dashboardWs.on('browser:command', handleBrowserCommand);
  return () => {
    unsub();
    initialized = false;
  };
}
