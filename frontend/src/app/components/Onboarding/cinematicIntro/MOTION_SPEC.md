# Cinematic Intro: build-ready motion spec

A first-launch cold-open for OpenSwarm, modeled on Arc's welcome cinematic but in our warm
palette and compressed to respect "quicker is better." Measured from the real Arc Mac Welcome
Intro (digigamer capture `5LcrfMiUvmo`): frame-stepped timings + canvas pixel samples, then
re-skinned to our tokens. This is the reference an engineer (or a later coding pass) implements
directly. No vibe-coding: every duration, easing, and color below is pinned.

## North star

The OpenSwarm orb is born on a warm-black field, blooms into a warm ember gradient, becomes our
logo, the headline cascades in word by word, then the whole layer dissolves into the first tile
screen ("Tap one and watch."). It plays ONCE on first launch, is always skippable, and doubles as
cover for the backend + 9router cold boot (it is renderer-only, so it runs while they come up).

The emotional beat is Arc's. The skin, the timing, and the payoff are ours. Do not copy Arc's blue;
that would read as a clone.

## Hard constraints (read before building)

- **In-window, not a desktop overlay.** Arc dims the whole macOS desktop with a borderless
  always-on-top transparent window. We do NOT. On first launch our window already fills the screen,
  so the cinematic plays inside a warm-black layer in our own renderer. This is the only choice that
  works identically on the signed DMG and the EXE, and it sidesteps every transparent-window /
  multi-monitor / packaged-build footgun. (A mac-only true desktop-dim is a possible later flourish,
  explicitly out of scope for v1.)
- **No new WebGL context.** Our existing `PixelBlast` WebGL2 surface is implicated in the GPU-process
  crash class (context churn). Cold launch, while the backend is still booting, is the worst moment
  to light up another GL context. The orb and the gradient are CSS (radial-gradients + transform +
  filter) or, at most, a cheap `<video>` WebM decode. Never a shader here.
- **Renderer-only + gated + skippable.** Mounts before/over the dashboard, gated on a one-time
  `cinematicShown` flag. Any pointerdown / keydown / Esc jumps straight to the handoff. Hard cap the
  whole thing at ~5.2s so a returning-feeling user is never trapped.
- **Reduced motion is a first-class path,** not an afterthought. `useReducedMotion()` (the existing
  hook) collapses the entire sequence to a single 220ms fade from black to the headline+tiles, with
  no orb, no scale, no blur. Pair every animated value with this.
- **No em/en dashes anywhere in shipped copy or code.** House rule.

## Master timeline (ours: ~5.2s, skippable)

Compressed from Arc's ~9s (one-time brand moments can afford 9s; an app cold-open should not), same
proportions and feel. `t` is seconds from mount. Phases overlap on purpose.

| Phase | t (s) | Layer | What happens | Duration | Easing |
| --- | --- | --- | --- | --- | --- |
| 0 Black hold | 0.00 to 0.20 | canvas | Warm-black fills the window. Nothing else. | 200ms | (none) |
| 1 Orb birth | 0.20 to 0.60 | orb | Orb fades in dead-center, tiny (scale 0.18), warm glow. | 400ms | `EASE.out` |
| 2 Orb bloom | 0.60 to 2.40 | orb | Orb scales 0.18 -> 1.0, glow intensifies, faint breathing. The slow bloom IS the feeling; do not rush it. | 1800ms | `cubic-bezier(0.33, 0, 0.2, 1)` (gentle, slow-in slow-out) |
| 3 Bloom to surface | 2.40 to 3.40 | orb -> card | Orb expands past its own edge and dissolves into the warm ember mesh gradient (the "card"). OpenSwarm logo fades in at center as the orb resolves. | 1000ms | `EASE.out` |
| 4 Text cascade | 3.20 to 4.60 | text | Logo cross-fades out as the headline reveals word by word (overlaps phase 3 by 200ms so it never feels sequential). | ~1400ms total | per-word `EASE.out` + micro-spring |
| 5 Settle + handoff | 4.60 to 5.20 | whole layer | Headline holds ~400ms, then the entire cinematic layer cross-dissolves into the first tile screen. | 600ms (200ms hold + 400ms dissolve) | `EASE.inOut` |

Skip at any point: cancel running transitions, jump to phase 5's dissolve from wherever you are
(never a hard cut; always the 400ms cross-dissolve so a skip still feels designed).

## Color: warm palette (mapped from Arc's measured blues)

Arc's measured values on the left (ground truth from canvas sampling), our warm equivalents on the
right. All ours are anchored to `claudeTokens` (`accent.*`, `bg.*`) so they stay on-brand; the few
extra ember/gold stops are cinematic-only and live in this component, not in the global tokens.

| Role | Arc (measured) | Ours (warm) | Source |
| --- | --- | --- | --- |
| Canvas (dimmed field) | near-black `#151203` | warm-black `#0F0D0B` | cinematic-local |
| Orb core | `#5354F2` periwinkle | amber `#F0B070` | cinematic-local |
| Orb glow | `#6772F8` | terracotta `#C4633A` | `accent.hover` |
| Gradient darkest corner | `#2B36C3` indigo | deep ember `#2B1509` | cinematic-local |
| Gradient mid | `#4D57FB` | `#AE5630` | `accent.primary` |
| Gradient bright bloom | `#575CEE` | `#D47548` | `accent` dark-hover |
| Gradient hottest point | (brightest periwinkle) | warm gold `#E0925A` | cinematic-local |
| Headline text | `#FFFFFF` | warm white `#FAF9F5` | `text.primary` (dark) |
| CTA / arrow glyph | indigo on frost | `#5C2E18` on `rgba(250,249,245,0.9)` | derived |

The gradient is a **mesh**, not a linear ramp: deep-ember corners with terracotta + amber light
blooms drifting through the middle. Build it as 3 to 4 layered `radial-gradient`s (see snippet),
slowly drifting via `transform: translate3d`, so it reads as living light, not a flat fill. A 6 to
10s ease-in-out loop on the drift is plenty; it only needs to breathe for the ~2s it is on screen.

## Layer specs

### Orb (CSS, no WebGL)

A single `<div>`: a radial-gradient from `#F0B070` (core) through `#C4633A` (glow) to transparent,
plus a `filter: blur(...)` for softness and a `box-shadow` bloom. Animate `scale`, `opacity`, and
glow `blur` only (all GPU-cheap, compositor-friendly). No layout, no repaint.

```ts
// orb birth + bloom (framer-motion)
const orb = {
  hidden: { scale: 0.18, opacity: 0, filter: 'blur(8px)' },
  bloom: {
    scale: 1.0,
    opacity: 1,
    filter: 'blur(0px)',
    transition: {
      scale:   { duration: 1.8, ease: [0.33, 0, 0.2, 1] }, // gentle slow bloom
      opacity: { duration: 0.4, ease: EASE_OUT },
      filter:  { duration: 1.0, ease: EASE_OUT },
    },
  },
};
```

A faint "breathing" while it blooms (scale 1.0 <-> 1.03, 1.5s, `EASE.pulse`) adds life; keep it
subtle or it looks like a loading spinner.

### Surface / mesh gradient (CSS)

```ts
// warm ember mesh: layered radial-gradients on a deep-ember base, slow drift
const meshBackground = `
  radial-gradient(60% 70% at 72% 18%, #E0925A 0%, transparent 60%),
  radial-gradient(70% 80% at 28% 88%, #D47548 0%, transparent 62%),
  radial-gradient(90% 90% at 50% 50%, #AE5630 0%, transparent 70%),
  linear-gradient(140deg, #2B1509 0%, #3A1C0E 100%)
`;
// drift: animate a wrapper's transform translate3d(±2%, ±2%) over 8s, EASE.inOut, alternate
```

The orb in phase 3 grows past its own radius and its glow becomes the brightest bloom of this mesh,
so the dissolve from orb to surface is a continuous brightening, not a swap.

### Headline text cascade (the signature)

Arc's signature is a per-word reveal with a **horizontal motion-blur streak** that resolves to
sharp. Plain CSS `filter: blur()` is isotropic (blurs all directions equally), which is the cheap,
acceptable fallback. For the authentic directional streak, drive an SVG filter whose
`feGaussianBlur stdDeviation` animates from `"14 0"` (x-only blur) to `"0 0"`. Decide per the
fidelity bar; spec both.

Split the headline into words (not characters; Arc reveals word-by-word, and per-char is too busy
for our shorter line). Each word is a motion child:

```ts
const line = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 3.2 } },
};
const word = {
  hidden: { opacity: 0, y: 10, x: -6, filter: 'blur(12px)' },
  show: {
    opacity: 1, y: 0, x: 0, filter: 'blur(0px)',
    transition: {
      duration: 0.42,
      ease: EASE_OUT,
      y: { type: 'spring', stiffness: 320, damping: 26 }, // micro-spring on settle
    },
  },
};
```

- **Stagger:** 90ms per word (`staggerChildren: 0.09`).
- **Per-word duration:** 420ms.
- **Transform:** rise `y: 10 -> 0`, slight left-drift `x: -6 -> 0` (the horizontal motion), `blur 12 -> 0`, `opacity 0 -> 1`.
- **Font:** `font.sans` token ("Anthropic Sans"), weight 700, tight tracking (-0.01em to -0.02em),
  two centered lines. Color `#FAF9F5`. Generous line-height (1.05) like Arc's display lockup.

**Copy (proposed, product to confirm):** headline `Meet your AI team.` (two lines:
"Meet your" / "AI team."), which sets up the tile screen's "Tap one and watch." Mark as placeholder;
copy is a product call, not a motion call.

### Handoff to tiles (phase 5)

The cinematic layer is a single absolutely-positioned overlay above the dashboard/welcome screen.
On complete (natural or skip): animate the overlay `opacity 1 -> 0` over 400ms `EASE.inOut` while
the tile screen underneath is already mounted at `opacity 0 -> 1`. The orb/headline do not animate
out individually; the whole layer cross-dissolves as one. Net effect: the headline melts and the
tiles are already there.

## Integration points

- **New component** `cinematicIntro/CinematicIntro.tsx` (this folder). Props:
  `{ onComplete: () => void }`. Self-contained: owns its own timeline + skip handling, calls
  `onComplete` once.
- **Mount** from `OnboardingRoot` (or `Main`) on first launch only, rendered as a fixed full-window
  overlay above everything, before the welcome-draft/tile screen takes focus.
- **One-time flag** `cinematicShown: boolean` in `onboardingProgressSlice` (localStorage-persisted,
  same store as `welcomeShown`). Gate mount on `!cinematicShown`; set true on `onComplete`. A user
  who has seen it never sees it again (and returning users never do).
- **Skip:** a window-level `pointerdown` + `keydown` (Esc / any key) listener installed on mount,
  removed on complete. Fires the same `onComplete` path (which runs the 400ms dissolve, never a cut).
- **onComplete** hands off to the existing welcome surface (the tile screen / welcome-draft). The
  cinematic does NOT spawn agents or hit the network; it is pure choreography. The first real action
  is still the user's tile tap, downstream of this.

## Performance, packaging, accessibility

- **Cold-boot cover:** the cinematic is renderer-only and starts at first paint, so it plays during
  the ~2 to 4s backend (`:8324`) + 9router spin-up. This replaces a startup spinner with brand. Do
  not block the cinematic on any backend readiness; they are independent.
- **GPU:** CSS transforms/filters + opacity only; all compositor-friendly. No WebGL, no layout
  thrash. If a `<video>` WebM is ever introduced for the gradient, it is a decode (cheap), still not
  a GL context. Default recommendation for v1: pure CSS, zero video assets, crisp at any DPI.
- **Packaged build:** because it is in-window web tech with no transparent overlay and no native
  bits, one implementation runs identically on the DMG and the EXE. Still smoke it on a packaged
  build per house rule, but there is no dev-vs-prod path divergence by construction.
- **Reduced motion** (`useReducedMotion()` true): skip phases 0 to 4 entirely. Render the warm
  gradient + headline + tiles immediately, fade the layer in over 220ms (`DURATION_MS.standard`),
  then the same handoff. No orb, no scale, no blur, no per-word stagger.
- **Tokens:** reuse `DURATION_MS` / `EASE` from `motionTokens.ts` (`EASE_OUT = EASE.out`,
  `EASE.inOut`, `EASE.pulse`). The two custom values this spec adds are the gentle bloom curve
  `cubic-bezier(0.33, 0, 0.2, 1)` and the spring `{ stiffness: 320, damping: 26 }`; keep them local
  to this component unless they prove reusable.

## What is measured vs proposed

- **Measured from Arc (ground truth):** the 5-phase structure, the slow-orb-then-bloom feel, the
  per-word horizontal-blur cascade, the mesh (not linear) gradient, and the source blue color values
  used for the warm re-map.
- **Proposed (our calls, change freely):** the ~5.2s compressed durations, the exact warm hex stops,
  the headline copy, word-level (not char-level) split, and the in-window (not desktop-dim) decision.

## Open questions for product

1. Headline copy + whether it is one line or two.
2. ~5.2s vs even tighter (~4s) for the cold-open. (Recommendation: 5.2s once, skippable.)
3. Directional SVG-blur streak (authentic, slightly more code) vs isotropic CSS blur (cheaper).
4. Does the orb resolve into the OpenSwarm wordmark, the glyph only, or straight to the headline?
