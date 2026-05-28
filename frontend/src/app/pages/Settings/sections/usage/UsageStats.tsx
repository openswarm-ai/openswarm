import React, { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { API_BASE } from '@/shared/config';
import { PixelBarOuter, PIXEL_BLUE } from './PixelBar';

const UsageStats: React.FC = () => {
  const c = useClaudeTokens();
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    fetch(`${API_BASE}/service/usage-summary`)
      .then(r => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  if (!stats) {
    const skeletonPulse = {
      animation: 'skeleton-pulse 1.5s ease-in-out infinite',
      '@keyframes skeleton-pulse': { '0%, 100%': { opacity: 0.5 }, '50%': { opacity: 0.25 } },
    };
    const skeletonCard = {
      p: 1.5, borderRadius: `${c.radius.md}px`, bgcolor: c.bg.elevated,
      border: `1px solid ${c.border.subtle}`, ...skeletonPulse,
    };
    return (
      <Box sx={{ mb: 2.5 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1, mb: 1 }}>
          {Array.from({ length: 4 }, (_, i) => (
            <Box key={i} sx={skeletonCard}>
              <Box sx={{ width: 60, height: 8, bgcolor: c.border.subtle, borderRadius: 1, mb: 1 }} />
              <Box sx={{ width: 50, height: 18, bgcolor: c.border.subtle, borderRadius: 1, mb: 0.5 }} />
              <Box sx={{ width: 90, height: 8, bgcolor: c.border.subtle, borderRadius: 1 }} />
            </Box>
          ))}
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1, mb: 1.5 }}>
          {Array.from({ length: 4 }, (_, i) => (
            <Box key={i} sx={skeletonCard}>
              <Box sx={{ width: 70, height: 8, bgcolor: c.border.subtle, borderRadius: 1, mb: 1 }} />
              <Box sx={{ width: 45, height: 18, bgcolor: c.border.subtle, borderRadius: 1, mb: 0.5 }} />
              <Box sx={{ width: 80, height: 8, bgcolor: c.border.subtle, borderRadius: 1 }} />
            </Box>
          ))}
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
          {Array.from({ length: 2 }, (_, i) => (
            <Box key={i} sx={{ ...skeletonCard, p: 2 }}>
              <Box sx={{ width: 80, height: 8, bgcolor: c.border.subtle, borderRadius: 1, mb: 2 }} />
              {Array.from({ length: 3 }, (_, j) => (
                <Box key={j} sx={{ mb: 1.5 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                    <Box sx={{ width: 60 + j * 15, height: 10, bgcolor: c.border.subtle, borderRadius: 1 }} />
                    <Box sx={{ width: 35, height: 10, bgcolor: c.border.subtle, borderRadius: 1 }} />
                  </Box>
                  <Box sx={{ display: 'flex', gap: '1px' }}>
                    {Array.from({ length: 16 }, (_, k) => (
                      <Box key={k} sx={{ width: 5, height: 5, bgcolor: c.border.subtle, opacity: k < 8 - j * 2 ? 0.6 : 0.2 }} />
                    ))}
                  </Box>
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      </Box>
    );
  }

  const formatCost = (v: number) => {
    if (v === 0) return '$0.00';
    if (v < 0.001) return `$${v.toFixed(6)}`;
    if (v < 0.01) return `$${v.toFixed(5)}`;
    if (v < 1) return `$${v.toFixed(4)}`;
    return `$${v.toFixed(2)}`;
  };
  const formatDuration = (s: number) => {
    if (s === 0) return '0s';
    if (s < 60) return `${s.toFixed(1)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  };
  const formatTotalTime = (s: number) => {
    if (s < 60) return `${s.toFixed(1)}s`;
    if (s < 3600) return `${(s / 60).toFixed(1)} min`;
    return `${(s / 3600).toFixed(1)} hrs`;
  };

  const cardSx = {
    p: 1.5,
    borderRadius: `${c.radius.md}px`,
    bgcolor: c.bg.elevated,
    border: `1px solid ${c.border.subtle}`,
  };
  const labelSx = { fontSize: '0.58rem', fontWeight: 700, color: c.text.ghost, textTransform: 'uppercase' as const, letterSpacing: '0.06em', mb: 0.25 };
  const valueSx = { fontSize: '1.05rem', fontWeight: 700, color: c.text.primary, lineHeight: 1.2 };
  const subSx = { fontSize: '0.62rem', color: c.text.tertiary, mt: 0.25 };

  const modelEntries = Object.entries(stats.models_used || {}).sort((a: any, b: any) => b[1] - a[1]) as [string, number][];
  const providerEntries = Object.entries(stats.providers_used || {}).sort((a: any, b: any) => b[1] - a[1]) as [string, number][];
  const toolEntries = Object.entries(stats.top_tools || {}).slice(0, 10) as [string, number][];
  const maxToolCount = toolEntries.length > 0 ? Math.max(...toolEntries.map(([, c]) => c)) : 1;
  const statusEntries = Object.entries(stats.status_breakdown || {}) as [string, string][];

  const PixelBar: React.FC<{ value: number; max: number; width?: number; palette?: string[] }> = (props) => (
    <PixelBarOuter {...props} tokens={c} />
  );

  const totalTime = stats.total_run_seconds ?? (stats.avg_duration_seconds * stats.total_sessions);
  const msgsPerSession = stats.total_sessions > 0 ? (stats.total_messages / stats.total_sessions).toFixed(1) : '0';
  const toolsPerSession = stats.total_sessions > 0 ? (stats.total_tool_calls / stats.total_sessions).toFixed(1) : '0';
  const formatTokens = (n: number) => {
    if (n === 0) return '0';
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
    return `${(n / 1_000_000).toFixed(2)}M`;
  };
  const isSubscription = stats.cost_source === '9router';
  const costSourceLabel = isSubscription ? 'saved with your subscription' : stats.cost_source === 'sdk' ? 'via API' : '';

  // Quirky savings nudge (subscription users only): what their token usage would've cost at API
  // rates, framed a little differently each day so it stays fun without nagging.
  const savedAmt = stats.total_cost_usd || 0;
  const sessionsLabel = (stats.total_sessions || 0).toLocaleString();
  const lattes = Math.max(1, Math.round(savedAmt / 5.75));
  const savingsQuips = [
    `You've sidestepped ${formatCost(savedAmt)} in API fees by routing ${sessionsLabel} agent runs through your own subscriptions. The meter never blinked.`,
    `${formatCost(savedAmt)} saved, about ${lattes} oat-milk latte${lattes === 1 ? '' : 's'} you didn't expense to a token meter.`,
    `Your subscriptions quietly did the work of a ${formatCost(savedAmt)} API bill. OpenSwarm just drove around the toll booth.`,
    `${formatCost(savedAmt)} that stayed in your wallet across ${sessionsLabel} sessions. Per-token guilt: zero.`,
  ];
  const savingsQuip = savingsQuips[Math.floor(Date.now() / 86_400_000) % savingsQuips.length];

  return (
    <Box sx={{ mb: 2.5 }}>
      {isSubscription && savedAmt > 1 && (
        <Box sx={{
          mb: 1.5, px: 1.5, py: 1, borderRadius: `${c.radius.md}px`,
          bgcolor: `${c.accent.primary}0F`, border: `1px solid ${c.accent.primary}26`,
          display: 'flex', alignItems: 'center', gap: 1,
        }}>
          <Typography sx={{ fontSize: '0.95rem', lineHeight: 1 }}>✨</Typography>
          <Typography sx={{ fontSize: '0.74rem', color: c.text.secondary, fontStyle: 'italic', lineHeight: 1.4 }}>
            {savingsQuip}
          </Typography>
        </Box>
      )}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1, mb: 1 }}>
        <Box sx={cardSx}>
          <Typography sx={labelSx}>Total Sessions</Typography>
          <Typography sx={valueSx}>{stats.total_sessions.toLocaleString()}</Typography>
          <Typography sx={subSx}>
            {statusEntries.map(([s, n]) => `${n} ${s}`).join(', ') || 'no sessions'}
          </Typography>
        </Box>
        <Box sx={cardSx}>
          <Typography sx={labelSx}>{isSubscription ? 'You Saved' : 'Total Cost'}</Typography>
          <Typography sx={valueSx}>{formatCost(stats.total_cost_usd)}</Typography>
          <Typography sx={subSx}>
            {isSubscription
              ? `${formatCost(stats.avg_cost_per_session)} avg, saved with your subscription`
              : costSourceLabel ? `${formatCost(stats.avg_cost_per_session)} avg, ${costSourceLabel}` : 'no cost data'}
          </Typography>
        </Box>
        <Box sx={cardSx}>
          <Typography sx={labelSx}>Total Messages</Typography>
          <Typography sx={valueSx}>{stats.total_messages.toLocaleString()}</Typography>
          <Typography sx={subSx}>
            {msgsPerSession} avg per session
          </Typography>
        </Box>
        <Box sx={cardSx}>
          <Typography sx={labelSx}>Total Tool Calls</Typography>
          <Typography sx={valueSx}>{stats.total_tool_calls.toLocaleString()}</Typography>
          <Typography sx={subSx}>
            {toolsPerSession} avg per session
          </Typography>
        </Box>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1, mb: 1.5 }}>
        <Box sx={cardSx}>
          <Typography sx={labelSx}>Total Run Time</Typography>
          <Typography sx={valueSx}>{formatTotalTime(totalTime)}</Typography>
          <Typography sx={subSx}>across all sessions</Typography>
        </Box>
        <Box sx={cardSx}>
          <Typography sx={labelSx}>Avg Session</Typography>
          <Typography sx={valueSx}>{formatDuration(stats.avg_duration_seconds)}</Typography>
          <Typography sx={subSx}>per session duration</Typography>
        </Box>
        <Box sx={cardSx}>
          <Typography sx={labelSx}>Completion Rate</Typography>
          <Typography sx={valueSx}>{(stats.completion_rate * 100).toFixed(1)}%</Typography>
          <Typography sx={subSx}>
            sessions finished successfully
          </Typography>
        </Box>
        <Box sx={cardSx}>
          <Typography sx={labelSx}>Tokens Used</Typography>
          <Typography sx={valueSx}>
            {stats.total_prompt_tokens || stats.total_completion_tokens
              ? formatTokens((stats.total_prompt_tokens || 0) + (stats.total_completion_tokens || 0))
              : Object.keys(stats.providers_used || {}).length}
          </Typography>
          <Typography sx={subSx}>
            {stats.total_prompt_tokens || stats.total_completion_tokens
              ? `${formatTokens(stats.total_prompt_tokens || 0)} in, ${formatTokens(stats.total_completion_tokens || 0)} out`
              : providerEntries.map(([p]) => p).join(', ') || 'none'}
          </Typography>
        </Box>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
        <Box sx={{ ...cardSx, p: 2 }}>
          <Typography sx={{ ...labelSx, mb: 1.5 }}>Models Used</Typography>
          {modelEntries.length > 0 ? modelEntries.map(([model, count]) => {
            const pct = stats.total_sessions > 0 ? ((count / stats.total_sessions) * 100).toFixed(0) : '0';
            return (
              <Box key={model} sx={{ mb: 1 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 0 }}>
                  <Typography sx={{ fontSize: '0.78rem', color: c.text.muted, fontWeight: 500 }}>{model}</Typography>
                  <Typography sx={{ fontSize: '0.68rem', color: c.text.tertiary, fontFamily: c.font.mono }}>
                    {count} ({pct}%)
                  </Typography>
                </Box>
                <PixelBar value={count} max={stats.total_sessions} palette={PIXEL_BLUE} />
              </Box>
            );
          }) : <Typography sx={{ fontSize: '0.75rem', color: c.text.ghost }}>No sessions yet</Typography>}
        </Box>

        <Box sx={{ ...cardSx, p: 2 }}>
          <Typography sx={{ ...labelSx, mb: 1.5 }}>Top Tools</Typography>
          {toolEntries.length > 0 ? toolEntries.map(([tool, count]) => {
            const shortName = tool.includes('__') ? tool.split('__').pop() : tool;
            const pct = stats.total_tool_calls > 0 ? ((count / stats.total_tool_calls) * 100).toFixed(0) : '0';
            return (
              <Box key={tool} sx={{ mb: 1 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 0 }}>
                  <Typography sx={{ fontSize: '0.72rem', color: c.text.muted, fontWeight: 500 }}>{shortName}</Typography>
                  <Typography sx={{ fontSize: '0.62rem', color: c.text.tertiary, fontFamily: c.font.mono }}>
                    {count} call{count !== 1 ? 's' : ''} ({pct}%)
                  </Typography>
                </Box>
                <PixelBar value={count} max={maxToolCount} />
              </Box>
            );
          }) : <Typography sx={{ fontSize: '0.75rem', color: c.text.ghost }}>No tool calls yet</Typography>}
        </Box>
      </Box>
    </Box>
  );
};

export default UsageStats;
