import React, { useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import Checkbox from '@mui/material/Checkbox';
import ListItemText from '@mui/material/ListItemText';
import OutlinedInput from '@mui/material/OutlinedInput';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import { PromptTemplate, TemplateField } from '@/shared/state/templatesSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface Props {
  template: PromptTemplate;
  open: boolean;
  onClose: () => void;
  onApply: (rendered: string) => void;
}

const TemplateInvokeModal: React.FC<Props> = ({ template, open, onClose, onApply }) => {
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
  const [values, setValues] = useState<Record<string, any>>(() => {
    const init: Record<string, any> = {};
    for (const f of template.fields) {
      init[f.name] = f.default ?? (f.type === 'multi-select' ? [] : '');
    }
    return init;
  });

  const handleApply = () => {
    let rendered = template.template;
    for (const f of template.fields) {
      const val = values[f.name];
      const str = Array.isArray(val) ? val.join(', ') : String(val ?? '');
      rendered = rendered.replace(new RegExp(`\\{\\{${f.name}\\}\\}`, 'g'), str);
    }
    onApply(rendered);
    onClose();
  };

  const renderField = (field: TemplateField) => {
    const val = values[field.name];
    const update = (v: any) => setValues((prev) => ({ ...prev, [field.name]: v }));

    switch (field.type) {
      case 'literal':
        return (
          <Box key={field.name} sx={{ mb: 2 }}>
            <Typography sx={{ color: c.text.tertiary, fontSize: '0.75rem', mb: 0.5 }}>{field.name}</Typography>
            <Typography sx={{ color: c.text.muted, fontSize: '0.85rem', fontFamily: c.font.mono, bgcolor: c.bg.secondary, p: 1, borderRadius: 1.5 }}>
              {field.default || ''}
            </Typography>
          </Box>
        );
      case 'select':
        return (
          <TextField
            key={field.name}
            select
            label={field.name}
            value={val || ''}
            onChange={(e) => update(e.target.value)}
            fullWidth
            size="small"
            sx={{ ...inputSx, mb: 2 }}
            SelectProps={{ MenuProps: { PaperProps: { sx: { bgcolor: c.bg.surface, color: c.text.primary } } } }}
          >
            {(field.options || []).map((opt) => (
              <MenuItem key={opt} value={opt}>{opt}</MenuItem>
            ))}
          </TextField>
        );
      case 'multi-select':
        return (
          <FormControl key={field.name} fullWidth size="small" sx={{ mb: 2, ...inputSx }}>
            <InputLabel sx={{ color: c.text.tertiary }}>{field.name}</InputLabel>
            <Select
              multiple
              value={Array.isArray(val) ? val : []}
              onChange={(e) => update(e.target.value)}
              input={<OutlinedInput label={field.name} />}
              renderValue={(selected: string[]) => selected.join(', ')}
              MenuProps={{ PaperProps: { sx: { bgcolor: c.bg.surface, color: c.text.primary } } }}
            >
              {(field.options || []).map((opt) => (
                <MenuItem key={opt} value={opt}>
                  <Checkbox checked={(val || []).includes(opt)} sx={{ color: c.text.tertiary }} />
                  <ListItemText primary={opt} />
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        );
      case 'int':
      case 'float':
        return (
          <TextField
            key={field.name}
            label={field.name}
            type="number"
            value={val ?? ''}
            onChange={(e) => update(field.type === 'int' ? parseInt(e.target.value) || '' : parseFloat(e.target.value) || '')}
            fullWidth
            size="small"
            sx={{ ...inputSx, mb: 2 }}
          />
        );
      default:
        return (
          <TextField
            key={field.name}
            label={field.name}
            value={val || ''}
            onChange={(e) => update(e.target.value)}
            fullWidth
            size="small"
            multiline={field.name.toLowerCase().includes('description') || field.name.toLowerCase().includes('prompt')}
            rows={field.name.toLowerCase().includes('description') || field.name.toLowerCase().includes('prompt') ? 3 : 1}
            sx={{ ...inputSx, mb: 2 }}
          />
        );
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: {
          bgcolor: c.bg.surface,
          borderRadius: 4,
          border: `1px solid ${c.border.subtle}`,
        },
      }}
    >
      <DialogTitle sx={{ color: c.text.primary, fontWeight: 600 }}>{template.name}</DialogTitle>
      <DialogContent>
        {template.description && (
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.85rem', mb: 2 }}>{template.description}</Typography>
        )}
        {template.fields.length === 0 ? (
          <Typography sx={{ color: c.text.muted, fontSize: '0.85rem' }}>
            This template has no input fields. It will be inserted as-is.
          </Typography>
        ) : (
          template.fields.map(renderField)
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} sx={{ color: c.text.tertiary }}>Cancel</Button>
        <Button
          onClick={handleApply}
          variant="contained"
          sx={{ bgcolor: c.accent.primary, '&:hover': { bgcolor: c.accent.hover }, fontWeight: 600 }}
        >
          Apply Template
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default TemplateInvokeModal;
