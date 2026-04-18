import { getWebview } from './browserRegistry';
import { agentsWs } from './ws/WebSocketManager';
import { type BrowserAction, setActivity } from './browserCommandTypes';
import {
  handleScreenshot,
  handleGetText,
  handleNavigate,
  handleClick,
  handleType,
  handleScroll,
  handleWait,
  handleGetElements,
  handleEvaluate,
} from './browserActionHandlers';

export type { BrowserAction, BrowserActivity } from './browserCommandTypes';
export { getActivity, subscribeActivity, getActionLabel } from './browserCommandTypes';

let initialized = false;

async function handleBrowserCommand(data: Record<string, any>) {
  const { request_id, action, browser_id, tab_id, params = {} } = data;
  if (!request_id) return;

  const wv = getWebview(browser_id, tab_id || undefined);
  if (!wv) {
    agentsWs.send('browser:result', {
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
      default:
        result = { error: `Unknown browser action: ${action}` };
    }
  } catch (err: any) {
    result = { error: `Browser command failed: ${err?.message || String(err)}` };
  }

  setActivity(browser_id, null);
  agentsWs.send('browser:result', { request_id, ...result });
}

export function initBrowserCommandHandler(): () => void {
  if (initialized) return () => {};
  initialized = true;
  const unsub = agentsWs.on('browser:command', handleBrowserCommand);
  return () => {
    unsub();
    initialized = false;
  };
}
