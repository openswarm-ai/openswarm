import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Slider from '@mui/material/Slider';
import LanguageIcon from '@mui/icons-material/Language';
import { AppSettings } from '@/shared/state/settingsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { SettingsStyles } from '../settingsStyles';
import { settingSelectAttrs } from '../settingSelect';

const CanvasSettings: React.FC<{
  form: AppSettings;
  setForm: React.Dispatch<React.SetStateAction<AppSettings>>;
  styles: SettingsStyles;
}> = ({ form, setForm, styles }) => {
  const c = useClaudeTokens();
  const { fieldSx, sectionSx, rowSx, rowLastSx, inlineRowSx, labelSx, descSx, toggleGroupSx } = styles;

  return (
    <>
      <Box sx={inlineRowSx} {...settingSelectAttrs('mouse_wheel_action', 'Mouse wheel', 'Interface', 'What a mouse wheel does on the dashboard canvas.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Mouse wheel</Typography>
          <Typography sx={descSx}>
            What a plain mouse wheel does on the canvas. The other one moves to cmd/ctrl + wheel.
            A trackpad two-finger scroll always pans, and pinch always zooms.
          </Typography>
        </Box>
        <ToggleButtonGroup
          value={form.mouse_wheel_action ?? 'zoom'}
          exclusive
          onChange={(_, v) => { if (v !== null) setForm({ ...form, mouse_wheel_action: v }); }}
          size="small"
          sx={toggleGroupSx}
        >
          <ToggleButton value="zoom">Zoom</ToggleButton>
          <ToggleButton value="scroll">Scroll</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box sx={rowSx} {...settingSelectAttrs('zoom_sensitivity', 'Zoom sensitivity', 'Interface', 'Scroll-to-zoom responsiveness.')}>
        <Typography sx={labelSx}>Zoom sensitivity</Typography>
        <Typography sx={{ ...descSx, mb: 1 }}>
          Scroll-to-zoom responsiveness. Lower for trackpads, higher for mouse wheels.
        </Typography>
        <Box sx={{ px: 1 }}>
          <Slider
            value={form.zoom_sensitivity}
            onChange={(_, v) => setForm({ ...form, zoom_sensitivity: v as number })}
            min={1}
            max={100}
            step={1}
            valueLabelDisplay="auto"
            marks={[
              { value: 1, label: 'Low' },
              { value: 50, label: 'Default' },
              { value: 100, label: 'High' },
            ]}
            sx={{
              color: c.accent.primary,
              '& .MuiSlider-markLabel': { color: c.text.tertiary, fontSize: '0.6875rem' },
              '& .MuiSlider-valueLabel': { bgcolor: c.accent.primary },
            }}
          />
        </Box>
      </Box>
      <Typography sx={{ ...sectionSx, mt: 3 }}>Browser</Typography>

      <Box sx={rowLastSx} {...settingSelectAttrs('browser_homepage', 'Default homepage', 'Browser', 'URL loaded when opening a new browser card.')}>
        <Typography sx={labelSx}>Default homepage</Typography>
        <Typography sx={{ ...descSx, mb: 1.5 }}>
          URL loaded when opening a new browser card on the dashboard.
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <LanguageIcon sx={{ fontSize: 18, color: c.text.tertiary, flexShrink: 0 }} />
          <TextField
            value={form.browser_homepage}
            onChange={(e) => setForm({ ...form, browser_homepage: e.target.value })}
            size="small"
            fullWidth
            placeholder="https://www.google.com"
            sx={{
              ...fieldSx,
              '& .MuiOutlinedInput-root': {
                ...fieldSx['& .MuiOutlinedInput-root'],
                fontFamily: c.font.mono,
              },
            }}
          />
        </Box>
      </Box>
    </>
  );
};

export default CanvasSettings;
