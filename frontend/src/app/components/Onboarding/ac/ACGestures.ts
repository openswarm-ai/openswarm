// Transient visual gesture helpers: click ripple, drag-rect, glow.

export function clickRipple(x: number, y: number, color: string): void {
  const SIZE = 28;
  const el = document.createElement('div');
  el.style.cssText = [
    'position: fixed',
    `left: ${x - SIZE / 2}px`,
    `top: ${y - SIZE / 2}px`,
    `width: ${SIZE}px`,
    `height: ${SIZE}px`,
    'border-radius: 50%',
    `background: ${color}`,
    'pointer-events: none',
    'z-index: 10499',
    'opacity: 0.55',
    'transform: scale(0.4)',
    'transition: transform 0.45s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.45s linear',
  ].join(';');
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    el.style.transform = 'scale(3)';
    el.style.opacity = '0';
  });
  window.setTimeout(() => el.remove(), 600);
}

export interface DragRect {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

export function animateDragSelect(rect: DragRect, color: string, durationMs = 600): Promise<void> {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    const left = Math.min(rect.fromX, rect.toX);
    const top = Math.min(rect.fromY, rect.toY);
    el.style.cssText = [
      'position: fixed',
      `left: ${rect.fromX}px`,
      `top: ${rect.fromY}px`,
      'width: 0px',
      'height: 0px',
      `border: 1.5px dashed ${color}`,
      `background: ${color}1a`,
      'pointer-events: none',
      'z-index: 10499',
      'border-radius: 4px',
      `transition: all ${durationMs}ms cubic-bezier(0.4, 0, 0.2, 1)`,
    ].join(';');
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.width = `${Math.abs(rect.toX - rect.fromX)}px`;
      el.style.height = `${Math.abs(rect.toY - rect.fromY)}px`;
    });
    window.setTimeout(() => {
      el.style.opacity = '0';
    }, durationMs + 200);
    window.setTimeout(() => {
      el.remove();
      resolve();
    }, durationMs + 600);
  });
}

/** Soft glow rect over a target (no click); caller must invoke the returned cleanup. */
export function spawnGlowRect(target: HTMLElement, color: string): () => void {
  const rect = target.getBoundingClientRect();
  const pad = 6;
  const el = document.createElement('div');
  el.style.cssText = [
    'position: fixed',
    `left: ${rect.left - pad}px`,
    `top: ${rect.top - pad}px`,
    `width: ${rect.width + pad * 2}px`,
    `height: ${rect.height + pad * 2}px`,
    'border-radius: 12px',
    `border: 2px solid ${color}`,
    `box-shadow: 0 0 24px ${color}55, inset 0 0 18px ${color}22`,
    'pointer-events: none',
    'z-index: 10498',
    'opacity: 0',
    'transition: opacity 0.3s ease',
  ].join(';');
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = '1';
  });
  return () => {
    el.style.opacity = '0';
    window.setTimeout(() => el.remove(), 320);
  };
}

/** Promise-wrapped setTimeout for use between ops. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}
