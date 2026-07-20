import type { ToolPair } from '../tool-bubbles/ToolCallBubble';

export interface WeatherForecastDay {
  day: string;
  condition?: string;
  high: number;
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
  | { component: 'links'; props: LinksProps };

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
  const component = String((input as { component?: unknown }).component || '');
  const props = (input as { props?: unknown }).props;
  if (!props || typeof props !== 'object') return null;
  const p = props as Record<string, unknown>;

  if (component === 'weather') {
    if (!str(p.location) || !num(p.temp)) return null;
    const forecast = Array.isArray(p.forecast)
      ? (p.forecast as Array<Record<string, unknown>>)
          .filter((d) => str(d.day) && num(d.high))
          .slice(0, 7)
          .map((d) => ({
            day: d.day as string,
            condition: str(d.condition) ? d.condition : undefined,
            high: d.high as number,
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
