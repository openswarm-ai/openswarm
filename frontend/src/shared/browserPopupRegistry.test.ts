// ENG-279: a native auth popup must become drivable the moment main announces it, and the card's
// commands must fall back to the real webview the moment it closes. The shim speaks CDP by
// webContents id, so these pin the method->CDP mapping with a recording fake bridge.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerPopup, unregisterPopupByWcId, activePopupShim, activePopupCount } from './browserPopupRegistry';

const calls: Array<{ wcId: number; method: string; params: any }> = [];
(globalThis as any).window = {
  openswarm: {
    sendCdpCommand: async (wcId: number, method: string, params: any) => {
      calls.push({ wcId, method, params });
      if (method === 'Runtime.evaluate') return { result: { value: '{"u":"https://accounts.google.com/o/oauth2","t":"Sign in"}' } };
      if (method === 'Page.captureScreenshot') return { data: 'aGk=' };
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 520, clientHeight: 680 } };
      return {};
    },
  },
};

beforeEach(() => {
  calls.length = 0;
  unregisterPopupByWcId(901);
  unregisterPopupByWcId(902);
});

test('a registered popup owns the card until closed, then the card falls back', () => {
  assert.equal(activePopupShim('card-1'), undefined);
  registerPopup('card-1', 901, 'https://accounts.google.com/');
  const shim = activePopupShim('card-1');
  assert.ok(shim, 'popup must be resolvable by the owning card');
  assert.equal(shim!.getWebContentsId(), 901, 'every CDP tool keys on this id');
  assert.equal(unregisterPopupByWcId(901), 'card-1');
  assert.equal(activePopupShim('card-1'), undefined, 'commands must return to the real webview');
  assert.equal(activePopupCount(), 0);
});

test('executeJavaScript rides Runtime.evaluate with returnByValue', async () => {
  registerPopup('card-1', 901, 'https://x/');
  await activePopupShim('card-1')!.executeJavaScript('1+1');
  const ev = calls.find((c) => c.method === 'Runtime.evaluate' && c.params.expression === '1+1');
  assert.ok(ev && ev.wcId === 901 && ev.params.returnByValue === true);
});

test('capturePage returns a data-url-able image sized from layout metrics', async () => {
  registerPopup('card-1', 901, 'https://x/');
  const img = await activePopupShim('card-1')!.capturePage();
  assert.equal(img.toDataURL(), 'data:image/png;base64,aGk=');
  assert.deepEqual(img.getSize(), { width: 520, height: 680 });
});

test('the electron key trio maps to the CDP trio', () => {
  registerPopup('card-1', 901, 'https://x/');
  const shim = activePopupShim('card-1')!;
  shim.sendInputEvent({ type: 'keyDown', keyCode: 'a' });
  shim.sendInputEvent({ type: 'char', keyCode: 'a' });
  shim.sendInputEvent({ type: 'keyUp', keyCode: 'a' });
  const kinds = calls.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => c.params.type);
  assert.deepEqual(kinds, ['rawKeyDown', 'char', 'keyUp']);
});

test('unregistering an unknown popup is a safe no-op', () => {
  assert.equal(unregisterPopupByWcId(777), null);
});
