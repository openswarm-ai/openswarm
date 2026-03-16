import { getWebview, type BrowserWebview } from './browserRegistry';
import { dashboardWs } from './ws/WebSocketManager';
import { resolveInput } from './resolveUrl';

let initialized = false;

export type BrowserAction = 'screenshot' | 'get_text' | 'navigate' | 'click' | 'type' | 'evaluate' | 'get_elements';

export interface BrowserActivity {
  action: BrowserAction;
  detail?: string;
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

async function handleGetElements(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const scope = (params.selector as string) || 'body';
  const safeScope = JSON.stringify(scope);
  const code = `(() => {
    const scope = document.querySelector(${safeScope}) || document.body;
    const interactive = scope.querySelectorAll(
      'a[href], button, input, textarea, select, [role="button"], [role="link"], '
      + '[role="textbox"], [role="searchbox"], [onclick], [tabindex]:not([tabindex="-1"])'
    );
    const results = [];
    for (const el of interactive) {
      if (results.length >= 60) break;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (window.getComputedStyle(el).visibility === 'hidden') continue;

      let selector = el.tagName.toLowerCase();
      if (el.id) {
        selector = '#' + el.id;
      } else if (el.getAttribute('name')) {
        selector = el.tagName.toLowerCase() + '[name="' + el.getAttribute('name') + '"]';
      } else if (el.getAttribute('aria-label')) {
        selector = el.tagName.toLowerCase() + '[aria-label="' + el.getAttribute('aria-label') + '"]';
      } else if (el.getAttribute('type') && el.tagName === 'INPUT') {
        selector = 'input[type="' + el.getAttribute('type') + '"]';
        if (el.getAttribute('placeholder'))
          selector += '[placeholder="' + el.getAttribute('placeholder') + '"]';
      } else if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\\s+/)[0];
        if (cls && cls.length < 40)
          selector = el.tagName.toLowerCase() + '.' + CSS.escape(cls);
      }

      const verify = document.querySelectorAll(selector);
      if (verify.length > 1) {
        const parent = el.parentElement;
        if (parent && parent.id) {
          selector = '#' + parent.id + ' > ' + selector;
        } else {
          const siblings = parent ? Array.from(parent.querySelectorAll(':scope > ' + el.tagName.toLowerCase())) : [];
          const idx = siblings.indexOf(el);
          if (idx >= 0 && parent)
            selector = (parent.tagName.toLowerCase() + (parent.className ? '.' + CSS.escape(parent.className.trim().split(/\\s+/)[0]) : ''))
              + ' > ' + el.tagName.toLowerCase() + ':nth-child(' + (idx + 1) + ')';
        }
      }

      results.push({
        selector,
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        text: (el.textContent || '').trim().substring(0, 80) || null,
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
