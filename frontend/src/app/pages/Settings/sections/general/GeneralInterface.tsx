import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Slider from '@mui/material/Slider';
import Switch from '@mui/material/Switch';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LanguageIcon from '@mui/icons-material/Language';
import { AppSettings } from '@/shared/state/settingsSlice';
import { useClaudeTokens, useThemeWash } from '@/shared/styles/ThemeContext';
import AccentColorPad from '@/app/components/theme/AccentColorPad';
import type { SettingsStyles } from '../settingsStyles';
import { settingSelectAttrs } from '../settingSelect';
import ShortcutRecorderChip, { dictationDefaultCombo, comboDisplay } from './parts/ShortcutRecorderChip';
import DictationModelPicker from './parts/DictationModelPicker';
import DictationHistoryList from './parts/DictationHistoryList';

const GeneralInterface: React.FC<{
  form: AppSettings;
  setForm: React.Dispatch<React.SetStateAction<AppSettings>>;
  styles: SettingsStyles;
}> = ({ form, setForm, styles }) => {
  const c = useClaudeTokens();
  const { washOpacity, grain, setWashOpacity, setGrain } = useThemeWash();
  const { fieldSx, sectionSx, rowSx, rowLastSx, inlineRowSx, inlineRowLastSx, labelSx, descSx, toggleGroupSx, switchSx } = styles;

  return (
    <>

      <Box sx={inlineRowSx} {...settingSelectAttrs('theme', 'Theme', 'Interface', 'Application color scheme.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Theme</Typography>
          <Typography sx={descSx}>Application color scheme.</Typography>
        </Box>
        <ToggleButtonGroup
          value={form.theme}
          exclusive
          onChange={(_, v) => { if (v) setForm({ ...form, theme: v }); }}
          size="small"
          sx={toggleGroupSx}
        >
          <ToggleButton value="light">
            <LightModeIcon sx={{ fontSize: 16 }} /> Light
          </ToggleButton>
          <ToggleButton value="dark">
            <DarkModeIcon sx={{ fontSize: 16 }} /> Dark
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box sx={rowSx} {...settingSelectAttrs('ui_font_scale', 'Text size', 'Interface', 'Scales all text across the app; layout stays intact.')}>
        <Typography sx={labelSx}>Text size</Typography>
        <Typography sx={{ ...descSx, mb: 1 }}>Scales all text across the app. Layout stays intact.</Typography>
        <Box sx={{ px: 1 }}>
          <Slider
            value={form.ui_font_scale ?? 1}
            onChange={(_, v) => setForm({ ...form, ui_font_scale: v as number })}
            min={0.8}
            max={1.35}
            step={0.05}
            valueLabelDisplay="auto"
            valueLabelFormat={(v) => `${Math.round(v * 100)}%`}
            marks={[
              { value: 0.8, label: 'Small' },
              { value: 1, label: 'Default' },
              { value: 1.35, label: 'Large' },
            ]}
            sx={{
              color: c.accent.primary,
              '& .MuiSlider-markLabel': { color: c.text.tertiary, fontSize: '0.6875rem' },
              '& .MuiSlider-valueLabel': { bgcolor: c.accent.primary },
            }}
          />
        </Box>
      </Box>

      <Box sx={rowSx} {...settingSelectAttrs('accent_color', 'Accent color', 'Interface', 'The accent color used across the app.')}>
        <Typography sx={labelSx}>Accent color</Typography>
        <Typography sx={{ ...descSx, mb: 1.5 }}>
          Pick any color; buttons, highlights, and glows follow it. Add a second dot for a canvas gradient. Reset returns the stock accent.
        </Typography>
        <AccentColorPad
          c={c}
          stops={form.accent_gradient ?? (form.accent_color ? [form.accent_color] : [])}
          onChange={(next) => setForm({ ...form, accent_color: next?.[0] ?? null, accent_gradient: next && next.length > 1 ? next : null })}
          height={120}
          wash={{ opacity: washOpacity, grain, onOpacity: setWashOpacity, onGrain: setGrain }}
          scheme={{
            value: form.theme === 'dark' ? 'dark' : 'light',
            onPick: (v) => setForm({ ...form, theme: v === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : v }),
          }}
        />
      </Box>

    </>
  );
};

export default GeneralInterface;
