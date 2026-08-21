// ENG-176: the transcript belongs to the field the user was in when they STARTED speaking.
// Run: node --test --experimental-strip-types frontend/src/shared/voice/injectTargetSnapshot.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setInjectSnapshot, clearInjectSnapshot, takeInjectSnapshot, isUsableTarget } from './injectTargetSnapshot.ts';

// Rendered by default: the predicate refuses anything with no layout box (a composer inside a collapsed card is display:none).
const el = (tagName: string, o: { connected?: boolean; editable?: boolean; rendered?: boolean } = {}) => ({
  tagName, isConnected: o.connected ?? true, isContentEditable: o.editable ?? false,
  getClientRects: () => ((o.rendered ?? true) ? [{}] : []),
}) as unknown as HTMLElement;
const field = (connected = true) => el('TEXTAREA', { connected });

beforeEach(() => clearInjectSnapshot());

test('the snapshot keeps the field it was given (injectAtFocus decides precedence, not this)', () => {
  const a = field();
  setInjectSnapshot({ el: a, browserId: null });
  assert.equal(takeInjectSnapshot().el, a);
});

test('a detached field is refused, so a dead origin can never be the destination', () => {
  setInjectSnapshot({ el: field(false), browserId: null });
  assert.equal(takeInjectSnapshot().el, null);
});

test('a non-typeable element never wins', () => {
  assert.equal(isUsableTarget(el('DIV')), false);
  assert.equal(isUsableTarget(el('DIV', { editable: true })), true);
  assert.equal(isUsableTarget(el('WEBVIEW')), true);
});

test('taking consumes it, so one take can never leak into the next', () => {
  setInjectSnapshot({ el: field(), browserId: 'b1' });
  assert.equal(takeInjectSnapshot().browserId, 'b1');
  assert.equal(takeInjectSnapshot().el, null);
  assert.equal(takeInjectSnapshot().browserId, null);
});

test('a cancelled take leaves nothing behind', () => {
  setInjectSnapshot({ el: field(), browserId: 'b2' });
  clearInjectSnapshot();
  assert.equal(takeInjectSnapshot().el, null);
});

// Precedence lives in injectAtFocus, and Eric's call is Wispr's: the CURSOR wins, not the origin.
// injectAtFocus needs a live DOM, so what is pinned here is the predicate that decides whether the
// live element is allowed to win at all. Getting this wrong is how the text lands in a stranger's box.
test('a live click target only beats the origin when it is really typeable', () => {
  const typeable = el('INPUT');
  const button = el('BUTTON');
  const body = el('BODY');
  assert.equal(isUsableTarget(typeable), true, 'clicking another field must take the text');
  assert.equal(isUsableTarget(button), false, 'clicking a button must NOT take the text');
  assert.equal(isUsableTarget(body), false, 'clicking empty space must NOT take the text');
  assert.equal(isUsableTarget(null), false);
});

test('a hidden field is refused: a collapsed card\'s composer cannot take a caret', () => {
  const hidden = el('DIV', { editable: true, rendered: false });
  assert.equal(isUsableTarget(hidden), false);
  setInjectSnapshot({ el: hidden, browserId: null });
  const taken = takeInjectSnapshot();
  assert.equal(taken.el, null);
  assert.equal(taken.targetLost, true, 'it was aimed at and then hidden, which is a lost target, not no target');
});
