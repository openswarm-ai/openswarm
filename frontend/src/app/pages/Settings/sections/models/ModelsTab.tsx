import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { AppSettings } from '@/shared/state/settingsSlice';
import OpenSwarmProCard from '../subscription/OpenSwarmProCard';
import SubscriptionCards from '../subscription/SubscriptionCards';
import ApiKeyCard, { API_KEY_CARDS } from './ApiKeyCard';
import CustomProvidersEditor from './CustomProvidersEditor';
import type { SettingsStyles } from '../settingsStyles';

const ModelsTab: React.FC<{
  form: AppSettings;
  setForm: React.Dispatch<React.SetStateAction<AppSettings>>;
  showApiKey: boolean;
  setShowApiKey: (v: boolean) => void;
  styles: SettingsStyles;
}> = ({ form, setForm, showApiKey, setShowApiKey, styles }) => {
  const c = useClaudeTokens();
  const { descSx } = styles;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', pt: 2.5, pb: 1, gap: 2.5, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>

      <Box data-onboarding="settings-pro-section" sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Typography sx={{ fontSize: '0.7rem', color: c.text.ghost, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
          One Subscription, No Setup
        </Typography>

        <Typography sx={{ ...descSx, mb: 0 }}>
          Don't have a Claude account? We'll handle it for you. One simple subscription covers Claude Sonnet, Opus, and Haiku.
        </Typography>

        <OpenSwarmProCard />
      </Box>

      <Box data-onboarding="settings-external-subs" sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Typography sx={{ fontSize: '0.7rem', color: c.text.ghost, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, mt: 1 }}>
          Or Use Your Existing Subscriptions
        </Typography>

        <Typography sx={{ ...descSx, mb: 0 }}>
          Already paying for Claude, ChatGPT, or Gemini? Connect your subscription, no API key needed, no extra cost.
        </Typography>

        <SubscriptionCards />
      </Box>

      <Box data-onboarding="settings-api-keys" sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Typography sx={{ fontSize: '0.7rem', color: c.text.ghost, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, mt: 1 }}>
          Or Connect With API Keys
        </Typography>

        <Typography sx={{ ...descSx, mb: -1 }}>
          Pay per use. Each key is stored locally on your device.
        </Typography>

        {API_KEY_CARDS.map((config) => (
          <ApiKeyCard
            key={config.field}
            config={config}
            form={form}
            setForm={setForm}
            showApiKey={showApiKey}
            setShowApiKey={setShowApiKey}
            styles={styles}
          />
        ))}

        <CustomProvidersEditor
          form={form}
          setForm={setForm}
          showApiKey={showApiKey}
          setShowApiKey={setShowApiKey}
          styles={styles}
        />
      </Box>

    </Box>
  );
};

export default ModelsTab;
