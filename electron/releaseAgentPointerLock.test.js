// Run: node --test electron/releaseAgentPointerLock.test.js
//
// ENG-310: "the app agent takes over the physical cursor." Measured mechanism, not a guess: an
// agent-dispatched click on a canvas that requests pointer lock left document.pointerLockElement=
// CANVAS, i.e. the user's real mouse captured and hidden, and with this module wired the same click
// logged ["locked","unlocked"] and ended at null.
//
// These pin the properties that decide whether it can come back: only the release half of a
// synthetic CLICK triggers a handback (so reads and keystrokes cost nothing), a failure can never
// break the command it follows, and main.js actually calls it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { releaseAgentPointerLock, isSyntheticClickRelease, EXIT_EXPRESSION } = require('./releaseAgentPointerLock');

function recorder() {
  const calls = [];
  const send = (wcId, method, params) => {
    calls.push({ wcId, method, params });
    return Promise.resolve({});
  };
  return { calls, send };
}

test('the release half of a synthetic click hands the cursor back', () => {
  const { calls, send } = recorder();
  assert.equal(releaseAgentPointerLock(send, 42, 'Input.dispatchMouseEvent', { type: 'mouseReleased' }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].wcId, 42, 'the handback must go to the surface that was clicked');
  assert.equal(calls[0].method, 'Runtime.evaluate');
  assert.equal(calls[0].params.expression, EXIT_EXPRESSION);
});

test('the expression is a no-op when nothing is locked', () => {
  // It runs after every agent click, so it must cost nothing on the overwhelmingly common path.
  const doc = { pointerLockElement: null, exitPointerLock: () => { throw new Error('must not be called'); } };
  const run = new Function('document', `return (${EXIT_EXPRESSION});`);
  assert.equal(run(doc), false);
});

test('the expression exits exactly one lock when there is one', () => {
  let exits = 0;
  const doc = { pointerLockElement: {}, exitPointerLock: () => { exits += 1; } };
  const run = new Function('document', `return (${EXIT_EXPRESSION});`);
  assert.equal(run(doc), true);
  assert.equal(exits, 1);
});

test('nothing else in a click triggers a handback, so one click costs one eval', () => {
  const { calls, send } = recorder();
  for (const params of [{ type: 'mouseMoved' }, { type: 'mousePressed' }, { type: 'mouseWheel' }]) {
    assert.equal(releaseAgentPointerLock(send, 1, 'Input.dispatchMouseEvent', params), false);
  }
  assert.equal(calls.length, 0);
});

test('reads and keystrokes never pay for it', () => {
  const { calls, send } = recorder();
  for (const method of ['Page.captureScreenshot', 'Runtime.evaluate', 'Accessibility.getFullAXTree', 'Input.dispatchKeyEvent']) {
    assert.equal(releaseAgentPointerLock(send, 1, method, { type: 'mouseReleased' }), false, `${method} must not trigger a handback`);
  }
  assert.equal(calls.length, 0);
});

test('missing or malformed params are ignored rather than thrown on', () => {
  const { calls, send } = recorder();
  assert.equal(releaseAgentPointerLock(send, 1, 'Input.dispatchMouseEvent', undefined), false);
  assert.equal(releaseAgentPointerLock(send, 1, 'Input.dispatchMouseEvent', null), false);
  assert.equal(calls.length, 0);
});

test('a handback that fails never breaks the click it follows', () => {
  const thrower = () => { throw new Error('debugger detached'); };
  assert.doesNotThrow(() => releaseAgentPointerLock(thrower, 1, 'Input.dispatchMouseEvent', { type: 'mouseReleased' }));
  const rejecter = () => Promise.reject(new Error('target closed'));
  assert.doesNotThrow(() => releaseAgentPointerLock(rejecter, 1, 'Input.dispatchMouseEvent', { type: 'mouseReleased' }));
});

test('the classifier is exact, never a prefix guess', () => {
  assert.equal(isSyntheticClickRelease('Input.dispatchMouseEvent', { type: 'mouseReleased' }), true);
  assert.equal(isSyntheticClickRelease('Input.dispatchMouseEventExtra', { type: 'mouseReleased' }), false);
  assert.equal(isSyntheticClickRelease('Input.dispatchMouseEvent', { type: 'mouseReleasedish' }), false);
});

test('main.js calls it, and only on the agent CDP path', () => {
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.match(src, /releaseAgentPointerLock\(sendCdpCommandSerialized, wcId, method, params\)/,
    'a handback nothing calls hands nothing back');
  const handler = src.slice(src.indexOf("ipcMain.handle('send-cdp-command'"));
  assert.ok(handler.indexOf('releaseAgentPointerLock') < handler.indexOf('return { ok: true, result }'),
    'the handback belongs inside the agent command path, where a human click never goes');
});
