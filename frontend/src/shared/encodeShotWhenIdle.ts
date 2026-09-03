import type { ElectronNativeImage } from '@/shared/browserRegistry';
import { interactionActive } from '@/shared/interactionPriority';
import { perfBaseline } from '@/shared/perfBaseline';

// A gesture that outlives this many waits gets its encode anyway, so a long pan cannot starve a shot forever.
const MAX_GESTURE_WAITS = 6;
const GESTURE_WAIT_MS = 400;
const IDLE_TIMEOUT_MS = 1500;

// PNG-encoding a full-page capture blocks the main thread for ~180 ms; shrinking first and encoding in an idle slot keeps it off every gesture frame.
export function encodeShotWhenIdle(
  image: ElectronNativeImage,
  maxWidth: number,
  done: (dataUrl: string) => void,
): void {
  let waits = 0;
  const run = (): void => {
    if (!perfBaseline() && interactionActive() && waits < MAX_GESTURE_WAITS) {
      waits += 1;
      window.setTimeout(run, GESTURE_WAIT_MS);
      return;
    }
    let dataUrl = '';
    try {
      const sized = image.getSize().width > maxWidth ? image.resize({ width: maxWidth, quality: 'good' }) : image;
      dataUrl = sized.toDataURL();
    } catch {
      dataUrl = '';
    }
    done(dataUrl);
  };
  // The A/B seam keeps the old shape: encode right here, on whatever frame the capture landed in.
  if (perfBaseline()) run();
  else if (typeof requestIdleCallback === 'function') requestIdleCallback(() => run(), { timeout: IDLE_TIMEOUT_MS });
  else window.setTimeout(run, 0);
}
