import { getWebview, type BrowserWebview } from './browserRegistry';
import { dashboardWs } from './ws/WebSocketManager';
import { resolveInput } from './resolveUrl';
import { rankAndCapInteractives, type RankItem } from './interactiveRanking';

let initialized = false;

export type BrowserAction = 'screenshot' | 'get_text' | 'navigate' | 'click' | 'type' | 'evaluate' | 'get_elements' | 'scroll' | 'wait' | 'press_key' | 'list_interactives' | 'click_index' | 'batch' | 'detect_webmcp' | 'list_routes' | 'replay_route';

export interface BrowserActivity {
  action: BrowserAction;
  detail?: string;
  coords?: { xPercent: number; yPercent: number };
}

type ActivityListener = (browserId: string, activity: BrowserActivity | null) => void;

const activityMap = new Map<string, BrowserActivity>();
const listeners = new Set<ActivityListener>();

function setActivity(browserId: string, activity: BrowserActivity | null) {
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
  batch: 'Running batch...',
};

export function getActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? 'Working...';
}

async function handleScreenshot(wv: BrowserWebview): Promise<Record<string, any>> {
  const nativeImage = await wv.capturePage();
  const dataUrl = nativeImage.toDataURL();
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  return { image: base64, url: wv.getURL(), title: wv.getTitle() };
}

async function handleGetText(wv: BrowserWebview): Promise<Record<string, any>> {
  const text: string = await wv.executeJavaScript(
    'document.body.innerText.substring(0, 15000)'
  );
  return { text, url: wv.getURL(), title: wv.getTitle() };
}

async function handleNavigate(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const raw = params.url as string;
  if (!raw) return { error: 'url parameter is required' };
  const url = resolveInput(raw);
  try {
    await wv.loadURL(url);
  } catch (err: any) {
    if (!err?.message?.includes('ERR_ABORTED')) throw err;
  }
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

function axNodesToCandidates(nodes: any[], sessionId?: string): RankItem[] {
  const out: RankItem[] = [];
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = extractAxValue(node.role);
    if (!INTERACTIVE_ROLES.has(role)) continue;
    const name = extractAxValue(node.name);
    if (!name && role !== 'textbox' && role !== 'searchbox' && role !== 'combobox') continue;
    const backendNodeId = node.backendDOMNodeId;
    if (backendNodeId == null) continue;
    out.push({ role, name: name.slice(0, 80), backendNodeId, sessionId });
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

async function handleListInteractives(wv: BrowserWebview, params: Record<string, any> = {}): Promise<Record<string, any>> {
  const candidates: RankItem[] = [];
  try {
    const rootTree = await sendCdp(wv, 'Accessibility.getFullAXTree', {});
    candidates.push(...axNodesToCandidates(rootTree?.nodes || []));
  } catch (err: any) {
    return { error: `getFullAXTree failed: ${err.message || String(err)}` };
  }

  // Merge cross-origin OOPIF child frames (e.g. the Google Docs share dialog),
  // whose nodes never appear in the root tree. A frame that won't answer
  // (closed / navigating) is skipped, not fatal.
  const children = await getChildSessions(wv);
  for (const child of children) {
    try {
      const childTree = await sendCdp(wv, 'Accessibility.getFullAXTree', {}, child.sessionId);
      candidates.push(...axNodesToCandidates(childTree?.nodes || [], child.sessionId));
    } catch {
      // skip unresponsive frame
    }
  }

  // Dedupe twins, rank what a human acts on first (and the current goal
  // highest), cap the long tail.
  const goal = typeof params?.goal === 'string' ? params.goal : '';
  const { shown, truncated } = rankAndCapInteractives(candidates, { goal });
  const interactives: InteractiveElement[] = shown.map((el, i) => ({
    index: i + 1,
    role: el.role,
    name: el.name,
    backendNodeId: el.backendNodeId,
    sessionId: el.sessionId,
  }));

  // Cache in main-process so click_index can resolve across separate WS commands.
  const indexMap: Record<number, { backendNodeId: number; sessionId?: string }> = {};
  for (const el of interactives) {
    indexMap[el.index] = { backendNodeId: el.backendNodeId, sessionId: el.sessionId };
  }
  try {
    const cacheBridge = (window as any).openswarm?.cdpCacheSet;
    if (cacheBridge) await cacheBridge(wv.getWebContentsId(), indexMap);
  } catch {
    // best-effort; click_index falls back to re-listing.
  }

  const lines = interactives.map(
    (el) => `[${el.index}]<${el.role} "${el.name}">`,
  );
  let text: string;
  if (lines.length === 0) {
    text = 'No interactive elements found on this page.';
  } else {
    text = `${lines.length} interactive elements:\n${lines.join('\n')}`;
    if (truncated > 0) {
      text += `\n... ${truncated} more not shown; scroll or scope with BrowserGetElements to reach them.`;
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

  // Revalidate in the element's own frame: fails fast if the page mutated and
  // the node is gone (vs. clicking the wrong element).
  try {
    await sendCdp(wv, 'DOM.resolveNode', { backendNodeId }, sessionId);
  } catch (err: any) {
    return {
      error: `Index ${idx} is no longer valid (${err.message || 'node not found'}). The page may have changed. Call BrowserListInteractives again.`,
    };
  }

  // Box model in the element's OWN frame -> frame-local center.
  let boxModel;
  try {
    boxModel = await sendCdp(wv, 'DOM.getBoxModel', { backendNodeId }, sessionId);
  } catch (err: any) {
    return {
      error: `Index ${idx} has no box model (likely off-screen or hidden). Try scrolling first or call BrowserListInteractives again.`,
    };
  }
  const content = boxModel?.model?.content;
  if (!Array.isArray(content) || content.length < 8) {
    return { error: `Index ${idx} has no valid bounding rect.` };
  }
  const lx = (content[0] + content[4]) / 2;
  const ly = (content[1] + content[5]) / 2;

  // Dispatch the OS-level click in the element's OWN frame (sessionId routes
  // into the OOPIF). This is compositor-independent, so it lands even when the
  // card is offscreen, and still passes the isTrusted check on hostile sites.
  try {
    await sendCdp(wv, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: lx, y: ly, button: 'left', clickCount: 1,
    }, sessionId);
    await sendCdp(wv, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: lx, y: ly, button: 'left', clickCount: 1,
    }, sessionId);
  } catch (err: any) {
    return { error: `Click failed: ${err.message || String(err)}` };
  }

  // Cosmetic ripple: place it in top-level coords. Best-effort for OOPIF.
  let rx = lx, ry = ly;
  if (sessionId) {
    try {
      const children = await getChildSessions(wv);
      const { dx, dy } = await frameOffset(wv, sessionId, children);
      rx = lx + dx;
      ry = ly + dy;
    } catch {
      // fall back to frame-local coords for the ripple
    }
  }

  return {
    text: `Clicked index ${idx} at (${Math.round(rx)}, ${Math.round(ry)})`,
    clickX: rx / wv.clientWidth * 100,
    clickY: ry / wv.clientHeight * 100,
  };
}

// Sequential sub-actions; aborts mid-batch if URL changes (indices/selectors go stale on navigation).
const MAX_BATCH_ACTIONS = 5;

type SubActionType =
  | 'click_index' | 'press_key' | 'type' | 'wait'
  | 'scroll' | 'navigate' | 'click';

const BATCH_DISPATCH: Record<SubActionType, (wv: BrowserWebview, p: Record<string, any>) => Promise<Record<string, any>>> = {
  click_index: handleClickIndex,
  press_key: handlePressKey,
  type: handleType,
  wait: handleWait,
  scroll: handleScroll,
  navigate: handleNavigate,
  click: handleClick,
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
  await new Promise((resolve) => setTimeout(resolve, ms));
  return {
    text: `Waited ${ms}ms. Current URL: ${wv.getURL()}`,
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
  const lines = safe.slice(0, 40).map((r) => `${r.method} ${r.template} (x${r.hits})`);
  return {
    text: `Replayable API routes for this site (safe GETs, call with BrowserReplayRoute):\n${lines.join('\n')}`,
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
    return { text: text ?? 'undefined', url: wv.getURL() };
  } catch (err: any) {
    return { error: `JS evaluation error: ${err?.message || String(err)}` };
  }
}

// The registry is renderer-local and a card briefly unregisters on remount /
// tab-switch; a command landing in that gap shouldn't hard-fail. Wait a bounded
// window for (re)registration before giving up, so the error stays a real
// "card is gone" signal rather than a transient race.
async function awaitWebview(browserId: string, tabId?: string): Promise<BrowserWebview | undefined> {
  const deadline = Date.now() + 2000;
  let wv = getWebview(browserId, tabId);
  while (!wv && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    wv = getWebview(browserId, tabId);
  }
  return wv;
}

async function handleBrowserCommand(data: Record<string, any>) {
  const { request_id, action, browser_id, tab_id, params = {} } = data;
  if (!request_id) return;

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
        result = await handleScreenshot(wv);
        break;
      case 'get_text':
        result = await handleGetText(wv);
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
