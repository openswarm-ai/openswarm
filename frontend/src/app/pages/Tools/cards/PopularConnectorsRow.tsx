import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { Integration } from '../integrations';

interface Props {
  integrations: Integration[];
  loading: Record<string, boolean>;
  onConnect: (ig: Integration) => void;
}

// claude.ai's POPULAR strip on the Connectors settings page: compact cards with a Connect button.
const PopularConnectorsRow: React.FC<Props> = ({ integrations, loading, onConnect }) => {
  const c = useClaudeTokens();
  if (integrations.length === 0) return null;
  return (
    <Box sx={{ mb: 2.5 }}>
      <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.06em', color: c.text.tertiary, textTransform: 'uppercase', mb: 1.25 }}>
        Popular
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1.5 }}>
        {integrations.map((ig) => (
          <Box key={ig.id} sx={{
            display: 'flex', alignItems: 'center', gap: 1.25, px: 1.75, py: 1.25,
            border: `1px solid ${c.border.subtle}`, borderRadius: '12px', bgcolor: c.bg.surface,
            transition: 'border-color 0.12s, box-shadow 0.12s',
            '&:hover': { borderColor: c.border.medium, boxShadow: c.shadow.sm },
          }}>
            <Box sx={{
              width: 30, height: 30, borderRadius: '8px', flexShrink: 0,
              border: `1px solid ${c.border.subtle}`, bgcolor: c.bg.surface,
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: ig.color,
            }}>
              {ig.icon}
            </Box>
            <Typography noWrap sx={{ fontSize: '0.9375rem', fontWeight: 600, color: c.text.primary, flex: 1 }}>{ig.name}</Typography>
            {loading[ig.id] ? (
              <CircularProgress size={16} sx={{ color: ig.color }} />
            ) : (
              <Button
                size="small"
                variant="outlined"
                onClick={() => onConnect(ig)}
                sx={{
                  textTransform: 'none', fontSize: '0.8125rem', fontWeight: 600, px: 1.5, py: 0.3,
                  color: c.text.primary, borderColor: c.border.medium, borderRadius: 999, minWidth: 0,
                  '&:hover': { borderColor: c.border.strong, bgcolor: c.bg.elevated },
                }}
              >
                Connect
              </Button>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
};

export default PopularConnectorsRow;
