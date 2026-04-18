import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Checkbox from '@mui/material/Checkbox';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import ListItemText from '@mui/material/ListItemText';
import OutlinedInput from '@mui/material/OutlinedInput';
import ListSubheader from '@mui/material/ListSubheader';
import ExtensionIcon from '@mui/icons-material/Extension';
import { ModeForm, ALL_BUILTIN_TOOL_NAMES } from '@/app/pages/Modes/modesConstants';

interface ToolsSelectorProps {
  form: ModeForm;
  setForm: React.Dispatch<React.SetStateAction<ModeForm>>;
  mcpToolNames: string[];
  c: any;
}

const ToolsSelector: React.FC<ToolsSelectorProps> = ({ form, setForm, mcpToolNames, c }) => (
  <Box>
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
      <Checkbox
        checked={form.toolsEnabled}
        onChange={(e) => setForm({ ...form, toolsEnabled: e.target.checked, tools: e.target.checked ? form.tools : [] })}
        size="small"
        sx={{ color: c.text.tertiary, '&.Mui-checked': { color: c.accent.primary }, p: 0 }}
      />
      <Typography sx={{ color: c.text.secondary, fontSize: '0.85rem' }}>
        Restrict actions {!form.toolsEnabled && <span style={{ color: c.text.tertiary }}>(all actions allowed)</span>}
      </Typography>
    </Box>
    {form.toolsEnabled && (
      <FormControl fullWidth size="small">
        <InputLabel sx={{ color: c.text.tertiary }}>Allowed Actions</InputLabel>
        <Select
          multiple
          value={form.tools}
          onChange={(e) => setForm({ ...form, tools: typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value })}
          input={<OutlinedInput label="Allowed Actions" />}
          renderValue={(selected) => selected.join(', ')}
          sx={{ bgcolor: c.bg.page }}
          MenuProps={{ PaperProps: { sx: { bgcolor: c.bg.surface, color: c.text.primary } } }}
        >
          <ListSubheader sx={{ bgcolor: c.bg.page, color: c.text.tertiary, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em', lineHeight: '32px' }}>
            Built-in Actions
          </ListSubheader>
          {ALL_BUILTIN_TOOL_NAMES.map((name) => (
            <MenuItem key={name} value={name}>
              <Checkbox checked={form.tools.includes(name)} size="small" sx={{ '&.Mui-checked': { color: c.accent.primary } }} />
              <ListItemText primary={name} />
            </MenuItem>
          ))}
          {mcpToolNames.length > 0 && (
            <ListSubheader sx={{ bgcolor: c.bg.page, color: '#f59e0b', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em', lineHeight: '32px', display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <ExtensionIcon sx={{ fontSize: 14 }} /> MCP Actions
            </ListSubheader>
          )}
          {mcpToolNames.map((name) => (
            <MenuItem key={name} value={name}>
              <Checkbox checked={form.tools.includes(name)} size="small" sx={{ '&.Mui-checked': { color: '#f59e0b' } }} />
              <ListItemText primary={name} primaryTypographyProps={{ sx: { display: 'flex', alignItems: 'center', gap: 0.5 } }}>
                {name}
              </ListItemText>
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    )}
  </Box>
);

export default ToolsSelector;
