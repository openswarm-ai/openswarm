// Single source of truth for animation timing + easing across the app.
// Mixing one-off durations / curves makes the chrome feel like several
// different products glued together; tokenizing makes everything land
// the same way.
//
// Pair with `useReducedMotion()` to respect OS-level "Reduce motion".

export const DURATION_MS = {
  /** 60ms — hover state changes, subtle press feedback */
  instant: 60,
  /** 140ms — rows fading in, popovers, tooltip open, status pill swaps */
  quick: 140,
  /** 220ms — modal open, page transitions, banners */
  standard: 220,
  /** 400ms — drawer slide, big layout shifts */
  slow: 400,
  /** 1500ms — skeleton pulse + ambient breathing indicators */
  ambient: 1500,
} as const;

export const EASE = {
  /** Linear's signature curve. Snappy out, gentle settle. Good default for "thing appears". */
  out: 'cubic-bezier(0.16, 1, 0.3, 1)',
  /** MUI / Material default. Symmetric — for things that move both directions. */
  inOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
  /** Subtle bounce at the end. Use sparingly for delight moments. */
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  /** Gentle breathing curve for ambient pulses. */
  pulse: 'cubic-bezier(0.4, 0, 0.6, 1)',
} as const;

/** Framer-motion uses array-form easing. Same curves as EASE above. */
export const FRAMER_EASE = {
  out: [0.16, 1, 0.3, 1] as [number, number, number, number],
  inOut: [0.4, 0, 0.2, 1] as [number, number, number, number],
  spring: [0.34, 1.56, 0.64, 1] as [number, number, number, number],
  pulse: [0.4, 0, 0.6, 1] as [number, number, number, number],
};

/** Module-scoped fadeIn keyframe. Imported once instead of redefined inline at each callsite. */
export const fadeInKeyframes = {
  '@keyframes openswarmFadeIn': {
    from: { opacity: 0 },
    to: { opacity: 1 },
  },
};

/** Skeleton + indicator pulse keyframe. Imported once. */
export const pulseKeyframes = {
  '@keyframes openswarmPulse': {
    '0%, 100%': { opacity: 0.5 },
    '50%': { opacity: 0.25 },
  },
};
