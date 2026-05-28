import React from 'react';
import { report } from '@/shared/serviceClient';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Switch from '@mui/material/Switch';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { closeSettingsModal, AppSettings } from '@/shared/state/settingsSlice';
import { onboardingBus } from '@/app/components/Onboarding/eventBus';
import { resetTour } from '@/shared/state/onboardingProgressSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import TrustedFilePatterns from '@/app/components/overlays/TrustedFilePatterns';
import SoftwareUpdateRow from './SoftwareUpdateRow';
import type { SettingsStyles } from '../settingsStyles';

const GeneralAdvanced: React.FC<{
  form: AppSettings;
  setForm: React.Dispatch<React.SetStateAction<AppSettings>>;
  styles: SettingsStyles;
}> = ({ form, setForm, styles }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const appVersion = useAppSelector((s) => s.update.appVersion);
  const { sectionSx, rowSx, inlineRowSx, inlineRowLastSx, labelSx, descSx } = styles;

  return (
    <>
      <Typography sx={{ ...sectionSx, mt: 3 }}>Advanced</Typography>

      <Box sx={inlineRowSx}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Developer mode</Typography>
          <Typography sx={descSx}>Show transport details, environment variables, raw configs, and other technical metadata throughout the app.</Typography>
        </Box>
        <Switch
          checked={form.dev_mode}
          onChange={(e) => setForm({ ...form, dev_mode: e.target.checked })}
          sx={{
            '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
            '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
          }}
        />
      </Box>

      <Box sx={inlineRowLastSx}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Experimental updates</Typography>
          <Typography sx={descSx}>Receive pre-release builds with new features earlier. These versions may be less stable than normal releases.</Typography>
        </Box>
        <Switch
          checked={form.allow_experimental_updates}
          onChange={(e) => setForm({ ...form, allow_experimental_updates: e.target.checked })}
          sx={{
            '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
            '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
          }}
        />
      </Box>

      <Typography sx={{ ...sectionSx, mt: 3 }}>About</Typography>

      <Box sx={rowSx}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box>
            <Typography sx={labelSx}>Version</Typography>
            <Typography sx={{ ...descSx, fontFamily: c.font.mono }}>
              {appVersion ?? '-'}
            </Typography>
          </Box>
        </Box>
      </Box>

      <SoftwareUpdateRow styles={styles} />

      <TrustedFilePatterns />

      <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Box>
          <Typography sx={{ ...labelSx, mb: 0.25 }}>Onboarding tour</Typography>
          <Typography sx={{ ...descSx, mb: 0 }}>
            Re-run the Show me walkthrough at any time.
          </Typography>
        </Box>
        <Button
          variant="outlined"
          size="small"
          data-onboarding="settings-restart-tour"
          onClick={() => {
            report('onboarding_v2', 'tour_restarted');
            try {
              window.localStorage.removeItem('openswarm.onboarding.v2');
            } catch { /* ignore */ }
            dispatch(resetTour());
            dispatch(closeSettingsModal());
            onboardingBus.emit('settings:closed');
          }}
          sx={{
            color: c.text.secondary,
            borderColor: c.border.medium,
            textTransform: 'none',
            fontSize: '0.8rem',
            whiteSpace: 'nowrap',
            '&:hover': { color: c.accent.primary, borderColor: c.accent.primary },
          }}
        >
          Restart tour
        </Button>
      </Box>
    </>
  );
};

export default GeneralAdvanced;
