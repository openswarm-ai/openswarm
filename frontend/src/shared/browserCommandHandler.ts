import { getWebview, type BrowserWebview } from './browserRegistry';
import { dashboardWs } from './ws/WebSocketManager';
import { resolveInput } from './resolveUrl';

let initialized = false;

export type BrowserAction = 'screenshot' | 'get_text' | 'navigate' | 'click' | 'type' | 'evaluate';

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
  const code = `(()=>{const el=document.querySelector(${safeSelector});if(!el)return{error:'Element not found: '+${safeSelector}};el.click();return{text:'Clicked element: '+el.tagName.toLowerCase()+(el.id?'#'+el.id:'')}})()`;
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
  const code = `(()=>{const el=document.querySelector(${safeSelector});if(!el)return{error:'Element not found: '+${safeSelector}};el.focus();el.value=${safeText};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return{text:'Typed into: '+el.tagName.toLowerCase()+(el.id?'#'+el.id:'')}})()`;
  const result = await wv.executeJavaScript(code);
  return result;
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
