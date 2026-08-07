import { useEffect, useState } from 'react';

// The grain PNG with the slider's opacity BAKED INTO its alpha, so grain can ride the wash element
// as a second background layer: one raster means a GPU-evicted tile drops wash AND grain together
// and falls back to the same flat tint, instead of the grain-only cutoff seam (the ENG-151 family).
const cache = new Map<number, string>();
let sourceImage: HTMLImageElement | null = null;

export function useGrainTileUrl(opacity: number): string | null {
  const key = Math.round(Math.max(0, Math.min(1, opacity)) * 100) / 100;
  const [url, setUrl] = useState<string | null>(cache.get(key) ?? null);

  useEffect(() => {
    if (key <= 0) { setUrl(null); return; }
    const hit = cache.get(key);
    if (hit) { setUrl(hit); return; }
    let alive = true;
    const bake = (img: HTMLImageElement): void => {
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.globalAlpha = key;
      ctx.drawImage(img, 0, 0);
      const baked = `url("${cv.toDataURL('image/png')}")`;
      cache.set(key, baked);
      if (alive) setUrl(baked);
    };
    if (sourceImage && sourceImage.complete) {
      bake(sourceImage);
    } else {
      const img = sourceImage ?? new Image();
      sourceImage = img;
      // addEventListener, never onload=: with two consumers (shell + canvas) the second onload
      // assignment silently erased the first, and that instance stayed grainless forever.
      img.addEventListener('load', () => bake(img), { once: true });
      if (!img.src) img.src = './grain-texture.png';
      if (img.complete && img.naturalWidth > 0) bake(img);
    }
    return () => { alive = false; };
  }, [key]);

  return key > 0 ? url : null;
}
