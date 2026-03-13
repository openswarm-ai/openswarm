import { useEffect, useRef, useCallback, RefObject } from 'react';
import { SelectedElement, useElementSelection } from '@/app/components/ElementSelectionContext';

const OVERLAY_ID = '__clawd-select-overlay__';
const LABEL_ID = '__clawd-select-label__';
const STYLE_ID = '__clawd-select-style__';

const HIGHLIGHT_COLOR = '#3b82f6';
const HIGHLIGHT_BG = 'rgba(59, 130, 246, 0.08)';
const FLASH_COLOR = 'rgba(59, 130, 246, 0.25)';
const SELECTED_CLASS = '__clawd-selected__';

const KEY_CSS_PROPS = [
  'display', 'position', 'width', 'height', 'margin', 'padding',
  'color', 'background', 'backgroundColor', 'border', 'borderRadius',
  'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'textAlign',
  'flexDirection', 'justifyContent', 'alignItems', 'gap', 'gridTemplateColumns',
  'overflow', 'opacity', 'zIndex', 'boxShadow',
];

function buildSelectorPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;

  while (current && current !== current.ownerDocument.documentElement) {
    let selector = current.tagName.toLowerCase();

    if (current.id) {
      selector += `#${current.id}`;
      parts.unshift(selector);
      break;
    }

    const classes = Array.from(current.classList).filter((c) => !c.startsWith('__clawd'));
    if (classes.length > 0) {
      selector += '.' + classes.slice(0, 2).join('.');
    } else {
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === current!.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          selector += `:nth-child(${idx})`;
        }
      }
    }

    parts.unshift(selector);
    current = current.parentElement;
  }

  return parts.join(' > ');
}

function getKeyStyles(el: Element): Record<string, string> {
  const computed = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!computed) return {};

  const styles: Record<string, string> = {};
  for (const prop of KEY_CSS_PROPS) {
    const val = computed.getPropertyValue(prop);
    if (val && val !== 'none' && val !== 'normal' && val !== 'auto' && val !== '0px' && val !== 'rgba(0, 0, 0, 0)') {
      styles[prop] = val;
    }
  }
  return styles;
}

function truncateHTML(html: string, max = 5000): string {
  if (html.length <= max) return html;
  return html.slice(0, max) + '\n<!-- ... truncated -->';
}

async function captureScreenshot(
  el: Element,
  iframeDoc: Document,
): Promise<string | undefined> {
  try {
    const win = iframeDoc.defaultView;
    if (!win) return undefined;

    if (!(win as any).html2canvas) {
      await new Promise<void>((resolve, reject) => {
        const script = iframeDoc.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load html2canvas'));
        iframeDoc.head.appendChild(script);
      });
    }

    const h2c = (win as any).html2canvas;
    if (!h2c) return undefined;

    const canvas = await h2c(el, {
      backgroundColor: null,
      scale: 1,
      logging: false,
      useCORS: true,
    });
    return canvas.toDataURL('image/png');
  } catch {
    return undefined;
  }
}

export function useIframeElementSelector(explicitIframeRef?: RefObject<HTMLIFrameElement | null>) {
  const ctx = useElementSelection();
  const hoveredRef = useRef<Element | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const selectedDomEls = useRef<Map<string, Element>>(new Map());

  const getIframe = useCallback((): HTMLIFrameElement | null => {
    if (explicitIframeRef) return explicitIframeRef.current;
    return ctx?.iframeRef.current ?? null;
  }, [explicitIframeRef, ctx]);

  const setupSelection = useCallback(() => {
    if (!ctx) return;
    const { addSelectedElement, updateSelectedElement } = ctx;
    const iframe = getIframe();
    if (!iframe) return;

    const iframeDoc = iframe.contentDocument;
    if (!iframeDoc) return;

    const style = iframeDoc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${OVERLAY_ID} {
        position: fixed;
        pointer-events: none;
        z-index: 2147483647;
        border: 2px solid ${HIGHLIGHT_COLOR};
        background: ${HIGHLIGHT_BG};
        transition: top 0.05s ease-out, left 0.05s ease-out, width 0.05s ease-out, height 0.05s ease-out;
        box-sizing: border-box;
      }
      #${LABEL_ID} {
        position: fixed;
        pointer-events: none;
        z-index: 2147483647;
        background: ${HIGHLIGHT_COLOR};
        color: #fff;
        font-size: 10px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace;
        padding: 1px 5px;
        border-radius: 0 0 4px 0;
        white-space: nowrap;
        line-height: 16px;
      }
      .${SELECTED_CLASS} {
        outline: 2px solid ${HIGHLIGHT_COLOR} !important;
        outline-offset: -1px !important;
        box-shadow: inset 0 0 0 1000px ${HIGHLIGHT_BG} !important;
      }
      @keyframes __clawd-flash {
        0% { background: ${FLASH_COLOR}; }
        100% { background: ${HIGHLIGHT_BG}; }
      }
    `;
    iframeDoc.head.appendChild(style);

    const overlay = iframeDoc.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.display = 'none';
    iframeDoc.body.appendChild(overlay);

    const label = iframeDoc.createElement('div');
    label.id = LABEL_ID;
    label.style.display = 'none';
    iframeDoc.body.appendChild(label);

    const positionOverlay = (el: Element) => {
      const rect = el.getBoundingClientRect();
      overlay.style.display = 'block';
      overlay.style.top = rect.top + 'px';
      overlay.style.left = rect.left + 'px';
      overlay.style.width = rect.width + 'px';
      overlay.style.height = rect.height + 'px';

      const tagName = el.tagName.toLowerCase();
      const classes = Array.from(el.classList)
        .filter((c) => !c.startsWith('__clawd'))
        .slice(0, 2);
      const labelText = classes.length > 0
        ? `${tagName}.${classes.join('.')}`
        : tagName;
      label.textContent = labelText;
      label.style.display = 'block';
      label.style.top = Math.max(0, rect.top) + 'px';
      label.style.left = Math.max(0, rect.left) + 'px';
    };

    const hideOverlay = () => {
      overlay.style.display = 'none';
      label.style.display = 'none';
    };

    const isOurElement = (el: Element) =>
      el.id === OVERLAY_ID || el.id === LABEL_ID || el.id === STYLE_ID;

    const onMouseMove = (e: MouseEvent) => {
      const target = e.target as Element;
      if (!target || isOurElement(target) || target === iframeDoc.body || target === iframeDoc.documentElement) {
        hideOverlay();
        hoveredRef.current = null;
        return;
      }
      hoveredRef.current = target;
      positionOverlay(target);
    };

    const onMouseLeave = () => {
      hideOverlay();
      hoveredRef.current = null;
    };

    const onClick = async (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const target = hoveredRef.current;
      if (!target || isOurElement(target)) return;

      overlay.style.animation = '__clawd-flash 0.3s ease-out';
      setTimeout(() => { overlay.style.animation = ''; }, 300);

      const rect = target.getBoundingClientRect();
      const elId = `el-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const selectedEl: SelectedElement = {
        id: elId,
        selectorPath: buildSelectorPath(target),
        tagName: target.tagName,
        className: Array.from(target.classList).filter((c) => !c.startsWith('__clawd')).join(' '),
        outerHTML: truncateHTML(target.outerHTML),
        computedStyles: getKeyStyles(target),
        boundingRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };

      addSelectedElement(selectedEl);

      target.classList.add(SELECTED_CLASS);
      selectedDomEls.current.set(elId, target);

      captureScreenshot(target, iframeDoc).then((screenshot) => {
        if (screenshot) {
          updateSelectedElement(elId, { screenshot });
        }
      }).catch(() => {});
    };

    iframeDoc.body.style.cursor = 'crosshair';

    iframeDoc.addEventListener('mousemove', onMouseMove, true);
    iframeDoc.addEventListener('mouseleave', onMouseLeave, true);
    iframeDoc.addEventListener('click', onClick, true);

    cleanupRef.current = () => {
      iframeDoc.removeEventListener('mousemove', onMouseMove, true);
      iframeDoc.removeEventListener('mouseleave', onMouseLeave, true);
      iframeDoc.removeEventListener('click', onClick, true);
      iframeDoc.body.style.cursor = '';
      selectedDomEls.current.forEach((el) => el.classList.remove(SELECTED_CLASS));
      selectedDomEls.current.clear();
      const existingOverlay = iframeDoc.getElementById(OVERLAY_ID);
      const existingLabel = iframeDoc.getElementById(LABEL_ID);
      const existingStyle = iframeDoc.getElementById(STYLE_ID);
      if (existingOverlay) existingOverlay.remove();
      if (existingLabel) existingLabel.remove();
      if (existingStyle) existingStyle.remove();
      hoveredRef.current = null;
    };
  }, [ctx, getIframe]);

  const teardownSelection = useCallback(() => {
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!ctx) return;

    if (ctx.selectMode) {
      teardownSelection();

      const iframe = getIframe();
      if (!iframe) return;

      const trySetup = () => {
        try {
          if (iframe.contentDocument?.body) {
            setupSelection();
          }
        } catch {
          // iframe not ready yet
        }
      };

      trySetup();
      iframe.addEventListener('load', trySetup);
      return () => {
        iframe.removeEventListener('load', trySetup);
        teardownSelection();
      };
    } else {
      teardownSelection();
    }
  }, [ctx?.selectMode, setupSelection, teardownSelection, getIframe]);

  useEffect(() => {
    if (!ctx?.selectMode) return;
    const iframe = getIframe();
    if (!iframe) return;

    const onLoad = () => {
      if (ctx.selectMode && iframe.contentDocument?.body) {
        teardownSelection();
        setupSelection();
      }
    };

    iframe.addEventListener('load', onLoad);
    return () => iframe.removeEventListener('load', onLoad);
  }, [ctx?.selectMode, setupSelection, teardownSelection, getIframe]);

  // Sync persistent highlights with selectedElements (handle removals & clears)
  useEffect(() => {
    if (!ctx) return;
    const currentIds = new Set(ctx.selectedElements.map((e) => e.id));
    const staleIds: string[] = [];
    selectedDomEls.current.forEach((el, id) => {
      if (!currentIds.has(id)) {
        el.classList.remove(SELECTED_CLASS);
        staleIds.push(id);
      }
    });
    staleIds.forEach((id) => selectedDomEls.current.delete(id));
  }, [ctx?.selectedElements]);
}
