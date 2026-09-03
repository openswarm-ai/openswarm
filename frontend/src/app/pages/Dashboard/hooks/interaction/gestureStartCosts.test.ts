import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// Three first-frame costs measured on a loaded board (2026-09-02): a React state flip for the pan cursor
// (77-100 ms sync render), a full-page PNG encode per pill-tucked browser every 5 s (160-200 ms each,
// mid-gesture included), and the suspend pass encoding every visible card right after a pan committed.
// Each is pinned in the source, so a later edit cannot quietly put one back.
// Tests run bundled out of .test-build, so sources resolve from the frontend root, not from this file.
const here = path.join(process.cwd(), 'src/app/pages/Dashboard/hooks/interaction');
const read = (rel: string) => readFileSync(path.resolve(here, rel), 'utf8');

test('the pan cursor is a style write on the viewport, not React state', () => {
  const src = read('useCanvasControls.ts');
  assert.ok(!/setIsPanning|\[isPanning/.test(src), 'isPanning state is back');
  assert.match(src, /vp\.style\.cursor = panning \? 'grabbing' : ''/);
  const canvas = read('../../canvas/DashboardCanvas.tsx');
  assert.ok(!canvas.includes('canvas.isPanning'), 'DashboardCanvas reads a panning state again');
});

test('the pill shot skips a live gesture and encodes shrunk, in an idle slot', () => {
  const src = read('../../cards/BrowserCard.tsx');
  const freeze = src.slice(src.indexOf('const freeze = (): void => {'), src.indexOf('freeze();'));
  assert.match(freeze, /isAnyBrowserBusy\(\) \|\| \(!perfBaseline\(\) && interactionActive\(\)\)/);
  assert.match(freeze, /encodeShotWhenIdle\(img, PILL_SHOT_MAX_W/);
  assert.ok(!freeze.includes('img.toDataURL()'), 'the pill shot encodes on the capture callback again');
});

test('the suspend pass waits for the gesture and its captures encode idle', () => {
  const src = read('useWebviewSuspend.ts');
  const refresh = src.slice(src.indexOf('async function refreshVisibleFrames'), src.indexOf('async function captureForSuspend'));
  assert.match(refresh, /isAnyBrowserBusy\(\) \|\| \(!perfBaseline\(\) && interactionActive\(\)\)/);
  const capture = src.slice(src.indexOf('async function captureCard'));
  assert.match(capture, /encodeShotWhenIdle\(image, SNAPSHOT_MAX_W/);
  assert.ok(!capture.includes('.toDataURL()'), 'captureCard encodes synchronously again');
});

test('the vendored widgets\' group-hover variant is keyed on .group, never on a bare :hover with a universal subject', () => {
  const css = readFileSync(path.join(process.cwd(), 'src/toolui/toolui.css'), 'utf8');
  assert.match(css, /@custom-variant group-hover \(\.group:hover &\);/);
  const widgets = execSync('grep -rl "group-hover/" src/toolui --include=*.tsx || true', { cwd: process.cwd() }).toString().trim();
  assert.equal(widgets, '', 'a named group-hover/<name> falls back to Tailwind\'s :is(:where(.group):hover *) shape: ' + widgets);
});
