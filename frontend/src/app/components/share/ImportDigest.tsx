// The "digest" flash that plays where you drop a .swarm: a brand-tinted pixel blast that radiates from the drop point all the way to the corners, thinning out and dimming as it travels so the edges dissolve instead of ending in a box. Plain Canvas2D on ONE pooled, full-viewport canvas (reusing PixelBlast's shared WebGL context would fight an app's loading animation, and WebGL-context churn is the exact thing that crashed the GPU process). play() refuses to start while a burst is running, so drop-spam can never pile up work.
import React, { forwardRef, useImperativeHandle, useRef } from 'react';

export interface DigestHandle {
  // Returns false if a burst is already playing (caller should ignore the drop).
  play: (x: number, y: number) => boolean;
}

const CELL = 12;        // chunky pixels read as a "blast", and fewer cells = cheap
const DURATION = 820;
const BAND = 110;       // wave-front thickness in px; wide enough to feel like a wave
const ALPHA_CAP = 0.62; // keep it a whisper, never a solid flash

function dither(gx: number, gy: number): number {
  const v = Math.sin(gx * 12.9898 + gy * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

const ImportDigest = forwardRef<DigestHandle, { color?: string }>(({ color = '#c4633a' }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const busyRef = useRef(false);
  const rafRef = useRef(0);
  const hideTimerRef = useRef(0);

  useImperativeHandle(ref, () => ({
    play(x: number, y: number): boolean {
      if (busyRef.current) return false;
      const canvas = canvasRef.current;
      if (!canvas) return false;

      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      busyRef.current = true;
      window.clearTimeout(hideTimerRef.current);
      canvas.style.display = 'block';
      canvas.style.opacity = '1';

      const finish = () => {
        busyRef.current = false;
        canvas.style.opacity = '0';
        // Idle display:none + a zeroed backing store return the ~19MB full-window GPU layer this pinned 24/7.
        hideTimerRef.current = window.setTimeout(() => {
          canvas.style.display = 'none';
          canvas.width = 0;
          canvas.height = 0;
        }, 240);
      };
      if (reduce) {
        // Honor reduced-motion: no flashing pixels, just a brief, calm beat.
        window.setTimeout(finish, 200);
        return true;
      }

      const W = window.innerWidth;
      const H = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        finish();
        return true;
      }
      ctx.scale(dpr, dpr);

      // Reach the farthest corner so the wave actually clears the whole window.
      const maxDist = Math.max(
        Math.hypot(x, y), Math.hypot(W - x, y),
        Math.hypot(x, H - y), Math.hypot(W - x, H - y),
      );
      const cols = Math.ceil(W / CELL);
      const rows = Math.ceil(H / CELL);
      const start = performance.now();

      const frame = () => {
        const t = Math.min(1, (performance.now() - start) / DURATION);
        const eased = 1 - Math.pow(1 - t, 3); // quick out, like a blast
        const ring = eased * (maxDist + BAND);
        const ringSq = ring * ring;
        const inner = Math.max(0, ring - BAND);
        const innerSq = inner * inner;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = color;
        for (let gy = 0; gy < rows; gy++) {
          const py = gy * CELL + CELL / 2;
          const dy = py - y;
          for (let gx = 0; gx < cols; gx++) {
            const px = gx * CELL + CELL / 2;
            const dx = px - x;
            const distSq = dx * dx + dy * dy;
            // Cheap annulus reject before the sqrt: skip everything not on the front.
            if (distSq > ringSq || distSq < innerSq) continue;
            const dist = Math.sqrt(distSq);
            const band = 1 - (ring - dist) / BAND; // brightest at the leading edge
            const distFrac = dist / maxDist;        // 0 at origin, 1 at far corner
            const d = dither(gx, gy);
            // Sparser the further out: distant cells need a high dither value to appear at all, so the wave frays into scattered pixels near the edges.
            if (d < distFrac * 0.85) continue;
            const a = band * (1 - distFrac * 0.6) * (1 - t * 0.2) * (0.4 + 0.6 * d) * ALPHA_CAP;
            if (a <= 0.02) continue;
            ctx.globalAlpha = a > ALPHA_CAP ? ALPHA_CAP : a;
            ctx.fillRect(gx * CELL, gy * CELL, CELL - 1, CELL - 1);
          }
        }
        if (t < 1) {
          rafRef.current = requestAnimationFrame(frame);
        } else {
          finish();
        }
      };
      rafRef.current = requestAnimationFrame(frame);
      return true;
    },
  }));

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 2100,
        opacity: 0,
        display: 'none',
        transition: 'opacity 200ms ease',
      }}
    />
  );
});

ImportDigest.displayName = 'ImportDigest';
export default ImportDigest;
