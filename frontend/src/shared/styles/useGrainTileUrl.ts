import { useEffect, useState } from 'react';

// The grain PNG with the slider's opacity BAKED INTO its alpha, so grain can ride the wash element
// as a second background layer: one raster means a GPU-evicted tile drops wash AND grain together
// and falls back to the same flat tint, instead of the grain-only cutoff seam (the ENG-151 family).
//
// The bake also measures the tile's MEAN contribution (per-pixel alpha-weighted colour + mean
// alpha). The never-white underlay was tint-matched to the wash alone, so an evicted tile flashed
// wash-without-grain, which on a light theme reads as the white blink (ENG-340). The mean lets the
// underlay match the tone the rasterized canvas actually averaged. One extra getImageData pass per
// bake, cached with the URL.
export interface GrainTile {
  url: string;
  meanHex: string;
  meanAlpha: number;
}

const cache = new Map<number, GrainTile>();
let sourceImage: HTMLImageElement | null = null;

function p_measure(ctx: CanvasRenderingContext2D, w: number, h: number): { meanHex: string; meanAlpha: number } {
  try {
    const d = ctx.getImageData(0, 0, w, h).data;
    let r = 0, g = 0, b = 0, a = 0;
    for (let i = 0; i < d.length; i += 4) {
      const al = d[i + 3] / 255;
      r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al;
    }
    if (a <= 0) return { meanHex: '#000000', meanAlpha: 0 };
    const hex = `#${(((Math.round(r / a) << 16) | (Math.round(g / a) << 8) | Math.round(b / a)) >>> 0).toString(16).padStart(6, '0')}`;
    return { meanHex: hex, meanAlpha: a / (d.length / 4) };
  } catch {
    // A tainted canvas (should never happen for a bundled asset) degrades to "no tone", which is
    // exactly the pre-measurement behaviour, never a crash in a render path.
    return { meanHex: '#000000', meanAlpha: 0 };
  }
}

export function useGrainTile(opacity: number): GrainTile | null {
  const key = Math.round(Math.max(0, Math.min(1, opacity)) * 100) / 100;
  const [tile, setTile] = useState<GrainTile | null>(cache.get(key) ?? null);

  useEffect(() => {
    if (key <= 0) { setTile(null); return; }
    const hit = cache.get(key);
    if (hit) { setTile(hit); return; }
    let alive = true;
    const bake = (img: HTMLImageElement): void => {
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.globalAlpha = key;
      ctx.drawImage(img, 0, 0);
      const baked: GrainTile = {
        url: `url("${cv.toDataURL('image/png')}")`,
        ...p_measure(ctx, cv.width, cv.height),
      };
      cache.set(key, baked);
      if (alive) setTile(baked);
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

  return key > 0 ? tile : null;
}

export function useGrainTileUrl(opacity: number): string | null {
  return useGrainTile(opacity)?.url ?? null;
}
