import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const Analytics: React.FC = () => {
  const c = useClaudeTokens();

  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 3 }}>
      <Box sx={{ maxWidth: 800, mx: 'auto' }}>
        <Typography variant="h5" sx={{ color: c.text.primary, fontWeight: 600, mb: 3 }}>
          Analytics
        </Typography>

        <Paper sx={{
          p: 4,
          bgcolor: c.bg.surface,
          border: `1px solid ${c.border.subtle}`,
          textAlign: 'center',
        }}>
          <Box sx={{ mb: 2 }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={c.accent.primary} strokeWidth="1.5">
              <path d="M3 3v18h18" />
              <path d="M7 16l4-4 4 4 5-5" />
              <circle cx="20" cy="7" r="1.5" fill={c.accent.primary} />
            </svg>
          </Box>
          <Typography sx={{ color: c.text.primary, fontSize: '1.1rem', fontWeight: 600, mb: 1 }}>
            Analytics powered by PostHog
          </Typography>
          <Typography sx={{ color: c.text.muted, fontSize: '0.85rem', lineHeight: 1.6, mb: 3, maxWidth: 500, mx: 'auto' }}>
            Usage data is automatically collected — sessions, costs, tool usage, model distribution, and task categories.
            All data is anonymous and can be disabled in Settings.
          </Typography>

          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2, mt: 3, textAlign: 'left' }}>
            {[
              { label: 'Sessions & Usage', desc: 'How often agents are launched, session duration, completion rates' },
              { label: 'Cost Tracking', desc: 'Spend by model, provider, and time period' },
              { label: 'Task Categories', desc: 'What users do — coding, email, research, social, browsing' },
              { label: 'Model Distribution', desc: 'Which models and providers are most popular' },
              { label: 'Tool Usage', desc: 'Most used MCP tools, execution times, approval rates' },
              { label: 'Retention & Funnels', desc: 'User engagement, feature adoption, onboarding flow' },
            ].map((item) => (
              <Box key={item.label} sx={{ p: 2, borderRadius: `${c.radius.md}px`, bgcolor: c.bg.elevated }}>
                <Typography sx={{ color: c.text.primary, fontSize: '0.82rem', fontWeight: 600, mb: 0.5 }}>
                  {item.label}
                </Typography>
                <Typography sx={{ color: c.text.muted, fontSize: '0.72rem', lineHeight: 1.4 }}>
                  {item.desc}
                </Typography>
              </Box>
            ))}
          </Box>
        </Paper>
      </Box>
    </Box>
  );
};

export default Analytics;
