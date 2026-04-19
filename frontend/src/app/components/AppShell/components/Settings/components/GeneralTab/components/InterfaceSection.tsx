import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Slider from '@mui/material/Slider';
import Switch from '@mui/material/Switch';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import type { UseSettingsReturn } from '../../../hooks/useSettings';

const InterfaceSection: React.FC<{ s: UseSettingsReturn }> = ({ s }) => {
  const { form, setForm, c, recordingShortcut, setRecordingShortcut,
          sectionSx, rowSx, inlineRowSx, inlineRowLastSx, labelSx, descSx } = s;
  return (
    <>
      <Typography sx={{ ...sectionSx, mt: 3 }}>Interface</Typography>
      <Box sx={inlineRowSx}>
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
              fontSize: '0.8rem',
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
      <Box sx={rowSx}>
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
              '& .MuiSlider-markLabel': { color: c.text.tertiary, fontSize: '0.7rem' },
              '& .MuiSlider-valueLabel': { bgcolor: c.accent.primary },
            }}
          />
        </Box>
      </Box>
      <Box sx={inlineRowSx}>
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
            <Typography sx={{ fontSize: '0.8rem', color: c.accent.primary, fontWeight: 500 }}>
              Press shortcut…
            </Typography>
          ) : (
            <Typography sx={{ fontSize: '0.8rem', color: c.text.primary, fontFamily: c.font.mono, fontWeight: 500 }}>
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
      <Box sx={inlineRowSx}>
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
      <Box sx={inlineRowSx}>
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
      <Box sx={inlineRowLastSx}>
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
    </>
  );
};

export default InterfaceSection;
