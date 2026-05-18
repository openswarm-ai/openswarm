// Bayer-dithering pixel-blast background; same shader as webapp_template splash so cold-start phases match.

import React, { useEffect, useRef } from 'react';

// Module-level epoch so remounts pick up where the previous mount left off in the noise loop.
const PIXEL_BLAST_EPOCH = performance.now();

interface PixelBlastProps {
  color?: string;
  pixelSize?: number;
  speed?: number;
  edgeFade?: number;
  style?: React.CSSProperties;
}

const PixelBlast: React.FC<PixelBlastProps> = ({
  color = '#cc785c',
  pixelSize = 4,
  speed = 0.5,
  edgeFade = 0.3,
  style,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true });
    if (!gl) return;

    const VS = `#version 300 es
in vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }`;
    const FS = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform vec2 uResolution;
uniform float uTime;
uniform float uPixelSize;
uniform vec3 uColor;
uniform float uEdgeFade;
float Bayer2(vec2 a){ a = floor(a); return fract(a.x/2.0 + a.y*a.y*0.75); }
#define Bayer4(a) (Bayer2(0.5*(a))*0.25 + Bayer2(a))
#define Bayer8(a) (Bayer4(0.5*(a))*0.25 + Bayer2(a))
float hash11(float n){ return fract(sin(n)*43758.5453); }
float vnoise(vec3 p){
  vec3 ip = floor(p); vec3 fp = fract(p);
  float n000 = hash11(dot(ip + vec3(0,0,0), vec3(1.0,57.0,113.0)));
  float n100 = hash11(dot(ip + vec3(1,0,0), vec3(1.0,57.0,113.0)));
  float n010 = hash11(dot(ip + vec3(0,1,0), vec3(1.0,57.0,113.0)));
  float n110 = hash11(dot(ip + vec3(1,1,0), vec3(1.0,57.0,113.0)));
  float n001 = hash11(dot(ip + vec3(0,0,1), vec3(1.0,57.0,113.0)));
  float n101 = hash11(dot(ip + vec3(1,0,1), vec3(1.0,57.0,113.0)));
  float n011 = hash11(dot(ip + vec3(0,1,1), vec3(1.0,57.0,113.0)));
  float n111 = hash11(dot(ip + vec3(1,1,1), vec3(1.0,57.0,113.0)));
  vec3 w = fp*fp*fp*(fp*(fp*6.0-15.0)+10.0);
  float x00 = mix(n000,n100,w.x); float x10 = mix(n010,n110,w.x);
  float x01 = mix(n001,n101,w.x); float x11 = mix(n011,n111,w.x);
  float y0  = mix(x00,x10,w.y); float y1 = mix(x01,x11,w.y);
  return mix(y0,y1,w.z) * 2.0 - 1.0;
}
float fbm2(vec2 uv, float t){
  vec3 p = vec3(uv * 2.0, t);
  float amp = 1.0; float freq = 1.0; float sum = 1.0;
  for (int i = 0; i < 5; i++) {
    sum  += amp * vnoise(p * freq);
    freq *= 1.25;
  }
  return sum * 0.5 + 0.5;
}
void main(){
  // 137.5 (golden-ratio angle) offsets off the FBM singularities so the center axes don't bright-stripe.
  vec2 fragCoord = gl_FragCoord.xy - uResolution * 0.5 + vec2(137.5, 137.5);
  float aspectRatio = uResolution.x / uResolution.y;
  float cellPixelSize = 8.0 * uPixelSize;
  vec2 cellId = floor(fragCoord / cellPixelSize);
  vec2 cellCoord = cellId * cellPixelSize;
  vec2 uv = cellCoord / uResolution * vec2(aspectRatio, 1.0);
  float base = fbm2(uv, uTime * 0.05);
  // Density tuned to read as ambient texture, not lumpy blob. -0.55
  // produced visible bright clusters around the noise peaks; pulling
  // back to -0.62 evens out the field and the brand color reads as a
  // diffuse haze instead of localized bright spots.
  base = base * 0.5 - 0.62;
  float feed = base + 0.5 * 0.3;
  float bayer = Bayer8(fragCoord / uPixelSize) - 0.5;
  float bw = step(0.5, feed + bayer);
  vec2 norm = gl_FragCoord.xy / uResolution;
  float edge = min(min(norm.x, norm.y), min(1.0 - norm.x, 1.0 - norm.y));
  float fade = smoothstep(0.0, uEdgeFade, edge);
  float M = bw * fade;
  vec3 srgb = mix(uColor * 12.92, 1.055 * pow(uColor, vec3(1.0/2.4)) - 0.055, step(0.0031308, uColor));
  fragColor = vec4(srgb, M);
}`;

    function compile(type: number, src: string): WebGLShader | null {
      const s = gl!.createShader(type)!;
      gl!.shaderSource(s, src);
      gl!.compileShader(s);
      if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) return null;
      return s;
    }
    const vs = compile(gl.VERTEX_SHADER, VS);
    const fs = compile(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const aLoc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(aLoc);
    gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);

    const uResolution = gl.getUniformLocation(prog, 'uResolution');
    const uTime = gl.getUniformLocation(prog, 'uTime');
    const uPixelSize = gl.getUniformLocation(prog, 'uPixelSize');
    const uColor = gl.getUniformLocation(prog, 'uColor');
    const uEdgeFade = gl.getUniformLocation(prog, 'uEdgeFade');

    const hex = color.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    gl.uniform3f(uColor, r, g, b);
    gl.uniform1f(uEdgeFade, edgeFade);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    function resize() {
      const w = Math.floor(canvas!.clientWidth * dpr);
      const h = Math.floor(canvas!.clientHeight * dpr);
      if (canvas!.width !== w || canvas!.height !== h) {
        canvas!.width = w;
        canvas!.height = h;
      }
      gl!.viewport(0, 0, w, h);
      gl!.uniform2f(uResolution, w, h);
      gl!.uniform1f(uPixelSize, pixelSize * dpr);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Use the module-level epoch so animation time is continuous across
    // mounts. New cards opened later in the session pick up at the
    // current epoch-relative time rather than restarting from 0.
    let raf = 0;
    const MIN_FRAME_MS = 1000 / 30;
    let lastFrameAt = 0;
    function frame() {
      const now = performance.now();
      if (now - lastFrameAt >= MIN_FRAME_MS) {
        lastFrameAt = now;
        const t = (now - PIXEL_BLAST_EPOCH) / 1000;
        gl!.uniform1f(uTime, t * speed);
        gl!.clearColor(0.10, 0.10, 0.10, 1);
        gl!.clear(gl!.COLOR_BUFFER_BIT);
        gl!.drawArrays(gl!.TRIANGLES, 0, 6);
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch (_) {}
    };
  }, [color, pixelSize, speed, edgeFade]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        display: 'block',
        ...style,
      }}
      aria-label="OpenSwarm idle background"
    />
  );
};

export default PixelBlast;
