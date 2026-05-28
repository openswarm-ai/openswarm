// Docked onboarding home: a small, quiet handle on the right edge that reopens the tour.

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Box, IconButton, Typography, CircularProgress } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useOnboardingProgress } from './hooks/useOnboardingProgress';
import { STEPS } from './steps';
import { report } from './telemetry';

const OnboardingDockedTab: React.FC = () => {
  const c = useClaudeTokens();
  const progress = useOnboardingProgress();
  const [hovered, setHovered] = useState(false);

  const total = STEPS.length;
  const done = progress.completedSteps.length;
  // Hide while the cursor is driving a step, same as the panel does.
  const show =
    progress.initialized &&
    progress.panelMode === 'docked' &&
    !progress.running &&
    done < total;
  const pct = total > 0 ? (done / total) * 100 : 0;

  const reopen = () => {
    report('panel_reopened', { from: 'docked_tab' });
    progress.setPanelMode('expanded');
  };

  return (
    <Box
      sx={{
        position: 'fixed',
        top: '50%',
        right: 0,
        transform: 'translateY(-50%)',
        zIndex: 1200,
        pointerEvents: 'none',
      }}
    >
      <AnimatePresence>
        {show && (
          <motion.div
            key="onboarding-docked-tab"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16 }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            style={{ pointerEvents: 'auto' }}
          >
            <Box
              role="button"
              tabIndex={0}
              aria-label="Resume setup"
              onMouseEnter={() => setHovered(true)}
              onMouseLeave={() => setHovered(false)}
              onClick={reopen}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  reopen();
                }
              }}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: hovered ? 0.7 : 0,
                cursor: 'pointer',
                bgcolor: c.bg.surface,
                border: `1px solid ${c.border.subtle}`,
                borderRight: 'none',
                borderTopLeftRadius: 9,
                borderBottomLeftRadius: 9,
                pl: hovered ? 1 : 0.5,
                pr: 0.5,
                py: 0.5,
                boxShadow: hovered ? c.shadow.md : '-1px 0 5px rgba(0,0,0,0.07)',
                transition:
                  'gap 0.18s ease, padding 0.18s ease, box-shadow 0.18s ease, background 0.15s',
                '&:hover': { bgcolor: c.bg.elevated ?? c.bg.surface },
              }}
            >
              <Box
                sx={{
                  width: hovered ? 20 : 0,
                  overflow: 'hidden',
                  display: 'flex',
                  transition: 'width 0.18s ease',
                }}
              >
                <IconButton
                  size="small"
                  aria-label="Dismiss setup"
                  onClick={(e) => {
                    e.stopPropagation();
                    report('panel_dismissed', { from: 'docked_tab' });
                    progress.setPanelMode('hidden');
                  }}
                  sx={{
                    p: 0.1,
                    color: c.text.tertiary,
                    '&:hover': { color: c.text.primary },
                  }}
                >
                  <CloseIcon sx={{ fontSize: 13 }} />
                </IconButton>
              </Box>
              <Box
                sx={{
                  width: hovered ? 72 : 0,
                  opacity: hovered ? 1 : 0,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  transition: 'width 0.18s ease, opacity 0.18s ease',
                }}
              >
                <Typography
                  sx={{ fontSize: 12.5, fontWeight: 600, color: c.text.secondary }}
                >
                  Finish setup
                </Typography>
              </Box>
              <Box sx={{ position: 'relative', display: 'inline-flex' }}>
                <CircularProgress
                  variant="determinate"
                  value={100}
                  size={18}
                  thickness={3.5}
                  sx={{ color: `${c.text.tertiary}26` }}
                />
                <CircularProgress
                  variant="determinate"
                  value={pct}
                  size={18}
                  thickness={3.5}
                  sx={{ color: c.accent.primary, position: 'absolute', left: 0 }}
                />
              </Box>
            </Box>
          </motion.div>
        )}
      </AnimatePresence>
    </Box>
  );
};

export default OnboardingDockedTab;
