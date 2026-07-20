import { getWebview } from './browserRegistry';
import { getViewWebview } from './viewWebviewRegistry';
import { getViewFrame } from './viewFrameRegistry';

// One arrow press moves the content about a wheel notch, so a held key and a trackpad flick cover ground at a comparable rate.
const ARROW_STEP_PX = 120;

// Walks up from whatever sits at the middle of the view (a key press has no cursor to aim with) to the first ancestor that can still scroll horizontally the way dx points, nudges it, and reports whether anything actually moved. The boundary test is the same one the wheel path uses in useCanvasControls, so keys and trackpad hand the gesture back to the canvas at the same moment.
// This runs in two worlds: stringified into a <webview> guest renderer, and called directly on a same-origin srcdoc iframe. Keep it self-contained - no imports, no closure references - or the stringified copy lands in the guest with dangling names.
function scrollContentX(doc: Document, win: Window, dx: number): boolean {
  const nudge = (node: Element | null): boolean => {
    if (!node) return false;
    const el = node as HTMLElement;
    if (el.scrollWidth <= el.clientWidth) return false;
    // The document's own scroller reports overflowX 'visible' yet still scrolls, so it skips the overflow test the way a real browser does.
    const isViewport = el === doc.scrollingElement;
    const overflowX = win.getComputedStyle(el).overflowX;
    if (!isViewport && overflowX !== 'auto' && overflowX !== 'scroll') return false;
    const atRight = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
    const atLeft = el.scrollLeft <= 1;
    if ((dx > 0 && atRight) || (dx < 0 && atLeft)) return false;
    // Instant, not smooth: a page with scroll-behavior smooth would otherwise still be animating when the next key repeat arrives.
    el.scrollBy({ left: dx, behavior: 'instant' });
    return true;
  };

  let node: Element | null = doc.elementFromPoint(
    Math.floor(win.innerWidth / 2),
    Math.floor(win.innerHeight / 2),
  );
  while (node) {
    if (nudge(node)) return true;
    node = node.parentElement;
  }
  return nudge(doc.scrollingElement);
}

// Present on real Electron webviews; a browser card falls back to a plain iframe on locked-out Windows builds, which has none of this.
interface GuestWebview {
  executeJavaScript?: (code: string) => Promise<unknown>;
}

/** Scrolls a card's own content sideways. True means the card absorbed the arrow, so the dashboard must not also navigate to a neighbor. */
export async function scrollCardContentX(cardId: string, direction: 'left' | 'right'): Promise<boolean> {
  const dx = direction === 'right' ? ARROW_STEP_PX : -ARROW_STEP_PX;

  const guest = (getWebview(cardId) ?? getViewWebview(cardId)) as GuestWebview | undefined;
  if (guest?.executeJavaScript) {
    // A guest is a separate renderer: the host can't read its scrollLeft, so the whole scroll-or-boundary decision has to be made over there and come back as a yes/no.
    try {
      const scrolled = await guest.executeJavaScript(`(${scrollContentX})(document, window, ${dx})`);
      return scrolled === true;
    } catch {
      return false;
    }
  }

  // Srcdoc app card: same-origin, so the host can walk the frame's DOM directly. A cross-origin frame throws on contentWindow access; treat that as "didn't scroll" and let the arrow navigate.
  const frame = getViewFrame(cardId);
  try {
    const win = frame?.contentWindow;
    if (!win) return false;
    return scrollContentX(win.document, win, dx);
  } catch {
    return false;
  }
}
