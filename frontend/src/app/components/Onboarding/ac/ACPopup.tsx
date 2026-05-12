import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { motion } from 'framer-motion';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useCursorPosition } from './cursorStore';

interface Props {
  text: string;
  /** Offset from cursor tip in px when there's room. */
  offset?: { x: number; y: number };
  /**
   * Preferred horizontal side of the cursor. Default `'right'` (the
   * bubble appears to the bottom-right of the tip). Pass `'left'` for
   * cursors that land on an icon whose right-hand neighbors would
   * otherwise be covered by the bubble (toolbar [+ grid globe history
   * note], chat input [cursor-circle clip mic], etc.). The viewport
   * clip-flip still wins — if the chosen side would clip, we flip to
   * the other side.
   */
  side?: 'left' | 'right';
}

const SAFE_PAD = 8;
// Slight bump to APPROX_W to match the larger font — keeps line-wrap
// behavior similar to before. The runtime measures the real rect via
// ref so this is just an initial-mount estimate.
const APPROX_W = 320;
const APPROX_H = 70;

// Pokémon-dialog cadence — letters pop in steadily, punctuation gets
// a small extra pause so sentences "land" instead of slurring together.
const STREAM_MS_PER_CHAR = 20;
const STREAM_PUNCT_EXTRA_MS = 140; // after . , ! ? ; :
const STREAM_MIN_CHARS = 5;

/**
 * Tiny popup that follows the cursor. Non-blocking — no CTA.
 *
 * Streams text character-by-character like an RPG dialog box (modulo
 * very short strings, which appear instantly to avoid visual jank on
 * single-word popups).
 *
 * Positioning: prefers bottom-right of the cursor, but flips quadrants
 * when the chosen position would clip past the viewport. Re-evaluates
 * whenever the cursor moves (cursorStore subscription).
 */
const ACPopup: React.FC<Props> = ({ text, offset = { x: 14, y: 14 }, side = 'right' }) => {
  const c = useClaudeTokens();
  const { x, y, visible } = useCursorPosition();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; flipX: boolean; flipY: boolean }>({
    x: x + offset.x,
    y: y + offset.y,
    flipX: false,
    flipY: false,
  });

  // Streaming text state — grows from 0 to text.length char-by-char.
  // Use chained setTimeout (not setInterval) so we can vary the delay
  // per character — punctuation gets an extra beat, mimicking the
  // pacing of Pokémon-style dialog boxes where sentences "land."
  const [streamCount, setStreamCount] = useState<number>(
    text.length < STREAM_MIN_CHARS ? text.length : 0,
  );
  useEffect(() => {
    if (text.length < STREAM_MIN_CHARS) {
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
      // Look at the char we *just* revealed — if it's punctuation,
      // wait an extra beat before the next one. Mirrors Pokémon's
      // "..." and end-of-sentence pacing.
      const justShown = text[i - 1];
      const isPunct = /[.,!?;:]/.test(justShown);
      const delay = STREAM_MS_PER_CHAR + (isPunct ? STREAM_PUNCT_EXTRA_MS : 0);
      timer = window.setTimeout(tick, delay);
    };
    timer = window.setTimeout(tick, STREAM_MS_PER_CHAR);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [text]);

  useLayoutEffect(() => {
    const el = ref.current;
    const w = el?.offsetWidth ?? APPROX_W;
    const h = el?.offsetHeight ?? APPROX_H;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Start on the preferred side. `flipX = true` means the bubble is
    // drawn to the LEFT of the cursor (and its tail anchors on the
    // bubble's right edge). Default preference is right.
    let flipX = side === 'left';
    // `side: 'left'` AND cursor in the lower half → also flip
    // vertically so the bubble sits ABOVE-LEFT of the cursor rather
    // than beside its target row. This matters for the chat-input
    // cluster (cursor-circle / clip / mic) where a below-left bubble
    // would extend horizontally across the input field's placeholder
    // text. Above-left stacks the bubble above the input box where
    // there's clear canvas. Top-half cursors (dashboard toolbar) stay
    // below-left so the bubble doesn't fly off into the title bar.
    let flipY = side === 'left' && y > vh / 2;
    let nx = flipX ? x - w - offset.x : x + offset.x;
    let ny = flipY ? y - h - offset.y : y + offset.y;

    // Viewport clip: if the preferred side would overflow, flip to the
    // other side. The flip wins over the preference so the bubble stays
    // on-screen no matter what the caller asked for.
    if (!flipX && nx + w + SAFE_PAD > vw) {
      nx = x - w - offset.x;
      flipX = true;
    } else if (flipX && nx < SAFE_PAD) {
      nx = x + offset.x;
      flipX = false;
    }
    if (!flipY && ny + h + SAFE_PAD > vh) {
      ny = y - h - offset.y;
      flipY = true;
    } else if (flipY && ny < SAFE_PAD) {
      ny = y + offset.y;
      flipY = false;
    }
    nx = Math.max(SAFE_PAD, Math.min(nx, vw - w - SAFE_PAD));
    ny = Math.max(SAFE_PAD, Math.min(ny, vh - h - SAFE_PAD));

    setPos({ x: nx, y: ny, flipX, flipY });
  }, [x, y, offset.x, offset.y, side, text, streamCount]);

  if (!visible) return null;

  const displayText = text.slice(0, streamCount);
  // Reserve full width with invisible char to prevent the bubble from
  // jiggling as letters arrive — invisible character keeps wrap consistent.
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
        opacity: { duration: 0.14 },
        scale: { duration: 0.14 },
        x: { type: 'spring', stiffness: 320, damping: 32 },
        y: { type: 'spring', stiffness: 320, damping: 32 },
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
        {/* Tail pointing back at the cursor. */}
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
            left: pos.flipX ? 'auto' : 14,
            right: pos.flipX ? 14 : 'auto',
            borderRight: pos.flipY ? `1px solid ${c.accent.primary}` : 'none',
            borderBottom: pos.flipY ? `1px solid ${c.accent.primary}` : 'none',
            borderTop: pos.flipY ? 'none' : `1px solid ${c.accent.primary}`,
            borderLeft: pos.flipY ? 'none' : `1px solid ${c.accent.primary}`,
          }}
        />
        <Typography
          sx={{
            // Sized to feel like a Pokémon dialog — small but firm.
            // 0.85rem reads cleanly without dominating the screen,
            // and pairs with the bolder weight to stay legible.
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
