import React from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import InputBase from '@mui/material/InputBase';
import SearchIcon from '@mui/icons-material/Search';
import Slider from '@mui/material/Slider';
import Collapse from '@mui/material/Collapse';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { CTX_STEPS, CTX_LABELS, COST_STEPS, COST_LABELS } from './modelPicker';

type CapFilters = { reasoning: boolean; subscription: boolean; apiKey: boolean };

interface Props {
  c: ClaudeTokens;
  modelSearchRef: React.RefObject<HTMLInputElement | null>;
  modelSearch: string;
  setModelSearch: (v: string) => void;
  pushRecentSearch: (q: string) => void;
  capFilters: CapFilters;
  setCapFilters: React.Dispatch<React.SetStateAction<CapFilters>>;
  ctxIdx: number;
  setCtxIdx: React.Dispatch<React.SetStateAction<number>>;
  costIdx: number;
  setCostIdx: React.Dispatch<React.SetStateAction<number>>;
  filtersExpanded: boolean;
  toggleFilters: () => void;
  anyFilterActive: boolean;
  tooltipSlotProps: any;
}

export const ModelPickerHeader: React.FC<Props> = ({
  c, modelSearchRef, modelSearch, setModelSearch, pushRecentSearch,
  capFilters, setCapFilters, ctxIdx, setCtxIdx, costIdx, setCostIdx,
  filtersExpanded, toggleFilters, anyFilterActive, tooltipSlotProps,
}) => {
  return (
    /* Sticky header stops click+key so Menu doesn't typeahead while user types. */
    <Box
      onKeyDown={(e) => {
        if (e.key !== 'Escape') e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
      sx={{
        position: 'sticky', top: 0, zIndex: 2,
        bgcolor: c.bg.surface,
        borderBottom: `1px solid ${c.border.subtle}`,
        display: 'flex', flexDirection: 'column',
        outline: 'none',
        '&:focus, &:focus-within': { outline: 'none' },
      }}
    >
      <Box sx={{
        px: 1.25, height: 36,
        display: 'flex', alignItems: 'center', gap: 0.75,
        flexShrink: 0,
      }}>
        <SearchIcon sx={{ fontSize: 16, color: c.text.ghost }} />
        <InputBase
          inputRef={modelSearchRef}
          value={modelSearch}
          onChange={(e) => setModelSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && modelSearch.trim()) {
              pushRecentSearch(modelSearch);
            }
          }}
          placeholder="Search models…"
          fullWidth
          sx={{
            fontSize: '0.85rem',
            color: c.text.primary,
            '& input': { padding: 0 },
            '& input::placeholder': { color: c.text.ghost, opacity: 1 },
          }}
        />
        <Tooltip
          title={anyFilterActive
            ? `${[capFilters.reasoning, capFilters.subscription, capFilters.apiKey, ctxIdx > 0, costIdx > 0].filter(Boolean).length} active filter${[capFilters.reasoning, capFilters.subscription, capFilters.apiKey, ctxIdx > 0, costIdx > 0].filter(Boolean).length === 1 ? '' : 's'}`
            : (filtersExpanded ? 'Hide filters' : 'Show filters')}
          placement="bottom"
          enterDelay={400}
          slotProps={tooltipSlotProps}
        >
          <Box
            onClick={toggleFilters}
            sx={{
              cursor: 'pointer', userSelect: 'none', flexShrink: 0,
              position: 'relative',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 24,
              color: anyFilterActive ? c.accent.primary : c.text.tertiary,
              borderRadius: '4px',
              '&:hover': {
                bgcolor: c.bg.elevated,
                color: anyFilterActive ? c.accent.primary : c.text.muted,
              },
              transition: 'all 0.12s',
            }}
          >
            <TuneOutlinedIcon sx={{
              fontSize: 16,
              transform: filtersExpanded ? 'rotate(180deg)' : 'none',
              transition: 'transform 0.18s',
            }} />
            {anyFilterActive && (
              <Box sx={{
                position: 'absolute',
                top: 3, right: 3,
                width: 5, height: 5,
                borderRadius: '50%',
                bgcolor: c.accent.primary,
                boxShadow: `0 0 0 1.5px ${c.bg.surface}`,
              }} />
            )}
          </Box>
        </Tooltip>
      </Box>
      <Collapse in={filtersExpanded} timeout={180} unmountOnExit>
      <Box sx={{
        px: 1.25, height: 28,
        display: 'flex', alignItems: 'center', gap: 0.5,
        flexShrink: 0,
        overflowX: 'auto',
        scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' },
      }}>
        {([
          { key: 'reasoning', label: 'Reasoning' },
          { key: 'subscription', label: 'Subscription' },
          { key: 'apiKey', label: 'API key' },
        ] as const).map(({ key, label }) => {
          const active = capFilters[key];
          return (
            <Box
              key={key}
              onClick={() => setCapFilters((prev) => ({ ...prev, [key]: !prev[key] }))}
              sx={{
                cursor: 'pointer', userSelect: 'none',
                px: 0.85, height: 20,
                display: 'inline-flex', alignItems: 'center',
                fontSize: '0.66rem', fontWeight: 600,
                letterSpacing: '0.04em',
                borderRadius: '4px',
                border: `1px solid ${active ? c.accent.primary : c.border.subtle}`,
                bgcolor: active ? `${c.accent.primary}1a` : 'transparent',
                color: active ? c.accent.primary : c.text.tertiary,
                whiteSpace: 'nowrap',
                transition: 'all 0.12s',
                '&:hover': { borderColor: c.accent.primary, color: active ? c.accent.primary : c.text.muted },
              }}
            >
              {label}
            </Box>
          );
        })}
        {anyFilterActive && (
          <Box
            onClick={() => {
              setCapFilters({ reasoning: false, subscription: false, apiKey: false });
              setCtxIdx(0); setCostIdx(0);
            }}
            sx={{
              cursor: 'pointer', userSelect: 'none',
              fontSize: '0.66rem', fontWeight: 500,
              color: c.text.ghost,
              ml: 0.5, px: 0.5,
              '&:hover': { color: c.text.muted },
            }}
          >
            Reset
          </Box>
        )}
      </Box>
      <Box sx={{
        px: 1.5, py: 0.5,
        display: 'flex', flexDirection: 'column', gap: 0.25,
        flexShrink: 0,
      }}>
        {([
          { label: 'Min context', idx: ctxIdx, set: setCtxIdx, max: CTX_STEPS.length - 1, valueLabel: CTX_LABELS[ctxIdx] },
          { label: 'Max cost',    idx: costIdx, set: setCostIdx, max: COST_STEPS.length - 1, valueLabel: COST_LABELS[costIdx] },
        ] as const).map((row, i) => (
          <Box key={i} sx={{
            display: 'grid', gridTemplateColumns: '78px 1fr 60px',
            alignItems: 'center', gap: 0.75,
            height: 22,
          }}>
            <Box sx={{
              fontSize: '0.65rem', fontWeight: 500,
              color: c.text.tertiary,
              letterSpacing: '0.02em',
            }}>
              {row.label}
            </Box>
            <Slider
              size="small"
              value={row.idx}
              onChange={(_, v) => row.set(v as number)}
              step={1}
              min={0}
              max={row.max}
              marks
              sx={{
                color: c.accent.primary,
                height: 3,
                padding: '8px 0',
                '& .MuiSlider-thumb': {
                  width: 10, height: 10,
                  '&:before': { boxShadow: 'none' },
                  '&:hover, &.Mui-focusVisible': { boxShadow: `0 0 0 6px ${c.accent.primary}26` },
                },
                '& .MuiSlider-rail': {
                  opacity: 0.35, color: c.border.subtle,
                },
                '& .MuiSlider-mark': {
                  width: 2, height: 2, borderRadius: '50%',
                  bgcolor: c.text.ghost, opacity: 0.6,
                },
                '& .MuiSlider-markActive': { opacity: 0 },
              }}
            />
            <Box sx={{
              fontSize: '0.65rem', fontWeight: 600,
              color: row.idx > 0 ? c.accent.primary : c.text.ghost,
              fontVariantNumeric: 'tabular-nums',
              textAlign: 'right',
            }}>
              {row.valueLabel}
            </Box>
          </Box>
        ))}
      </Box>
      </Collapse>
    </Box>
  );
};
