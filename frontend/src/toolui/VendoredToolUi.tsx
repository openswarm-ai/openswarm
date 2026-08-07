import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useThemeMode } from '@/shared/styles/ThemeContext';
import { TOOL_UI_REGISTRY } from './registry';

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

type Gate =
  | { state: 'pending' }
  | { state: 'ok'; parsed: Record<string, unknown> }
  | { state: 'bad'; problem: string };

/** Models pad payloads with invented keys; strip ONLY unrecognized-key issues and retry once, so
    sloppiness self-heals while genuinely wrong shapes still fall back loudly. */
function slugFor(label: unknown, i: number): string {
  const t = typeof label === 'string' ? label.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40) : '';
  return t || `item-${i + 1}`;
}

// Mechanical repairs for the mistakes agents actually make (numeric ids, ranked priorities, nested
// row objects, bare action objects). Only ever applied when the strict parse FAILED, and the result
// is re-validated, so a repair can flip fail->pass but never corrupt a valid payload.
function repairCommonAgentShapes(props: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown>;
  try {
    out = JSON.parse(JSON.stringify(props ?? {}, (_k, v) => (v === undefined ? null : v)));
  } catch {
    return props;
  }
  const fixIdLabel = (arr: unknown): unknown => {
    if (!Array.isArray(arr)) return arr;
    return arr.map((o, i) => {
      if (typeof o === 'string') return { id: slugFor(o, i), label: o };
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        const obj = { ...(o as Record<string, unknown>) };
        // Agents reach for value/name/key and title/text as synonyms; honor them before inventing a slug.
        if (obj.id == null || obj.id === '') obj.id = obj.value ?? obj.key ?? obj.name ?? null;
        if (obj.id == null || obj.id === '') obj.id = slugFor(obj.label ?? obj.title ?? obj.text, i);
        else if (typeof obj.id !== 'string') obj.id = String(obj.id);
        if (typeof obj.label !== 'string' || !obj.label) obj.label = String(obj.label ?? obj.title ?? obj.text ?? obj.name ?? obj.id);
        return obj;
      }
      return o;
    });
  };
  if ('options' in out) out.options = fixIdLabel(out.options);
  if ('actions' in out) {
    if (out.actions && !Array.isArray(out.actions) && typeof out.actions === 'object' && 'label' in (out.actions as object)) out.actions = [out.actions];
    out.actions = fixIdLabel(out.actions);
  }
  const PRIORITY_SYNONYMS: Record<string, string> = { '1': 'primary', '2': 'secondary', '3': 'tertiary', high: 'primary', medium: 'secondary', low: 'tertiary', primary: 'primary', secondary: 'secondary', tertiary: 'tertiary' };
  if (Array.isArray(out.columns)) {
    out.columns = out.columns.map((c) => {
      if (c && typeof c === 'object' && 'priority' in (c as object)) {
        const mapped = PRIORITY_SYNONYMS[String((c as Record<string, unknown>).priority).toLowerCase()];
        const copy = { ...(c as Record<string, unknown>) };
        if (mapped) copy.priority = mapped; else delete copy.priority;
        return copy;
      }
      return c;
    });
  }
  if (Array.isArray(out.data)) {
    // Row arrays (instead of keyed objects) zip against the column keys, in order.
    const colKeys = Array.isArray(out.columns)
      ? (out.columns as Array<Record<string, unknown>>).map((c, i) => String((c && typeof c === 'object' ? (c.key ?? c.id ?? c.label) : c) ?? `col${i + 1}`))
      : null;
    out.data = out.data.map((row) => {
      if (Array.isArray(row) && colKeys && colKeys.length > 0) {
        return Object.fromEntries(row.map((v, i) => [colKeys[i] ?? `col${i + 1}`, v]));
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      return Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([k, v]) => {
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) return [k, JSON.stringify(v)];
        if (Array.isArray(v)) return [k, v.map((x) => (x !== null && typeof x === 'object' ? JSON.stringify(x) : x))];
        return [k, v];
      }));
    });
  }
  return out;
}

function parseLeniently(schema: { safeParse: (v: unknown) => any }, props: Record<string, unknown>): Gate {
  let result = schema.safeParse(props);
  let base: Record<string, unknown> = props;
  if (!result.success) {
    const issues: Array<{ code: string; keys?: string[]; path: Array<string | number>; message: string }> = result.error.issues;
    if (issues.every((i) => i.code === 'unrecognized_keys')) {
      const cleaned: Record<string, unknown> = { ...props };
      for (const issue of issues) {
        for (const key of issue.keys || []) delete cleaned[key];
      }
      base = cleaned;
      result = schema.safeParse(cleaned);
    }
  }
  if (!result.success) {
    const repaired = schema.safeParse(repairCommonAgentShapes(base));
    if (repaired.success) return { state: 'ok', parsed: repaired.data as Record<string, unknown> };
  }
  if (result.success) return { state: 'ok', parsed: result.data as Record<string, unknown> };
  const issues = result.error.issues.slice(0, 2).map((i: { path: Array<string | number>; message: string }) => `${i.path.join('.')}: ${i.message}`).join('; ');
  return { state: 'bad', problem: issues };
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
  // Parents rebuild the props object every render; keying the validation on identity re-ran an async zod parse per transcript render (real typing-lag cost in table-bearing chats). Content is the real dependency.
  const propsKey = useMemo(() => { try { return JSON.stringify(props); } catch { return String(Math.random()); } }, [props]);

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
  if (gate.state === 'pending') {
    return quietFail ? null : <SkeletonBlock name={name} />;
  }
  const Component = entry.Component;
  return (
    <div className={`tool-ui-scope${mode === 'dark' ? ' dark' : ''}`}>
      <ComponentGuard name={name} quiet={quietFail}>
        <Suspense fallback={<SkeletonBlock name={name} />}>
          <Component {...gate.parsed} {...(extraProps || {})} />
        </Suspense>
      </ComponentGuard>
    </div>
  );
}

export default VendoredToolUi;
