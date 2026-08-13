// Run: node --test (via frontend/scripts/run-tests.mjs)
//
// ENG-278 condition 4, exercised across the whole input space instead of one screenshot. A single
// rendered sample proves the slot at one viewport and one page shape; this proves it at every
// viewport a laptop or monitor actually has, crossed with every page aspect from tall-phone to
// ultrawide, which is the claim the fix is actually making.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserSlotSize, SLOT_MAX_PX, SLOT_MAX_VH, SLOT_MIN_PX } from './browserSlotSize.ts';

// Real viewport heights: small laptop through 5K, plus the awkward ones in between.
const VIEWPORTS = [600, 700, 768, 800, 900, 1000, 1050, 1080, 1117, 1118, 1200, 1440, 1600, 1800, 2160, 2880];
// Page shapes: tall portrait through ultrawide.
const ASPECTS: Array<[number, number]> = [
  [390, 844], [768, 1024], [1024, 768], [1280, 720], [1440, 900],
  [1920, 1080], [2560, 1080], [3440, 1440], [1000, 1000],
];

test('the slot never exceeds a third of the viewport, at any size or page shape', () => {
  let cases = 0;
  for (const vh of VIEWPORTS) for (const [pw, ph] of ASPECTS) {
    const s = browserSlotSize(pw, ph, vh);
    // The old behaviour, kept here as the thing that must never come back.
    const oldCap = Math.min(480, 0.52 * vh);
    assert.ok(s.height <= Math.max(SLOT_MIN_PX, (SLOT_MAX_VH / 100) * vh) + 0.001,
      `vh=${vh} ${pw}x${ph}: height ${s.height} exceeds ${SLOT_MAX_VH}vh`);
    assert.ok(s.height <= SLOT_MAX_PX, `vh=${vh}: height ${s.height} exceeds ${SLOT_MAX_PX}px`);
    if (vh >= 500) {
      assert.ok(s.height < oldCap, `vh=${vh}: ${s.height} is not smaller than the old cap ${oldCap}`);
    }
    cases += 1;
  }
  assert.equal(cases, VIEWPORTS.length * ASPECTS.length, 'enumeration size drifted');
});

test('the page aspect is preserved exactly, so the live overlay is never letterboxed', () => {
  for (const vh of VIEWPORTS) for (const [pw, ph] of ASPECTS) {
    const s = browserSlotSize(pw, ph, vh);
    assert.ok(s.width !== null, 'a known page size must produce a width');
    const got = (s.width as number) / s.height;
    assert.ok(Math.abs(got - pw / ph) < 1e-9, `vh=${vh} ${pw}x${ph}: aspect drifted to ${got}`);
  }
});

test('a page that reports nothing goes full width at the smaller fallback cap', () => {
  for (const vh of VIEWPORTS) {
    const s = browserSlotSize(0, 0, vh);
    assert.equal(s.fullWidth, true, `vh=${vh}: unknown size should be full width`);
    assert.equal(s.width, null);
    assert.ok(s.height <= 300, `vh=${vh}: fallback ${s.height} exceeds 300px`);
    assert.ok(s.height <= Math.max(SLOT_MIN_PX, 0.28 * vh) + 0.001, `vh=${vh}: fallback exceeds 28vh`);
  }
});

test('a tiny viewport still leaves a usable slot rather than collapsing to nothing', () => {
  for (const vh of [200, 300, 400, 500]) {
    const s = browserSlotSize(1280, 720, vh);
    assert.ok(s.height >= SLOT_MIN_PX, `vh=${vh}: collapsed to ${s.height}, below the ${SLOT_MIN_PX}px floor`);
  }
});

test('degenerate page sizes fall back instead of producing NaN or Infinity', () => {
  for (const [pw, ph] of [[0, 0], [-1, 100], [100, -1], [0, 720], [1280, 0], [NaN, NaN]] as Array<[number, number]>) {
    const s = browserSlotSize(pw, ph, 1080);
    assert.ok(Number.isFinite(s.height), `${pw}x${ph} produced height ${s.height}`);
    assert.ok(s.width === null || Number.isFinite(s.width), `${pw}x${ph} produced width ${s.width}`);
  }
});

// The number the issue actually claims, pinned so it cannot drift silently.
test('the measured reduction against the old cap', () => {
  const at1440 = browserSlotSize(1920, 1080, 1440);
  assert.equal(at1440.height, 380, 'tall viewport should sit on the 380px cap');
  assert.equal(Math.min(480, 0.52 * 1440), 480, 'old cap at 1440 was 480px');
  const at900 = browserSlotSize(1920, 1080, 900);
  assert.ok(Math.abs(at900.height - 306) < 0.5, `at 900px viewport expected ~306, got ${at900.height}`);
  assert.ok(Math.abs(Math.min(480, 0.52 * 900) - 468) < 0.5, 'old cap at 900 was 468px');
});

// The trap this guards: everything above tests an extracted MODEL of the sizing, while the component
// renders CSS min()/calc() strings. A model that has drifted from the code it describes passes its
// own tests perfectly. Bind the two, so changing one without the other fails here.
test('the component CSS still matches the constants this file tests', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const here = url.fileURLToPath(new URL('.', import.meta.url));
  // The test runs from .test-build, so resolve the source next to it by name.
  const candidates = [
    here + 'AgentChat.tsx',
    here.replace('/.test-build/', '/src/') + 'AgentChat.tsx',
  ];
  const path = candidates.find((p) => fs.existsSync(p));
  assert.ok(path, `could not locate AgentChat.tsx from ${here}`);
  const src = fs.readFileSync(path as string, 'utf8');
  assert.ok(src.includes(`min(${SLOT_MAX_PX}px, ${SLOT_MAX_VH}vh)`),
    `AgentChat no longer uses min(${SLOT_MAX_PX}px, ${SLOT_MAX_VH}vh); the model here has drifted from the code`);
  assert.ok(src.includes('min(300px, 28vh)'),
    'AgentChat no longer uses the min(300px, 28vh) fallback');
  assert.ok(!src.includes('52vh') && !src.includes('480px'),
    'the old oversized caps are back in AgentChat');
});
