import React, { useState, useEffect, useCallback, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { trackEvent } from '@/shared/analytics';

export interface WalkthroughStep {
  target: string;                               // data-onboarding="<value>" selector
  title: string;
  description: string;
  placement: 'top' | 'bottom' | 'left' | 'right';
  actionHint?: string;                          // e.g. "Click the + button"
  waitForTarget?: boolean;                      // pause until target appears in DOM
  centerOverlay?: boolean;                      // no spotlight, show card in center
}

const STEPS: WalkthroughStep[] = [
  {
    target: 'agent-card',
    title: 'This is an AI conversation',
    description: 'Each card is a chat with AI. You can ask questions, get help writing, research topics, or have it browse the web for you.',
    placement: 'right',
    actionHint: 'Click it to open',
  },
  {
    target: 'new-agent-button',
    title: 'Start a new conversation',
    description: 'Click here to create a new AI assistant. You can have multiple conversations running at the same time, side by side.',
    placement: 'top',
    actionHint: 'Try clicking the + button below',
  },
  {
    target: 'browser-button',
    title: 'Browse the web',
    description: 'Open a web browser right inside your workspace. Your AI assistants can see and interact with any website.',
    placement: 'top',
  },
  {
    target: 'canvas-controls',
    title: 'Navigate your workspace',
    description: 'Scroll to zoom in and out. Drag the background to pan around. Click any card to focus on it.',
    placement: 'top',
  },
  {
    target: 'sidebar-skills',
    title: 'Skills',
    description: 'Browse and install ready-made workflows \u2014 no coding needed. Skills teach your AI new abilities.',
    placement: 'right',
  },
  {
    target: 'sidebar-actions',
    title: 'Connect Your Tools',
    description: 'Link Google Docs, Notion, Reddit, and more. Your AI assistants can read, write, and interact with your favorite apps.',
    placement: 'right',
  },
  {
    target: 'sidebar-modes',
    title: 'Assistant Types',
    description: 'Customize how your AI behaves. Create specialized assistants for writing, research, coding, or any task.',
    placement: 'right',
  },
  {
    target: 'sidebar-apps',
    title: 'Build Mini Apps',
    description: 'Create simple apps powered by AI \u2014 dashboards, forms, data tools. Just describe what you want.',
    placement: 'right',
  },
  {
    target: '',
    title: 'Try your first task',
    description: "OpenSwarm is most useful when you give it something real. Open a new chat and try one of these:",
    placement: 'bottom',
    centerOverlay: true,
  },
];

const EXAMPLE_PROMPTS: { emoji: string; label: string; prompt: string }[] = [
  {
    emoji: '🔎',
    label: 'Research a topic',
    prompt: 'Research the latest developments in AI agents and give me a short briefing',
  },
  {
    emoji: '🛠️',
    label: 'Build a mini app',
    prompt: 'Build me a simple habit tracker with a clean UI',
  },
  {
    emoji: '📄',
    label: 'Summarize a webpage',
    prompt: 'Browse https://news.ycombinator.com and summarize the top 5 stories',
  },
];

interface Props {
  onComplete: () => void;
}

interface SpotlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const OnboardingWalkthrough: React.FC<Props> = ({ onComplete }) => {
  const c = useClaudeTokens();
  const [currentStep, setCurrentStep] = useState(0);
  const [spotlightRect, setSpotlightRect] = useState<SpotlightRect | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [visible, setVisible] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number | null>(null);

  const step = STEPS[currentStep];
  const totalSteps = STEPS.length;
  const isLastStep = currentStep === totalSteps - 1;

  // Track walkthrough start on mount
  useEffect(() => {
    trackEvent('walkthrough.started');
  }, []);

  // Track each step viewed
  useEffect(() => {
    if (step) {
      trackEvent('walkthrough.step_viewed', { step: currentStep, step_name: step.target || 'done' });
    }
  }, [currentStep, step]);

  // Find target element and compute spotlight + tooltip position
  const updatePosition = useCallback(() => {
    if (!step) return;

    if (step.centerOverlay) {
      setSpotlightRect(null);
      const isAnnouncement = currentStep === STEPS.length - 1;
      const w = isAnnouncement ? 600 : 320;
      const h = isAnnouncement ? 640 : 200;
      setTooltipPos({
        top: Math.max(24, window.innerHeight / 2 - h / 2),
        left: Math.max(24, window.innerWidth / 2 - w / 2),
      });
      setVisible(true);
      return;
    }

    const el = (
      document.querySelector(`[data-onboarding="${step.target}"]`) ||
      document.querySelector(`[data-select-type="${step.target}"]`)
    ) as HTMLElement | null;
    if (!el) {
      if (step.waitForTarget) {
        // Retry next frame
        animFrameRef.current = requestAnimationFrame(updatePosition);
        return;
      }
      // Skip this step if target not found
      if (currentStep < totalSteps - 1) {
        setCurrentStep((s) => s + 1);
      }
      return;
    }

    const rect = el.getBoundingClientRect();
    const pad = 8;
    const sr: SpotlightRect = {
      top: rect.top - pad,
      left: rect.left - pad,
      width: rect.width + pad * 2,
      height: rect.height + pad * 2,
    };
    setSpotlightRect(sr);

    // Position tooltip relative to spotlight
    const tooltipW = 320;
    const tooltipH = 180;
    const gap = 16;
    let tp = { top: 0, left: 0 };

    // If target is in the lower half of the screen, anchor the tooltip at a
    // fixed center-upper position so it doesn't shift between toolbar steps.
    const isBottomTarget = sr.top > window.innerHeight * 0.5;
    if (isBottomTarget) {
      tp = {
        top: Math.round(window.innerHeight * 0.35),
        left: Math.round(window.innerWidth / 2 - tooltipW / 2),
      };
    } else {
      switch (step.placement) {
        case 'right':
          tp = { top: sr.top + sr.height / 2 - tooltipH / 2, left: sr.left + sr.width + gap };
          break;
        case 'left':
          tp = { top: sr.top + sr.height / 2 - tooltipH / 2, left: sr.left - tooltipW - gap };
          break;
        case 'top':
          tp = { top: sr.top - tooltipH - gap, left: sr.left + sr.width / 2 - tooltipW / 2 };
          break;
        case 'bottom':
          tp = { top: sr.top + sr.height + gap, left: sr.left + sr.width / 2 - tooltipW / 2 };
          break;
      }
    }

    // Final clamp
    tp.left = Math.max(8, Math.min(tp.left, window.innerWidth - tooltipW - 8));
    tp.top = Math.max(8, Math.min(tp.top, window.innerHeight - tooltipH - 8));

    setTooltipPos(tp);
    setVisible(true);
  }, [step, currentStep, totalSteps]);

  useEffect(() => {
    // Don't toggle visibility between steps — that fades the dark overlay out
    // and back in, briefly showing the bright dashboard underneath (the "white
    // flash"). Just update positions and let the existing CSS transitions
    // smoothly animate the spotlight and tooltip to their new locations.
    const timer = setTimeout(updatePosition, 0);
    return () => {
      clearTimeout(timer);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [currentStep, updatePosition]);

  // Recompute on resize
  useEffect(() => {
    const onResize = () => updatePosition();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [updatePosition]);

  const handleNext = useCallback(() => {
    if (isLastStep) {
      trackEvent('walkthrough.completed', { steps_viewed: currentStep + 1 });
      onComplete();
    } else {
      setCurrentStep((s) => s + 1);
    }
  }, [isLastStep, onComplete, currentStep]);

  const handleBack = useCallback(() => {
    setCurrentStep((s) => Math.max(0, s - 1));
  }, []);

  const handleSkip = useCallback(() => {
    trackEvent('walkthrough.skipped', { step: currentStep, step_name: step?.target || 'done' });
    onComplete();
  }, [onComplete, currentStep, step]);

  const handleStartFirstChat = useCallback((example?: { label: string; prompt: string }) => {
    trackEvent('walkthrough.first_chat_started', { example: example?.label || 'cta' });
    if (example?.prompt) {
      try {
        sessionStorage.setItem('openswarm_first_prompt', example.prompt);
      } catch {}
    } else {
      try {
        sessionStorage.removeItem('openswarm_first_prompt');
      } catch {}
    }
    onComplete();
    setTimeout(() => {
      const btn = document.querySelector(
        '[data-onboarding="new-agent-button"]',
      ) as HTMLElement | null;
      btn?.click();
    }, 150);
  }, [onComplete]);

  // Allow clicking the spotlight target to advance for action steps
  useEffect(() => {
    if (!step?.actionHint || step.centerOverlay) return;

    const el = (
      document.querySelector(`[data-onboarding="${step.target}"]`) ||
      document.querySelector(`[data-select-type="${step.target}"]`)
    ) as HTMLElement | null;
    if (!el) return;

    const handler = () => {
      trackEvent('walkthrough.step_action', { step: currentStep, step_name: step.target });
      setTimeout(() => handleNext(), 300);
    };
    el.addEventListener('click', handler, { once: true });
    return () => el.removeEventListener('click', handler);
  }, [step, handleNext]);

  if (!step) return null;

  // SVG mask for spotlight cutout
  const clipPath = spotlightRect
    ? `polygon(
        0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
        ${spotlightRect.left}px ${spotlightRect.top}px,
        ${spotlightRect.left}px ${spotlightRect.top + spotlightRect.height}px,
        ${spotlightRect.left + spotlightRect.width}px ${spotlightRect.top + spotlightRect.height}px,
        ${spotlightRect.left + spotlightRect.width}px ${spotlightRect.top}px,
        ${spotlightRect.left}px ${spotlightRect.top}px
      )`
    : undefined;

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        transition: 'opacity 0.3s ease',
        opacity: visible ? 1 : 0,
        pointerEvents: 'none',
      }}
    >
      {/* Dark overlay with spotlight cutout — clicks pass through the cutout */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          bgcolor: 'rgba(0, 0, 0, 0.65)',
          clipPath: clipPath || 'none',
          transition: 'clip-path 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
        onClick={handleNext}
      />

      {/* Spotlight ring glow */}
      {spotlightRect && (
        <Box
          sx={{
            position: 'absolute',
            top: spotlightRect.top - 2,
            left: spotlightRect.left - 2,
            width: spotlightRect.width + 4,
            height: spotlightRect.height + 4,
            borderRadius: '12px',
            border: `2px solid ${c.accent.primary}`,
            boxShadow: `0 0 20px ${c.accent.primary}40, inset 0 0 20px ${c.accent.primary}10`,
            pointerEvents: 'none',
            transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        />
      )}

      {/* Tooltip card */}
      <Box
        ref={tooltipRef}
        sx={{
          position: 'absolute',
          top: tooltipPos.top,
          left: tooltipPos.left,
          width: isLastStep ? 600 : 320,
          bgcolor: c.bg.surface,
          border: `1px solid ${c.border.medium}`,
          borderRadius: `${c.radius.xl}px`,
          boxShadow: '0 16px 48px rgba(0,0,0,0.35)',
          p: isLastStep ? 0 : 2.5,
          overflow: 'hidden',
          transition: 'top 0.4s cubic-bezier(0.4, 0, 0.2, 1), left 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s',
          opacity: visible ? 1 : 0,
          pointerEvents: 'auto',
          zIndex: 10000,
        }}
      >
        {isLastStep ? (
          <>
            {/* Hero image area — soft pastel multi-color blob */}
            <Box
              sx={{
                position: 'relative',
                width: '100%',
                height: 320,
                background: `
                  radial-gradient(circle at 18% 78%, #F5A574 0%, rgba(245,165,116,0) 48%),
                  radial-gradient(circle at 58% 55%, #E9A5D0 0%, rgba(233,165,208,0) 52%),
                  radial-gradient(circle at 82% 22%, #B9C9F4 0%, rgba(185,201,244,0) 58%),
                  linear-gradient(135deg, #C4D0F2 0%, #EDB3CC 50%, #F5B088 100%)
                `,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
              <Typography
                sx={{
                  position: 'relative',
                  zIndex: 2,
                  fontSize: 72,
                  color: '#fff',
                  filter: 'drop-shadow(0 4px 16px rgba(0,0,0,0.18))',
                  lineHeight: 1,
                }}
              >
                ✦
              </Typography>
            </Box>

            <Box sx={{ p: 2.25 }}>
              {/* Step counter dots */}
              <Box sx={{ display: 'flex', gap: 0.5, mb: 1.25, justifyContent: 'center' }}>
                {STEPS.map((_, i) => (
                  <Box
                    key={i}
                    sx={{
                      width: i === currentStep ? 14 : 4,
                      height: 4,
                      borderRadius: 3,
                      bgcolor: i === currentStep ? c.accent.primary : i < currentStep ? c.accent.primary + '60' : c.border.medium,
                      transition: 'all 0.3s',
                    }}
                  />
                ))}
              </Box>

              <Box
                sx={{
                  display: 'inline-block',
                  fontSize: '0.58rem',
                  fontWeight: 700,
                  color: c.accent.primary,
                  bgcolor: c.accent.primary + '1f',
                  px: 0.85,
                  py: 0.2,
                  borderRadius: `${c.radius.xs}px`,
                  letterSpacing: '0.5px',
                  mb: 0.75,
                  fontFamily: c.font.sans,
                }}
              >
                READY TO TRY
              </Box>

              <Typography
                sx={{
                  fontSize: '0.92rem',
                  fontWeight: 700,
                  color: c.text.primary,
                  mb: 0.35,
                  fontFamily: c.font.sans,
                }}
              >
                {step.title}
              </Typography>

              <Typography
                sx={{
                  fontSize: '0.72rem',
                  color: c.text.secondary,
                  lineHeight: 1.45,
                  mb: 1.25,
                  fontFamily: c.font.sans,
                }}
              >
                {step.description}
              </Typography>

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mb: 1.5 }}>
                {EXAMPLE_PROMPTS.map((ex) => (
                  <Box
                    key={ex.label}
                    onClick={() => handleStartFirstChat(ex)}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1,
                      px: 1,
                      py: 0.75,
                      borderRadius: `${c.radius.md}px`,
                      border: `1px solid ${c.border.subtle}`,
                      bgcolor: c.bg.elevated || c.bg.surface,
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      '&:hover': {
                        borderColor: c.accent.primary,
                        bgcolor: c.accent.primary + '10',
                        transform: 'translateX(2px)',
                      },
                    }}
                  >
                    <Box sx={{ fontSize: '0.95rem', lineHeight: 1 }}>{ex.emoji}</Box>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontSize: '0.72rem', fontWeight: 600, color: c.text.primary, fontFamily: c.font.sans }}>
                        {ex.label}
                      </Typography>
                      <Typography sx={{ fontSize: '0.64rem', color: c.text.tertiary, fontFamily: c.font.sans, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {ex.prompt}
                      </Typography>
                    </Box>
                    <Typography sx={{ fontSize: '0.8rem', color: c.text.tertiary, fontFamily: c.font.sans }}>→</Typography>
                  </Box>
                ))}
              </Box>

              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Button
                  onClick={handleSkip}
                  sx={{
                    textTransform: 'none',
                    fontSize: '0.72rem',
                    fontWeight: 600,
                    color: c.text.tertiary,
                    borderRadius: `${c.radius.md}px`,
                    px: 1.25,
                    py: 0.5,
                    fontFamily: c.font.sans,
                    '&:hover': { bgcolor: 'rgba(255,255,255,0.05)' },
                  }}
                >
                  Not now
                </Button>
                <Button
                  onClick={() => handleStartFirstChat()}
                  sx={{
                    textTransform: 'none',
                    fontSize: '0.72rem',
                    fontWeight: 600,
                    bgcolor: c.accent.primary,
                    color: '#fff',
                    borderRadius: `${c.radius.md}px`,
                    px: 2,
                    py: 0.5,
                    fontFamily: c.font.sans,
                    '&:hover': { bgcolor: c.accent.hover || c.accent.primary },
                  }}
                >
                  Start a new chat
                </Button>
              </Box>
            </Box>
          </>
        ) : (
          <>
        {/* Step counter dots */}
        <Box sx={{ display: 'flex', gap: 0.5, mb: 1.5, justifyContent: 'center' }}>
          {STEPS.map((_, i) => (
            <Box
              key={i}
              sx={{
                width: i === currentStep ? 16 : 5,
                height: 5,
                borderRadius: 3,
                bgcolor: i === currentStep ? c.accent.primary : i < currentStep ? c.accent.primary + '60' : c.border.medium,
                transition: 'all 0.3s',
              }}
            />
          ))}
        </Box>

        <Typography
          sx={{
            fontSize: '1rem',
            fontWeight: 700,
            color: c.text.primary,
            mb: 0.75,
            fontFamily: c.font.sans,
          }}
        >
          {step.title}
        </Typography>

        <Typography
          sx={{
            fontSize: '0.82rem',
            color: c.text.secondary,
            lineHeight: 1.5,
            mb: step.actionHint ? 1 : 2,
            fontFamily: c.font.sans,
          }}
        >
          {step.description}
        </Typography>

        {step.actionHint && (
          <Typography
            sx={{
              fontSize: '0.72rem',
              color: c.accent.primary,
              fontWeight: 600,
              mb: 2,
              fontFamily: c.font.sans,
            }}
          >
            {step.actionHint}
          </Typography>
        )}

        {/* Buttons */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button
            onClick={handleBack}
            disabled={currentStep === 0}
            sx={{
              textTransform: 'none',
              fontSize: '0.82rem',
              fontWeight: 600,
              color: c.text.tertiary,
              borderRadius: `${c.radius.md}px`,
              px: 2,
              py: 0.75,
              fontFamily: c.font.sans,
              visibility: currentStep === 0 || step.target === 'new-agent-button' ? 'hidden' : 'visible',
              '&:hover': { bgcolor: 'rgba(255,255,255,0.05)' },
            }}
          >
            Back
          </Button>
          <Button
            onClick={handleNext}
            sx={{
              textTransform: 'none',
              fontSize: '0.82rem',
              fontWeight: 600,
              bgcolor: c.accent.primary,
              color: '#fff',
              borderRadius: `${c.radius.md}px`,
              px: 2.5,
              py: 0.75,
              fontFamily: c.font.sans,
              '&:hover': { bgcolor: c.accent.hover || c.accent.primary },
            }}
          >
            {isLastStep ? 'Get Started' : 'Next'}
          </Button>
        </Box>
          </>
        )}
      </Box>
    </Box>
  );
};

export default OnboardingWalkthrough;
