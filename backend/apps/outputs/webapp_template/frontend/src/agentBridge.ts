// window.OPENSWARM_APP - the agent bridge, shipped with the template so it
// EXISTS from first paint, before any app-specific code runs (index.tsx imports
// this first). An app makes itself agent-operable by calling
// window.OPENSWARM_APP.register({ rules, controls, getState, invoke }) on mount;
// it never has to wire up the plumbing, so it cannot forget it. Until the app
// registers, describe()/getState() report { __ready: false } so the agent knows
// the app is still booting (and waits) instead of declaring it bridge-less.

export type AgentControl = {
  name: string;
  args?: Record<string, unknown>;
  description?: string;
  keys?: string; // optional key hint, e.g. "Space = flap", "WASD to move"
};

export type AgentRegistration = {
  rules?: string; // what the app is and its objective, plain prose
  controls: AgentControl[] | (() => AgentControl[]); // a function for dynamic controls
  getState?: () => unknown; // small JSON snapshot, used to verify an action landed
  invoke: (name: string, args?: Record<string, unknown>) => unknown;
  // Optional in-page self-play for fast-twitch games (Flappy, Doodle Jump) the
  // agent cannot react to frame-by-frame over the network. This is the INNER loop
  // of a two-loop design: the bridge runs policy() at frame rate (reflexes), and
  // the agent supervises on a slow cadence (seconds) via getState. Each frame the
  // bridge calls policy(hint) and, if it returns a control name, invokes it. The
  // `hint` is the agent's steering channel: knobs it set with the reserved
  // "__autopilot__" control (e.g. {bias, aggressiveness, target}) so a slow
  // supervisor can correct the fast reflex without owning the frame loop. The app
  // owns the heuristic (reads its own live state); the bridge owns loop + timing.
  policy?: (hint: Record<string, unknown>) => string | null | undefined | void;
};

type Bridge = {
  __openswarm: true;
  __ready: boolean;
  __rev: number;
  register: (api: AgentRegistration) => void;
  refresh: () => void; // bump __rev after dynamic controls change so the agent re-reads
  describe: () => unknown;
  getState: () => unknown;
  invoke: (name: string, args?: Record<string, unknown>) => unknown;
};

declare global {
  interface Window {
    OPENSWARM_APP?: Bridge;
  }
}

let registration: AgentRegistration | null = null;

// Reserved control name the agent invokes to start/stop/steer in-page self-play.
const AUTOPILOT = '__autopilot__';
let autopilotRAF = 0;
// Frames the current autopilot run has executed. Surfaced in getState as
// __autopilotFrames so a supervisor (or a human) can tell, from ONE poll, whether
// the reflex loop is actually ticking: climbing == running at frame rate; stuck at
// a low number while __autopilot is true == requestAnimationFrame is throttled
// (e.g. the app webview is backgrounded), which no policy tuning can fix.
let autopilotFrames = 0;
// The agent's steering knobs, read by policy() each frame. Merged from the
// non-`on` args of __autopilot__ invokes; the supervisor adjusts these after it
// diagnoses a stall, the reflex obeys at frame rate.
let autopilotHint: Record<string, unknown> = {};

function resolveControls(): AgentControl[] {
  if (!registration) return [];
  const c = registration.controls;
  try {
    return typeof c === 'function' ? c() || [] : c || [];
  } catch {
    return [];
  }
}

function autopilotRunning(): boolean {
  return autopilotRAF !== 0;
}

function startAutopilot(): void {
  if (autopilotRAF || !registration || typeof registration.policy !== 'function') return;
  autopilotFrames = 0; // fresh run starts the frame count from zero
  const step = () => {
    // Re-arm the next frame FIRST so a single throwing frame can't kill the loop.
    autopilotRAF = requestAnimationFrame(step);
    autopilotFrames++;
    try {
      const name = registration && registration.policy ? registration.policy(autopilotHint) : null;
      if (name) bridge.invoke(name);
    } catch {
      /* swallow: keep playing; the agent monitors progress via getState/score */
    }
  };
  autopilotRAF = requestAnimationFrame(step);
}

function stopAutopilot(): void {
  if (autopilotRAF) {
    cancelAnimationFrame(autopilotRAF);
    autopilotRAF = 0;
  }
}

const bridge: Bridge = {
  __openswarm: true,
  __ready: false,
  __rev: 0,
  register(api: AgentRegistration) {
    stopAutopilot(); // a fresh registration owns its own loop; drop any prior one
    autopilotHint = {};
    autopilotFrames = 0;
    registration = api;
    bridge.__ready = true;
    bridge.__rev += 1;
  },
  refresh() {
    bridge.__rev += 1;
  },
  describe() {
    if (!bridge.__ready || !registration) {
      return { __ready: false, __rev: bridge.__rev };
    }
    // Copy so advertising the autopilot control never mutates the app's array.
    const controls = [...resolveControls()];
    if (typeof registration.policy === 'function') {
      controls.push({
        name: AUTOPILOT,
        args: { on: true },
        description:
          'Self-play: the app plays itself at frame rate so you never press keys ' +
          "per frame. {on:true} starts, {on:false} stops. Pass this app's own " +
          'steering knobs (named in the app rules/state) to adjust the running ' +
          'policy without stopping it. Supervise on a slow cadence: poll getState; ' +
          'if progress stalls, take ONE screenshot to diagnose, then re-invoke ' +
          'with an adjusted knob.',
      });
    }
    return {
      rules: registration.rules || '',
      controls,
      __rev: bridge.__rev,
    };
  },
  getState() {
    if (!bridge.__ready || !registration) {
      return { __ready: false, __rev: bridge.__rev };
    }
    let state: unknown = {};
    try {
      state = registration.getState ? registration.getState() : {};
    } catch (e) {
      return { __error__: String((e as Error)?.message || e), __rev: bridge.__rev };
    }
    // Carry __rev alongside the app's own state so the agent can detect a
    // controls change with a single getState, without re-describing every turn.
    const out: Record<string, unknown> =
      state && typeof state === 'object' && !Array.isArray(state)
        ? { ...(state as Record<string, unknown>) }
        : { value: state };
    // __autopilot/__hint let the slow supervisor see the reflex's on/off state
    // and the knobs in effect; only surfaced for apps that registered a policy.
    if (typeof registration.policy === 'function') {
      out.__autopilot = autopilotRunning();
      out.__autopilotFrames = autopilotFrames;
      out.__hint = autopilotHint;
    }
    out.__rev = bridge.__rev;
    return out;
  },
  invoke(name: string, args?: Record<string, unknown>) {
    if (!bridge.__ready || !registration) {
      throw 'OPENSWARM_APP not registered yet';
    }
    if (name === AUTOPILOT) {
      if (typeof registration.policy !== 'function') {
        return { error: 'this app registered no autopilot policy' };
      }
      const { on, ...knobs } = args || {};
      const hasKnobs = Object.keys(knobs).length > 0;
      // Merge steering knobs into the live hint the policy reads each frame.
      if (hasKnobs) autopilotHint = { ...autopilotHint, ...knobs };
      // Toggle: explicit `on` wins; a bare call (no knobs either) means "start".
      if (on !== undefined) {
        if (on) startAutopilot();
        else stopAutopilot();
      } else if (!hasKnobs) {
        startAutopilot();
      }
      return { autopilot: autopilotRunning(), hint: autopilotHint };
    }
    return registration.invoke(name, args || {});
  },
};

window.OPENSWARM_APP = bridge;
