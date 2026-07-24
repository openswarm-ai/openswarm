import React, { useLayoutEffect, useRef, useState } from 'react';
import { Box, Typography, ButtonBase } from '@mui/material';
import { motion } from '../_motionWin';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useCursorPosition } from './cursorStore';
import type { ACMultiChoiceOption } from '../steps/types';

interface Props {
  question: string;
  options: ACMultiChoiceOption[];
  onAnswer: (id: string) => void;
  offset?: { x: number; y: number };
}

const SAFE_PAD = 8;
const APPROX_W = 320;
const APPROX_H = 200;

/**
 * Single-select multi-choice popup. Same chrome as ACPopup but with
 * answer chips. Captures pointer events (auto) so chips are clickable.
 * Stays mounted until user picks (or runtime aborts via hidePopup).
 */
const ACMultiChoice: React.FC<Props> = ({
  question,
  options,
  onAnswer,
  offset = { x: 14, y: 14 },
}) => {
  const c = useClaudeTokens();
  const { x, y, visible } = useCursorPosition();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({
    x: x + offset.x,
    y: y + offset.y,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    const w = el?.offsetWidth ?? APPROX_W;
    const h = el?.offsetHeight ?? APPROX_H;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = x + offset.x;
    let ny = y + offset.y;
    if (nx + w + SAFE_PAD > vw) nx = x - w - offset.x;
    if (ny + h + SAFE_PAD > vh) ny = y - h - offset.y;
    nx = Math.max(SAFE_PAD, Math.min(nx, vw - w - SAFE_PAD));
    ny = Math.max(SAFE_PAD, Math.min(ny, vh - h - SAFE_PAD));
    setPos({ x: nx, y: ny });
  }, [x, y, offset.x, offset.y, options.length, question]);

  if (!visible) return null;

  return (
    <motion.div
      key="ac-multichoice"
      ref={ref}
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1, x: pos.x, y: pos.y }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{
        opacity: { duration: 0.16 },
        scale: { duration: 0.16 },
        x: { type: 'spring', stiffness: 300, damping: 30 },
        y: { type: 'spring', stiffness: 300, damping: 30 },
      }}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: 10501,
        pointerEvents: 'auto',
      }}
    >
      <Box
        sx={{
          maxWidth: 320,
          minWidth: 240,
          bgcolor: c.bg.surface,
          color: c.text.primary,
          border: `1px solid ${c.border.medium}`,
          borderRadius: '14px',
          boxShadow: '0 12px 32px rgba(0,0,0,0.25)',
          px: 1.6,
          py: 1.2,
          fontFamily: c.font.sans,
        }}
      >
        <Typography
          sx={{
            fontSize: '0.8125rem',
            fontWeight: 600,
            color: c.text.primary,
            lineHeight: 1.4,
            mb: 1,
          }}
        >
          {question}
        </Typography>
        <Box
          sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}
          role="radiogroup"
          aria-label={question}
        >
          {options.map((opt) => (
            <ButtonBase
              key={opt.id}
              onClick={() => onAnswer(opt.id)}
              role="radio"
              aria-checked={false}
              sx={{
                justifyContent: 'flex-start',
                textAlign: 'left',
                bgcolor: 'transparent',
                color: c.text.primary,
                border: `1px solid ${c.border.subtle}`,
                borderRadius: '10px',
                px: 1.1,
                py: 0.7,
                fontSize: '0.75rem',
                fontWeight: 500,
                fontFamily: c.font.sans,
                transition: 'all 0.12s',
                '&:hover': {
                  bgcolor: `${c.accent.primary}14`,
                  borderColor: c.accent.primary,
                  color: c.accent.primary,
                },
                '&:focus-visible': {
                  outline: `2px solid ${c.accent.primary}`,
                  outlineOffset: 2,
                },
              }}
            >
              {opt.label}
            </ButtonBase>
          ))}
        </Box>
      </Box>
    </motion.div>
  );
};

export default ACMultiChoice;
