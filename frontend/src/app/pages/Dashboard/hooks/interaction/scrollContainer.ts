// Whether a wheel over this element should scroll IT instead of moving the canvas. The overflow
// style is cached per node (getComputedStyle walks were the dominant cost of trackpad nav); the
// capacity is read live every time, because a composer or transcript that was short when first
// wheeled grows later, and a cached "cannot scroll" from that first wheel stuck for the life of the
// canvas (Haik, exp.8: a composer past its cap would not scroll, the canvas panned instead).
export type OverflowVerdict = 'scrolls' | 'clips';

export interface ScrollBox {
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
}

type OverflowStyle = Pick<CSSStyleDeclaration, 'overflowY' | 'overflowX'>;

export function overflowVerdict(style: OverflowStyle): OverflowVerdict {
  const scrolls = (v: string) => v === 'auto' || v === 'scroll';
  return scrolls(style.overflowY) || scrolls(style.overflowX) ? 'scrolls' : 'clips';
}

export function hasScrollCapacity(el: ScrollBox): boolean {
  return el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth;
}

export function isScrollContainer(
  el: HTMLElement,
  cache: WeakMap<HTMLElement, OverflowVerdict>,
  computeStyle: (el: HTMLElement) => OverflowStyle = (e) => getComputedStyle(e),
): boolean {
  if (!hasScrollCapacity(el)) return false;
  let verdict = cache.get(el);
  if (verdict === undefined) {
    verdict = overflowVerdict(computeStyle(el));
    cache.set(el, verdict);
  }
  return verdict === 'scrolls';
}
