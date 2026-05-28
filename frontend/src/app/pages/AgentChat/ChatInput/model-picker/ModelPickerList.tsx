import React from 'react';
import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import Collapse from '@mui/material/Collapse';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { PROVIDER_COLORS, OR_AUTO_COLLAPSE_THRESHOLD } from './modelPicker';
import { formatTokenCount } from '../helpers';
import { ModelPickerRecents } from './ModelPickerRecents';

interface Props {
  c: ClaudeTokens;
  model: string;
  onModelChange: (model: string) => void;
  onProviderChange?: (provider: string) => void;
  pushRecentModel: (value: string) => void;
  pushRecentSearch: (q: string) => void;
  modelSearch: string;
  showRecents: boolean;
  collapsedGroups: Record<string, boolean>;
  toggleGroupCollapse: (prov: string, currentlyCollapsed: boolean) => void;
  recentMaterialised: Array<any>;
  filteredModelGroups: Record<string, any[]>;
  setModelAnchor: (el: HTMLElement | null) => void;
  anyFilterActive: boolean;
  pendingKinds: Set<string>;
  pendingPayloadEstimate: number;
  buildModelTooltip: (opt: any) => React.ReactNode;
  tooltipSlotProps: any;
}

export const ModelPickerList: React.FC<Props> = ({
  c, model, onModelChange, onProviderChange, pushRecentModel, pushRecentSearch,
  modelSearch, showRecents, collapsedGroups, toggleGroupCollapse, recentMaterialised,
  filteredModelGroups, setModelAnchor, anyFilterActive, pendingKinds, pendingPayloadEstimate,
  buildModelTooltip, tooltipSlotProps,
}) => {
  return (
    <>
      {showRecents && (
        <ModelPickerRecents
          c={c}
          model={model}
          onModelChange={onModelChange}
          pushRecentModel={pushRecentModel}
          collapsedGroups={collapsedGroups}
          toggleGroupCollapse={toggleGroupCollapse}
          recentMaterialised={recentMaterialised}
          setModelAnchor={setModelAnchor}
          buildModelTooltip={buildModelTooltip}
          tooltipSlotProps={tooltipSlotProps}
        />
      )}

      {Object.keys(filteredModelGroups).length === 0 && (
        <Box
          sx={{
            px: 2, py: 1.5,
            fontSize: '0.8rem',
            color: c.text.ghost,
            textAlign: 'center',
            fontStyle: 'italic',
          }}
        >
          {modelSearch.trim() ? (
            <>No models match "{modelSearch.trim()}".{anyFilterActive && (<><br/><Box component="span" sx={{ fontSize: '0.7rem' }}>Try clearing the filters above.</Box></>)}</>
          ) : (
            <>No models match the current filters.</>
          )}
        </Box>
      )}

      {Object.entries(filteredModelGroups).map(([prov, models]) => {
        const isOpenSwarmPro = prov === 'OpenSwarm Pro';
        const isOR = prov.startsWith('OpenRouter');
        const ms = models as any[];
        // OR vendor groups with >12 entries auto-collapse on first open; search disables this.
        const collapsible = true;
        const searchActive = modelSearch.trim().length > 0;
        const userToggle = collapsedGroups[prov];
        const autoCollapse = isOR && !searchActive && ms.length > OR_AUTO_COLLAPSE_THRESHOLD;
        const collapsed = userToggle !== undefined ? userToggle : autoCollapse;
        const brandKey = (isOR ? 'openrouter' : prov.toLowerCase());
        const brandColor = PROVIDER_COLORS[brandKey] ?? c.text.tertiary;
        const OPENSWARM_GRADIENT =
          'linear-gradient(135deg, #8FB3FF 0%, #E56BC4 45%, #FFA85C 100%)';

        const highlightMatch = (text: string): React.ReactNode => {
          const q = modelSearch.trim();
          if (!q) return text;
          const idx = text.toLowerCase().indexOf(q.toLowerCase());
          if (idx < 0) return text;
          return (
            <>
              {text.slice(0, idx)}
              <Box component="span" sx={{ fontWeight: 700, color: c.text.primary }}>
                {text.slice(idx, idx + q.length)}
              </Box>
              {text.slice(idx + q.length)}
            </>
          );
        };

        return [
          <MenuItem
            key={`header-${prov}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleGroupCollapse(prov, collapsed);
            }}
            sx={{
              opacity: '1 !important',
              py: 0.75, px: 1.5, minHeight: 'auto',
              cursor: 'pointer',
              '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, width: '100%' }}>
              <KeyboardArrowRightIcon
                sx={{
                  fontSize: 14,
                  color: c.text.tertiary,
                  transform: collapsed ? 'none' : 'rotate(90deg)',
                  transition: 'transform 0.15s',
                }}
              />
              <Box sx={{
                width: 6, height: 6, borderRadius: '50%',
                background: isOpenSwarmPro ? OPENSWARM_GRADIENT : brandColor,
                boxShadow: isOpenSwarmPro
                  ? '0 0 8px rgba(229, 107, 196, 0.6)'
                  : `0 0 6px ${brandColor}80`,
                flexShrink: 0,
              }} />
              <Typography sx={{
                fontSize: '0.7rem', fontWeight: 700,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                flex: 1,
                ...(isOpenSwarmPro
                  ? {
                      background: OPENSWARM_GRADIENT,
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                    }
                  : { color: brandColor }),
              }}>
                {prov}
              </Typography>
              <Typography sx={{ fontSize: '0.65rem', color: c.text.ghost, fontWeight: 500 }}>
                {ms.length}
              </Typography>
            </Box>
          </MenuItem>,
          <Collapse
            key={`coll-${prov}`}
            in={!collapsed}
            timeout={180}
            unmountOnExit
          >
            {models.map((opt: any) => {
                let displayLabel = opt.label;
                if (isOR && displayLabel.includes(': ')) {
                  const groupVendor = prov.replace(/^OpenRouter\s*[·•]\s*/i, '').toLowerCase();
                  const colonIdx = displayLabel.indexOf(': ');
                  const labelPrefix = displayLabel.slice(0, colonIdx).toLowerCase();
                  if (labelPrefix === groupVendor) {
                    displayLabel = displayLabel.slice(colonIdx + 2);
                  }
                }
                return (
                  <Tooltip
                    key={opt.value}
                    title={buildModelTooltip(opt)}
                    placement="right"
                    enterDelay={300}
                    slotProps={tooltipSlotProps}
                  >
                    <MenuItem
                      selected={model === opt.value}
                      onClick={() => {
                        onModelChange(opt.value);
                        pushRecentModel(opt.value);
                        if (modelSearch.trim()) pushRecentSearch(modelSearch);
                        if (onProviderChange) {
                          const provLower = prov.toLowerCase();
                          const providerMap: Record<string, string> = {
                            anthropic: 'anthropic',
                            'openswarm pro': 'anthropic',
                            openai: 'openai',
                            google: 'gemini',
                          };
                          onProviderChange(providerMap[provLower] || (isOR ? 'openrouter' : provLower));
                        }
                        setModelAnchor(null);
                      }}
                    >
                      <ListItemText
                        primary={highlightMatch(displayLabel)}
                        slotProps={{ primary: { sx: { fontSize: '0.8rem', color: model === opt.value ? c.text.primary : c.text.muted } } }}
                      />
                      {(() => {
                        const win = (opt.context_window as number) || 0;
                        const api = (opt.api as string || 'anthropic').toLowerCase();
                        const optIsCodex = typeof opt.value === 'string' && (opt.value.toLowerCase().includes('codex') || opt.value.toLowerCase().startsWith('cx/'));
                        const optSupportsPdf = (
                          ['anthropic', 'gemini', 'gemini-cli', 'openrouter'].includes(api) ||
                          (api === 'openai' && !optIsCodex)
                        );
                        const optSupportsImage = ['anthropic', 'gemini', 'gemini-cli', 'openai', 'openrouter'].includes(api);
                        const cannotPdf = pendingKinds.has('pdf') && !optSupportsPdf;
                        const cannotImg = pendingKinds.has('image') && !optSupportsImage;
                        if (!win) return null;
                        return (
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 1 }}>
                            {(cannotPdf || cannotImg) && (
                              <Box sx={{ fontSize: '0.62rem', color: '#ef4444', border: '1px solid #ef444440', borderRadius: '4px', px: 0.5, py: 0.05, lineHeight: 1.4 }}>
                                No {cannotPdf ? 'PDF' : 'image'}
                              </Box>
                            )}
                            <Typography sx={{ fontSize: '0.66rem', color: c.text.ghost, fontVariantNumeric: 'tabular-nums' }}>
                              {formatTokenCount(win)}
                            </Typography>
                          </Box>
                        );
                      })()}
                    </MenuItem>
                  </Tooltip>
                );
              })}
          </Collapse>,
        ];
      }).flat()}
    </>
  );
};
