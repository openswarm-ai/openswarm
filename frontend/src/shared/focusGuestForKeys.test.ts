// Run: node --test (via frontend/scripts/run-tests.mjs)
//
// The invariant this file defends: an agent keystroke never reaches the user's own text box.
// It is enforced by giving the guest host focus BEFORE dispatching, because a synthetic key follows
// the host window's focus rather than the CDP target (measured in an Electron probe; both
// Input.dispatchKeyEvent and Input.insertText leaked a real string into a host <input>).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusGuestForKeys, guestKeyTakeoverCount, resetGuestKeyTakeoverCount } from './focusGuestForKeys.ts';

function fakeWebview(): { focus: (o?: FocusOptions) => void; focused: number; lastOpts?: FocusOptions } {
  const wv = {
    focused: 0,
    lastOpts: undefined as FocusOptions | undefined,
    focus(o?: FocusOptions): void { wv.focused += 1; wv.lastOpts = o; },
  };
  return wv;
}

// A docked browser parks off-canvas, and focus() is allowed to scroll its target into view.
test('the guest is focused without scrolling it into view', () => {
  const wv = fakeWebview();
  withActive(userInput, () => focusGuestForKeys(wv as never));
  assert.equal(wv.lastOpts?.preventScroll, true, 'a bare focus() can drag a parked card into view');
});

function withActive(el: unknown, fn: () => void): void {
  const doc = globalThis.document as unknown as { activeElement: unknown };
  const prev = doc.activeElement;
  doc.activeElement = el;
  try { fn(); } finally { doc.activeElement = prev; }
}

const userInput = { tagName: 'INPUT', isContentEditable: false };

test('the guest is focused before any keystroke, so the key cannot land on the host', () => {
  const wv = fakeWebview();
  withActive(userInput, () => focusGuestForKeys(wv as never));
  assert.equal(wv.focused, 1, 'the guest never took focus, so the keystroke would follow the host');
});

test('taking the caret off a user text box is counted', () => {
  resetGuestKeyTakeoverCount();
  const wv = fakeWebview();
  withActive(userInput, () => focusGuestForKeys(wv as never));
  assert.equal(guestKeyTakeoverCount(), 1);
});

test('a contenteditable counts too, since that is where a half-written message lives', () => {
  resetGuestKeyTakeoverCount();
  const wv = fakeWebview();
  withActive({ tagName: 'DIV', isContentEditable: true }, () => focusGuestForKeys(wv as never));
  assert.equal(guestKeyTakeoverCount(), 1);
});

// The negative half: without it, "it counts" would pass on a version that counts unconditionally.
test('routine driving with no user caret involved counts nothing', () => {
  resetGuestKeyTakeoverCount();
  const wv = fakeWebview();
  withActive({ tagName: 'BODY', isContentEditable: false }, () => focusGuestForKeys(wv as never));
  withActive(null, () => focusGuestForKeys(wv as never));
  assert.equal(guestKeyTakeoverCount(), 0, 'a takeover was counted when no user surface held the caret');
  assert.equal(wv.focused, 2, 'the guest must still be focused every time');
});

test('a webview that already holds focus is not counted as a takeover', () => {
  resetGuestKeyTakeoverCount();
  const wv = fakeWebview();
  withActive(wv, () => focusGuestForKeys(wv as never));
  assert.equal(guestKeyTakeoverCount(), 0);
});

test('a card that unmounted mid-command fails quiet instead of killing the run', () => {
  const dead = { focus(): void { throw new Error('detached'); } };
  withActive(userInput, () => {
    assert.doesNotThrow(() => focusGuestForKeys(dead as never));
  });
});
