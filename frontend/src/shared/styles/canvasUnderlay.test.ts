// ENG-340: mid-drag texture eviction flashed near-white. The never-white underlay was tint-matched
// to the WASH alone; the tone the canvas actually shows also includes the baked grain (measured
// mean #858585 at 6.8% alpha for grain=0.5) and, marginally, the dot grid. Folding those in was
// measured in a real Chromium raster: the fallback quad's distance from the composite's true mean
// dropped 11.62 -> 0.95 RGB units, i.e. from a visible blink to sub-perceptual.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canvasUnderlayColor, dotGridCoverage, parseCssColor, washUnderlayColor, DEFAULT_WASH_STOPS,
} from '@/shared/styles/washBackground';

const PAGE = '#F5F5F0';
const DOT = 'rgba(0,0,0,0.08)';

test('an rgba dot colour can never NaN the underlay into an invalid colour', () => {
  // mixHex is hex-only; fed rgba() it produced #NaN…, the backgroundColor was silently dropped,
  // and the never-white guarantee itself died. That regression shipped for zero minutes.
  const out = canvasUnderlayColor(DEFAULT_WASH_STOPS, 0.5, PAGE, DOT, 1.5, 24);
  assert.match(out, /^#[0-9a-f]{6}$/i, `not a valid colour: ${out}`);
});

test('an unparseable dot colour degrades to the plain wash underlay, never to garbage', () => {
  const out = canvasUnderlayColor(DEFAULT_WASH_STOPS, 0.5, PAGE, 'color-mix(in srgb, red, blue)', 1.5, 24);
  assert.equal(out, washUnderlayColor(DEFAULT_WASH_STOPS, 0.5, PAGE));
});

test('no grain means the exact pre-fix colour, so stock installs see zero change', () => {
  // Default grain is 0; the dots contribute ~1% coverage at 8% alpha, under one RGB step.
  const before = washUnderlayColor(DEFAULT_WASH_STOPS, 0.5, PAGE);
  const after = canvasUnderlayColor(DEFAULT_WASH_STOPS, 0.5, PAGE, DOT, 1.5, 24, null);
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const d = Math.max(...rgb(before).map((v, i) => Math.abs(v - rgb(after)[i])));
  assert.ok(d <= 1, `stock delta must be imperceptible, got ${d}`);
});

test('grain darkens the fallback toward the measured composite tone', () => {
  const plain = washUnderlayColor(DEFAULT_WASH_STOPS, 0.5, PAGE);
  const withGrain = canvasUnderlayColor(DEFAULT_WASH_STOPS, 0.5, PAGE, DOT, 1.5, 24,
    { meanHex: '#858585', meanAlpha: 0.0676 });
  const lum = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).reduce((a, b) => a + b);
  assert.ok(lum(withGrain) < lum(plain), 'the grain-bearing fallback must be darker than the wash-only one');
});

test('dot coverage is the exact geometry, capped at 1', () => {
  assert.ok(Math.abs(dotGridCoverage(1.5, 24) - (Math.PI * 2.25) / 576) < 1e-9);
  assert.equal(dotGridCoverage(100, 1), 1);
  assert.equal(dotGridCoverage(1, 0), 0);
});

test('parseCssColor accepts exactly the token shapes and nothing else', () => {
  assert.deepEqual(parseCssColor('#F5F5F0'), { hex: '#F5F5F0', alpha: 1 });
  assert.deepEqual(parseCssColor('rgba(0,0,0,0.08)'), { hex: '#000000', alpha: 0.08 });
  assert.deepEqual(parseCssColor('rgb(222, 220, 209)'), { hex: '#dedcd1', alpha: 1 });
  assert.equal(parseCssColor('tomato'), null);
  assert.equal(parseCssColor('#fff'), null);
});
