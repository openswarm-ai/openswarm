import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import RestoreIcon from '@mui/icons-material/Restore';
import { Mode } from '@/shared/state/modesSlice';
import RichPromptEditor from '@/app/components/RichPromptEditor';
import { ModeForm, ICON_MAP, ICON_OPTIONS, COLOR_OPTIONS } from './modesConstants';
import ToolsSelector from './ToolsSelector';

interface ModeFormDialogProps {
  open: boolean;
  onClose: () => void;
  editingId: string | null;
  editingIsBuiltin: boolean;
  hasDiverged: boolean;
  form: ModeForm;
  setForm: React.Dispatch<React.SetStateAction<ModeForm>>;
  onSave: () => void;
  onReset: () => void;
  otherModes: Mode[];
  mcpToolNames: string[];
  browseFolder: () => void;
  c: any;
}

const ModeFormDialog: React.FC<ModeFormDialogProps> = ({
  open, onClose, editingId, editingIsBuiltin, hasDiverged,
  form, setForm, onSave, onReset, otherModes, mcpToolNames,
  browseFolder, c,
}) => (
  <>
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: { bgcolor: c.bg.surface, backgroundImage: 'none', borderRadius: 4, border: `1px solid ${c.border.subtle}` },
      }}
    >
      <DialogTitle sx={{ color: c.text.primary, fontWeight: 600 }}>
        {editingId ? 'Edit Mode' : 'New Mode'}
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        <TextField
          label="Name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          fullWidth
          size="small"
          sx={{ '& .MuiOutlinedInput-root': { bgcolor: c.bg.page } }}
        />
        <TextField
          label="Description"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          fullWidth
          size="small"
          sx={{ '& .MuiOutlinedInput-root': { bgcolor: c.bg.page } }}
        />
        <RichPromptEditor
          label="System Prompt"
          value={form.system_prompt}
          onChange={(v) => setForm({ ...form, system_prompt: v })}
          placeholder="Instructions for the agent when using this mode... (@ for context, / for commands)"
          minRows={3}
          maxRows={8}
        />

        <ToolsSelector form={form} setForm={setForm} mcpToolNames={mcpToolNames} c={c} />

        <FormControl fullWidth size="small">
          <InputLabel sx={{ color: c.text.tertiary }}>Default Next Mode</InputLabel>
          <Select
            value={form.default_next_mode}
            label="Default Next Mode"
            onChange={(e) => setForm({ ...form, default_next_mode: e.target.value })}
            sx={{ bgcolor: c.bg.page }}
            MenuProps={{ PaperProps: { sx: { bgcolor: c.bg.surface, color: c.text.primary } } }}
          >
            <MenuItem value="">
              <em>None</em>
            </MenuItem>
            {otherModes.map((m) => (
              <MenuItem key={m.id} value={m.id}>{m.name}</MenuItem>
            ))}
          </Select>
        </FormControl>

        <Box>
          <Typography sx={{ color: c.text.secondary, fontSize: '0.85rem', mb: 0.75 }}>
            Default Folder
          </Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField
              value={form.default_folder}
              onChange={(e) => setForm({ ...form, default_folder: e.target.value })}
              fullWidth
              size="small"
              placeholder="Not set (uses global default)"
              sx={{
                '& .MuiOutlinedInput-root': {
                  bgcolor: c.bg.page,
                  fontFamily: 'monospace',
                  fontSize: '0.85rem',
                },
              }}
            />
            <Button
              variant="outlined"
              onClick={browseFolder}
              startIcon={<FolderOpenIcon />}
              sx={{
                color: c.accent.primary,
                borderColor: c.border.medium,
                textTransform: 'none',
                whiteSpace: 'nowrap',
                minWidth: 'auto',
              }}
            >
              Browse
            </Button>
          </Box>
        </Box>

        <Box sx={{ display: 'flex', gap: 2 }}>
          <FormControl size="small" sx={{ flex: 1 }}>
            <InputLabel sx={{ color: c.text.tertiary }}>Icon</InputLabel>
            <Select
              value={form.icon}
              label="Icon"
              onChange={(e) => setForm({ ...form, icon: e.target.value })}
              sx={{ bgcolor: c.bg.page }}
              MenuProps={{ PaperProps: { sx: { bgcolor: c.bg.surface, color: c.text.primary } } }}
            >
              {ICON_OPTIONS.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    {ICON_MAP[opt.value]}
                    <span>{opt.label}</span>
                  </Box>
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ flex: 1 }}>
            <InputLabel sx={{ color: c.text.tertiary }}>Color</InputLabel>
            <Select
              value={form.color}
              label="Color"
              onChange={(e) => setForm({ ...form, color: e.target.value })}
              sx={{ bgcolor: c.bg.page }}
              MenuProps={{ PaperProps: { sx: { bgcolor: c.bg.surface, color: c.text.primary } } }}
            >
              {COLOR_OPTIONS.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Box sx={{ width: 14, height: 14, borderRadius: '50%', bgcolor: opt.value }} />
                    <span>{opt.label}</span>
                  </Box>
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, justifyContent: 'space-between' }}>
        <Box>
          {editingIsBuiltin && (
            <Tooltip title={hasDiverged ? 'Restore this mode to its original built-in defaults' : 'Mode matches built-in defaults'}>
              <span>
                <Button
                  startIcon={<RestoreIcon sx={{ fontSize: 16 }} />}
                  onClick={onReset}
                  disabled={!hasDiverged}
                  sx={{
                    color: hasDiverged ? c.text.muted : c.text.ghost,
                    textTransform: 'none',
                    fontSize: '0.82rem',
                    '&:hover': hasDiverged ? { color: c.status.error, bgcolor: `${c.status.error}10` } : {},
                  }}
                >
                  Reset to Default
                </Button>
              </span>
            </Tooltip>
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button onClick={onClose} sx={{ color: c.text.tertiary, textTransform: 'none' }}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={onSave}
            disabled={!form.name}
            sx={{
              bgcolor: c.accent.primary,
              '&:hover': { bgcolor: c.accent.pressed },
              textTransform: 'none',
              borderRadius: 2,
            }}
          >
            {editingId ? 'Save Changes' : 'Create Mode'}
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  </>
);

export default ModeFormDialog;
