import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { AppSettings } from '@/shared/state/settingsSlice';
import type { SettingsStyles } from '../settingsStyles';

type ApiKeyField = 'anthropic_api_key' | 'openai_api_key' | 'google_api_key' | 'openrouter_api_key';

export interface ApiKeyConfig {
  field: ApiKeyField;
  label: string;
  desc: string;
  placeholder: string;
  href: string;
}

export const API_KEY_CARDS: ApiKeyConfig[] = [
  { field: 'anthropic_api_key', label: 'Anthropic', desc: 'Claude Sonnet, Opus, Haiku.', placeholder: 'sk-ant-...', href: 'https://console.anthropic.com/settings/keys' },
  { field: 'openai_api_key', label: 'OpenAI', desc: 'GPT-5.4, GPT-5.4 Mini, o-series reasoning models.', placeholder: 'sk-...', href: 'https://platform.openai.com/api-keys' },
  { field: 'google_api_key', label: 'Google', desc: 'Gemini 3 Pro, Gemini 3 Flash, Gemini 2.5 Pro.', placeholder: 'AIza...', href: 'https://aistudio.google.com/apikey' },
  { field: 'openrouter_api_key', label: 'OpenRouter', desc: '300+ models from xAI, Meta, DeepSeek, Mistral, Qwen, and more.', placeholder: 'sk-or-...', href: 'https://openrouter.ai/keys' },
];

const ApiKeyCard: React.FC<{
  config: ApiKeyConfig;
  form: AppSettings;
  setForm: React.Dispatch<React.SetStateAction<AppSettings>>;
  showApiKey: boolean;
  setShowApiKey: (v: boolean) => void;
  styles: SettingsStyles;
}> = ({ config, form, setForm, showApiKey, setShowApiKey, styles }) => {
  const c = useClaudeTokens();
  const { fieldSx, descSx, labelSx } = styles;
  const value = form[config.field] as string | null | undefined;
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography sx={labelSx}>{config.label}</Typography>
        {value ? (
          <Typography sx={{ fontSize: '0.6rem', fontWeight: 600, color: c.status.success, bgcolor: `${c.status.success}15`, px: 0.75, py: 0.15, borderRadius: '3px' }}>CONNECTED</Typography>
        ) : null}
      </Box>
      <Typography sx={{ ...descSx, mb: 1 }}>{config.desc}</Typography>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        <TextField
          type={showApiKey ? 'text' : 'password'}
          value={value ?? ''}
          onChange={(e) => setForm({ ...form, [config.field]: e.target.value || null })}
          size="small"
          fullWidth
          placeholder={config.placeholder}
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
          href={config.href}
          target="_blank"
          rel="noopener"
          sx={{ color: c.accent.primary, fontSize: '0.72rem', whiteSpace: 'nowrap', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 0.3, '&:hover': { textDecoration: 'underline' } }}
        >
          Get key <OpenInNewIcon sx={{ fontSize: 11 }} />
        </Typography>
      </Box>
    </Box>
  );
};

export default ApiKeyCard;
