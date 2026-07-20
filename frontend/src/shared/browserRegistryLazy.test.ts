// Run: node --test frontend/src/shared/browserRegistryLazy.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerWebview,
  unregisterWebview,
  registerPendingLoad,
  isPendingLoad,
  wakePendingLoad,
  clearPendingLoad,
  findWebviewByDomain,
  type BrowserWebview,
} from './browserRegistry.ts';

// Minimal fake webview: the registry only calls addEventListener (load tracking) + getURL.
function fakeWebview(url: string): BrowserWebview {
  return {
    getURL: () => url,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as BrowserWebview;
}

test('a lazy tab is resolvable by its INTENDED url while deferred, then wakes exactly once', () => {
  const wv = fakeWebview('about:blank');
  registerWebview('b1', 't1', wv);
  let loaded = 0;
  registerPendingLoad(wv, 'https://tiktok.com/@me', () => { loaded += 1; });

  assert.equal(isPendingLoad(wv), true);
  // about:blank live url can't match, but the intended-url fallback finds it for the session-borrow shims.
  assert.equal(findWebviewByDomain('tiktok.com'), wv);

  assert.equal(wakePendingLoad(wv), true);
  assert.equal(loaded, 1);
  // Second wake is a no-op (already loaded), so an agent re-touching the tab can't double-load it.
  assert.equal(wakePendingLoad(wv), false);
  assert.equal(loaded, 1);
  assert.equal(isPendingLoad(wv), false);

  unregisterWebview('b1', 't1');
});

test('clearPendingLoad drops the deferred load without firing it (navigate replaces the url)', () => {
  const wv = fakeWebview('about:blank');
  registerWebview('b2', 't2', wv);
  let loaded = 0;
  registerPendingLoad(wv, 'https://old.example.com', () => { loaded += 1; });

  clearPendingLoad(wv);
  assert.equal(isPendingLoad(wv), false);
  assert.equal(wakePendingLoad(wv), false);
  assert.equal(loaded, 0);

  unregisterWebview('b2', 't2');
});

test('a live-url tab still matches by its real url (unchanged path)', () => {
  const wv = fakeWebview('https://youtube.com/watch?v=x');
  registerWebview('b3', 't3', wv);
  assert.equal(findWebviewByDomain('youtube.com'), wv);
  assert.equal(isPendingLoad(wv), false);
  unregisterWebview('b3', 't3');
});

test('a live tab wins over a deferred tab for the same domain', () => {
  const live = fakeWebview('https://reddit.com/r/x');
  const lazy = fakeWebview('about:blank');
  registerWebview('b4', 'live', live);
  registerWebview('b4', 'lazy', lazy);
  registerPendingLoad(lazy, 'https://reddit.com/r/y', () => {});
  // The already-loaded tab is preferred; the deferred one is only a fallback.
  assert.equal(findWebviewByDomain('reddit.com'), live);
  unregisterWebview('b4', 'live');
  unregisterWebview('b4', 'lazy');
});
