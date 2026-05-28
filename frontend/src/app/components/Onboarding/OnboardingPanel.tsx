/** Docked top-right panel; states: pill, expanded, roadmap, hidden. */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from './_motionWin';
import { Box, Typography, IconButton, Button, ButtonBase } from '@mui/material';
import RemoveIcon from '@mui/icons-material/Remove';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CloseIcon from '@mui/icons-material/Close';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch } from '@/shared/hooks';
import { useOnboardingProgress } from './hooks/useOnboardingProgress';
import { clearJustCompleted } from '@/shared/state/onboardingProgressSlice';
import { STEPS, findStepById } from './steps';
import { STAGE_LABELS } from './steps/types';
import { onboardingDirector } from './OnboardingDirector';
import { report } from './telemetry';
import { cursorStore } from './ac/cursorStore';
import OnboardingRoadmapModal from './OnboardingRoadmapModal';

const PANEL_WIDTH = 420;
const CELEBRATION_MS = 900;

/** Mirrors AgenticCursor's shape so AC visually "comes to life" out of this icon on Show me click. */
const CursorIconSmall: React.FC<{ size?: number; color: string }> = ({
  size = 14,
  color,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 22 22"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden
    style={{ display: 'block' }}
  >
    <path
      d="M3 2 L3 18 L7.5 14 L10 19.5 L13 18 L10.5 12.5 L17 12 Z"
      fill={color}
      stroke="white"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
  </svg>
);

const OnboardingPanel: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const progress = useOnboardingProgress();
  const infoBtnRef = useRef<HTMLButtonElement | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

  // AC spawn point flies out of this icon.
  const cursorIconRef = useRef<HTMLSpanElement | null>(null);
  // Cooldown so rapid double-clicks don't fire parallel step starts; each one re-triggers in-flight backend seed/launch calls.
  const lastShowMeClickRef = useRef<number>(0);

  const currentStep = useMemo(() => {
    const explicit = progress.currentStepId
      ? findStepById(progress.currentStepId)
      : null;
    if (explicit && !progress.completedSteps.includes(explicit.id)) return explicit;
    return STEPS.find((s) => !progress.completedSteps.includes(s.id)) ?? null;
  }, [progress.currentStepId, progress.completedSteps]);

  // Stage name labels the panel; the count + bar stay global so progress never resets between stages.
  const stageOf = currentStep?.stage ?? 'get_started';

  const total = STEPS.length;
  const done = progress.completedSteps.length;

  // Timer lives inside CelebrationView so parent re-renders can't cancel it.
  const justDoneStepId = progress.justCompletedStepId;
  const justDoneStep = justDoneStepId ? findStepById(justDoneStepId) : null;

  const handleShowMe = async () => {
    if (!currentStep) return;
    // 600ms cooldown: cancelStep doesn't kill in-flight backend fetches so spam would launch parallel sessions.
    const now = Date.now();
    if (now - lastShowMeClickRef.current < 600) return;
    lastShowMeClickRef.current = now;

    // Unstick a stale "running" flag from a prior unhandled error or HMR; yield a tick so reset lands first.
    if (progress.running) {
      onboardingDirector.cancelStep();
      progress.setRunning(false);
      await new Promise<void>((r) => window.setTimeout(r, 0));
    }
    const iconEl = cursorIconRef.current;
    const rect = iconEl?.getBoundingClientRect();
    // Mid-transition rects can be 0,0,0,0; fall back to a top-right anchor.
    const validRect =
      rect && (rect.width > 0 || rect.height > 0) && (rect.left > 0 || rect.top > 0);
    const spawnPoint = validRect
      ? { x: rect!.left + rect!.width / 2, y: rect!.top + rect!.height / 2 }
      : { x: window.innerWidth - 80, y: 110 };
    report('show_me_clicked', { step_id: currentStep.id });
    // 2s watchdog recovers the panel if AC never becomes visible (HMR / silent rejection).
    const watchedStepId = currentStep.id;
    window.setTimeout(() => {
      const acVisible = cursorStore.get().visible;
      if (!acVisible) {
        onboardingDirector.cancelStep();
        progress.setRunning(false);
        report('show_me_watchdog_recovery', { step_id: watchedStepId });
      }
    }, 2000);
    await onboardingDirector.startStep(currentStep.id, spawnPoint);
  };

  if (!currentStep && !justDoneStep) return null;
  if (progress.panelMode === 'hidden') return null;

  // Slide panel off-screen while AC runs so it doesn't sit on top of top-right targets (Skills install, "+ New app", etc).
  const panelHidden = progress.running;

  return (
    <>
      <Box
        component={motion.div}
        animate={{
          x: panelHidden ? PANEL_WIDTH + 48 : 0,
          opacity: panelHidden ? 0 : 1,
        }}
        transition={{ type: 'spring', stiffness: 280, damping: 32 }}
        sx={{
          position: 'fixed',
          // 38px title bar + 6px breathing room.
          top: 44,
          right: 16,
          zIndex: 1200,
          fontFamily: c.font.sans,
          pointerEvents: panelHidden ? 'none' : 'auto',
        }}
      >
        <AnimatePresence mode="wait" initial={false}>
          {progress.panelMode === 'pill' && (
            <motion.div
              key="pill"
              initial={{ opacity: 0, y: -6, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.96 }}
              transition={{ duration: 0.18 }}
              style={{ pointerEvents: 'auto' }}
            >
              <ButtonBase
                onClick={() => {
                  report('panel_expanded', { from: 'pill' });
                  progress.setPanelMode('expanded');
                }}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.7,
                  bgcolor: c.bg.surface,
                  border: `1px solid ${c.border.medium}`,
                  borderRadius: 999,
                  py: 1.05,
                  pl: 2.1,
                  pr: 1.9,
                  boxShadow: `0 8px 22px rgba(0,0,0,0.15), 0 0 0 1px ${c.accent.primary}1f`,
                  textAlign: 'left',
                  transition: 'background 0.15s, box-shadow 0.15s, transform 0.15s',
                  '&:hover': {
                    bgcolor: c.bg.elevated ?? c.bg.surface,
                    boxShadow: `0 12px 28px rgba(0,0,0,0.2), 0 0 0 1px ${c.accent.primary}44`,
                    transform: 'translateY(-1px)',
                  },
                }}
              >
                <Typography sx={{ fontSize: 14.5, fontWeight: 600, color: c.text.primary }}>
                  Finish setup
                </Typography>
                <Typography sx={{ fontSize: 13.5, color: c.text.muted, fontWeight: 500 }}>
                  {done}/{total}
                </Typography>
                <Box sx={{ flexGrow: 1, minWidth: 12 }} />
                <Typography
                  sx={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: c.accent.primary,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.45,
                  }}
                >
                  Continue
                  <ArrowForwardIcon sx={{ fontSize: 15.5 }} />
                </Typography>
              </ButtonBase>
            </motion.div>
          )}

          {progress.panelMode === 'expanded' && (
            <motion.div
              key="expanded"
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.97 }}
              transition={{ duration: 0.2 }}
              style={{ pointerEvents: 'auto' }}
            >
              <Box
                sx={{
                  width: PANEL_WIDTH,
                  bgcolor: c.bg.surface,
                  border: `1px solid ${c.border.medium}`,
                  borderRadius: `${c.radius.lg}px`,
                  boxShadow: '0 12px 36px rgba(0,0,0,0.16)',
                  overflow: 'hidden',
                }}
              >
                <Box
                  sx={{
                    px: 1.6,
                    pt: 1.2,
                    pb: 0.95,
                  }}
                >
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.7 }}>
                      <Typography
                        sx={{ fontSize: 12.5, fontWeight: 600, color: c.text.primary }}
                      >
                        {STAGE_LABELS[stageOf]}
                      </Typography>
                      <Typography sx={{ fontSize: 11, color: c.text.muted }}>
                        {done}/{total}
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.2 }}>
                      <ButtonBase
                        onClick={() => {
                          report('panel_skipped', { from: 'expanded' });
                          progress.setPanelMode('docked');
                        }}
                        sx={{
                          fontSize: 11.5,
                          fontWeight: 500,
                          color: c.text.muted,
                          px: 0.7,
                          py: 0.3,
                          borderRadius: `${c.radius.sm}px`,
                          transition: 'color 0.15s, background 0.15s',
                          '&:hover': { color: c.text.primary, bgcolor: `${c.text.tertiary}0A` },
                        }}
                        aria-label="Skip setup and tuck it into the sidebar"
                      >
                        Skip
                      </ButtonBase>
                      <IconButton
                        size="small"
                        onClick={() => {
                          report('panel_minimized', { from: 'expanded' });
                          progress.setPanelMode('pill');
                        }}
                        sx={{ color: c.text.tertiary, p: 0.4 }}
                        aria-label="Minimize"
                      >
                        <RemoveIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </Box>
                  </Box>
                  <Box
                    sx={{
                      mt: 0.7,
                      height: 3,
                      width: '100%',
                      borderRadius: 999,
                      bgcolor: c.bg.secondary,
                      overflow: 'hidden',
                    }}
                  >
                    <motion.div
                      key="tour-progress"
                      initial={false}
                      animate={{
                        width: `${total > 0 ? (done / total) * 100 : 0}%`,
                      }}
                      transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
                      style={{
                        height: '100%',
                        background: c.accent.primary,
                        borderRadius: 999,
                      }}
                    />
                  </Box>
                </Box>

                <Box sx={{ position: 'relative' }}>
                  <AnimatePresence mode="wait" initial={false}>
                    {justDoneStep ? (
                      <motion.div
                        key={`celebrate-${justDoneStep.id}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.2 }}
                      >
                        <CelebrationView step={justDoneStep} accent={c.accent.primary} />
                      </motion.div>
                    ) : currentStep ? (
                      <motion.div
                        key={`step-${currentStep.id}`}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.22 }}
                      >
                        <StepCardBody
                          step={currentStep}
                          tokens={c}
                          cursorIconRef={cursorIconRef}
                          infoBtnRef={infoBtnRef}
                          onShowMe={handleShowMe}
                          onOpenRoadmap={() => {
                            report('roadmap_opened', { from: 'panel' });
                            progress.setPanelMode('roadmap');
                          }}
                          onToggleInfo={() => {
                            report('info_toggled', {
                              step_id: currentStep.id,
                              opening: !infoOpen,
                            });
                            setInfoOpen((v) => !v);
                          }}
                          running={progress.running}
                        />
                      </motion.div>
                    ) : (
                      <motion.div
                        key="all-done"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                      >
                        <AllDoneView accent={c.accent.primary} tokens={c} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </Box>
              </Box>
            </motion.div>
          )}
        </AnimatePresence>
      </Box>

      {/* Rendered outside the panel container so it can extend left without clipping. */}
      {infoOpen && currentStep && (
        <InfoPopover
          stepId={currentStep.id}
          anchorRef={infoBtnRef}
          onClose={() => setInfoOpen(false)}
          tokens={c}
        />
      )}

      <OnboardingRoadmapModal />
    </>
  );
};

interface StepCardProps {
  step: ReturnType<typeof findStepById> & {};
  tokens: ReturnType<typeof useClaudeTokens>;
  cursorIconRef: React.MutableRefObject<HTMLSpanElement | null>;
  infoBtnRef: React.MutableRefObject<HTMLButtonElement | null>;
  onShowMe: () => void;
  onOpenRoadmap: () => void;
  onToggleInfo: () => void;
  running: boolean;
}

const StepCardBody: React.FC<StepCardProps> = ({
  step,
  tokens: c,
  cursorIconRef,
  infoBtnRef,
  onShowMe,
  onOpenRoadmap,
  onToggleInfo,
  running,
}) => {
  // Auto-collapses on step change so a leftover overlay from step N doesn't linger into step N+1.
  const [videoExpanded, setVideoExpanded] = useState(false);
  useEffect(() => {
    setVideoExpanded(false);
  }, [step?.id]);
  if (!step) return null;
  return (
    <>
    <Box sx={{ px: 1.6, pt: 1.2, pb: 1.6 }}>
      <Typography
        sx={{
          fontSize: 16,
          fontWeight: 600,
          color: c.text.primary,
          mb: 0.4,
          fontFamily: '"Charter", Georgia, serif',
        }}
      >
        {step.title}
      </Typography>
      <Typography
        sx={{
          fontSize: 12.5,
          color: c.text.secondary,
          mb: 1.4,
          lineHeight: 1.4,
        }}
      >
        {step.description}
      </Typography>

      <Box
        onClick={step.videoSrc ? () => setVideoExpanded(true) : undefined}
        sx={{
          position: 'relative',
          borderRadius: `${c.radius.md}px`,
          overflow: 'hidden',
          aspectRatio: '16 / 9',
          mb: 1.5,
          background: `linear-gradient(135deg, ${c.accent.primary}22, ${c.accent.primary}08)`,
          border: `1px solid ${c.border.subtle}`,
          cursor: step.videoSrc ? 'zoom-in' : 'default',
          transition: 'transform 0.18s ease-out, box-shadow 0.18s ease-out',
          '&:hover': step.videoSrc
            ? {
                transform: 'scale(1.015)',
                boxShadow: `0 8px 22px ${c.accent.primary}33`,
              }
            : undefined,
        }}
      >
        {step.videoSrc ? (
          <Box
            component="video"
            src={step.videoSrc}
            autoPlay={typeof navigator === 'undefined' || !navigator.userAgent.includes('Windows')}
            muted
            loop
            playsInline
            onError={(e: React.SyntheticEvent<HTMLVideoElement>) => {
              (e.currentTarget as HTMLVideoElement).style.display = 'none';
            }}
            sx={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              // Source recordings have baked-in black side bars; scale + parent overflow:hidden crops them off.
              transform: 'scale(1.0)',
              transformOrigin: 'center',
              pointerEvents: 'none',
            }}
          />
        ) : null}
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.4,
        }}
      >
        <Button
          onClick={onShowMe}
          disabled={running}
          sx={{
            textTransform: 'none',
            bgcolor: c.accent.primary,
            color: '#fff',
            fontWeight: 600,
            fontSize: 13,
            px: 1.4,
            py: 0.55,
            borderRadius: `${c.radius.md}px`,
            boxShadow: `0 4px 12px ${c.accent.primary}40`,
            '&:hover': { bgcolor: c.accent.hover ?? c.accent.primary },
            '&.Mui-disabled': { opacity: 0.6, color: '#fff' },
            display: 'flex',
            alignItems: 'center',
            gap: 0.7,
          }}
        >
          Show me
          <Box
            component="span"
            ref={cursorIconRef}
            data-onboarding="show-me-cursor-icon"
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <CursorIconSmall color="#fff" />
          </Box>
        </Button>
        <ButtonBase
          onClick={onOpenRoadmap}
          sx={{
            fontSize: 12.5,
            fontWeight: 500,
            color: c.text.secondary,
            '&:hover': { color: c.text.primary },
          }}
        >
          See all todos
        </ButtonBase>
        <IconButton
          size="small"
          ref={infoBtnRef}
          onClick={onToggleInfo}
          sx={{
            color: c.text.tertiary,
            p: 0.4,
            ml: 'auto',
            '&:hover': { color: c.text.secondary },
          }}
          aria-label="More info"
        >
          <HelpOutlineIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>
    </Box>
    {videoExpanded && step.videoSrc
      ? createPortal(
          <Box
            onClick={() => setVideoExpanded(false)}
            sx={{
              position: 'fixed',
              inset: 0,
              bgcolor: 'rgba(0,0,0,0.78)',
              backdropFilter: 'blur(4px)',
              zIndex: 2000,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'zoom-out',
              p: 4,
            }}
          >
            <Box
              onClick={(e) => e.stopPropagation()}
              sx={{
                position: 'relative',
                width: 'min(960px, 92vw)',
                aspectRatio: '16 / 9',
                borderRadius: `${c.radius.lg}px`,
                overflow: 'hidden',
                boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
                bgcolor: '#000',
              }}
            >
              <Box
                component="video"
                src={step.videoSrc}
                autoPlay={typeof navigator === 'undefined' || !navigator.userAgent.includes('Windows')}
                muted
                loop
                playsInline
                controls
                sx={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  transform: 'scale(1.0)',
                  transformOrigin: 'center',
                  display: 'block',
                }}
              />
              <IconButton
                onClick={() => setVideoExpanded(false)}
                aria-label="Close video"
                sx={{
                  position: 'absolute',
                  top: 10,
                  right: 10,
                  bgcolor: 'rgba(0,0,0,0.55)',
                  color: '#fff',
                  '&:hover': { bgcolor: 'rgba(0,0,0,0.75)' },
                }}
              >
                <CloseIcon />
              </IconButton>
            </Box>
          </Box>,
          document.body,
        )
      : null}
    </>
  );
};

interface CelebrationProps {
  step: NonNullable<ReturnType<typeof findStepById>>;
  accent: string;
}

const CelebrationView: React.FC<CelebrationProps> = ({ step, accent }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  // Self-clearing timer fires once per celebration; cannot be cancelled by parent re-renders.
  useEffect(() => {
    const t = window.setTimeout(() => {
      dispatch(clearJustCompleted());
    }, CELEBRATION_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Box sx={{ px: 1.6, pt: 1.6, pb: 1.6 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.8 }}>
        <motion.div
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 240, damping: 16 }}
          style={{ display: 'flex' }}
        >
          <CheckCircleIcon sx={{ fontSize: 22, color: accent }} />
        </motion.div>
        <Typography
          sx={{
            fontSize: 11.5,
            fontWeight: 700,
            letterSpacing: '0.06em',
            color: accent,
            textTransform: 'uppercase',
          }}
        >
          Done
        </Typography>
      </Box>
      <Box sx={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
        <Typography
          sx={{
            fontSize: 16,
            fontWeight: 600,
            color: c.text.primary,
            fontFamily: '"Charter", Georgia, serif',
            position: 'relative',
            display: 'inline-block',
          }}
        >
          {step.title}
          <motion.span
            initial={{ width: 0 }}
            animate={{ width: '100%' }}
            transition={{ duration: 0.6, ease: 'easeOut', delay: 0.1 }}
            style={{
              position: 'absolute',
              left: 0,
              top: '52%',
              height: 2,
              background: accent,
              transformOrigin: 'left center',
            }}
          />
        </Typography>
      </Box>
      <Typography
        sx={{
          mt: 1,
          fontSize: 12,
          color: c.text.muted,
          lineHeight: 1.4,
        }}
      >
        Loading next step…
      </Typography>
    </Box>
  );
};

const AllDoneView: React.FC<{ accent: string; tokens: ReturnType<typeof useClaudeTokens> }> = ({
  accent,
  tokens: c,
}) => (
  <Box sx={{ px: 1.6, pt: 2, pb: 2, textAlign: 'center' }}>
    <motion.div
      initial={{ scale: 0.5, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 200, damping: 14 }}
      style={{ display: 'inline-flex', justifyContent: 'center' }}
    >
      <CheckCircleIcon sx={{ fontSize: 40, color: accent }} />
    </motion.div>
    <Typography
      sx={{
        mt: 1.2,
        fontSize: 16,
        fontWeight: 600,
        color: c.text.primary,
        fontFamily: '"Charter", Georgia, serif',
      }}
    >
      You're all set up
    </Typography>
    <Typography sx={{ mt: 0.4, fontSize: 12.5, color: c.text.secondary }}>
      You've finished the OpenSwarm tour. You can re-run it anytime from Settings → General.
    </Typography>
  </Box>
);

interface InfoPopoverProps {
  stepId: string;
  anchorRef: React.MutableRefObject<HTMLButtonElement | null>;
  onClose: () => void;
  tokens: ReturnType<typeof useClaudeTokens>;
}

const InfoPopover: React.FC<InfoPopoverProps> = ({ stepId, anchorRef, onClose, tokens: c }) => {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    const calc = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const POPOVER_W = 280;
      const POPOVER_H = 240;
      const top = Math.min(r.bottom + 8, window.innerHeight - POPOVER_H - 8);
      const left = Math.max(8, r.right - POPOVER_W);
      setPos({ top, left });
    };
    calc();
    window.addEventListener('resize', calc);
    return () => window.removeEventListener('resize', calc);
  }, [anchorRef]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      const pop = document.getElementById('onboarding-info-popover');
      if (pop?.contains(t)) return;
      onClose();
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [anchorRef, onClose]);

  if (!pos) return null;
  const text = INFO_BY_STEP_ID[stepId] ?? 'More information coming soon.';
  return (
    <motion.div
      id="onboarding-info-popover"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15 }}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        zIndex: 1250,
        width: 280,
      }}
    >
      <Box
        sx={{
          bgcolor: c.bg.surface,
          border: `1px solid ${c.border.medium}`,
          borderRadius: `${c.radius.md}px`,
          boxShadow: '0 14px 40px rgba(0,0,0,0.18)',
          p: 1.6,
          fontFamily: c.font.sans,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.8 }}>
          <HelpOutlineIcon sx={{ fontSize: 14, color: c.text.muted }} />
          <Typography
            sx={{
              fontSize: 11,
              fontWeight: 700,
              color: c.text.muted,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            More info
          </Typography>
        </Box>
        <Typography
          sx={{
            fontSize: 11.8,
            color: c.text.secondary,
            lineHeight: 1.55,
            whiteSpace: 'pre-line',
          }}
        >
          {text}
        </Typography>
      </Box>
    </motion.div>
  );
};

const INFO_BY_STEP_ID: Record<string, string> = {
  connect_model: `Open Swarm works with any AI model.

If you already have a subscription to ChatGPT, Claude, or Gemini, plug it directly into Open Swarm.

We also offer an Open Swarm subscription that gives you the same usage as those providers.

Or use your own API keys.`,
  enable_actions: `Actions are the capabilities available to your AI agents.

Every tool an agent uses (reading a file, sending an email, searching the web) is an action.

Every action has a permission policy. It decides whether an agent can use it on its own or whether it needs your approval first.

The Actions page is where you turn integrations on, sign in, and tune those permissions.`,
  launch_agent: `An agent in Open Swarm can do anything you can do on your computer.

It can read and write files, run commands, search the web, control a browser, send emails, manage your calendar, and handle long, multi step tasks on its own.

Think of each agent as a teammate you can brief on a task and let loose, while you watch it work in real time.`,
  use_browser: `Open Swarm has built in browsers so you never have to jump between apps. One place, one workspace, for you and your agents.

The browsers aren't just for you. Your agents can use them too. By default an agent can spin up and use its own browser whenever it needs one.

In the next step we'll see how to hand off a browser you're using to an agent.`,
  agent_use_browser: `This shows how to give an agent control of a browser already on your canvas. Agents can also spin up their own browsers whenever they need one.

In this demo you handed off a single browser, but you can also hand off multiple browsers at once.

Under the hood, each browser is run by its own specialized agent that talks back to the agent you handed it to.`,
  agent_control_agents: `Just like browsers, you can pick which agents work together. Or an agent can spin up its own helpers whenever it needs to.

When a task gets too big for one agent, it spins up sub agents to share the load.

When a sub agent finishes, it collapses back into its parent. You can always reopen it from the parent chat by clicking "Reveal in dashboard".`,
  install_skill: `An agent on its own is a strong general purpose reasoner. It can do a lot, but it doesn't know the specifics of your workflows, your output formats, or your domain.

Skills fill that gap.

A skill is a set of instructions that teach an agent how to handle a specific kind of task. When a skill is active, the agent follows its guidance and produces better, more consistent results in that area.`,
  make_app: `Apps are interactive, AI generated web applications that live inside OpenSwarm.

Instead of paying for software or spending weeks building a UI, you describe what you want and an agent writes it for you. A live, runnable app appears in seconds.

Once it's made, you can pop the App into your canvas alongside agents and browsers.`,
};

export default OnboardingPanel;
