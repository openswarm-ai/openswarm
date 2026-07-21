import React, { Suspense, useEffect, useState } from 'react';
import { useThemeMode } from '@/shared/styles/ThemeContext';
import { TOOL_UI_REGISTRY } from './registry';

interface GuardProps { name: string; children: React.ReactNode }

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
      return (
        <div style={{ fontSize: '0.75rem', opacity: 0.55, padding: '4px 0' }}>
          {this.props.name} failed to render
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
}

type Gate =
  | { state: 'pending' }
  | { state: 'ok'; parsed: Record<string, unknown> }
  | { state: 'bad'; problem: string };

/** Models pad payloads with invented keys; strip ONLY unrecognized-key issues and retry once, so
    sloppiness self-heals while genuinely wrong shapes still fall back loudly. */
function parseLeniently(schema: { safeParse: (v: unknown) => any }, props: Record<string, unknown>): Gate {
  let result = schema.safeParse(props);
  if (!result.success) {
    const issues: Array<{ code: string; keys?: string[]; path: Array<string | number>; message: string }> = result.error.issues;
    if (issues.every((i) => i.code === 'unrecognized_keys')) {
      const cleaned: Record<string, unknown> = { ...props };
      for (const issue of issues) {
        for (const key of issue.keys || []) delete cleaned[key];
      }
      result = schema.safeParse(cleaned);
    }
  }
  if (result.success) return { state: 'ok', parsed: result.data as Record<string, unknown> };
  const issues = result.error.issues.slice(0, 2).map((i: { path: Array<string | number>; message: string }) => `${i.path.join('.')}: ${i.message}`).join('; ');
  return { state: 'bad', problem: issues };
}

/** Validates against the upstream zod contract, then renders the vendored component inside the scoped theme. */
function VendoredToolUi({ name, props, extraProps }: VendoredToolUiProps): React.ReactElement | null {
  const { mode } = useThemeMode();
  const entry = TOOL_UI_REGISTRY[name];
  const [gate, setGate] = useState<Gate>({ state: 'pending' });

  useEffect(() => {
    let cancelled = false;
    if (!entry) return undefined;
    entry
      .loadSchema()
      .then((schema) => {
        if (!cancelled) setGate(parseLeniently(schema, props));
      })
      .catch(() => { if (!cancelled) setGate({ state: 'bad', problem: 'component failed to load' }); });
    return () => { cancelled = true; };
  }, [entry, props]);

  if (!entry) return null;
  if (gate.state === 'bad') {
    return (
      <div style={{ fontSize: '0.75rem', opacity: 0.55, padding: '4px 0' }}>
        {name} payload didn't validate ({gate.problem})
      </div>
    );
  }
  if (gate.state === 'pending') {
    return <div style={{ height: 48, width: 280, borderRadius: 12, background: 'rgba(127,127,127,0.12)' }} />;
  }
  const Component = entry.Component;
  return (
    <div className={`tool-ui-scope${mode === 'dark' ? ' dark' : ''}`}>
      <ComponentGuard name={name}>
        <Suspense fallback={<div style={{ height: 48, width: 280, borderRadius: 12, background: 'rgba(127,127,127,0.12)' }} />}>
          <Component {...gate.parsed} {...(extraProps || {})} />
        </Suspense>
      </ComponentGuard>
    </div>
  );
}

export default VendoredToolUi;
