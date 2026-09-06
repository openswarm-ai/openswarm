import React, { useEffect, useMemo, useState } from 'react';
import { useThemeMode } from '@/shared/styles/ThemeContext';
import { TOOL_UI_REGISTRY, type ToolUiEntry } from './registry';
import { parseLeniently, type Gate } from './parseLeniently';

interface GuardProps { name: string; quiet?: boolean; children: React.ReactNode }

// A component render throwing must cost exactly one quiet line, never the app: the top-level
// ErrorBoundary unmounts the whole shell for any uncaught child throw (the linkedin-post {post}
// mismatch took down the dashboard until this wall existed).
class ComponentGuard extends React.Component<GuardProps, { failed: boolean }> {
  constructor(props: GuardProps) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      if (this.props.quiet) return null;
      return (
        <div style={{ fontSize: '0.75rem', opacity: 0.45, padding: '4px 0', fontStyle: 'italic' }}>
          Couldn't draw the {this.props.name.replace(/-/g, ' ')} view
        </div>
      );
    }
    return this.props.children;
  }
}

interface VendoredToolUiProps {
  name: string;
  props: Record<string, unknown>;
  /** Non-serializable React props (callbacks, live overrides) merged AFTER validation of the wire props. */
  extraProps?: Record<string, unknown>;
  /** Ambient surfaces (the collapsed pill) show NOTHING on failure; a floating error line on the canvas is worse than absence. */
  quietFail?: boolean;
}

const warnedShapes = new Set<string>();
// One import per component for the whole page, and the loader owns its own readiness: a code-split component behind a
// fallback boundary lost its retry above the memoized bubble (measured 2026-09-05: chunk loaded, module resolved, skeleton
// forever), so the component arrives through state, which re-renders THIS component no matter what memo sits above it.
const loadedComponents = new Map<ToolUiEntry, Promise<React.ComponentType<any>>>();
export function componentFor(entry: ToolUiEntry): Promise<React.ComponentType<any>> {
  let p = loadedComponents.get(entry);
  if (!p) {
    // A rejection is forgotten, so the next widget of this kind fetches again instead of inheriting one blip for the rest of the page.
    p = entry.load().catch((e) => { if (loadedComponents.get(entry) === p) loadedComponents.delete(entry); throw e; });
    loadedComponents.set(entry, p);
  }
  return p;
}

// Rough resting height per component family so the loading skeleton reserves believable space
// (Lobe/Open WebUI pattern: a breathing block where the card will land, not a tiny sliver).
function skeletonHeightFor(name: string): number {
  if (/table|chart|gallery|map|carousel|post|terminal/.test(name)) return 180;
  if (/stats|weather|plan|order|preferences|question/.test(name)) return 110;
  return 56;
}

const SkeletonBlock: React.FC<{ name: string }> = ({ name }) => (
  <div
    style={{
      height: skeletonHeightFor(name),
      width: '100%',
      borderRadius: 12,
      background: 'rgba(127,127,127,0.12)',
      animation: 'toolui-skeleton-pulse 1.4s ease-in-out infinite',
    }}
  >
    <style>{'@keyframes toolui-skeleton-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }'}</style>
  </div>
);

/** Validates against the upstream zod contract, then renders the vendored component inside the scoped theme. */
function VendoredToolUi({ name, props, extraProps, quietFail = false }: VendoredToolUiProps): React.ReactElement | null {
  const { mode } = useThemeMode();
  const entry = TOOL_UI_REGISTRY[name];
  const [gate, setGate] = useState<Gate>({ state: 'pending' });
  const [Component, setComponent] = useState<React.ComponentType<any> | null>(null);
  // Parents rebuild the props object every render; keying the validation on identity re-ran an async zod parse per transcript render (real typing-lag cost in table-bearing chats). Content is the real dependency.
  const propsKey = useMemo(() => { try { return JSON.stringify(props); } catch { return String(Math.random()); } }, [props]);

  useEffect(() => {
    let cancelled = false;
    if (!entry) return undefined;
    Promise.all([entry.loadSchema(), componentFor(entry)])
      .then(([schema, Loaded]) => {
        if (cancelled) return;
        setComponent(() => Loaded);
        setGate(parseLeniently(schema, props));
      })
      .catch(() => { if (!cancelled) setGate({ state: 'bad', problem: 'component failed to load' }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, propsKey]);

  if (!entry) return null;
  if (gate.state === 'bad') {
    // Schema jargon is for the console, once per component+issue SHAPE for the whole session; a
    // transcript full of the same agent mistake used to print 37 copies of the identical warning.
    const shapeKey = `${name}:${gate.problem}`;
    if (!warnedShapes.has(shapeKey)) {
      warnedShapes.add(shapeKey);
      console.warn(`[tool-ui] ${name} payload didn't validate:`, gate.problem);
    }
    if (quietFail) return null;
    return (
      <div style={{ fontSize: '0.75rem', opacity: 0.45, padding: '4px 0', fontStyle: 'italic' }}>
        Couldn't draw the {name.replace(/-/g, ' ')} view
      </div>
    );
  }
  if (gate.state === 'pending' || !Component) {
    return quietFail ? null : <SkeletonBlock name={name} />;
  }
  return (
    <div className={`tool-ui-scope${mode === 'dark' ? ' dark' : ''}`}>
      <ComponentGuard name={name} quiet={quietFail}>
        <Component {...gate.parsed} {...(extraProps || {})} />
      </ComponentGuard>
    </div>
  );
}

export default VendoredToolUi;
