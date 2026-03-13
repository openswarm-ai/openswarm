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

interface SchemaNode {
  type?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
  enum?: string[];
  description?: string;
  default?: any;
}

interface Props {
  schema: SchemaNode;
  value: any;
  onChange: (value: any) => void;
  label?: string;
  depth?: number;
}

function getDefault(schema: SchemaNode): any {
  if (schema.default !== undefined) return schema.default;
  switch (schema.type) {
    case 'string': return '';
    case 'number': return 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': {
      const obj: Record<string, any> = {};
      if (schema.properties) {
        for (const [k, v] of Object.entries(schema.properties)) {
          obj[k] = getDefault(v);
        }
      }
      return obj;
    }
    default: return '';
  }
}

const STRING_STUBS: Record<string, string> = {
  name: 'Jane Smith', first_name: 'Jane', last_name: 'Smith', firstName: 'Jane', lastName: 'Smith',
  email: 'jane@example.com', url: 'https://example.com', website: 'https://example.com',
  phone: '+1 (555) 123-4567', address: '123 Main St, Springfield',
  city: 'Springfield', state: 'CA', country: 'US', zip: '90210',
  title: 'Sample Title', subject: 'Hello World', message: 'This is a sample message.',
  description: 'A brief description of the item.', content: 'Lorem ipsum dolor sit amet.',
  username: 'janesmith', password: 'P@ssw0rd!', token: 'tok_sample_abc123',
  id: 'item_001', uuid: '550e8400-e29b-41d4-a716-446655440000',
  date: '2025-03-15', time: '14:30', datetime: '2025-03-15T14:30:00Z',
  color: '#4a90d9', label: 'Important', tag: 'sample', category: 'general',
  query: 'search term', search: 'example query', text: 'Sample text content',
  path: '/home/user/file.txt', file: 'document.pdf', filename: 'report.pdf',
  company: 'Acme Corp', organization: 'Acme Corp',
};

function stubString(key: string): string {
  const lower = key.toLowerCase().replace(/[-_]/g, '');
  for (const [pattern, val] of Object.entries(STRING_STUBS)) {
    if (lower === pattern.toLowerCase().replace(/[-_]/g, '') || lower.endsWith(pattern.toLowerCase().replace(/[-_]/g, ''))) {
      return val;
    }
  }
  return `sample_${key}`;
}

function getStubbed(schema: SchemaNode, key?: string): any {
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case 'string': return stubString(key || 'value');
    case 'number': return 42;
    case 'integer': return 7;
    case 'boolean': return true;
    case 'array': {
      if (!schema.items) return [];
      return [getStubbed(schema.items, key ? `${key}_item` : 'item')];
    }
    case 'object': {
      const obj: Record<string, any> = {};
      if (schema.properties) {
        for (const [k, v] of Object.entries(schema.properties)) {
          obj[k] = getStubbed(v, k);
        }
      }
      return obj;
    }
    default: return stubString(key || 'value');
  }
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

export { getDefault, getStubbed };
export default InputSchemaForm;
