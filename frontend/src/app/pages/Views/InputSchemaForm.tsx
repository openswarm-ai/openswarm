import React from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import InputLabel from '@mui/material/InputLabel';
import FormControl from '@mui/material/FormControl';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import AddIcon from '@mui/icons-material/Add';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { getDefault, type SchemaNode } from '@/shared/inputSchemaDefaults';

interface Props {
  schema: SchemaNode;
  value: any;
  onChange: (value: any) => void;
  label?: string;
  depth?: number;
}

const InputSchemaForm: React.FC<Props> = ({ schema, value, onChange, label, depth = 0 }) => {
  const c = useClaudeTokens();

  if (schema.enum && schema.enum.length > 0) {
    return (
      <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
        {label && <InputLabel>{label}</InputLabel>}
        <Select
          value={value ?? ''}
          label={label}
          onChange={(e) => onChange(e.target.value)}
          sx={{
            fontSize: '0.85rem',
            '& .MuiOutlinedInput-notchedOutline': { borderColor: c.border.medium },
          }}
        >
          {schema.enum.map((opt) => (
            <MenuItem key={opt} value={opt}>{opt}</MenuItem>
          ))}
        </Select>
        {schema.description && (
          <Typography sx={{ fontSize: '0.7rem', color: c.text.tertiary, mt: 0.25, ml: 0.5 }}>
            {schema.description}
          </Typography>
        )}
      </FormControl>
    );
  }

  if (schema.type === 'boolean') {
    return (
      <Box sx={{ mb: 1 }}>
        <FormControlLabel
          control={
            <Switch
              checked={!!value}
              onChange={(e) => onChange(e.target.checked)}
              size="small"
            />
          }
          label={
            <Typography sx={{ fontSize: '0.85rem', color: c.text.secondary }}>
              {label || 'Toggle'}
            </Typography>
          }
        />
        {schema.description && (
          <Typography sx={{ fontSize: '0.7rem', color: c.text.tertiary, ml: 0.5 }}>
            {schema.description}
          </Typography>
        )}
      </Box>
    );
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    return (
      <TextField
        fullWidth
        size="small"
        type="number"
        label={label}
        helperText={schema.description}
        value={value ?? 0}
        onChange={(e) => onChange(Number(e.target.value))}
        sx={{
          mb: 1.5,
          '& .MuiOutlinedInput-root': { fontSize: '0.85rem' },
          '& .MuiFormHelperText-root': { fontSize: '0.7rem' },
        }}
      />
    );
  }

  if (schema.type === 'string') {
    return (
      <TextField
        fullWidth
        size="small"
        label={label}
        helperText={schema.description}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        multiline={(value?.length ?? 0) > 80}
        sx={{
          mb: 1.5,
          '& .MuiOutlinedInput-root': { fontSize: '0.85rem' },
          '& .MuiFormHelperText-root': { fontSize: '0.7rem' },
        }}
      />
    );
  }

  if (schema.type === 'array' && schema.items) {
    const items = Array.isArray(value) ? value : [];
    return (
      <Box
        sx={{
          mb: 1.5,
          pl: depth > 0 ? 1.5 : 0,
          borderLeft: depth > 0 ? `2px solid ${c.border.subtle}` : 'none',
        }}
      >
        {label && (
          <Typography
            sx={{ fontSize: '0.8rem', fontWeight: 600, color: c.text.secondary, mb: 0.5 }}
          >
            {label}
          </Typography>
        )}
        {schema.description && (
          <Typography sx={{ fontSize: '0.7rem', color: c.text.tertiary, mb: 0.5 }}>
            {schema.description}
          </Typography>
        )}
        {items.map((item: any, i: number) => (
          <Box key={i} sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, mb: 0.5 }}>
            <Box sx={{ flex: 1 }}>
              <InputSchemaForm
                schema={schema.items!}
                value={item}
                onChange={(newVal) => {
                  const updated = [...items];
                  updated[i] = newVal;
                  onChange(updated);
                }}
                label={`Item ${i + 1}`}
                depth={depth + 1}
              />
            </Box>
            <IconButton
              size="small"
              onClick={() => {
                const updated = items.filter((_: any, idx: number) => idx !== i);
                onChange(updated);
              }}
              sx={{ color: c.status.error, mt: 0.5 }}
            >
              <RemoveCircleOutlineIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Box>
        ))}
        <Button
          size="small"
          startIcon={<AddIcon sx={{ fontSize: 14 }} />}
          onClick={() => onChange([...items, getDefault(schema.items!)])}
          sx={{
            fontSize: '0.75rem',
            color: c.accent.primary,
            textTransform: 'none',
          }}
        >
          Add item
        </Button>
      </Box>
    );
  }

  if (schema.type === 'object' && schema.properties) {
    const obj = typeof value === 'object' && value !== null ? value : {};
    return (
      <Box
        sx={{
          mb: 1.5,
          pl: depth > 0 ? 1.5 : 0,
          borderLeft: depth > 0 ? `2px solid ${c.border.subtle}` : 'none',
        }}
      >
        {label && (
          <Typography
            sx={{ fontSize: '0.8rem', fontWeight: 600, color: c.text.secondary, mb: 1 }}
          >
            {label}
          </Typography>
        )}
        {schema.description && (
          <Typography sx={{ fontSize: '0.7rem', color: c.text.tertiary, mb: 0.5 }}>
            {schema.description}
          </Typography>
        )}
        {Object.entries(schema.properties).map(([key, propSchema]) => (
          <InputSchemaForm
            key={key}
            schema={propSchema}
            value={obj[key]}
            onChange={(newVal) => onChange({ ...obj, [key]: newVal })}
            label={key + (schema.required?.includes(key) ? ' *' : '')}
            depth={depth + 1}
          />
        ))}
      </Box>
    );
  }

  return (
    <TextField
      fullWidth
      size="small"
      label={label}
      value={typeof value === 'string' ? value : JSON.stringify(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      sx={{ mb: 1.5, '& .MuiOutlinedInput-root': { fontSize: '0.85rem' } }}
    />
  );
};

export default InputSchemaForm;
