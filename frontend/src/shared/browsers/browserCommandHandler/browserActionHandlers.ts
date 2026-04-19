import { type BrowserWebview } from '../browserRegistry';
import { resolveInput } from '../resolveUrl';

export async function handleScreenshot(wv: BrowserWebview): Promise<Record<string, any>> {
  const nativeImage = await wv.capturePage();
  const dataUrl = nativeImage.toDataURL();
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  return { image: base64, url: wv.getURL(), title: wv.getTitle() };
}

export async function handleGetText(wv: BrowserWebview): Promise<Record<string, any>> {
  const text: string = await wv.executeJavaScript(
    'document.body.innerText.substring(0, 15000)'
  );
  return { text, url: wv.getURL(), title: wv.getTitle() };
}

export async function handleNavigate(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const raw = params.url as string;
  if (!raw) return { error: 'url parameter is required' };
  const url = resolveInput(raw);
  try {
    await wv.loadURL(url);
  } catch (err: any) {
    if (!err?.message?.includes('ERR_ABORTED')) throw err;
  }
  return { text: `Navigated to ${url}`, url };
}

export async function handleClick(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const selector = params.selector as string;
  if (!selector) return { error: 'selector parameter is required' };
  const safeSelector = JSON.stringify(selector);
  const code = `(()=>{
    const el = document.querySelector(${safeSelector});
    if (!el) return { error: 'Element not found: ' + ${safeSelector} };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return {
      text: 'Clicked element: ' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
      url: location.href,
      clickX: window.innerWidth > 0 ? x / window.innerWidth : 0.5,
      clickY: window.innerHeight > 0 ? y / window.innerHeight : 0.5,
    };
  })()`;
  const result = await wv.executeJavaScript(code);
  return result;
}

export async function handleType(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const selector = params.selector as string;
  const text = params.text as string;
  if (!selector) return { error: 'selector parameter is required' };
  if (text == null) return { error: 'text parameter is required' };
  const safeSelector = JSON.stringify(selector);
  const safeText = JSON.stringify(text);
  const code = `(async ()=>{
    const el = document.querySelector(${safeSelector});
    if (!el) return { error: 'Element not found: ' + ${safeSelector} };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    if (el.select) el.select();
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    document.execCommand('insertText', false, ${safeText});
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: ${safeText},
    }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      text: 'Typed into: ' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
    };
  })()`;
  const result = await wv.executeJavaScript(code);
  return result;
}

export async function handleScroll(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const direction = (params.direction as string) || 'down';
  const amount = (params.amount as number) || 500;
  const code = `(() => {
    function findScrollable() {
      const candidates = document.querySelectorAll(
        '[class*="scroller"], [class*="scroll-container"], [class*="content"], '
        + 'main, [role="main"], article, .notion-scroller, .notion-frame'
      );
      for (const el of candidates) {
        const s = window.getComputedStyle(el);
        const isScrollable = (s.overflow === 'auto' || s.overflow === 'scroll'
          || s.overflowY === 'auto' || s.overflowY === 'scroll');
        if (isScrollable && el.scrollHeight > el.clientHeight + 10) return el;
      }
      const all = document.querySelectorAll('*');
      for (const el of all) {
        if (el === document.body || el === document.documentElement) continue;
        const s = window.getComputedStyle(el);
        const isScrollable = (s.overflow === 'auto' || s.overflow === 'scroll'
          || s.overflowY === 'auto' || s.overflowY === 'scroll');
        if (isScrollable && el.scrollHeight > el.clientHeight + 50
            && el.clientHeight > 200) return el;
      }
      return null;
    }
    const dy = ${JSON.stringify(direction)} === 'up' ? -${amount} : ${amount};
    const container = findScrollable();
    if (container) {
      const before = container.scrollTop;
      container.scrollBy({ top: dy, behavior: 'instant' });
      const after = container.scrollTop;
      return {
        scrolled: Math.abs(after - before),
        scrollTop: after,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        atTop: after <= 0,
        atBottom: after + container.clientHeight >= container.scrollHeight - 5,
        target: 'container',
      };
    }
    const before = window.scrollY;
    window.scrollBy({ top: dy, behavior: 'instant' });
    const after = window.scrollY;
    return {
      scrolled: Math.abs(after - before),
      scrollTop: after,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: window.innerHeight,
      atTop: after <= 0,
      atBottom: after + window.innerHeight >= document.documentElement.scrollHeight - 5,
      target: 'window',
    };
  })()`;
  try {
    const result = await wv.executeJavaScript(code);
    const status = result.atBottom ? ' (reached bottom)' : result.atTop ? ' (reached top)' : '';
    return {
      text: `Scrolled ${direction} by ${result.scrolled}px${status}. Position: ${result.scrollTop}/${result.scrollHeight - result.clientHeight}px`,
      ...result,
      url: wv.getURL(),
    };
  } catch (err: any) {
    return { error: `Scroll failed: ${err?.message || String(err)}` };
  }
}

export async function handleWait(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const ms = Math.min(Math.max((params.milliseconds as number) || 1000, 100), 10000);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return {
    text: `Waited ${ms}ms. Current URL: ${wv.getURL()}`,
    url: wv.getURL(),
    title: wv.getTitle(),
  };
}

export async function handleGetElements(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const scope = (params.selector as string) || 'body';
  const safeScope = JSON.stringify(scope);
  const code = `(() => {
    const scope = document.querySelector(${safeScope}) || document.body;
    const interactive = scope.querySelectorAll(
      'a[href], button, input, textarea, select, [role="button"], [role="link"], '
      + '[role="textbox"], [role="searchbox"], [role="menuitem"], [role="tab"], '
      + '[role="checkbox"], [role="switch"], [role="option"], '
      + '[onclick], [tabindex]:not([tabindex="-1"]), '
      + '[data-block-id], [contenteditable="true"]'
    );
    const seen = new Set();
    const results = [];
    for (const el of interactive) {
      if (results.length >= 80) break;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (style.opacity === '0') continue;

      let selector = el.tagName.toLowerCase();
      if (el.id) {
        selector = '#' + CSS.escape(el.id);
      } else if (el.getAttribute('data-block-id')) {
        selector = '[data-block-id="' + el.getAttribute('data-block-id') + '"]';
      } else if (el.getAttribute('name')) {
        selector = el.tagName.toLowerCase() + '[name="' + CSS.escape(el.getAttribute('name')) + '"]';
      } else if (el.getAttribute('aria-label')) {
        selector = el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(el.getAttribute('aria-label')) + '"]';
      } else if (el.getAttribute('type') && el.tagName === 'INPUT') {
        selector = 'input[type="' + el.getAttribute('type') + '"]';
        if (el.getAttribute('placeholder'))
          selector += '[placeholder="' + CSS.escape(el.getAttribute('placeholder')) + '"]';
      } else if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\\s+/)[0];
        if (cls && cls.length < 60)
          selector = el.tagName.toLowerCase() + '.' + CSS.escape(cls);
      }

      if (seen.has(selector)) {
        const parent = el.parentElement;
        if (parent && parent.id) {
          selector = '#' + CSS.escape(parent.id) + ' > ' + selector;
        } else {
          const siblings = parent ? Array.from(parent.children) : [];
          const idx = siblings.indexOf(el);
          if (idx >= 0) selector += ':nth-child(' + (idx + 1) + ')';
        }
      }
      seen.add(selector);

      results.push({
        selector,
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        text: (el.textContent || '').trim().substring(0, 120) || null,
        placeholder: el.placeholder || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        role: el.getAttribute('role') || null,
        href: el.href && el.href !== location.href ? el.href : null,
      });
    }
    return { elements: results, total: interactive.length, url: location.href, title: document.title };
  })()`;
  try {
    const result = await wv.executeJavaScript(code);
    return { text: JSON.stringify(result, null, 2), url: wv.getURL() };
  } catch (err: any) {
    return { error: `Failed to get elements: ${err?.message || String(err)}` };
  }
}

export async function handleEvaluate(wv: BrowserWebview, params: Record<string, any>): Promise<Record<string, any>> {
  const expression = params.expression as string;
  if (!expression) return { error: 'expression parameter is required' };
  try {
    const result = await wv.executeJavaScript(expression);
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return { text: text ?? 'undefined', url: wv.getURL() };
  } catch (err: any) {
    return { error: `JS evaluation error: ${err?.message || String(err)}` };
  }
}
