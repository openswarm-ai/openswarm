// A cheap page fingerprint taken before and after a click, so we can MEASURE the
// invisible failure the tool-error counter misses: a click that "succeeds" (dispatches
// fine) but lands on the wrong element or a dead one, so nothing on the page changes.
// A real click almost always moves at least one of: the URL, the element count (menu
// opened / row added), the focused element, or the scroll position.
export const FP_EXPR =
  "location.href + '|' + document.getElementsByTagName('*').length + '|' + "
  + "(document.activeElement ? document.activeElement.tagName + (document.activeElement.getAttribute('aria-expanded')||'') + (document.activeElement.getAttribute('aria-checked')||'') : '') + '|' + "
  + "Math.round(window.scrollY)";

export function clickEffect(before: string, after: string): 'changed' | 'none' {
  return before && after && before !== after ? 'changed' : 'none';
}
