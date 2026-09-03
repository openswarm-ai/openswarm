import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import SearchIcon from '@mui/icons-material/Search';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import CheckIcon from '@mui/icons-material/Check';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

export interface PickerOption {
  value: string;
  label: string;
}

export interface FilterSection {
  label: string;
  options: PickerOption[];
}

const pillSx = (c: ReturnType<typeof useClaudeTokens>) => ({
  display: 'flex', alignItems: 'center', gap: 0.75, px: 1.75, py: 0.9,
  borderRadius: `${c.radius.md}px`, border: `1px solid ${c.border.medium}`,
  cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
  '&:hover': { borderColor: c.border.strong, bgcolor: c.bg.elevated },
});

// claude.ai's Filter pill: always reads "Filter by"; state lives in the menu as checkable rows under section headers.
const FilterPill: React.FC<{ sections: FilterSection[]; selected: string[]; onToggle: (value: string) => void }> = ({ sections, selected, onToggle }) => {
  const c = useClaudeTokens();
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  return (
    <>
      <Box role="button" onClick={(e: React.MouseEvent<HTMLElement>) => setAnchor(e.currentTarget)} sx={pillSx(c)}>
        <Typography sx={{ fontSize: '0.9375rem', color: c.text.primary }}>Filter by</Typography>
        <KeyboardArrowDownIcon sx={{ fontSize: 18, color: c.text.tertiary }} />
      </Box>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        PaperProps={{ sx: { bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, mt: 0.5, minWidth: 190 } }}
      >
        {sections.flatMap((section, i) => [
          <Typography key={`h-${section.label}`} sx={{ px: 2, pt: i === 0 ? 0.75 : 1.25, pb: 0.25, fontSize: '0.75rem', color: c.text.tertiary }}>
            {section.label}
          </Typography>,
          ...section.options.map((o) => (
            <MenuItem
              key={o.value}
              onClick={() => onToggle(o.value)}
              sx={{ fontSize: '0.875rem', color: c.text.primary, display: 'flex', justifyContent: 'space-between', gap: 2, '&:hover': { bgcolor: c.bg.secondary } }}
            >
              {o.label}
              <CheckIcon sx={{ fontSize: 16, color: '#3b82f6', visibility: selected.includes(o.value) ? 'visible' : 'hidden' }} />
            </MenuItem>
          )),
        ])}
      </Menu>
    </>
  );
};

const SortPill: React.FC<{ options: PickerOption[]; value: string; onChange: (value: string) => void }> = ({ options, value, onChange }) => {
  const c = useClaudeTokens();
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  return (
    <>
      <Box role="button" onClick={(e: React.MouseEvent<HTMLElement>) => setAnchor(e.currentTarget)} sx={pillSx(c)}>
        <Typography sx={{ fontSize: '0.9375rem', color: c.text.primary }}>Sort by</Typography>
        <KeyboardArrowDownIcon sx={{ fontSize: 18, color: c.text.tertiary }} />
      </Box>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        PaperProps={{ sx: { bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, mt: 0.5, minWidth: 190 } }}
      >
        {options.map((o) => (
          <MenuItem
            key={o.value}
            onClick={() => { onChange(o.value); setAnchor(null); }}
            sx={{ fontSize: '0.875rem', color: c.text.primary, display: 'flex', justifyContent: 'space-between', gap: 2, '&:hover': { bgcolor: c.bg.secondary } }}
          >
            {o.label}
            <CheckIcon sx={{ fontSize: 16, color: '#3b82f6', visibility: o.value === value ? 'visible' : 'hidden' }} />
          </MenuItem>
        ))}
      </Menu>
    </>
  );
};

interface Props {
  searchPlaceholder: string;
  query: string;
  onQuery: (q: string) => void;
  filterSections: FilterSection[];
  filterSelected: string[];
  onToggleFilter: (value: string) => void;
  sortOptions: PickerOption[];
  sortValue: string;
  onSort: (v: string) => void;
  // Optional left-hand content for the controls row; without it that band is empty with two pills pushed to the far right.
  leading?: React.ReactNode;
}

// The Directory's search row + chip/filter row, shared by both tabs (same chrome on claude.ai).
const DirectoryFilterBar: React.FC<Props> = ({
  searchPlaceholder, query, onQuery,
  filterSections, filterSelected, onToggleFilter, sortOptions, sortValue, onSort, leading,
}) => {
  const c = useClaudeTokens();
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.75, flexShrink: 0 }}>
      <TextField
        placeholder={searchPlaceholder}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        fullWidth
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon sx={{ fontSize: 20, color: c.text.ghost }} />
            </InputAdornment>
          ),
        }}
        sx={{
          '& .MuiOutlinedInput-root': {
            bgcolor: c.bg.surface, borderRadius: `${c.radius.md}px`, fontSize: '0.9375rem',
            '& input': { py: 1.4 },
            '& fieldset': { borderColor: c.border.medium },
            '&:hover fieldset': { borderColor: c.border.strong },
            '&.Mui-focused fieldset': { borderColor: c.border.strong, borderWidth: 1 },
          },
        }}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <Box sx={{ minWidth: 0 }}>{leading}</Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <FilterPill sections={filterSections} selected={filterSelected} onToggle={onToggleFilter} />
          <SortPill options={sortOptions} value={sortValue} onChange={onSort} />
        </Box>
      </Box>
    </Box>
  );
};

export default DirectoryFilterBar;
