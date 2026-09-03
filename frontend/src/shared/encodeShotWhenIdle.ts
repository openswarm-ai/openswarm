import type { ElectronNativeImage } from '@/shared/browserRegistry';
import { interactionActive } from '@/shared/interactionPriority';
import { perfBaseline } from '@/shared/perfBaseline';

// A gesture that outlives this many waits gets its encode anyway, so a long pan cannot starve a shot forever.
const MAX_GESTURE_WAITS = 6;
const GESTURE_WAIT_MS = 400;
const IDLE_TIMEOUT_MS = 1500;
// One encode per idle slot with a breath between: a board full of shots coming due together used to land as one frameless run of encodes.
const BETWEEN_ENCODES_MS = 50;

interface PendingShot { image: ElectronNativeImage; maxWidth: number; done: (dataUrl: string) => void; waits: number }
const queue: PendingShot[] = [];
let pumping = false;

function encodeNow(job: PendingShot): void {
  let dataUrl = '';
  try {
    const sized = job.image.getSize().width > job.maxWidth ? job.image.resize({ width: job.maxWidth, quality: 'good' }) : job.image;
    dataUrl = sized.toDataURL();
  } catch {
    dataUrl = '';
  }
  job.done(dataUrl);
}

function whenIdle(fn: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => fn(), { timeout: IDLE_TIMEOUT_MS });
  else window.setTimeout(fn, 0);
}

function pump(): void {
  const job = queue[0];
  if (!job) { pumping = false; return; }
  if (interactionActive() && job.waits < MAX_GESTURE_WAITS) {
    job.waits += 1;
    window.setTimeout(pump, GESTURE_WAIT_MS);
    return;
  }
  queue.shift();
  encodeNow(job);
  if (queue.length === 0) { pumping = false; return; }
  window.setTimeout(() => whenIdle(pump), BETWEEN_ENCODES_MS);
}

// PNG-encoding a full-page capture blocks the main thread for ~180 ms; shrinking first and encoding one per idle slot keeps it off every gesture frame.
export function encodeShotWhenIdle(
  image: ElectronNativeImage,
  maxWidth: number,
  done: (dataUrl: string) => void,
): void {
  const job: PendingShot = { image, maxWidth, done, waits: 0 };
  // The A/B seam keeps the old shape: encode right here, on whatever frame the capture landed in.
  if (perfBaseline()) { encodeNow(job); return; }
  queue.push(job);
  if (pumping) return;
  pumping = true;
  whenIdle(pump);
}
