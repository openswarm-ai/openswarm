import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Every open chat's held stream used to hit the one-second ceiling in the same tick and land as ONE task
// of several synchronous React renders (200-270 ms inside a pan, measured 2026-09-02 under eight agents).
// The drain takes one manager per animation frame, keeps a timer fallback for windows that paint no
// frames, and only ever runs while a gesture is live; the baseline seam restores the old single flush.
const ws = fs.readFileSync(path.join(process.cwd(), 'src/shared/ws/WebSocketManager.ts'), 'utf8');
const chat = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/AgentChat/AgentChat.tsx'), 'utf8');

test('a held stream past the ceiling is spread one manager per frame, never flushed in the same tick', () => {
  const arm = ws.slice(ws.indexOf('private armBgFlush()'), ws.indexOf('private static _spreadQueue'));
  const spread = arm.indexOf('WebSocketManager.spreadFlush(this)');
  const direct = arm.indexOf('this.flushBgDelta();');
  assert.ok(spread > 0 && direct > spread, 'the spread path is checked BEFORE the direct flush');
  assert.match(arm, /interactionActive\(\) && !perfBaseline\(\)/, 'spreading applies only mid-gesture and only off the baseline seam');
  const drain = ws.slice(ws.indexOf('private static _drainSpread'), ws.indexOf('connect() {'));
  assert.match(drain, /_spreadQueue\.shift\(\)/, 'one manager per drain');
  assert.match(drain, /setTimeout\(WebSocketManager\._drainSpread, 250\)/, 'the rest wait a quarter second, not the next frame (one chat per frame read as a run of hitches on a short zoom)');
  assert.match(ws.slice(ws.indexOf('private static scheduleSpreadDrain'), ws.indexOf('private static _drainSpread')), /setTimeout\(WebSocketManager\._drainSpread, 300\)/, 'a timer covers a window that paints no frames');
});

test('transcript heights are measured on mounted-set changes and resizes, never on every commit or mid-gesture', () => {
  // The transcript has an older ResizeObserver above this effect (auto-follow), so every index starts at the effect itself.
  const start = chat.indexOf('const measuredIdsRef');
  const observerAt = chat.indexOf('new ResizeObserver', start);
  const effect = chat.slice(start, observerAt);
  assert.match(effect, /mountedIdsKey === measuredIdsRef\.current \|\| interactionActive\(\)/, 'skips an unchanged set and a live gesture');
  assert.match(effect, /if \(perfBaseline\(\)\) \{ measureWindowItems\(\); return; \}/, 'the seam restores measure-every-commit');
  const observer = chat.slice(observerAt, chat.indexOf('observer.disconnect()', observerAt));
  assert.match(observer, /if \(interactionActive\(\) \|\| raf !== null\) return;/, 'a resize mid-gesture waits too');
  assert.match(observer, /requestAnimationFrame/, 'resizes measure after paint, forcing nothing');
});
