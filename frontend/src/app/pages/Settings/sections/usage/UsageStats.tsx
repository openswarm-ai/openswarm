import React, { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { API_BASE } from '@/shared/config';
import CountUp from './parts/CountUp';
import BarSeries from './parts/BarSeries';
import ActivityColumns from './parts/ActivityColumns';
import StatusDonut from './parts/StatusDonut';

type Window = '7d' | '30d' | 'all';

interface DayPoint { day: string; chats: number }

interface UsageSummary {
  window: string;
  excluded_automation_sessions: number;
  total_sessions: number;
  total_messages: number;
  total_tool_calls: number;
  completion_rate: number;
  models_used: Record<string, number>;
  top_tools: Record<string, number>;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cost_usd: number;
  status_breakdown: Record<string, number>;
  daily_activity: DayPoint[];
  hourly_activity: number[];
}

function fmtCount(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n).toLocaleString();
}

function cleanToolName(t: string): string {
  return t.replace(/^mcp__[^_]+(?:__)+/, '').replace(/^openswarm-\w+__/, '');
}

function hourLabel(h: number): string {
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

/** Your real activity: windowed, automation excluded, and only numbers we actually measure. */
const UsageStats: React.FC = () => {
  const c = useClaudeTokens();
  const [win, setWin] = useState<Window>('30d');
  const [stats, setStats] = useState<UsageSummary | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/service/usage-summary?window=${win}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: UsageSummary) => { if (alive) setStats(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [win]);

  const sectionSx = {
    color: c.text.muted, fontSize: '0.71875rem', fontWeight: 650, letterSpacing: '0.05em',
    textTransform: 'uppercase', mt: 3, mb: 1,
  } as const;
  const cardSx = {
    flex: 1, minWidth: 0, px: 1.75, py: 1.5, borderRadius: `${c.radius.md}px`,
    border: `1px solid ${c.border.subtle}`, background: c.bg.elevated,
  } as const;
  const bigSx = { color: c.text.primary, fontSize: '1.5rem', fontWeight: 600, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' } as const;
  const capSx = { color: c.text.muted, fontSize: '0.75rem', mt: 0.4 } as const;

  const peakHour = stats ? stats.hourly_activity.indexOf(Math.max(...stats.hourly_activity)) : 0;
  const avgMsgs = stats && stats.total_sessions > 0 ? stats.total_messages / stats.total_sessions : 0;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Typography sx={{ color: c.text.secondary, fontSize: '0.8125rem' }}>
          Your own sessions on this device{stats && stats.excluded_automation_sessions > 0
            ? `; ${fmtCount(stats.excluded_automation_sessions)} automated runs excluded`
            : ''}.
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={win}
          onChange={(_e, v: Window | null) => { if (v) setWin(v); }}
          sx={{ '& .MuiToggleButton-root': { px: 1.25, py: 0.25, fontSize: '0.71875rem', textTransform: 'none' } }}
        >
          <ToggleButton value="7d">7 days</ToggleButton>
          <ToggleButton value="30d">30 days</ToggleButton>
          <ToggleButton value="all">All time</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {!stats ? (
        <Box sx={{ py: 4, textAlign: 'center', color: c.text.ghost, fontSize: '0.8125rem' }}>Loading…</Box>
      ) : (
        <>
          <Box sx={{ display: 'flex', gap: 1.25 }}>
            <Box sx={cardSx}>
              <Typography sx={bigSx}><CountUp value={stats.total_sessions} format={fmtCount} /></Typography>
              <Typography sx={capSx}>Chats</Typography>
            </Box>
            <Box sx={cardSx}>
              <Typography sx={bigSx}><CountUp value={stats.total_messages} format={fmtCount} /></Typography>
              <Typography sx={capSx}>Messages</Typography>
            </Box>
            <Box sx={cardSx}>
              <Typography sx={bigSx}><CountUp value={stats.total_tool_calls} format={fmtCount} /></Typography>
              <Typography sx={capSx}>Tool calls</Typography>
            </Box>
            <Box sx={cardSx}>
              <Typography sx={bigSx}><CountUp value={avgMsgs} format={(n) => n.toFixed(1)} /></Typography>
              <Typography sx={capSx}>Messages per chat</Typography>
            </Box>
          </Box>

          {stats.daily_activity.length > 1 && (
            <>
              <Typography sx={sectionSx}>Chats per day</Typography>
              <ActivityColumns
                data={stats.daily_activity.map((d) => ({ key: d.day, value: d.chats, caption: d.day.slice(5) }))}
              />
            </>
          )}

          <Typography sx={sectionSx}>When you work</Typography>
          <ActivityColumns
            height={64}
            highlightIndex={peakHour}
            data={stats.hourly_activity.map((v, h) => ({ key: String(h), value: v, caption: hourLabel(h) }))}
          />
          <Typography sx={{ color: c.text.ghost, fontSize: '0.75rem', mt: 0.5 }}>
            Busiest around {hourLabel(peakHour)}.
          </Typography>

          <Typography sx={sectionSx}>How chats end</Typography>
          <StatusDonut
            slices={[
              { label: 'Finished cleanly', value: stats.status_breakdown.completed ?? 0, color: c.accent.primary },
              { label: 'You stopped it', value: stats.status_breakdown.stopped ?? 0, color: c.text.ghost },
              { label: 'Hit an error', value: stats.status_breakdown.error ?? 0, color: c.status?.error ?? '#c2554d' },
            ].filter((s) => s.value > 0)}
          />

          <Typography sx={sectionSx}>Models</Typography>
          <BarSeries
            data={Object.entries(stats.models_used).slice(0, 6).map(([label, value]) => ({ label, value, suffix: 'chats' }))}
          />

          <Typography sx={sectionSx}>Most used tools</Typography>
          <BarSeries
            data={Object.entries(stats.top_tools).slice(0, 8).map(([t, value]) => ({ label: cleanToolName(t), value, suffix: 'calls' }))}
          />

          <Typography sx={sectionSx}>Routed requests (all traffic, lifetime)</Typography>
          <Typography sx={{ color: c.text.ghost, fontSize: '0.75rem', mb: 1 }}>
            Everything routed through the local model router since install, including background helpers; not limited to the window above. The dollar figure is what this traffic would cost at pay-per-use API rates, not a charge: on a subscription or the free trial you paid nothing extra for it.
          </Typography>
          <Box sx={{ display: 'flex', gap: 1.25 }}>
            <Box sx={cardSx}>
              <Typography sx={bigSx}><CountUp value={stats.total_prompt_tokens} format={fmtCount} /></Typography>
              <Typography sx={capSx}>Tokens in</Typography>
            </Box>
            <Box sx={cardSx}>
              <Typography sx={bigSx}><CountUp value={stats.total_completion_tokens} format={fmtCount} /></Typography>
              <Typography sx={capSx}>Tokens out</Typography>
            </Box>
            <Box sx={cardSx}>
              <Typography sx={bigSx}>$<CountUp value={stats.total_cost_usd} format={(n) => n.toFixed(2)} /></Typography>
              <Typography sx={capSx}>Worth at API prices, not billed</Typography>
            </Box>
          </Box>
        </>
      )}
    </Box>
  );
};

export default UsageStats;
