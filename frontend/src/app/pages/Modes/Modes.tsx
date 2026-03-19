import React, { useEffect, useState, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActions from '@mui/material/CardActions';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Checkbox from '@mui/material/Checkbox';
import ListItemText from '@mui/material/ListItemText';
import OutlinedInput from '@mui/material/OutlinedInput';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import TuneIcon from '@mui/icons-material/Tune';
import LockIcon from '@mui/icons-material/Lock';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import RestoreIcon from '@mui/icons-material/Restore';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import QuestionAnswerOutlinedIcon from '@mui/icons-material/QuestionAnswerOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import CategoryOutlinedIcon from '@mui/icons-material/CategoryOutlined';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  fetchModes,
  createMode,
  updateMode,
  deleteMode,
  resetMode,
  Mode,
} from '@/shared/state/modesSlice';
import { fetchBuiltinTools, fetchTools } from '@/shared/state/toolsSlice';
import { fetchTemplates } from '@/shared/state/templatesSlice';
import { fetchSkills } from '@/shared/state/skillsSlice';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ExtensionIcon from '@mui/icons-material/Extension';
import ListSubheader from '@mui/material/ListSubheader';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import DirectoryBrowser from '@/app/components/DirectoryBrowser';
import RichPromptEditor from '@/app/components/RichPromptEditor';

const ICON_MAP: Record<string, React.ReactNode> = {
  smart_toy: <SmartToyOutlinedIcon sx={{ fontSize: 20 }} />,
  question_answer: <QuestionAnswerOutlinedIcon sx={{ fontSize: 20 }} />,
  map: <MapOutlinedIcon sx={{ fontSize: 20 }} />,
  category: <CategoryOutlinedIcon sx={{ fontSize: 20 }} />,
  tune: <TuneIcon sx={{ fontSize: 20 }} />,
};

const ICON_OPTIONS = [
  { value: 'smart_toy', label: 'Robot' },
  { value: 'question_answer', label: 'Q&A' },
  { value: 'map', label: 'Map' },
  { value: 'category', label: 'Category' },
  { value: 'tune', label: 'Tune' },
];

const COLOR_OPTIONS = [
  { value: '#ae5630', label: 'Terra Cotta' },
  { value: '#4ade80', label: 'Green' },
  { value: '#fbbf24', label: 'Amber' },
  { value: '#f87171', label: 'Red' },
  { value: '#38bdf8', label: 'Sky' },
  { value: '#c084fc', label: 'Purple' },
  { value: '#fb923c', label: 'Orange' },
  { value: '#2dd4bf', label: 'Teal' },
];

interface ModeForm {
  name: string;
  description: string;
  system_prompt: string;
  tools: string[];
  toolsEnabled: boolean;
  default_next_mode: string;
  icon: string;
  color: string;
  default_folder: string;
}

const emptyForm: ModeForm = {
  name: '',
  description: '',
  system_prompt: '',
  tools: [],
  toolsEnabled: false,
  default_next_mode: '',
  icon: 'smart_toy',
  color: '#ae5630',
  default_folder: '',
};

const ALL_BUILTIN_TOOL_NAMES = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'AskUserQuestion'];

const Modes: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const { items, builtinDefaults, loading } = useAppSelector((s) => s.modes);
  const toolItems = useAppSelector((s) => s.tools.items);
  const modes = useMemo(() => Object.values(items), [items]);

  const mcpToolNames = useMemo(() => {
    return Object.values(toolItems)
      .filter((t) => t.mcp_config && Object.keys(t.mcp_config).length > 0 && t.auth_status !== 'none')
      .map((t) => `mcp:${t.name}`);
  }, [toolItems]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ModeForm>(emptyForm);
  const [browseOpen, setBrowseOpen] = useState(false);

  useEffect(() => {
    dispatch(fetchModes());
    dispatch(fetchBuiltinTools());
    dispatch(fetchTools());
    dispatch(fetchTemplates());
    dispatch(fetchSkills());
  }, [dispatch]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (mode: Mode) => {
    setEditingId(mode.id);
    setForm({
      name: mode.name,
      description: mode.description,
      system_prompt: mode.system_prompt ?? '',
      tools: mode.tools ?? [],
      toolsEnabled: mode.tools !== null,
      default_next_mode: mode.default_next_mode ?? '',
      icon: mode.icon,
      color: mode.color,
      default_folder: mode.default_folder ?? '',
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const payload = {
      name: form.name,
      description: form.description,
      system_prompt: form.system_prompt || null,
      tools: form.toolsEnabled ? form.tools : null,
      default_next_mode: form.default_next_mode || null,
      icon: form.icon,
      color: form.color,
      default_folder: form.default_folder || null,
    };

    if (editingId) {
      await dispatch(updateMode({ id: editingId, ...payload }));
    } else {
      await dispatch(createMode(payload as any));
    }
    setDialogOpen(false);
  };

  const handleDelete = async (id: string) => {
    await dispatch(deleteMode(id));
  };

  const editingIsBuiltin = editingId ? items[editingId]?.is_builtin ?? false : false;

  const hasDiverged = useMemo(() => {
    if (!editingId || !editingIsBuiltin) return false;
    const defaults = builtinDefaults[editingId];
    if (!defaults) return false;
    const current = items[editingId];
    if (!current) return false;
    return (
      current.name !== defaults.name ||
      current.description !== defaults.description ||
      (current.system_prompt ?? '') !== (defaults.system_prompt ?? '') ||
      JSON.stringify(current.tools) !== JSON.stringify(defaults.tools) ||
      (current.default_next_mode ?? '') !== (defaults.default_next_mode ?? '') ||
      current.icon !== defaults.icon ||
      current.color !== defaults.color ||
      (current.default_folder ?? '') !== (defaults.default_folder ?? '')
    );
  }, [editingId, editingIsBuiltin, items, builtinDefaults]);

  const handleReset = async () => {
    if (!editingId) return;
    const action = await dispatch(resetMode(editingId));
    if (resetMode.fulfilled.match(action)) {
      const m = action.payload;
      setForm({
        name: m.name,
        description: m.description,
        system_prompt: m.system_prompt ?? '',
        tools: m.tools ?? [],
        toolsEnabled: m.tools !== null,
        default_next_mode: m.default_next_mode ?? '',
        icon: m.icon,
        color: m.color,
        default_folder: m.default_folder ?? '',
      });
    }
  };

  const otherModes = modes.filter((m) => m.id !== editingId);

  return (
    <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Box>
          <Typography variant="h5" sx={{ color: c.text.primary, fontWeight: 700, mb: 0.5 }}>
            Modes
          </Typography>
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.9rem' }}>
            Configure agent interaction modes with custom system prompts, actions, and auto-switching.
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={openCreate}
          sx={{
            bgcolor: c.accent.primary,
            '&:hover': { bgcolor: c.accent.pressed },
            textTransform: 'none',
            borderRadius: 2,
          }}
        >
          New Mode
        </Button>
      </Box>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}>
          <CircularProgress sx={{ color: c.accent.primary }} />
        </Box>
      ) : modes.length === 0 ? (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            py: 8,
            color: c.text.ghost,
            gap: 2,
          }}
        >
          <TuneIcon sx={{ fontSize: 48, opacity: 0.4 }} />
          <Typography>No modes defined yet. Create one to get started.</Typography>
        </Box>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
            gap: 2,
          }}
        >
          {modes.map((mode) => (
            <Card
              key={mode.id}
              sx={{
                bgcolor: c.bg.surface,
                border: `1px solid ${c.border.subtle}`,
                borderRadius: 2,
                boxShadow: c.shadow.sm,
                '&:hover': { borderColor: mode.color, boxShadow: c.shadow.md },
                transition: 'border-color 0.2s, box-shadow 0.2s',
              }}
            >
              <CardContent sx={{ pb: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
                  <Box sx={{ color: mode.color, display: 'flex', alignItems: 'center' }}>
                    {ICON_MAP[mode.icon] || ICON_MAP.smart_toy}
                  </Box>
                  <Typography variant="h6" sx={{ color: c.text.primary, fontWeight: 600, fontSize: '1rem', flex: 1 }}>
                    {mode.name}
                  </Typography>
                  {mode.is_builtin && (
                    <Chip
                      icon={<LockIcon sx={{ fontSize: 12 }} />}
                      label="Built-in"
                      size="small"
                      sx={{ bgcolor: c.bg.secondary, color: c.text.muted, fontSize: '0.7rem', height: 22 }}
                    />
                  )}
                </Box>
                {mode.description && (
                  <Typography sx={{ color: c.text.muted, fontSize: '0.85rem', mb: 1.5 }}>
                    {mode.description}
                  </Typography>
                )}
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                  {mode.tools !== null ? (
                    <Chip
                      label={`${mode.tools.length} action${mode.tools.length !== 1 ? 's' : ''}`}
                      size="small"
                      sx={{ bgcolor: `${mode.color}18`, color: mode.color, fontSize: '0.75rem', height: 24 }}
                    />
                  ) : (
                    <Chip
                      label="All actions"
                      size="small"
                      sx={{ bgcolor: `${mode.color}18`, color: mode.color, fontSize: '0.75rem', height: 24 }}
                    />
                  )}
                  {mode.system_prompt && (
                    <Chip
                      label="System prompt"
                      size="small"
                      sx={{ bgcolor: 'rgba(174,86,48,0.15)', color: c.accent.hover, fontSize: '0.75rem', height: 24 }}
                    />
                  )}
                  {mode.default_next_mode && (
                    <Chip
                      icon={<ArrowForwardIcon sx={{ fontSize: 12 }} />}
                      label={items[mode.default_next_mode]?.name || mode.default_next_mode}
                      size="small"
                      sx={{ bgcolor: 'rgba(251,191,36,0.15)', color: '#fbbf24', fontSize: '0.75rem', height: 24 }}
                    />
                  )}
                  {mode.default_folder && (
                    <Chip
                      icon={<FolderOpenIcon sx={{ fontSize: 12 }} />}
                      label={mode.default_folder.split('/').pop() || mode.default_folder}
                      size="small"
                      sx={{ bgcolor: 'rgba(56,189,248,0.15)', color: '#38bdf8', fontSize: '0.75rem', height: 24 }}
                    />
                  )}
                </Box>
              </CardContent>
              <CardActions sx={{ justifyContent: 'flex-end', px: 2, pb: 1.5 }}>
                <Tooltip title="Edit">
                  <IconButton size="small" onClick={() => openEdit(mode)} sx={{ color: c.text.tertiary, '&:hover': { color: c.accent.primary } }}>
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                {!mode.is_builtin && (
                  <Tooltip title="Delete">
                    <IconButton size="small" onClick={() => handleDelete(mode.id)} sx={{ color: c.text.tertiary, '&:hover': { color: c.status.error } }}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </CardActions>
            </Card>
          ))}
        </Box>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
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

          {/* Tools toggle + multi-select */}
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
                  <ListSubheader sx={{ bgcolor: c.bg.page, color: c.text.tertiary, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em', lineHeight: '32px' }}>Built-in Actions</ListSubheader>
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

          {/* Default Folder */}
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
                onClick={() => setBrowseOpen(true)}
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
                    onClick={handleReset}
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
            <Button onClick={() => setDialogOpen(false)} sx={{ color: c.text.tertiary, textTransform: 'none' }}>
              Cancel
            </Button>
            <Button
              variant="contained"
              onClick={handleSave}
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

      <DirectoryBrowser
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        onSelect={(item) => setForm({ ...form, default_folder: item.path })}
        initialPath={form.default_folder || ''}
      />
    </Box>
  );
};

export default Modes;
