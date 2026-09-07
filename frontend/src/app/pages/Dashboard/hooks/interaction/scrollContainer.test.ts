import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isScrollContainer, OverflowVerdict } from './scrollContainer';

function box(scrollHeight: number, overflowY = 'auto') {
  const el = { scrollHeight, clientHeight: 220, scrollWidth: 300, clientWidth: 300 } as unknown as HTMLElement;
  let styleReads = 0;
  const computeStyle = () => { styleReads++; return { overflowY, overflowX: 'visible' }; };
  return { el, computeStyle, reads: () => styleReads };
}

test('a composer that was short at the first wheel scrolls once it has grown past its cap', () => {
  const cache = new WeakMap<HTMLElement, OverflowVerdict>();
  const b = box(200);
  assert.equal(isScrollContainer(b.el, cache, b.computeStyle), false);
  (b.el as unknown as { scrollHeight: number }).scrollHeight = 900;
  assert.equal(isScrollContainer(b.el, cache, b.computeStyle), true);
});

test('the overflow style is read once per node, the capacity every time', () => {
  const cache = new WeakMap<HTMLElement, OverflowVerdict>();
  const b = box(900);
  for (let i = 0; i < 5; i++) assert.equal(isScrollContainer(b.el, cache, b.computeStyle), true);
  assert.equal(b.reads(), 1);
});

test('a clipped box never takes the wheel, however tall its content', () => {
  const cache = new WeakMap<HTMLElement, OverflowVerdict>();
  const b = box(5000, 'hidden');
  assert.equal(isScrollContainer(b.el, cache, b.computeStyle), false);
});
