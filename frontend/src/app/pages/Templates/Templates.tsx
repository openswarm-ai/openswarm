import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  fetchTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  PromptTemplate,
  TemplateField,
} from '@/shared/state/templatesSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const FIELD_TYPES = ['str', 'int', 'float', 'select', 'multi-select', 'literal'] as const;

interface EditorState {
  name: string;
  description: string;
  template: string;
  fields: TemplateField[];
  tags: string[];
}

const emptyEditor: EditorState = {
  name: '',
  description: '',
  template: '',
  fields: [],
  tags: [],
};

const Templates: React.FC = () => {
  const c = useClaudeTokens();

  const inputSx = {
    '& .MuiOutlinedInput-root': {
      color: c.text.primary,
      '& fieldset': { borderColor: c.border.strong },
      '&:hover fieldset': { borderColor: c.text.tertiary },
      '&.Mui-focused fieldset': { borderColor: c.accent.primary },
    },
    '& .MuiInputLabel-root': { color: c.text.tertiary },
    '& .MuiInputLabel-root.Mui-focused': { color: c.accent.primary },
  };

  const claudePaperProps = {
    sx: {
      bgcolor: c.bg.surface,
      color: c.text.primary,
      borderRadius: 4,
      border: `1px solid ${c.border.subtle}`,
      maxHeight: '90vh',
    },
  };

  const dispatch = useAppDispatch();
  const { items, loading } = useAppSelector((s) => s.templates);
  const templates = Object.values(items);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(emptyEditor);
  const [tagInput, setTagInput] = useState('');

  useEffect(() => {
    dispatch(fetchTemplates());
  }, [dispatch]);

  const openNew = () => {
    setEditingId(null);
    setEditor(emptyEditor);
    setTagInput('');
    setEditorOpen(true);
  };

  const openEdit = (t: PromptTemplate) => {
    setEditingId(t.id);
    setEditor({
      name: t.name,
      description: t.description,
      template: t.template,
      fields: t.fields.map((f) => ({ ...f })),
      tags: [...t.tags],
    });
    setTagInput('');
    setEditorOpen(true);
  };

  const handleSave = async () => {
    if (!editor.name.trim() || !editor.template.trim()) return;
    if (editingId) {
      await dispatch(updateTemplate({ id: editingId, ...editor }));
    } else {
      await dispatch(createTemplate(editor));
    }
    setEditorOpen(false);
  };

  const handleDelete = async (id: string) => {
    await dispatch(deleteTemplate(id));
  };

  const addField = () => {
    setEditor((prev) => ({
      ...prev,
      fields: [...prev.fields, { name: '', type: 'str', required: true }],
    }));
  };

  const updateField = (idx: number, patch: Partial<TemplateField>) => {
    setEditor((prev) => ({
      ...prev,
      fields: prev.fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)),
    }));
  };

  const removeField = (idx: number) => {
    setEditor((prev) => ({
      ...prev,
      fields: prev.fields.filter((_, i) => i !== idx),
    }));
  };

  const addTag = () => {
    const tag = tagInput.trim();
    if (tag && !editor.tags.includes(tag)) {
      setEditor((prev) => ({ ...prev, tags: [...prev.tags, tag] }));
      setTagInput('');
    }
  };

  const removeTag = (tag: string) => {
    setEditor((prev) => ({ ...prev, tags: prev.tags.filter((t) => t !== tag) }));
  };

  return (
    <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Box>
          <Typography variant="h5" sx={{ color: c.text.primary, fontWeight: 700, mb: 0.5 }}>
            Prompt Templates
          </Typography>
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.85rem' }}>
            Create and manage reusable prompt templates with structured input fields.
          </Typography>
        </Box>
        <Button
          startIcon={<AddIcon />}
          variant="contained"
          onClick={openNew}
          sx={{
            bgcolor: c.accent.primary,
            '&:hover': { bgcolor: c.accent.pressed },
            textTransform: 'none',
            fontWeight: 600,
            borderRadius: 2,
          }}
        >
          New Template
        </Button>
      </Box>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}>
          <CircularProgress sx={{ color: c.accent.primary }} />
        </Box>
      ) : templates.length === 0 ? (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '50vh',
            color: c.text.ghost,
          }}
        >
          <Typography sx={{ fontSize: '1.1rem', mb: 1 }}>No templates yet</Typography>
          <Typography sx={{ fontSize: '0.85rem' }}>Click "New Template" to get started.</Typography>
        </Box>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: 2,
          }}
        >
          {templates.map((t) => (
            <Box
              key={t.id}
              sx={{
                bgcolor: c.bg.surface,
                border: `1px solid ${c.border.subtle}`,
                borderRadius: 3,
                p: 2.5,
                cursor: 'pointer',
                boxShadow: c.shadow.sm,
                transition: 'border-color 0.2s, box-shadow 0.2s',
                '&:hover': {
                  borderColor: c.accent.primary,
                  boxShadow: '0 0 0 1px rgba(174,86,48,0.15)',
                },
              }}
              onClick={() => openEdit(t)}
            >
              <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
                <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '1rem' }}>
                  {t.name}
                </Typography>
                <Box sx={{ display: 'flex', gap: 0.5, ml: 1, flexShrink: 0 }}>
                  <IconButton
                    size="small"
                    onClick={(e) => { e.stopPropagation(); openEdit(t); }}
                    sx={{ color: c.text.tertiary, '&:hover': { color: c.accent.primary } }}
                  >
                    <EditIcon fontSize="small" />
                  </IconButton>
                  <IconButton
                    size="small"
                    onClick={(e) => { e.stopPropagation(); handleDelete(t.id); }}
                    sx={{ color: c.text.tertiary, '&:hover': { color: c.status.error } }}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Box>
              </Box>
              {t.description && (
                <Typography
                  sx={{
                    color: c.text.tertiary,
                    fontSize: '0.8rem',
                    mb: 1.5,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {t.description}
                </Typography>
              )}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Chip
                  label={`${t.fields.length} field${t.fields.length !== 1 ? 's' : ''}`}
                  size="small"
                  sx={{
                    bgcolor: 'rgba(174,86,48,0.08)',
                    color: c.accent.primary,
                    fontSize: '0.7rem',
                    height: 22,
                  }}
                />
                {t.tags.map((tag) => (
                  <Chip
                    key={tag}
                    label={tag}
                    size="small"
                    sx={{
                      bgcolor: c.bg.secondary,
                      color: c.text.muted,
                      fontSize: '0.7rem',
                      height: 22,
                    }}
                  />
                ))}
              </Box>
            </Box>
          ))}
        </Box>
      )}

      {/* Editor Dialog */}
      <Dialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        maxWidth="md"
        fullWidth
        PaperProps={claudePaperProps}
      >
        <DialogTitle sx={{ color: c.text.primary, fontWeight: 600 }}>
          {editingId ? 'Edit Template' : 'New Template'}
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          <TextField
            label="Name"
            value={editor.name}
            onChange={(e) => setEditor((p) => ({ ...p, name: e.target.value }))}
            fullWidth
            size="small"
            sx={inputSx}
          />
          <TextField
            label="Description"
            value={editor.description}
            onChange={(e) => setEditor((p) => ({ ...p, description: e.target.value }))}
            fullWidth
            size="small"
            multiline
            rows={2}
            sx={inputSx}
          />
          <TextField
            label="Template (use {{field_name}} for placeholders)"
            value={editor.template}
            onChange={(e) => setEditor((p) => ({ ...p, template: e.target.value }))}
            fullWidth
            size="small"
            multiline
            rows={5}
            sx={{
              ...inputSx,
              '& .MuiOutlinedInput-root': {
                ...inputSx['& .MuiOutlinedInput-root'],
                fontFamily: c.font.mono,
                fontSize: '0.85rem',
              },
            }}
          />

          {/* Fields */}
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
              <Typography sx={{ color: c.text.muted, fontSize: '0.85rem', fontWeight: 600 }}>
                Fields
              </Typography>
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={addField}
                sx={{ color: c.accent.primary, textTransform: 'none', fontSize: '0.8rem' }}
              >
                Add Field
              </Button>
            </Box>
            {editor.fields.map((field, idx) => (
              <Box
                key={idx}
                sx={{
                  display: 'flex',
                  gap: 1,
                  mb: 1,
                  alignItems: 'flex-start',
                  bgcolor: c.bg.elevated,
                  p: 1.5,
                  borderRadius: 2,
                  border: `1px solid ${c.border.subtle}`,
                }}
              >
                <TextField
                  label="Field name"
                  value={field.name}
                  onChange={(e) => updateField(idx, { name: e.target.value })}
                  size="small"
                  sx={{ ...inputSx, flex: 1 }}
                />
                <TextField
                  select
                  label="Type"
                  value={field.type}
                  onChange={(e) => updateField(idx, { type: e.target.value as TemplateField['type'] })}
                  size="small"
                  sx={{ ...inputSx, minWidth: 130 }}
                  SelectProps={{ MenuProps: { PaperProps: { sx: { bgcolor: c.bg.surface, color: c.text.primary } } } }}
                >
                  {FIELD_TYPES.map((ft) => (
                    <MenuItem key={ft} value={ft}>{ft}</MenuItem>
                  ))}
                </TextField>
                {(field.type === 'select' || field.type === 'multi-select') && (
                  <TextField
                    label="Options (comma-sep)"
                    value={(field.options || []).join(', ')}
                    onChange={(e) =>
                      updateField(idx, {
                        options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                      })
                    }
                    size="small"
                    sx={{ ...inputSx, flex: 1 }}
                  />
                )}
                <TextField
                  label="Default"
                  value={field.default ?? ''}
                  onChange={(e) => updateField(idx, { default: e.target.value || undefined })}
                  size="small"
                  sx={{ ...inputSx, flex: 0.7 }}
                />
                <IconButton
                  onClick={() => removeField(idx)}
                  sx={{ color: c.text.tertiary, mt: 0.5, '&:hover': { color: c.status.error } }}
                >
                  <RemoveCircleOutlineIcon fontSize="small" />
                </IconButton>
              </Box>
            ))}
          </Box>

          {/* Tags */}
          <Box>
            <Typography sx={{ color: c.text.muted, fontSize: '0.85rem', fontWeight: 600, mb: 1 }}>
              Tags
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
              {editor.tags.map((tag) => (
                <Chip
                  key={tag}
                  label={tag}
                  size="small"
                  onDelete={() => removeTag(tag)}
                  sx={{
                    bgcolor: c.bg.secondary,
                    color: c.text.muted,
                    '& .MuiChip-deleteIcon': { color: c.text.tertiary, '&:hover': { color: c.status.error } },
                  }}
                />
              ))}
              <TextField
                placeholder="Add tag..."
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTag();
                  }
                }}
                size="small"
                sx={{ ...inputSx, width: 140 }}
              />
            </Box>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setEditorOpen(false)} sx={{ color: c.text.tertiary }}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            variant="contained"
            disabled={!editor.name.trim() || !editor.template.trim()}
            sx={{
              bgcolor: c.accent.primary,
              '&:hover': { bgcolor: c.accent.pressed },
              '&.Mui-disabled': { bgcolor: c.bg.secondary, color: c.text.ghost },
              textTransform: 'none',
              fontWeight: 600,
            }}
          >
            {editingId ? 'Save Changes' : 'Create Template'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Templates;
