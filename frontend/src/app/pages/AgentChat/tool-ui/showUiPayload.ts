import type { ToolPair } from '../tool-bubbles/ToolCallBubble';
import { isToolUiComponent } from '@toolui/registry';

export interface WeatherForecastDay {
  day: string;
  condition?: string;
  high?: number;
  low?: number;
}

export interface WeatherProps {
  location: string;
  temp: number;
  unit?: 'F' | 'C';
  high?: number;
  low?: number;
  condition?: string;
  forecast?: WeatherForecastDay[];
}

export interface PlanStep {
  label: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface PlanProps {
  title?: string;
  steps: PlanStep[];
}

export interface StatItem {
  label: string;
  value: string;
  delta?: string;
  direction?: 'up' | 'down';
}

export interface StatsProps {
  title?: string;
  stats: StatItem[];
}

export interface LinkItem {
  title: string;
  url: string;
  description?: string;
}

export interface LinksProps {
  links: LinkItem[];
}

export type ShowUiPayload =
  | { component: 'weather'; props: WeatherProps }
  | { component: 'plan'; props: PlanProps }
  | { component: 'stats'; props: StatsProps }
  | { component: 'links'; props: LinksProps }
  | { component: 'vendored'; name: string; props: Record<string, unknown> };

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function str(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function isShowUiPair(pair: ToolPair): boolean {
  const tool = typeof pair.call.content === 'object' ? String(pair.call.content?.tool || '') : '';
  return /(^|__)ShowUI$/.test(tool);
}

export function isAskUiPair(pair: ToolPair): boolean {
  const tool = typeof pair.call.content === 'object' ? String(pair.call.content?.tool || '') : '';
  return /(^|__)AskUI$/.test(tool);
}

/** Latest ShowUI payload anywhere in a transcript; the collapsed card pins this artifact under its pill. */
export function extractLatestShowUi(messages: Array<{ role: string; content: any }>): ShowUiPayload | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'tool_call') continue;
    const tool = typeof msg.content === 'object' ? String(msg.content?.tool || '') : '';
    if (!/(^|__)ShowUI$/.test(tool)) continue;
    const parsed = parseShowUiInput(msg.content?.input);
    if (parsed) return parsed;
  }
  return null;
}

/** Strict parse of a ShowUI tool_call's input; null on any mismatch so the caller falls back to the plain bubble. */
export function parseShowUiPayload(pair: ToolPair): ShowUiPayload | null {
  const content = typeof pair.call.content === 'object' ? pair.call.content : null;
  return parseShowUiInput(content?.input);
}

function parseShowUiInput(input: unknown): ShowUiPayload | null {
  if (!input || typeof input !== 'object') return null;
  {
    const name = String((input as { component?: unknown }).component || '');
    const rawProps = (input as { props?: unknown }).props;
    if (isToolUiComponent(name) && rawProps && typeof rawProps === 'object') {
      // Vendored components carry their own zod contract; deep validation happens at render.
      return { component: 'vendored', name, props: rawProps as Record<string, unknown> };
    }
  }
  const component = String((input as { component?: unknown }).component || '');
  const props = (input as { props?: unknown }).props;
  if (!props || typeof props !== 'object') return null;
  const p = props as Record<string, unknown>;

  if (component === 'weather') {
    if (!str(p.location) || !num(p.temp)) return null;
    const forecast = Array.isArray(p.forecast)
      ? (p.forecast as Array<Record<string, unknown>>)
          // Either bound is enough; a "Tonight" entry legitimately has only a low.
          .filter((d) => str(d.day) && (num(d.high) || num(d.low)))
          .slice(0, 7)
          .map((d) => ({
            day: d.day as string,
            condition: str(d.condition) ? d.condition : undefined,
            high: num(d.high) ? d.high : undefined,
            low: num(d.low) ? d.low : undefined,
          }))
      : undefined;
    return {
      component: 'weather',
      props: {
        location: p.location,
        temp: p.temp,
        unit: p.unit === 'C' ? 'C' : 'F',
        high: num(p.high) ? p.high : undefined,
        low: num(p.low) ? p.low : undefined,
        condition: str(p.condition) ? p.condition : undefined,
        forecast,
      },
    };
  }

  if (component === 'plan') {
    if (!Array.isArray(p.steps)) return null;
    const steps = (p.steps as Array<Record<string, unknown>>)
      .filter((s) => str(s.label))
      .slice(0, 20)
      .map((s) => ({
        label: s.label as string,
        status: (s.status === 'completed' || s.status === 'in_progress' ? s.status : 'pending') as PlanStep['status'],
      }));
    if (steps.length === 0) return null;
    return { component: 'plan', props: { title: str(p.title) ? p.title : undefined, steps } };
  }

  if (component === 'stats') {
    if (!Array.isArray(p.stats)) return null;
    const stats = (p.stats as Array<Record<string, unknown>>)
      .filter((s) => str(s.label) && str(s.value))
      .slice(0, 8)
      .map((s) => ({
        label: s.label as string,
        value: s.value as string,
        delta: str(s.delta) ? s.delta : undefined,
        direction: (s.direction === 'up' || s.direction === 'down' ? s.direction : undefined) as StatItem['direction'],
      }));
    if (stats.length === 0) return null;
    return { component: 'stats', props: { title: str(p.title) ? p.title : undefined, stats } };
  }

  if (component === 'links') {
    if (!Array.isArray(p.links)) return null;
    const links = (p.links as Array<Record<string, unknown>>)
      .filter((l) => str(l.title) && str(l.url) && /^https?:\/\//i.test(l.url as string))
      .slice(0, 10)
      .map((l) => ({
        title: l.title as string,
        url: l.url as string,
        description: str(l.description) ? l.description : undefined,
      }));
    if (links.length === 0) return null;
    return { component: 'links', props: { links } };
  }

  return null;
}

// A dead turn must not keep spinners alive: once the agent stops, any step still marked
// in-progress is work that is NOT happening, so it renders as its truthful stalled state.
export function freezeIfDone(payload: ShowUiPayload, running: boolean): ShowUiPayload {
  if (running || payload.component !== 'vendored') return payload;
  if (payload.name !== 'progress-tracker' && payload.name !== 'plan') return payload;
  const steps = payload.props.steps ?? payload.props.todos;
  if (!Array.isArray(steps)) return payload;
  const liveKey = payload.name === 'plan' ? 'in_progress' : 'in-progress';
  if (!steps.some((s) => (s as { status?: string })?.status === liveKey)) return payload;
  const frozen = steps.map((s) =>
    (s as { status?: string })?.status === liveKey ? { ...(s as object), status: 'pending' } : s,
  );
  const key = payload.name === 'plan' ? 'todos' : 'steps';
  return { ...payload, props: { ...payload.props, [key]: frozen } };
}
