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
import ShortcutRecorderChip, { dictationDefaultCombo, comboDisplay } from './ShortcutRecorderChip';
import DictationModelPicker from './DictationModelPicker';

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
          sx={toggleGroupSx}
        >
          <ToggleButton value={0.8}>Tiny</ToggleButton>
          <ToggleButton value={0.9}>Small</ToggleButton>
          <ToggleButton value={1}>Default</ToggleButton>
          <ToggleButton value={1.1}>Large</ToggleButton>
          <ToggleButton value={1.2}>Larger</ToggleButton>
          <ToggleButton value={1.35}>Largest</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box sx={inlineRowSx} {...settingSelectAttrs('voice_hold_to_talk', 'Dictation', 'Interface', 'Hold to talk, or tap to start and stop.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Dictation</Typography>
          <Typography sx={descSx}>{`How the mic button and the dictation shortcut (${comboDisplay(form.dictation_shortcut || dictationDefaultCombo())}) work.`}</Typography>
        </Box>
        <ToggleButtonGroup
          value={form.voice_hold_to_talk ?? true}
          exclusive
          onChange={(_, v) => {
            if (v === null) return;
            setForm({ ...form, voice_hold_to_talk: v });
            // Keyboard hold needs the native key tap; picking Hold on a Mac without the Accessibility
            // grant fires the system prompt so the choice can actually take effect after a relaunch.
            if (v) void window.openswarm?.voiceRequestHoldPermission?.();
          }}
          size="small"
          sx={toggleGroupSx}
        >
          <ToggleButton value={true}>Hold to talk</ToggleButton>
          <ToggleButton value={false}>Tap to toggle</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box sx={inlineRowSx} {...settingSelectAttrs('dictation_shortcut', 'Dictation shortcut', 'Interface', 'Global hotkey that starts dictation.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Dictation shortcut</Typography>
          <Typography sx={descSx}>Works anywhere, even with the app in the background.</Typography>
        </Box>
        <ShortcutRecorderChip
          value={form.dictation_shortcut || dictationDefaultCombo()}
          onChange={(combo) => setForm({ ...form, dictation_shortcut: combo })}
        />
      </Box>

      <Box sx={inlineRowSx} {...settingSelectAttrs('dictation_model', 'Dictation model', 'Interface', 'Speech model used for dictation; bigger is more accurate but slower.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Dictation model</Typography>
          <Typography sx={descSx}>Runs on this machine, nothing is uploaded. Bigger is more accurate but slower to transcribe.</Typography>
        </Box>
        <DictationModelPicker
          value={form.dictation_model ?? null}
          onChange={(id) => setForm({ ...form, dictation_model: id })}
        />
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

      <Box sx={inlineRowSx} {...settingSelectAttrs('new_agent_shortcut', 'New agent shortcut', 'Interface', 'Keyboard shortcut to create an agent.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>New agent shortcut</Typography>
          <Typography sx={descSx}>Keyboard shortcut to create an agent.</Typography>
        </Box>
        <ShortcutRecorderChip
          value={form.new_agent_shortcut}
          onChange={(combo) => setForm({ ...form, new_agent_shortcut: combo })}
        />
      </Box>

      <Box sx={inlineRowSx} {...settingSelectAttrs('auto_select_mode_on_new_agent', 'Auto-enable element selection', 'Interface', 'Enter element selection mode when creating a new agent.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Auto-enable element selection</Typography>
          <Typography sx={descSx}>Automatically enter element selection mode when creating a new agent.</Typography>
        </Box>
        <ToggleButtonGroup
          value={form.auto_select_mode_on_new_agent ?? false}
          exclusive
          onChange={(_, v) => { if (v !== null) setForm({ ...form, auto_select_mode_on_new_agent: v }); }}
          size="small"
          sx={toggleGroupSx}
        >
          <ToggleButton value={true}>On</ToggleButton>
          <ToggleButton value={false}>Off</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box sx={inlineRowSx} {...settingSelectAttrs('expand_new_chats_in_dashboard', 'Default agent spawn state in dashboard', 'Interface', 'New agents spawn expanded instead of collapsed.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Default agent spawn state in dashboard</Typography>
          <Typography sx={descSx}>When enabled, new agents spawn expanded instead of collapsed.</Typography>
        </Box>
        {/* Named for the state you get, not on/off: "spawn state" has no obvious on. */}
        <ToggleButtonGroup
          value={form.expand_new_chats_in_dashboard ?? false}
          exclusive
          onChange={(_, v) => { if (v !== null) setForm({ ...form, expand_new_chats_in_dashboard: v }); }}
          size="small"
          sx={toggleGroupSx}
        >
          <ToggleButton value={true}>Expanded</ToggleButton>
          <ToggleButton value={false}>Collapsed</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box sx={inlineRowLastSx} {...settingSelectAttrs('auto_reveal_sub_agents', 'Auto-reveal sub-agents on dashboard', 'Interface', 'Show sub-agent cards tethered to their parent on the dashboard.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Auto-reveal sub-agents on dashboard</Typography>
          <Typography sx={descSx}>Automatically show sub-agent cards (from CreateAgent / InvokeAgent) tethered to their parent on the dashboard.</Typography>
        </Box>
        <ToggleButtonGroup
          value={form.auto_reveal_sub_agents ?? false}
          exclusive
          onChange={(_, v) => { if (v !== null) setForm({ ...form, auto_reveal_sub_agents: v }); }}
          size="small"
          sx={toggleGroupSx}
        >
          <ToggleButton value={true}>Show</ToggleButton>
          <ToggleButton value={false}>Hide</ToggleButton>
        </ToggleButtonGroup>
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
