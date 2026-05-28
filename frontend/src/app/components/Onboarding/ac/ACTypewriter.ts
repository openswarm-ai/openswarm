// Type into input/textarea/contentEditable using React-prototype native setters so onChange fires.

// Bundle-version marker; check window.__OPENSWARM_TYPEINTO__ to confirm dev-reload landed.
if (typeof window !== 'undefined') {
  (window as any).__OPENSWARM_TYPEINTO__ = 'v2-dom-direct-2026-05-12';
}

const INPUT_PROTO_VALUE_DESC =
  typeof window !== 'undefined'
    ? Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )
    : undefined;

const TEXTAREA_PROTO_VALUE_DESC =
  typeof window !== 'undefined'
    ? Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )
    : undefined;

function nativeSetValue(el: HTMLElement, value: string): void {
  if (el instanceof HTMLInputElement && INPUT_PROTO_VALUE_DESC?.set) {
    INPUT_PROTO_VALUE_DESC.set.call(el, value);
  } else if (
    el instanceof HTMLTextAreaElement &&
    TEXTAREA_PROTO_VALUE_DESC?.set
  ) {
    TEXTAREA_PROTO_VALUE_DESC.set.call(el, value);
  } else {
    (el as HTMLInputElement).value = value;
  }
}

function dispatchInput(el: HTMLElement): void {
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// contentEditable: append a Text node + dispatch InputEvent; execCommand silently no-ops when a webview steals focus.
function insertContentEditableText(el: HTMLElement, ch: string): void {
  el.focus();
  // Append at the very end; walk past skill-pill spans by appending a sibling text node.
  const range = document.createRange();
  const last = el.lastChild;
  if (last && last.nodeType === Node.TEXT_NODE) {
    range.setStart(last, (last.nodeValue ?? '').length);
    range.collapse(true);
    (last as Text).appendData(ch);
    range.setStart(last, (last.nodeValue ?? '').length);
    range.collapse(true);
  } else {
    const textNode = document.createTextNode(ch);
    el.appendChild(textNode);
    range.setStart(textNode, ch.length);
    range.collapse(true);
  }
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
  // inputType:insertText + data:ch mirrors a real keystroke so React's handleInput fires.
  el.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      data: ch,
      inputType: 'insertText',
    }),
  );
}

export interface TypeIntoOptions {
  speedMs?: number;
  /** Per-char callback so the cursor can re-align to the input's right edge as text grows. */
  onTick?: () => void;
}

function readEffectiveText(el: HTMLElement): string {
  if (el.isContentEditable) return (el.textContent ?? '').trim();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return (el.value ?? '').trim();
  }
  return (el.textContent ?? '').trim();
}

export async function typeInto(
  el: HTMLElement,
  text: string,
  opts: TypeIntoOptions = {},
): Promise<void> {
  // 18ms default; readable without making typing the bottleneck.
  const speed = opts.speedMs ?? 18;
  el.focus();

  // Constant cadence (jitter reads glitchy); only punctuation gets a longer pause to breathe.
  const punctPause = (ch: string): number => {
    if (ch === ',') return 220;
    if (ch === '.' || ch === '!' || ch === '?') return 320;
    if (ch === ':' || ch === ';') return 180;
    return 0;
  };

  if (el.isContentEditable) {
    for (const ch of text) {
      insertContentEditableText(el, ch);
      opts.onTick?.();
      await new Promise((r) => window.setTimeout(r, speed + punctPause(ch)));
    }
  } else {
    let acc = '';
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      acc = el.value ?? '';
    }
    for (const ch of text) {
      acc += ch;
      nativeSetValue(el, acc);
      dispatchInput(el);
      opts.onTick?.();
      await new Promise((r) => window.setTimeout(r, speed + punctPause(ch)));
    }
  }

  // Verify post-typing under load: if React's reconciler dropped chars, fall back to single-shot insert.
  const target = text.trim();
  if (!target) return;
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => window.setTimeout(r, 100));
    const got = readEffectiveText(el);
    if (got.length >= Math.floor(target.length * 0.8)) return;
  }

  // Fallback: nuke contents and insert in one shot; loses animation, preserves outcome.
  try {
    if (el.isContentEditable) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      try {
        document.execCommand('delete', false);
      } catch {
        /* fall through */
      }
      try {
        const ok = document.execCommand('insertText', false, text);
        if (!ok) {
          el.textContent = text;
          el.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              data: text,
              inputType: 'insertText',
            }),
          );
        }
      } catch {
        el.textContent = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement
    ) {
      nativeSetValue(el, text);
      dispatchInput(el);
    }
  } catch {
    /* best-effort; runtime's wait_user will time out and recover */
  }
}
