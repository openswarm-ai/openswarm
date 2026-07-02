/** 10-step roadmap modal opened from the panel's "See all todos"; Stage 2 unlocks once Stage 1 is fully complete. */

import React from 'react';
import { Modal, Box, Typography, IconButton, Button } from '@mui/material';
import { motion, AnimatePresence } from './_motionWin';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import LockIcon from '@mui/icons-material/Lock';
import CloseIcon from '@mui/icons-material/Close';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useOnboardingProgress } from './hooks/useOnboardingProgress';
import { STAGE_GROUPS, STEPS, findStepById } from './steps';
import { useUnlockedStepIds, unlockHintFor } from './steps/stepUnlock';
import { STAGE_LABELS } from './steps/types';
import { onboardingDirector } from './OnboardingDirector';
import { report } from './telemetry';

const OnboardingRoadmapModal: React.FC = () => {
  const c = useClaudeTokens();
  const progress = useOnboardingProgress();
  const open = progress.panelMode === 'roadmap';
  const close = () => progress.setPanelMode('expanded');

  const unlockedIds = useUnlockedStepIds();

  // Current = first unlocked, not-yet-done step (locked ones wait their turn).
  const currentStep = (() => {
    const explicit = progress.currentStepId ? findStepById(progress.currentStepId) : null;
    if (explicit && !progress.completedSteps.includes(explicit.id) && unlockedIds.has(explicit.id)) {
      return explicit;
    }
    return STEPS.find((s) => !progress.completedSteps.includes(s.id) && unlockedIds.has(s.id));
  })();

  // Filter to live steps so a user who finished a since-removed step can't read e.g. 8/6.
  const totalDone = progress.completedSteps.filter((id) => findStepById(id)).length;
  const total = STEPS.length;

  const jumpToCurrent = () => {
    if (currentStep) progress.setCurrentStep(currentStep.id);
    progress.setPanelMode('expanded');
  };

  // Anchored top:44 / right:16 to match OnboardingPanel's dock so the modal reads as the panel expanding.
  return (
    <Modal
      open={open}
      onClose={close}
      sx={{ inset: 0 }}
      slotProps={{
        backdrop: {
          sx: { backgroundColor: 'rgba(0,0,0,0.42)' },
        },
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          top: 44,
          right: 16,
          outline: 'none',
        }}
      >
      <AnimatePresence>
        {open && (
        <motion.div
          key="onboarding-roadmap"
          initial={{ opacity: 0, y: -10, scale: 0.94, transformOrigin: 'top right' }}
          animate={{ opacity: 1, y: 0, scale: 1, transformOrigin: 'top right' }}
          exit={{ opacity: 0, y: -8, scale: 0.96, transformOrigin: 'top right' }}
          transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
          style={{ outline: 'none' }}
        >
      <Box
        sx={{
          width: 360,
          maxHeight: 'calc(100vh - 80px)',
          overflowY: 'auto',
          bgcolor: c.bg.surface,
          color: c.text.primary,
          border: `1px solid ${c.border.medium}`,
          borderRadius: `${c.radius.lg}px`,
          boxShadow: '0 14px 40px rgba(0,0,0,0.28)',
          outline: 'none',
          fontFamily: c.font.sans,
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: 2.4,
            pt: 1.8,
            pb: 1.2,
            borderBottom: `1px solid ${c.border.subtle}`,
          }}
        >
          <Box>
            <Typography
              sx={{
                fontSize: 16,
                fontWeight: 600,
                fontFamily: '"Charter", Georgia, serif',
              }}
            >
              Your roadmap
            </Typography>
            <Typography sx={{ fontSize: 12, color: c.text.muted, mt: 0.2 }}>
              {totalDone}/{total} milestones reached
            </Typography>
          </Box>
          <IconButton
            size="small"
            onClick={close}
            sx={{ color: c.text.tertiary }}
            aria-label="Close roadmap"
          >
            <CloseIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Box>

        <Box sx={{ px: 2.4, pt: 1.6, pb: 0.5 }}>
          {STAGE_GROUPS.map((group, gi) => {
            const stageDone = group.steps.filter((s) =>
              progress.completedSteps.includes(s.id),
            ).length;
            const isInProgress = stageDone < group.steps.length;
            const stageLabel = isInProgress ? 'IN PROGRESS' : 'COMPLETE';
            return (
              <Box key={group.stage} sx={{ mb: 2 }}>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    mb: 0.5,
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
                    <Typography
                      sx={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        letterSpacing: '0.08em',
                        color: isInProgress ? c.accent.primary : c.text.secondary,
                      }}
                    >
                      STAGE {gi + 1} · {stageLabel}
                    </Typography>
                  </Box>
                  <Typography sx={{ fontSize: 11, color: c.text.muted }}>
                    {stageDone}/{group.steps.length}
                  </Typography>
                </Box>
                <Typography
                  sx={{
                    fontSize: 14,
                    fontWeight: 600,
                    mb: 0.8,
                    color: c.text.primary,
                  }}
                >
                  {STAGE_LABELS[group.stage]}
                </Typography>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.6 }}>
                  {group.steps.map((step) => {
                    const isDone = progress.completedSteps.includes(step.id);
                    const isStepLocked = !isDone && !unlockedIds.has(step.id);
                    const isCurrent =
                      currentStep?.id === step.id && !isDone && !isStepLocked;
                    const lockHint = isStepLocked ? unlockHintFor(step.id) : null;
                    return (
                      <Box
                        key={step.id}
                        onClick={() => {
                          if (isStepLocked) return;
                          // Abort mid-flow step before jumping; otherwise AC keeps animating for a step the user no longer sees.
                          if (progress.running) {
                            onboardingDirector.cancelStep();
                          }
                          report('roadmap_step_clicked', {
                            step_id: step.id,
                            from_step_id: progress.currentStepId,
                          });
                          progress.setCurrentStep(step.id);
                          progress.setPanelMode('expanded');
                        }}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1,
                          py: 0.45,
                          px: 0.4,
                          borderRadius: `${c.radius.sm}px`,
                          cursor: isStepLocked ? 'default' : 'pointer',
                          opacity: isStepLocked ? 0.55 : 1,
                          transition: 'background 0.12s',
                          '&:hover': isStepLocked
                            ? {}
                            : { bgcolor: c.bg.secondary },
                        }}
                      >
                        {isStepLocked ? (
                          <LockIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
                        ) : isDone ? (
                          <CheckCircleIcon
                            sx={{ fontSize: 17, color: c.accent.primary }}
                          />
                        ) : (
                          <RadioButtonUncheckedIcon
                            sx={{
                              fontSize: 17,
                              color: isCurrent
                                ? c.accent.primary
                                : c.border.medium,
                            }}
                          />
                        )}
                        <Typography
                          sx={{
                            fontSize: 13,
                            fontWeight: isCurrent ? 600 : 500,
                            color: isDone
                              ? c.text.tertiary
                              : c.text.primary,
                            textDecoration: isDone ? 'line-through' : 'none',
                            flexGrow: 1,
                          }}
                        >
                          {step.title}
                        </Typography>
                        {isCurrent ? (
                          <Typography
                            sx={{
                              fontSize: 10.5,
                              fontWeight: 700,
                              letterSpacing: '0.05em',
                              color: c.accent.primary,
                              textTransform: 'uppercase',
                            }}
                          >
                            current
                          </Typography>
                        ) : lockHint ? (
                          <Typography
                            sx={{ fontSize: 10.5, color: c.text.tertiary, whiteSpace: 'nowrap' }}
                          >
                            {lockHint}
                          </Typography>
                        ) : null}
                      </Box>
                    );
                  })}
                </Box>
              </Box>
            );
          })}
        </Box>

        <Box
          sx={{
            px: 2.4,
            pb: 2,
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <Button
            onClick={jumpToCurrent}
            disabled={!currentStep}
            sx={{
              textTransform: 'none',
              bgcolor: c.accent.primary,
              color: '#fff',
              fontWeight: 600,
              fontSize: 13,
              px: 1.6,
              py: 0.6,
              borderRadius: `${c.radius.md}px`,
              '&:hover': { bgcolor: c.accent.hover ?? c.accent.primary },
            }}
          >
            Jump to current todo
          </Button>
        </Box>
      </Box>
        </motion.div>
        )}
      </AnimatePresence>
      </Box>
    </Modal>
  );
};

export default OnboardingRoadmapModal;
