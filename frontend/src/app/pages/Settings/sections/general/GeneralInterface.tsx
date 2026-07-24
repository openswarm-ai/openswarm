import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Slider from '@mui/material/Slider';
import Switch from '@mui/material/Switch';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import LanguageIcon from '@mui/icons-material/Language';
import { AppSettings } from '@/shared/state/settingsSlice';
import { useClaudeTokens, useThemeWash } from '@/shared/styles/ThemeContext';
import AccentColorPad from '@/app/components/theme/AccentColorPad';
import type { SettingsStyles } from '../settingsStyles';
import { settingSelectAttrs } from '../settingSelect';

const GeneralInterface: React.FC<{
  form: AppSettings;
  setForm: React.Dispatch<React.SetStateAction<AppSettings>>;
  styles: SettingsStyles;
}> = ({ form, setForm, styles }) => {
  const c = useClaudeTokens();
  const { washOpacity, grain, setWashOpacity, setGrain } = useThemeWash();
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const { fieldSx, sectionSx, rowSx, rowLastSx, inlineRowSx, inlineRowLastSx, labelSx, descSx } = styles;

  return (
    <>
      <Typography sx={{ ...sectionSx, mt: 3 }}>Interface</Typography>

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
          sx={{
            '& .MuiToggleButton-root': {
              color: c.text.muted,
              borderColor: c.border.medium,
              textTransform: 'none',
              px: 2,
              py: 0.5,
              gap: 0.5,
              fontSize: '0.8125rem',
              '&.Mui-selected': {
                bgcolor: `${c.accent.primary}15`,
                color: c.accent.primary,
                borderColor: c.accent.primary,
                '&:hover': { bgcolor: `${c.accent.primary}20` },
              },
            },
          }}
        >
          <ToggleButton value="light">
            <LightModeIcon sx={{ fontSize: 16 }} /> Light
          </ToggleButton>
          <ToggleButton value="dark">
            <DarkModeIcon sx={{ fontSize: 16 }} /> Dark
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box sx={inlineRowSx} {...settingSelectAttrs('ui_font_scale', 'Text size', 'Interface', 'Scales all text across the app; layout stays intact.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Text size</Typography>
          <Typography sx={descSx}>Scales all text across the app. Layout stays intact.</Typography>
        </Box>
        <ToggleButtonGroup
          value={form.ui_font_scale ?? 1}
          exclusive
          onChange={(_, v) => { if (v) setForm({ ...form, ui_font_scale: v }); }}
          size="small"
          sx={{
            '& .MuiToggleButton-root': {
              color: c.text.muted,
              borderColor: c.border.medium,
              textTransform: 'none',
              px: 1.75,
              py: 0.5,
              fontSize: '0.8125rem',
              '&.Mui-selected': {
                bgcolor: `${c.accent.primary}15`,
                color: c.accent.primary,
                borderColor: c.accent.primary,
                '&:hover': { bgcolor: `${c.accent.primary}20` },
              },
            },
          }}
        >
          <ToggleButton value={0.9}>Small</ToggleButton>
          <ToggleButton value={1}>Default</ToggleButton>
          <ToggleButton value={1.1}>Large</ToggleButton>
          <ToggleButton value={1.2}>Largest</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box sx={inlineRowSx} {...settingSelectAttrs('voice_hold_to_talk', 'Dictation', 'Interface', 'Hold to talk, or tap to start and stop.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Dictation</Typography>
          <Typography sx={descSx}>How the mic button works. The mic key (F5) starts and stops.</Typography>
        </Box>
        <ToggleButtonGroup
          value={form.voice_hold_to_talk ?? true}
          exclusive
          onChange={(_, v) => { if (v !== null) setForm({ ...form, voice_hold_to_talk: v }); }}
          size="small"
          sx={{
            '& .MuiToggleButton-root': {
              color: c.text.muted,
              borderColor: c.border.medium,
              textTransform: 'none',
              px: 1.75,
              py: 0.5,
              fontSize: '0.8125rem',
              '&.Mui-selected': {
                bgcolor: `${c.accent.primary}15`,
                color: c.accent.primary,
                borderColor: c.accent.primary,
                '&:hover': { bgcolor: `${c.accent.primary}20` },
              },
            },
          }}
        >
          <ToggleButton value={true}>Hold to talk</ToggleButton>
          <ToggleButton value={false}>Tap to toggle</ToggleButton>
        </ToggleButtonGroup>
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
        />
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

      <Box sx={inlineRowSx} {...settingSelectAttrs('new_agent_shortcut', 'New agent shortcut', 'Interface', 'Keyboard shortcut to create an agent.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>New agent shortcut</Typography>
          <Typography sx={descSx}>Keyboard shortcut to create an agent.</Typography>
        </Box>
        <Box
          tabIndex={0}
          onKeyDown={(e) => {
            if (!recordingShortcut) return;
            if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return;
            e.preventDefault();
            const parts: string[] = [];
            if (e.metaKey) parts.push('Meta');
            if (e.ctrlKey) parts.push('Ctrl');
            if (e.altKey) parts.push('Alt');
            if (e.shiftKey) parts.push('Shift');
            parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
            setForm({ ...form, new_agent_shortcut: parts.join('+') });
            setRecordingShortcut(false);
          }}
          onBlur={() => setRecordingShortcut(false)}
          onClick={() => setRecordingShortcut(true)}
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.75,
            px: 1.5,
            py: 0.75,
            borderRadius: `${c.radius.sm}px`,
            border: `1px solid ${recordingShortcut ? c.accent.primary : c.border.medium}`,
            cursor: 'pointer',
            outline: 'none',
            transition: 'border-color 0.15s',
            '&:hover': { borderColor: c.accent.primary },
          }}
        >
          <KeyboardIcon sx={{ fontSize: 16, color: recordingShortcut ? c.accent.primary : c.text.tertiary }} />
          {recordingShortcut ? (
            <Typography sx={{ fontSize: '0.8125rem', color: c.accent.primary, fontWeight: 500 }}>
              Press shortcut…
            </Typography>
          ) : (
            <Typography sx={{ fontSize: '0.8125rem', color: c.text.primary, fontFamily: c.font.mono, fontWeight: 500 }}>
              {form.new_agent_shortcut
                .split('+')
                .map((p) => {
                  if (p === 'Meta') return '⌘';
                  if (p === 'Ctrl') return 'Ctrl';
                  if (p === 'Alt') return '⌥';
                  if (p === 'Shift') return '⇧';
                  return p.toUpperCase();
                })
                .join(' + ')}
            </Typography>
          )}
        </Box>
      </Box>

      <Box sx={inlineRowSx} {...settingSelectAttrs('auto_select_mode_on_new_agent', 'Auto-enable element selection', 'Interface', 'Enter element selection mode when creating a new agent.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Auto-enable element selection</Typography>
          <Typography sx={descSx}>Automatically enter element selection mode when creating a new agent.</Typography>
        </Box>
        <Switch
          checked={form.auto_select_mode_on_new_agent}
          onChange={(e) => setForm({ ...form, auto_select_mode_on_new_agent: e.target.checked })}
          sx={{
            '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
            '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
          }}
        />
      </Box>

      <Box sx={inlineRowSx} {...settingSelectAttrs('expand_new_chats_in_dashboard', 'Default agent spawn state in dashboard', 'Interface', 'New agents spawn expanded instead of collapsed.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Default agent spawn state in dashboard</Typography>
          <Typography sx={descSx}>When enabled, new agents spawn expanded instead of collapsed.</Typography>
        </Box>
        <Switch
          checked={form.expand_new_chats_in_dashboard}
          onChange={(e) => setForm({ ...form, expand_new_chats_in_dashboard: e.target.checked })}
          sx={{
            '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
            '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
          }}
        />
      </Box>

      <Box sx={inlineRowLastSx} {...settingSelectAttrs('auto_reveal_sub_agents', 'Auto-reveal sub-agents on dashboard', 'Interface', 'Show sub-agent cards tethered to their parent on the dashboard.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Auto-reveal sub-agents on dashboard</Typography>
          <Typography sx={descSx}>Automatically show sub-agent cards (from CreateAgent / InvokeAgent) tethered to their parent on the dashboard.</Typography>
        </Box>
        <Switch
          checked={form.auto_reveal_sub_agents}
          onChange={(e) => setForm({ ...form, auto_reveal_sub_agents: e.target.checked })}
          sx={{
            '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
            '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
          }}
        />
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

export default GeneralInterface;
