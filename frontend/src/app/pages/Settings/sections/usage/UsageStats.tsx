import React, { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { API_BASE } from '@/shared/config';

type Window = '7d' | '30d' | 'all';

interface UsageSummary {
  window: string;
  excluded_automation_sessions: number;
  total_sessions: number;
  total_messages: number;
  total_tool_calls: number;
  total_run_seconds: number;
  avg_duration_seconds: number;
  completion_rate: number;
  models_used: Record<string, number>;
  top_tools: Record<string, number>;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cost_usd: number;
}

function fmtDuration(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} hrs`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds)}s`;
}

function fmtCount(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();
}

/** Your real activity, claude-flat: windowed, automation excluded, friendly names, honest scopes. */
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

  const rowSx = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    py: 1.1, borderBottom: `1px solid ${c.border.subtle}`, '&:last-of-type': { borderBottom: 'none' },
  } as const;
  const labelSx = { color: c.text.primary, fontSize: '0.8438rem', fontWeight: 500 } as const;
  const valueSx = { color: c.text.primary, fontSize: '0.8438rem', fontVariantNumeric: 'tabular-nums' } as const;
  const sectionSx = { color: c.text.muted, fontSize: '0.71875rem', fontWeight: 650, letterSpacing: '0.05em', textTransform: 'uppercase', mt: 2.5, mb: 0.5 } as const;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
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
          <Box sx={rowSx}>
            <Typography sx={labelSx}>Chats</Typography>
            <Typography sx={valueSx}>{fmtCount(stats.total_sessions)}</Typography>
          </Box>
          <Box sx={rowSx}>
            <Typography sx={labelSx}>Messages</Typography>
            <Typography sx={valueSx}>{fmtCount(stats.total_messages)}</Typography>
          </Box>
          <Box sx={rowSx}>
            <Typography sx={labelSx}>Tool calls</Typography>
            <Typography sx={valueSx}>{fmtCount(stats.total_tool_calls)}</Typography>
          </Box>
          <Box sx={rowSx}>
            <Typography sx={labelSx}>Agent time</Typography>
            <Typography sx={valueSx}>{fmtDuration(stats.total_run_seconds)}</Typography>
          </Box>
          <Box sx={rowSx}>
            <Typography sx={labelSx}>Finished cleanly</Typography>
            <Typography sx={valueSx}>{Math.round(stats.completion_rate * 100)}%</Typography>
          </Box>

          <Typography sx={sectionSx}>Models</Typography>
          {Object.entries(stats.models_used).slice(0, 6).map(([model, count]) => (
            <Box key={model} sx={rowSx}>
              <Typography sx={labelSx}>{model}</Typography>
              <Typography sx={{ ...valueSx, color: c.text.secondary }}>{fmtCount(count)} chats</Typography>
            </Box>
          ))}

          <Typography sx={sectionSx}>Most used tools</Typography>
          {Object.entries(stats.top_tools).slice(0, 8).map(([tool, count]) => (
            <Box key={tool} sx={rowSx}>
              <Typography sx={labelSx}>{tool.replace(/^mcp__[^_]+(?:__)+/, '').replace(/^openswarm-\w+__/, '')}</Typography>
              <Typography sx={{ ...valueSx, color: c.text.secondary }}>{fmtCount(count)} calls</Typography>
            </Box>
          ))}

          <Typography sx={sectionSx}>Routed requests (all traffic, lifetime)</Typography>
          <Typography sx={{ color: c.text.ghost, fontSize: '0.75rem', mb: 0.5 }}>
            Everything routed through the local model router since install, including background helpers; not limited to the window above.
          </Typography>
          <Box sx={rowSx}>
            <Typography sx={labelSx}>Tokens in / out</Typography>
            <Typography sx={valueSx}>{fmtCount(stats.total_prompt_tokens)} / {fmtCount(stats.total_completion_tokens)}</Typography>
          </Box>
          <Box sx={rowSx}>
            <Typography sx={labelSx}>API value covered</Typography>
            <Typography sx={valueSx}>${stats.total_cost_usd.toFixed(2)}</Typography>
          </Box>
        </>
      )}
    </Box>
  );
};

export default UsageStats;
