/**
 * Run: node --test frontend/src/shared/styles/washBackground.test.ts
 *
 * The wash is the app's biggest evictable GPU texture, and every case here is about NOT allocating
 * one we don't need. Chromium can drop a texture's tiles under memory pressure (many webviews, an
 * external display) and paints the element's background-color in their place, which is the
 * hard-edged rectangle of flat tint users report. A background-color is a compositor solid-colour
 * quad and can never be evicted, so when the wash is one flat colour the image must not exist at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { washIsUniform, washBackgroundLayers, washUnderlayColor, washOpaqueBackgroundUrl, DEFAULT_WASH_STOPS, effectiveWashStops } from './washBackground.ts';

const PAGE = '#F5F4ED';

test('a single accent is uniform, so it needs no image', () => {
  assert.equal(washIsUniform(['#B7CDEA']), true);
  assert.equal(washBackgroundLayers(['#B7CDEA'], 0.17, PAGE, null), null);
});

test('repeated identical stops are uniform too (the boot-paint shape)', () => {
  assert.equal(washIsUniform(['#B7CDEA', '#B7CDEA']), true);
  assert.equal(washIsUniform(['#b7cdea', '#B7CDEA']), true, 'hex case must not decide this');
});

test('a real multi-stop gradient is NOT uniform and still paints', () => {
  const stops = ['#B7CDEA', '#EFE0D2', '#E7BDD1'];
  assert.equal(washIsUniform(stops), false);
  const layers = washBackgroundLayers(stops, 0.17, PAGE, null);
  assert.ok(layers && layers.image.includes('linear-gradient'));
  assert.equal(layers!.size, '100% 100%');
});

test('for a uniform wash the tint IS the colour, so dropping the image changes no pixel', () => {
  // The whole safety argument for skipping the image rests on these two being the same colour, so
  // compare the numbers rather than the spelling (#eaedec vs rgba(234, 237, 236, 1)).
  for (const accent of ['#B7CDEA', '#E7BDD1', '#3D3D3A', '#FFFFFF']) {
    const tint = washUnderlayColor([accent], 0.17, PAGE);
    const rgb = washOpaqueBackgroundUrl([accent], 0.17, PAGE).match(/\d+/g)!.slice(1, 4).map(Number);
    const hex = [1, 3, 5].map((i) => parseInt(tint.slice(i, i + 2), 16));
    assert.deepEqual(rgb, hex, `${accent}: image paints ${rgb}, background-color is ${hex}`);
  }
});

test('grain alone still paints when the wash is uniform', () => {
  const layers = washBackgroundLayers(['#B7CDEA'], 0.17, PAGE, 'url(grain)');
  assert.deepEqual(layers, { image: 'url(grain)', size: 'auto', repeat: 'repeat' });
});

test('grain stacks above the gradient, in that order', () => {
  const layers = washBackgroundLayers(['#B7CDEA', '#E7BDD1'], 0.17, PAGE, 'url(grain)');
  assert.ok(layers!.image.startsWith('url(grain), '), 'grain must be the top layer');
  assert.equal(layers!.size, 'auto, 100% 100%');
  assert.equal(layers!.repeat, 'repeat, no-repeat');
});

test('no stops and no grain means no background image at all', () => {
  assert.equal(washBackgroundLayers([], 0.17, PAGE, null), null);
  assert.equal(washIsUniform([]), true);
});

test('the STOCK theme is uniform, so a default install cannot tear', () => {
  // Everyone who never opened the theme pad lands here. Making this multi-stop again would put a
  // full-window texture back under every default install, which is the band, so it is asserted.
  assert.equal(washIsUniform(DEFAULT_WASH_STOPS), true, 'default wash must stay one flat colour');
  assert.equal(washBackgroundLayers(DEFAULT_WASH_STOPS, 0.17, PAGE, null), null);
  assert.equal(washIsUniform(effectiveWashStops(null, null)), true, 'no accent, no gradient');
  assert.equal(washIsUniform(effectiveWashStops(null, '#B7CDEA')), true, 'a picked accent is one stop');
});

test('a user who picks a real gradient still gets one, texture and all', () => {
  const chosen = ['#B7CDEA', '#E7BDD1'];
  assert.equal(washIsUniform(effectiveWashStops(chosen, null)), false);
  assert.ok(washBackgroundLayers(chosen, 0.17, PAGE, null));
});
