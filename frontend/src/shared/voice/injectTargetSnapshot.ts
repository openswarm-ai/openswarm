// Focus drifts during the seconds of decode + polish (click another field, another app), so the
// dictation destination is snapshotted when the user starts speaking and preferred at paste time.
export interface InjectSnapshot {
  el: HTMLElement | null;
  browserId: string | null;
}

let p_snapshot: InjectSnapshot | null = null;

export function setInjectSnapshot(snap: InjectSnapshot): void {
  p_snapshot = snap;
}

export function clearInjectSnapshot(): void {
  p_snapshot = null;
}

/** A snapshot is only worth honoring while its element is still attached and still typeable. */
export function isUsableTarget(el: HTMLElement | null): boolean {
  if (!el || !el.isConnected) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'WEBVIEW' || el.isContentEditable;
}

export interface TakenSnapshot extends InjectSnapshot {
  /** We aimed at a real field and it died mid-decode. Distinct from never having aimed anywhere. */
  targetLost: boolean;
}

/** Consumes the snapshot: reading it once is the whole contract, so a stale one can never linger. */
export function takeInjectSnapshot(): TakenSnapshot {
  const snap = p_snapshot;
  p_snapshot = null;
  if (!snap) return { el: null, browserId: null, targetLost: false };
  const usable = isUsableTarget(snap.el);
  return { el: usable ? snap.el : null, browserId: snap.browserId, targetLost: !!snap.el && !usable };
}
