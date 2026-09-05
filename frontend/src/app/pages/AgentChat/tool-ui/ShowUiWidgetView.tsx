import React from 'react';
import WeatherWidget from './WeatherWidget';
import PlanWidget from './PlanWidget';
import StatsWidget from './StatsWidget';
import LinksWidget from './LinksWidget';
import VendoredToolUi from '@toolui/VendoredToolUi';
import type { ShowUiPayload } from './showUiPayload';
import { useOpenUrlInBrowserCard } from './useOpenUrlInBrowserCard';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { ambientShape } from './showUiAmbient';
import { perfBaselineFor } from '@/shared/perfBaseline';

/** One switch for every surface that renders a ShowUI payload (chat bubble, pill artifact); ambient = low-cost render for resting surfaces. */
function ShowUiWidgetView({ payload, ambient }: { payload: ShowUiPayload; ambient?: boolean }): React.ReactElement | null {
  const openUrl = useOpenUrlInBrowserCard();
  const c = useClaudeTokens();
  if (payload.component === 'weather') return <WeatherWidget props={payload.props} ambient={ambient} />;
  if (payload.component === 'plan') return <PlanWidget props={payload.props} />;
  if (payload.component === 'stats') return <StatsWidget props={payload.props} />;
  if (payload.component === 'links') return <LinksWidget props={payload.props} />;
  if (payload.component === 'vendored') {
    // The vendored contracts carry no question/title field, so agent-supplied ones silently vanish and a choice widget renders with no visible question; surface them as a host header (ENG-227).
    const raw = (payload.props ?? {}) as Record<string, unknown>;
    const title = [raw.title, raw.question, raw.prompt, raw.heading]
      .find((v): v is string => typeof v === 'string' && v.trim().length > 0) ?? '';
    const desc = typeof raw.description === 'string' && raw.description !== title ? raw.description : '';
    // The vendored media components ship real navigation callbacks that were never passed, so a rendered post went nowhere and links opened UNDER a fullscreen chat (ENG-234).
    const nav: Record<string, unknown> = {};
    const postUrl = /^(x|linkedin|instagram)-post$/.test(payload.name) && typeof raw.url === 'string' ? raw.url : null;
    if (payload.name === 'x-post' && postUrl) nav.onOpen = () => openUrl(postUrl);
    if (payload.name === 'link-preview' || payload.name === 'image') nav.onNavigate = (href: string) => openUrl(href);
    // A bare image (src only) is unclickable by contract; defaulting href to the source makes the click open the full-size original.
    if (payload.name === 'image' && typeof raw.href !== 'string') {
      const fallback = [raw.src, raw.url].find((v): v is string => typeof v === 'string');
      if (fallback) nav.href = fallback;
    }
    const shaped = ambient && !perfBaselineFor('ambient') ? ambientShape(payload.name, raw) : { props: payload.props, note: null };
    let widget = <VendoredToolUi name={payload.name} props={shaped.props} quietFail={ambient} extraProps={nav} />;
    if (shaped.note) {
      widget = (
        <div>
          {widget}
          <div style={{ fontSize: '0.75rem', color: c.text.secondary, padding: '6px 8px 2px' }}>{shaped.note}</div>
        </div>
      );
    }
    // The post components only wire clicks on their media, so a text-only post has no way to reach the actual post; the whole card opens it, like the platforms themselves (skipped on ambient pills, where a click means expand).
    if (postUrl && !ambient) {
      widget = (
        <div
          style={{ cursor: 'pointer' }}
          onClickCapture={(e: React.MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('button, a, input, textarea, [role=button]')) return;
            openUrl(postUrl);
          }}
        >
          {widget}
        </div>
      );
    }
    if (!title && !desc) return widget;
    return (
      <div>
        <div style={{ marginBottom: 6, paddingLeft: 4, paddingRight: 4 }}>
          {/* Colour explicitly, never inherited. This header sits above a vendored card whose own
              surface is dark, and with no colour of its own it took whatever the ancestor happened to
              carry: on a light-mode app that is near-black text on a dark card, i.e. an invisible
              title (screenshot 2026-08-31). Same class as ENG-419: a surface that fixes its own
              background owes its text a token in the same place. */}
          {title && <div style={{ fontSize: '0.9375rem', fontWeight: 600, lineHeight: 1.35, color: c.text.primary }}>{title}</div>}
          {desc && <div style={{ fontSize: '0.8125rem', color: c.text.secondary, marginTop: 2, lineHeight: 1.4 }}>{desc}</div>}
        </div>
        {widget}
      </div>
    );
  }
  return null;
}

// Memoized: a chat re-renders on every streamed delta and this sits inside every ShowUI message; the payload is memoized upstream on the message objects.
export default perfBaselineFor('ambient') ? ShowUiWidgetView : React.memo(ShowUiWidgetView);
