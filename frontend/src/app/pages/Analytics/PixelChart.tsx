import React, { useRef, useEffect, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const PALETTES = {
  salmon: ['#C46B57', '#D4795F', '#E8927A', '#F0A088', '#F5B49E'],
  blue: ['#445588', '#5577AA', '#6688BB', '#7799CC', '#88AADD'],
  coral: ['#993344', '#AA3D4E', '#BB4455', '#CC5566', '#DD6677'],
  green: ['#447755', '#558866', '#669977', '#77AA88', '#88BB99'],
  purple: ['#665588', '#7766AA', '#8877BB', '#9988CC', '#AA99DD'],
} as const;

type PaletteKey = keyof typeof PALETTES;

interface PixelChartProps {
  data: { label: string; value: number }[];
  palette?: PaletteKey;
  height?: number;
  pixelSize?: number;
  formatValue?: (v: number) => string;
  glow?: boolean;
  showXLabels?: boolean;
  showYScale?: boolean;
  mode?: 'bar' | 'area';  // 'area' draws a filled line chart instead of bars
}

const PixelChart: React.FC<PixelChartProps> = ({
  data,
  palette = 'salmon',
  height = 140,
  pixelSize = 6,
  formatValue,
  glow = true,
  showXLabels = true,
  showYScale = true,
  mode = 'bar',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animRef = useRef(0);
  const progressRef = useRef(0);
  const hoverIdxRef = useRef(-1);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const c = useClaudeTokens();
  const colors = PALETTES[palette];

  const maxVal = Math.max(...data.map((d) => d.value), 0.001);

  // Compute nice Y-axis ticks
  const yTicks = (() => {
    if (maxVal <= 0) return [0];
    const rawStep = maxVal / 3;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const normalised = rawStep / magnitude;
    let niceStep: number;
    if (normalised <= 1) niceStep = magnitude;
    else if (normalised <= 2) niceStep = 2 * magnitude;
    else if (normalised <= 5) niceStep = 5 * magnitude;
    else niceStep = 10 * magnitude;
    const ticks: number[] = [];
    for (let v = 0; v <= maxVal * 1.1; v += niceStep) {
      ticks.push(v);
    }
    if (ticks.length < 2) ticks.push(niceStep);
    return ticks;
  })();

  // X-axis labels: show first, last, and up to 3 evenly spaced
  const xLabels = (() => {
    if (data.length <= 1) return data.map((d, i) => ({ idx: i, label: d.label }));
    if (data.length <= 5) return data.map((d, i) => ({ idx: i, label: d.label }));
    const result: { idx: number; label: string }[] = [];
    result.push({ idx: 0, label: data[0].label });
    const step = Math.floor(data.length / 4);
    for (let i = 1; i <= 3; i++) {
      const idx = Math.min(i * step, data.length - 2);
      if (idx > 0 && idx < data.length - 1) {
        result.push({ idx, label: data[idx].label });
      }
    }
    result.push({ idx: data.length - 1, label: data[data.length - 1].label });
    return result;
  })();

  const Y_LABEL_WIDTH = showYScale ? 80 : 0;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || data.length === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const totalW = container.clientWidth;
    const chartW = totalW - Y_LABEL_WIDTH;
    const h = height;
    canvas.width = totalW * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${totalW}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const px = pixelSize;
    const gridCols = Math.floor(chartW / px);
    const gridRows = Math.floor(h / px);
    const effectiveMax = yTicks[yTicks.length - 1] || maxVal;

    ctx.clearRect(0, 0, totalW, h);

    // Y-axis labels and horizontal grid lines
    if (showYScale) {
      ctx.font = '10px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';

      for (const tick of yTicks) {
        const yNorm = effectiveMax > 0 ? tick / effectiveMax : 0;
        const yPx = h - yNorm * (h - px);

        // Grid line
        ctx.strokeStyle = c.border.subtle;
        ctx.lineWidth = 0.5;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(Y_LABEL_WIDTH, yPx);
        ctx.lineTo(totalW, yPx);
        ctx.stroke();
        ctx.setLineDash([]);

        // Label
        const label = formatValue ? formatValue(tick) : (tick % 1 === 0 ? String(tick) : tick.toFixed(1));
        ctx.fillStyle = c.text.ghost;
        ctx.fillText(label, Y_LABEL_WIDTH - 8, yPx);
      }
    }

    // Subtle grid dots in chart area
    ctx.fillStyle = c.border.subtle;
    for (let gy = 0; gy < gridRows; gy += 5) {
      for (let gx = 0; gx < gridCols; gx += 5) {
        ctx.fillRect(Y_LABEL_WIDTH + gx * px, gy * px, 1, 1);
      }
    }

    const progress = Math.min(progressRef.current, 1);
    const hoverIdx = hoverIdxRef.current;

    if (mode === 'area') {
      // ── Area / line chart mode ──
      // Draw a smooth filled area under a line
      const usableH = h - px * 2;
      const points: { x: number; y: number }[] = [];

      for (let i = 0; i < data.length; i++) {
        const val = data[i].value;
        const norm = effectiveMax > 0 ? val / effectiveMax : 0;
        const x = Y_LABEL_WIDTH + (i / Math.max(data.length - 1, 1)) * chartW;
        const y = h - px - norm * usableH * progress;
        points.push({ x, y });
      }

      if (points.length > 0) {
        // Filled area with gradient
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, colors[colors.length - 1] + '60');
        gradient.addColorStop(0.5, colors[Math.floor(colors.length / 2)] + '30');
        gradient.addColorStop(1, colors[0] + '08');

        ctx.beginPath();
        ctx.moveTo(points[0].x, h);
        // Smooth curve through points
        for (let i = 0; i < points.length; i++) {
          if (i === 0) {
            ctx.lineTo(points[i].x, points[i].y);
          } else {
            // Cubic bezier for smoothing
            const prev = points[i - 1];
            const curr = points[i];
            const cpx = (prev.x + curr.x) / 2;
            ctx.bezierCurveTo(cpx, prev.y, cpx, curr.y, curr.x, curr.y);
          }
        }
        ctx.lineTo(points[points.length - 1].x, h);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        // Line on top
        ctx.beginPath();
        for (let i = 0; i < points.length; i++) {
          if (i === 0) {
            ctx.moveTo(points[i].x, points[i].y);
          } else {
            const prev = points[i - 1];
            const curr = points[i];
            const cpx = (prev.x + curr.x) / 2;
            ctx.bezierCurveTo(cpx, prev.y, cpx, curr.y, curr.x, curr.y);
          }
        }
        ctx.strokeStyle = colors[colors.length - 1];
        ctx.lineWidth = 2;
        ctx.stroke();

        // Glow on line
        if (glow) {
          ctx.shadowColor = colors[colors.length - 1];
          ctx.shadowBlur = 8;
          ctx.stroke();
          ctx.shadowBlur = 0;
        }

        // Data point dots
        for (let i = 0; i < points.length; i++) {
          if (data[i].value > 0) {
            const isHov = i === hoverIdx;
            ctx.beginPath();
            ctx.arc(points[i].x, points[i].y, isHov ? 4 : 2.5, 0, Math.PI * 2);
            ctx.fillStyle = isHov ? colors[colors.length - 1] : colors[Math.floor(colors.length / 2)];
            ctx.fill();
            if (isHov) {
              ctx.strokeStyle = colors[colors.length - 1];
              ctx.lineWidth = 1.5;
              ctx.stroke();
            }
          }
        }

        // Pixel scatter in the filled area for the pixel art feel
        for (let i = 0; i < points.length - 1; i++) {
          const p1 = points[i];
          const p2 = points[i + 1];
          const steps = Math.ceil((p2.x - p1.x) / px);
          for (let s = 0; s < steps; s++) {
            const t = s / steps;
            const x = p1.x + t * (p2.x - p1.x);
            const lineY = p1.y + t * (p2.y - p1.y);
            // Scatter pixels below the line
            for (let py = lineY + px * 2; py < h - px; py += px * 2) {
              if (Math.random() > 0.65) {
                const depth = (py - lineY) / (h - lineY);
                const ci = Math.max(0, Math.floor((1 - depth) * (colors.length - 1)));
                ctx.globalAlpha = 0.15 + (1 - depth) * 0.2;
                ctx.fillStyle = colors[ci];
                ctx.fillRect(Math.floor(x / px) * px, Math.floor(py / px) * px, px - 1, px - 1);
              }
            }
          }
        }
        ctx.globalAlpha = 1;
      }
    } else {
      // ── Bar chart mode (original) ──
      const barSlots = data.length;
      const totalBarPx = Math.max(1, Math.floor(gridCols / barSlots));
      const barW = Math.max(1, totalBarPx - 1);

      for (let i = 0; i < data.length; i++) {
        const val = data[i].value;
        const normalised = effectiveMax > 0 ? val / effectiveMax : 0;
        const usableRows = gridRows - 2;
        const targetH = Math.max(normalised > 0 ? 1 : 0, Math.round(normalised * usableRows));
        const barH = Math.round(targetH * progress);
        const barX = i * totalBarPx;
        const isHovered = i === hoverIdx;

        for (let row = 0; row < barH; row++) {
          const y = gridRows - 1 - row;
          const colorIdx = Math.min(colors.length - 1, Math.floor((row / Math.max(barH - 1, 1)) * (colors.length - 1)));
          const baseColor = isHovered ? colors[Math.min(colorIdx + 1, colors.length - 1)] : colors[colorIdx];

          for (let col = 0; col < barW; col++) {
            ctx.fillStyle = baseColor;
            ctx.fillRect(Y_LABEL_WIDTH + (barX + col) * px, y * px, px - 1, px - 1);
          }
        }

        if (glow && barH > 0) {
          const topY = (gridRows - 1 - barH + 1) * px;
          ctx.shadowColor = colors[colors.length - 1];
          ctx.shadowBlur = 6;
          ctx.fillStyle = colors[colors.length - 1];
          for (let col = 0; col < barW; col++) {
            ctx.fillRect(Y_LABEL_WIDTH + (barX + col) * px, topY, px - 1, px - 1);
          }
          ctx.shadowBlur = 0;
        }
      }
    }
  }, [data, height, pixelSize, c, colors, glow, maxVal, yTicks, showYScale, Y_LABEL_WIDTH, formatValue, mode]);

  useEffect(() => {
    progressRef.current = 0;
    let start: number | null = null;
    const animate = (ts: number) => {
      if (!start) start = ts;
      progressRef.current = Math.min(1, (ts - start) / 600);
      draw();
      if (progressRef.current < 1) animRef.current = requestAnimationFrame(animate);
    };
    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, [data, draw]);

  useEffect(() => {
    const handleResize = () => draw();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [draw]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current;
      const tooltip = tooltipRef.current;
      if (!canvas || !tooltip || data.length === 0) return;

      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left - Y_LABEL_WIDTH;
      if (mx < 0) { hoverIdxRef.current = -1; tooltip.style.opacity = '0'; draw(); return; }

      const chartW = rect.width - Y_LABEL_WIDTH;
      const gridCols = Math.floor(chartW / pixelSize);
      const totalBarPx = Math.max(1, Math.floor(gridCols / data.length));
      const idx = Math.floor(mx / (totalBarPx * pixelSize));

      if (idx >= 0 && idx < data.length) {
        hoverIdxRef.current = idx;
        const d = data[idx];
        const valStr = formatValue ? formatValue(d.value) : d.value.toFixed(2);
        tooltip.textContent = `${d.label}: ${valStr}`;
        tooltip.style.opacity = '1';
        tooltip.style.left = `${e.clientX - rect.left}px`;
        tooltip.style.top = `${e.clientY - rect.top - 28}px`;
      } else {
        hoverIdxRef.current = -1;
        tooltip.style.opacity = '0';
      }
      draw();
    },
    [data, pixelSize, draw, formatValue, Y_LABEL_WIDTH],
  );

  const handleMouseLeave = useCallback(() => {
    hoverIdxRef.current = -1;
    if (tooltipRef.current) tooltipRef.current.style.opacity = '0';
    draw();
  }, [draw]);

  return (
    <Box ref={containerRef} sx={{ position: 'relative', width: '100%' }}>
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ display: 'block', width: '100%', imageRendering: 'pixelated', cursor: 'crosshair' }}
      />
      {/* X-axis labels */}
      {showXLabels && data.length > 0 && (
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.5, pl: `${Y_LABEL_WIDTH}px` }}>
          {xLabels.map((xl) => (
            <Typography
              key={xl.idx}
              sx={{
                color: c.text.ghost,
                fontSize: '0.58rem',
                fontFamily: c.font.mono,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 60,
              }}
            >
              {xl.label}
            </Typography>
          ))}
        </Box>
      )}
      {/* Tooltip */}
      <Box
        ref={tooltipRef}
        sx={{
          position: 'absolute',
          pointerEvents: 'none',
          opacity: 0,
          transition: 'opacity 0.12s',
          bgcolor: c.bg.inverse,
          color: c.text.inverse,
          fontSize: '0.7rem',
          fontFamily: c.font.mono,
          fontWeight: 500,
          px: 1,
          py: 0.35,
          borderRadius: 0.75,
          whiteSpace: 'nowrap',
          transform: 'translateX(-50%)',
          zIndex: 10,
          boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        }}
      />
    </Box>
  );
};

export default PixelChart;
