import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import SubscriptionCards from './components/SubscriptionCards';
import type { UseSettingsReturn } from '../../hooks/useSettings';

const ModelsTab: React.FC<{ s: UseSettingsReturn }> = ({ s }) => {
  const { c, form, setForm, showApiKey, setShowApiKey, fieldSx, labelSx, descSx } = s;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', pt: 2.5, pb: 1, gap: 2.5, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
      <Typography sx={{ fontSize: '0.7rem', color: c.text.ghost, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
        Use Your Existing Subscriptions
      </Typography>
      <Typography sx={{ ...descSx, mb: 0 }}>
        Already paying for Claude, ChatGPT, or Gemini? Connect your subscription — no API key needed, no extra cost.
      </Typography>
      <SubscriptionCards />
      <Typography sx={{ fontSize: '0.7rem', color: c.text.ghost, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, mt: 1 }}>
        Or Connect With API Keys
      </Typography>
      <Typography sx={{ ...descSx, mb: -1 }}>
        Pay per use. Each key is stored locally on your device.
      </Typography>
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={labelSx}>Anthropic</Typography>
          {form.anthropic_api_key ? (
            <Typography sx={{ fontSize: '0.6rem', fontWeight: 600, color: c.status.success, bgcolor: `${c.status.success}15`, px: 0.75, py: 0.15, borderRadius: '3px' }}>CONNECTED</Typography>
          ) : null}
        </Box>
        <Typography sx={{ ...descSx, mb: 1 }}>Claude Sonnet, Opus, Haiku.</Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <TextField
            type={showApiKey ? 'text' : 'password'}
            value={form.anthropic_api_key ?? ''}
            onChange={(e) => setForm({ ...form, anthropic_api_key: e.target.value || null })}
            size="small"
            fullWidth
            placeholder="sk-ant-..."
            sx={{ ...fieldSx, '& .MuiOutlinedInput-root': { ...fieldSx['& .MuiOutlinedInput-root'], fontFamily: c.font.mono } }}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton onClick={() => setShowApiKey(!showApiKey)} edge="end" size="small" sx={{ color: c.text.tertiary }}>
                    {showApiKey ? <VisibilityOffIcon sx={{ fontSize: 16 }} /> : <VisibilityIcon sx={{ fontSize: 16 }} />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
          />
          <Typography
            component="a"
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noopener"
            sx={{ color: c.accent.primary, fontSize: '0.72rem', whiteSpace: 'nowrap', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 0.3, '&:hover': { textDecoration: 'underline' } }}
          >
            Get key <OpenInNewIcon sx={{ fontSize: 11 }} />
          </Typography>
        </Box>
      </Box>
    </Box>
  );
};

export default ModelsTab;
