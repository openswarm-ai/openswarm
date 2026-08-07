import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Slider from '@mui/material/Slider';
import Switch from '@mui/material/Switch';
import { AppSettings } from '@/shared/state/settingsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { SettingsStyles } from '../settingsStyles';
import { settingSelectAttrs } from '../settingSelect';
import ShortcutRecorderChip, { dictationDefaultCombo, comboDisplay } from './parts/ShortcutRecorderChip';
import DictationModelPicker from './parts/DictationModelPicker';
import DictationHistoryList from './parts/DictationHistoryList';

const DictationSettings: React.FC<{
  form: AppSettings;
  setForm: React.Dispatch<React.SetStateAction<AppSettings>>;
  styles: SettingsStyles;
}> = ({ form, setForm, styles }) => {
  const c = useClaudeTokens();
  const { inlineRowSx, labelSx, descSx, toggleGroupSx } = styles;

  return (
    <>

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
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {form.dictation_shortcut ? (
            <Typography
              onClick={() => setForm({ ...form, dictation_shortcut: null })}
              sx={{ fontSize: '0.75rem', color: 'text.secondary', cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}
            >
              Reset to {comboDisplay(dictationDefaultCombo())}
            </Typography>
          ) : null}
          <ShortcutRecorderChip
            value={form.dictation_shortcut || dictationDefaultCombo()}
            onChange={(combo) => setForm({ ...form, dictation_shortcut: combo })}
          />
        </Box>
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

      <Box sx={inlineRowSx} {...settingSelectAttrs('dictation_dictionary', 'Dictation dictionary', 'Interface', 'Names and jargon dictation should always spell right.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Dictionary</Typography>
          <Typography sx={descSx}>Comma-separated names and jargon (people, products, acronyms) that dictation should always spell right.</Typography>
        </Box>
        <TextField
          size="small"
          placeholder="Anthropic, Kubernetes, OpenSwarm"
          value={form.dictation_dictionary ?? ''}
          onChange={(e) => setForm({ ...form, dictation_dictionary: e.target.value })}
          sx={{ width: 280 }}
        />
      </Box>

      <Box sx={inlineRowSx} {...settingSelectAttrs('dictation_sounds', 'Dictation sounds', 'Interface', 'The start and stop cues.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Sounds</Typography>
          <Typography sx={descSx}>The start and stop cues, and how loud they play.</Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Slider
            size="small"
            min={0}
            max={100}
            disabled={!(form.dictation_sounds ?? true)}
            value={Math.round((form.dictation_sound_volume ?? 0.7) * 100)}
            onChange={(_, v) => setForm({ ...form, dictation_sound_volume: (v as number) / 100 })}
            sx={{ width: 110 }}
          />
          <Switch
            size="small"
            checked={form.dictation_sounds ?? true}
            onChange={(e) => setForm({ ...form, dictation_sounds: e.target.checked })}
          />
        </Box>
      </Box>

      <Box sx={inlineRowSx} {...settingSelectAttrs('dictation_haptics', 'Dictation haptics', 'Interface', 'Trackpad taps on start and stop.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Haptics</Typography>
          <Typography sx={descSx}>Trackpad taps when dictation starts and stops.</Typography>
        </Box>
        <Switch
          size="small"
          checked={form.dictation_haptics ?? true}
          onChange={(e) => setForm({ ...form, dictation_haptics: e.target.checked })}
        />
      </Box>

      <Box sx={inlineRowSx} {...settingSelectAttrs('dictation_disabled_surfaces', 'Dictation off for sites', 'Interface', 'Sites where the dictation key does nothing.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Off for sites</Typography>
          <Typography sx={descSx}>Comma-separated hostnames where the dictation key refuses to record (it tells you instead of failing silently).</Typography>
        </Box>
        <TextField
          size="small"
          placeholder="docs.google.com, slack.com"
          value={form.dictation_disabled_surfaces ?? ''}
          onChange={(e) => setForm({ ...form, dictation_disabled_surfaces: e.target.value })}
          sx={{ width: 280 }}
        />
      </Box>

      <Box sx={{ ...inlineRowSx, alignItems: 'flex-start' }} {...settingSelectAttrs('dictation_history', 'Dictation history', 'Interface', 'Your recent dictations, copyable.')}>
        <Box sx={{ mr: 3, flexShrink: 0, width: 220 }}>
          <Typography sx={labelSx}>History</Typography>
          <Typography sx={descSx}>Recent dictations, stored only on this machine. Copy one back if it landed in the wrong place.</Typography>
        </Box>
        <DictationHistoryList />
      </Box>

    </>
  );
};

export default DictationSettings;
