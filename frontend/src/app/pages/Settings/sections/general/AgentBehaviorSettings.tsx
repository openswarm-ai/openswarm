import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { AppSettings } from '@/shared/state/settingsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { SettingsStyles } from '../settingsStyles';
import { settingSelectAttrs } from '../settingSelect';
import ShortcutRecorderChip from './parts/ShortcutRecorderChip';

const AgentBehaviorSettings: React.FC<{
  form: AppSettings;
  setForm: React.Dispatch<React.SetStateAction<AppSettings>>;
  styles: SettingsStyles;
}> = ({ form, setForm, styles }) => {
  const c = useClaudeTokens();
  const { inlineRowSx, inlineRowLastSx, labelSx, descSx, toggleGroupSx } = styles;

  return (
    <>
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
    </>
  );
};

export default AgentBehaviorSettings;
