import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { motion } from 'framer-motion';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useCursorPosition } from './cursorStore';

interface Props {
  text: string;
  /** Offset from cursor tip in px when there's room. */
  offset?: { x: number; y: number };
}

const SAFE_PAD = 8;
const APPROX_W = 320;
const APPROX_H = 70;
const TAIL_PAD = 16;

const STREAM_MS_PER_CHAR = 30;
/** Extra pause after . , ! ? ; : */
const STREAM_PUNCT_EXTRA_MS = 210;
const STREAM_MIN_CHARS = 5;

/** Non-blocking cursor popup; streams char-by-char above the cursor (flips below if no room). */
const ACPopup: React.FC<Props> = ({ text, offset = { x: 0, y: 14 } }) => {
  const c = useClaudeTokens();
  const { x, y, visible } = useCursorPosition();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    x: number;
    y: number;
    tailLeft: number;
    flipY: boolean;
  }>({
    x: x - APPROX_W / 2,
    y: y - APPROX_H - offset.y,
    tailLeft: APPROX_W / 2,
    flipY: true,
  });

  // [debug] popups skip streaming so the diagnostic suffix is visible immediately.
  const isDebugPopup = text.includes('[debug]');
  const skipStream = isDebugPopup || text.length < STREAM_MIN_CHARS;
  const [streamCount, setStreamCount] = useState<number>(
    skipStream ? text.length : 0,
  );
  useEffect(() => {
    if (skipStream) {
      setStreamCount(text.length);
      return;
    }
    setStreamCount(0);
    let i = 0;
    let timer: number | null = null;
    const tick = () => {
      i += 1;
      setStreamCount(i);
      if (i >= text.length) {
        timer = null;
        return;
      }
      // Punctuation we just revealed gets an extra beat.
      const justShown = text[i - 1];
      const isPunct = /[.,!?;:]/.test(justShown);
      const delay = STREAM_MS_PER_CHAR + (isPunct ? STREAM_PUNCT_EXTRA_MS : 0);
      timer = window.setTimeout(tick, delay);
    };
    timer = window.setTimeout(tick, STREAM_MS_PER_CHAR);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [text, skipStream]);

  useLayoutEffect(() => {
    const el = ref.current;
    const w = el?.offsetWidth ?? APPROX_W;
    const h = el?.offsetHeight ?? APPROX_H;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let nx = x - w / 2;
    let ny = y - h - offset.y;
    let flipY = true;
    if (ny < SAFE_PAD) {
      ny = y + offset.y;
      flipY = false;
    }

    // Tail anchor x is computed AFTER clamp so it still points at the cursor when bubble shifts.
    const nxClamped = Math.max(SAFE_PAD, Math.min(nx, vw - w - SAFE_PAD));
    const nyClamped = Math.max(SAFE_PAD, Math.min(ny, vh - h - SAFE_PAD));
    const tailRaw = x - nxClamped;
    const tailLeft = Math.max(TAIL_PAD, Math.min(tailRaw, w - TAIL_PAD));

    setPos({ x: nxClamped, y: nyClamped, tailLeft, flipY });
  }, [x, y, offset.y, text, streamCount]);

  if (!visible) return null;

  const displayText = text.slice(0, streamCount);
  // Reserve full width with invisible chars so the bubble doesn't jiggle as letters arrive.
  const isStreaming = streamCount < text.length;

  return (
    <motion.div
      key="ac-popup"
      ref={ref}
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{
        opacity: 1,
        scale: 1,
        x: pos.x,
        y: pos.y,
      }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{
        // Slowed 50% from {0.14, 320, 32}; matches cursor spring.
        opacity: { duration: 0.21 },
        scale: { duration: 0.21 },
        x: { type: 'spring', stiffness: 160, damping: 22 },
        y: { type: 'spring', stiffness: 160, damping: 22 },
      }}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: 10501,
        pointerEvents: 'none',
      }}
    >
      <Box
        sx={{
          position: 'relative',
          maxWidth: 320,
          minWidth: 110,
          bgcolor: c.bg.surface,
          color: c.text.primary,
          border: `1px solid ${c.accent.primary}`,
          borderRadius: '14px',
          boxShadow: `0 14px 36px rgba(0,0,0,0.32), 0 0 16px ${c.accent.primary}33`,
          px: 1.6,
          py: 1.0,
          fontFamily: c.font.sans,
        }}
      >
        {/* Tail anchored on cursor's actual x via tailLeft; lands on target despite bubble clamp. */}
        <Box
          sx={{
            position: 'absolute',
            width: 10,
            height: 10,
            bgcolor: c.bg.surface,
            border: `1px solid ${c.accent.primary}`,
            transform: 'rotate(45deg)',
            top: pos.flipY ? 'auto' : -5,
            bottom: pos.flipY ? -5 : 'auto',
            left: pos.tailLeft - 5,
            // flipY true: bubble above, tail at bottom (br corners visible, points down). flipY false flips.
            borderRight: pos.flipY ? `1px solid ${c.accent.primary}` : 'none',
            borderBottom: pos.flipY ? `1px solid ${c.accent.primary}` : 'none',
            borderTop: pos.flipY ? 'none' : `1px solid ${c.accent.primary}`,
            borderLeft: pos.flipY ? 'none' : `1px solid ${c.accent.primary}`,
          }}
        />
        <Typography
          sx={{
            // 0.85rem with bold weight reads cleanly without dominating.
            fontSize: '0.85rem',
            color: c.text.primary,
            fontWeight: 600,
            lineHeight: 1.4,
            whiteSpace: 'pre-line',
            position: 'relative',
          }}
        >
          {displayText}
          {isStreaming && (
            <Box
              component="span"
              sx={{
                opacity: 0,
                pointerEvents: 'none',
                userSelect: 'none',
              }}
            >
              {text.slice(streamCount)}
            </Box>
          )}
        </Typography>
      </Box>
    </motion.div>
  );
};

export default ACPopup;
