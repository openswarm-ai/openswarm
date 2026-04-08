import { getWebview, type BrowserWebview } from './browserRegistry';
import { dashboardWs } from './ws/WebSocketManager';
import { resolveInput } from './resolveUrl';

let initialized = false;

export type BrowserAction = 'screenshot' | 'get_text' | 'navigate' | 'click' | 'type' | 'evaluate' | 'get_elements' | 'scroll' | 'wait' | 'press_key' | 'list_interactives' | 'click_index' | 'batch';

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

// Map common JS KeyboardEvent.key values to Electron's accelerator keyCodes.
// Electron's sendInputEvent expects: 'Up', 'Down', 'Left', 'Right', 'Enter',
// 'Escape', 'Tab', 'Backspace', 'Delete', 'Space', or single char letters.
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
  // Focus the page first so the key event has a sensible target.
  await wv.executeJavaScript('document.body && document.body.focus && document.body.focus(); true');
  // Native OS-level key events — these have event.isTrusted === true so site
  // keyboard handlers (Tinder, Slack, Notion, etc.) actually respect them.
  wv.sendInputEvent({ type: 'keyDown', keyCode });
  wv.sendInputEvent({ type: 'char', keyCode });
  wv.sendInputEvent({ type: 'keyUp', keyCode });
  return { text: `Pressed ${rawKey}` };
}

// ---------------------------------------------------------------------------
// CDP accessibility-tree element indexing
// ---------------------------------------------------------------------------
// list_interactives uses Chrome DevTools Protocol's Accessibility.getFullAXTree
// to get the *computed* accessibility tree, not the raw DOM. This sees roles,
// names, and labels even on hostile sites (Tinder, Instagram) where the raw
// HTML is just unlabeled <div>s with click handlers — because Chromium computes
// accessible names for screen readers from icons, surrounding text, etc.
//
// Each interactive element is assigned a numeric index. The index → backendNodeId
// map is cached server-side per webContents and used by click_index. This is
// orders of magnitude more reliable than CSS-selector-based clicking on sites
// that don't expose semantic markup.

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

async function sendCdp(wv: BrowserWebview, method: string, params?: Record<string, any>): Promise<any> {
  const wcId = wv.getWebContentsId();
  const bridge = (window as any).openswarm?.sendCdpCommand as
    | ((id: number, m: string, p?: any) => Promise<CdpResult>)
    | undefined;
  if (!bridge) throw new Error('CDP bridge not available — restart the app');
  const resp = await bridge(wcId, method, params);
  if (!resp || !resp.ok) {
    throw new Error(resp?.error || `CDP ${method} failed`);
  }
  return resp.result;
}

async function handleListInteractives(wv: BrowserWebview): Promise<Record<string, any>> {
  let axResult;
  try {
    axResult = await sendCdp(wv, 'Accessibility.getFullAXTree', {});
  } catch (err: any) {
    return { error: `getFullAXTree failed: ${err.message || String(err)}` };
  }

  const nodes: any[] = axResult?.nodes || [];
  const interactives: InteractiveElement[] = [];
  let index = 1;

  for (const node of nodes) {
    if (node.ignored) continue;
    const role = extractAxValue(node.role);
    if (!INTERACTIVE_ROLES.has(role)) continue;
    const name = extractAxValue(node.name);
    if (!name && role !== 'textbox' && role !== 'searchbox' && role !== 'combobox') {
      // Skip nameless elements unless they're inputs (which can be empty)
      continue;
    }
    const backendNodeId = node.backendDOMNodeId;
    if (backendNodeId == null) continue;
    interactives.push({ index, role, name: name.slice(0, 80), backendNodeId });
    index++;
  }

  // Cache the index map in main-process storage so click_index can resolve it
  // even across separate WebSocket commands.
  const indexMap: Record<number, number> = {};
  for (const el of interactives) {
    indexMap[el.index] = el.backendNodeId;
  }
  try {
    const cacheBridge = (window as any).openswarm?.cdpCacheSet;
    if (cacheBridge) await cacheBridge(wv.getWebContentsId(), indexMap);
  } catch {
    // Cache is best-effort; click_index will fall back to re-listing.
  }

  // Build the model-friendly text representation: [1]<button "Like">
  const lines = interactives.map(
    (el) => `[${el.index}]<${el.role} "${el.name}">`,
  );
  const text = lines.length
    ? `${lines.length} interactive elements:\n${lines.join('\n')}`
    : 'No interactive elements found on this page.';

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

  // Look up the cached index → backendNodeId mapping.
  let backendNodeId: number | undefined;
  try {
    const cacheBridge = (window as any).openswarm?.cdpCacheGet;
    if (cacheBridge) {
      const cached = await cacheBridge(wv.getWebContentsId());
      if (cached && cached[idx] != null) {
        backendNodeId = Number(cached[idx]);
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

  // Cheap revalidation: resolve the backend node ID to a runtime object.
  // If the page has mutated and the node is gone, this fails fast with a
  // clear error message instead of clicking the wrong element.
  try {
    await sendCdp(wv, 'DOM.resolveNode', { backendNodeId });
  } catch (err: any) {
    return {
      error: `Index ${idx} is no longer valid (${err.message || 'node not found'}). The page may have changed. Call BrowserListInteractives again.`,
    };
  }

  // Get the element's bounding box for clicking via Input.dispatchMouseEvent
  // (more reliable than Element.click() on hostile sites — bypasses any
  // synthetic-event filtering since these are real OS-level mouse events).
  let boxModel;
  try {
    boxModel = await sendCdp(wv, 'DOM.getBoxModel', { backendNodeId });
  } catch (err: any) {
    return {
      error: `Index ${idx} has no box model (likely off-screen or hidden). Try scrolling first or call BrowserListInteractives again.`,
    };
  }

  const content = boxModel?.model?.content;
  if (!Array.isArray(content) || content.length < 8) {
    return { error: `Index ${idx} has no valid bounding rect.` };
  }
  // content is [x1,y1, x2,y2, x3,y3, x4,y4] — compute center
  const x = (content[0] + content[4]) / 2;
  const y = (content[1] + content[5]) / 2;

  try {
    await sendCdp(wv, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x, y,
      button: 'left',
      clickCount: 1,
    });
    await sendCdp(wv, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x, y,
      button: 'left',
      clickCount: 1,
    });
  } catch (err: any) {
    return { error: `Click failed: ${err.message || String(err)}` };
  }

  return {
    text: `Clicked index ${idx} at (${Math.round(x)}, ${Math.round(y)})`,
    clickX: x / wv.clientWidth * 100,
    clickY: y / wv.clientHeight * 100,
  };
}

// ---------------------------------------------------------------------------
// Batched actions
// ---------------------------------------------------------------------------
// handleBatch executes a list of sub-actions sequentially on the same webview,
// capturing the URL before/after each one and aborting the rest of the batch
// if the URL changes mid-batch (page navigated → indices and selectors are
// stale). This lets the model emit "[click_index 7, wait 500, type 'eric',
// press_key Enter]" in a single tool call instead of round-tripping for each
// action.

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
      // Continue with the rest — per-action failures don't abort the batch.
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

    // If the URL changed, abort the rest — selectors and indices are stale
    // and any subsequent actions would be operating on a half-loaded page.
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

async function handleBrowserCommand(data: Record<string, any>) {
  const { request_id, action, browser_id, tab_id, params = {} } = data;
  if (!request_id) return;

  const wv = getWebview(browser_id, tab_id || undefined);
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
        result = await handleListInteractives(wv);
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
