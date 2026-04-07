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
    target: 'sidebar-prompts',
    title: 'Saved Prompts',
    description: 'Save message templates you use often \u2014 like email formats, report structures, or frequently asked questions.',
    placement: 'right',
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
    title: "You're all set!",
    description: 'Start chatting with your AI assistants. Explore your workspace, connect your tools, and make it yours.',
    placement: 'bottom',
    centerOverlay: true,
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
      setTooltipPos({ top: window.innerHeight / 2 - 100, left: window.innerWidth / 2 - 180 });
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
          width: 320,
          bgcolor: c.bg.surface,
          border: `1px solid ${c.border.medium}`,
          borderRadius: `${c.radius.xl}px`,
          boxShadow: '0 16px 48px rgba(0,0,0,0.35)',
          p: 2.5,
          transition: 'top 0.4s cubic-bezier(0.4, 0, 0.2, 1), left 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s',
          opacity: visible ? 1 : 0,
          pointerEvents: 'auto',
          zIndex: 10000,
        }}
      >
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
              '&:hover': { bgcolor: c.bg.hover || 'rgba(255,255,255,0.05)' },
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
      </Box>
    </Box>
  );
};

export default OnboardingWalkthrough;
