// Animation timing/easing tokens. Pair with useReducedMotion() for OS "Reduce motion".

export const DURATION_MS = {
  /** 60ms: hover, subtle press feedback. */
  instant: 60,
  /** 140ms: row fade, popover/tooltip open, status pill swap. */
  quick: 140,
  /** 220ms: modal open, page transitions, banners. */
  standard: 220,
  /** 400ms: drawer slide, big layout shifts. */
  slow: 400,
  /** 1500ms: skeleton pulse + ambient breathing. */
  ambient: 1500,
} as const;

export const EASE = {
  /** Linear-style snappy out, gentle settle; good default for things appearing. */
  out: 'cubic-bezier(0.16, 1, 0.3, 1)',
  /** Material symmetric; for two-way motion. */
  inOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
  /** Subtle bounce; use sparingly. */
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  /** Gentle breathing curve. */
  pulse: 'cubic-bezier(0.4, 0, 0.6, 1)',
} as const;

/** Array-form easing for framer-motion; same curves as EASE. */
export const FRAMER_EASE = {
  out: [0.16, 1, 0.3, 1] as [number, number, number, number],
  inOut: [0.4, 0, 0.2, 1] as [number, number, number, number],
  spring: [0.34, 1.56, 0.64, 1] as [number, number, number, number],
  pulse: [0.4, 0, 0.6, 1] as [number, number, number, number],
};

/** Shared fadeIn keyframe; import once. */
export const fadeInKeyframes = {
  '@keyframes openswarmFadeIn': {
    from: { opacity: 0 },
    to: { opacity: 1 },
  },
};

/** Shared skeleton/indicator pulse keyframe. */
export const pulseKeyframes = {
  '@keyframes openswarmPulse': {
    '0%, 100%': { opacity: 0.5 },
    '50%': { opacity: 0.25 },
  },
};
