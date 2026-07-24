import React from 'react';
import Box from '@mui/material/Box';
import Menu from '@mui/material/Menu';
import Tooltip from '@mui/material/Tooltip';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { useModelTooltip } from './modelTooltip';
import { ModelPickerHeader } from './ModelPickerHeader';
import { ModelPickerList } from './ModelPickerList';
import { ModelPickerFooter } from './ModelPickerFooter';

type CapFilters = { reasoning: boolean; subscription: boolean; apiKey: boolean };

interface Props {
  c: ClaudeTokens;
  menuPaperProps: { sx: any };
  modelAnchor: HTMLElement | null;
  setModelAnchor: (el: HTMLElement | null) => void;
  model: string;
  onModelChange: (model: string) => void;
  onProviderChange?: (provider: string) => void;
  modelSearchRef: React.RefObject<HTMLInputElement | null>;
  modelSearch: string;
  setModelSearch: (v: string) => void;
  pushRecentModel: (value: string) => void;
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
  probeResult: { value: string; ok: boolean; error?: string; latency_ms?: number } | null;
  showRecents: boolean;
  collapsedGroups: Record<string, boolean>;
  toggleGroupCollapse: (prov: string, currentlyCollapsed: boolean) => void;
  recentMaterialised: Array<any>;
  filteredModelGroups: Record<string, any[]>;
  pickerSummary: { total: number; free: number; reasoning: number; subscription: number; apiKey: number; paid: number; longContext: number };
  pendingKinds: Set<string>;
  pendingPayloadEstimate: number;
}

// Probe errors come back as raw upstream JSON ("Error code: 400 - {'error': {...}}"); never show that to users. Map to a short actionable line (the raw is console-logged in useModelPicker for devs).
function friendlyProbeError(raw?: string): string {
  const r = (raw || '').toLowerCase();
  if (r.includes('no credentials') || r.includes('not connected') || r.includes('bad_request')) {
    return "This model isn't connected, add its provider in Settings.";
  }
  if (r.includes('401') || r.includes('unauthorized') || r.includes('invalid api key') || r.includes('invalid_api_key')) {
    return "This model's key looks invalid, check it in Settings.";
  }
  if (r.includes('402') || r.includes('quota') || r.includes('credit') || r.includes('billing')) {
    return "This model is out of credits, check billing.";
  }
  return "This model isn't available right now.";
}

export const ModelPickerMenu: React.FC<Props> = (props) => {
  const {
    c, menuPaperProps, modelAnchor, setModelAnchor, model, onModelChange, onProviderChange,
    modelSearchRef, modelSearch, setModelSearch, pushRecentModel, pushRecentSearch,
    capFilters, setCapFilters, ctxIdx, setCtxIdx, costIdx, setCostIdx,
    filtersExpanded, toggleFilters, anyFilterActive, probeResult,
    showRecents, collapsedGroups, toggleGroupCollapse, recentMaterialised,
    filteredModelGroups, pickerSummary, pendingKinds, pendingPayloadEstimate,
  } = props;
  const { buildModelTooltip, tooltipSlotProps } = useModelTooltip(c);

  return (
    <Menu
      anchorEl={modelAnchor}
      open={Boolean(modelAnchor)}
      onClose={() => setModelAnchor(null)}
      anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
      transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      slotProps={{ paper: menuPaperProps }}
      autoFocus={false}
      MenuListProps={{ autoFocusItem: false }}
    >
      <ModelPickerHeader
        c={c}
        modelSearchRef={modelSearchRef}
        modelSearch={modelSearch}
        setModelSearch={setModelSearch}
        pushRecentSearch={pushRecentSearch}
        capFilters={capFilters}
        setCapFilters={setCapFilters}
        ctxIdx={ctxIdx}
        setCtxIdx={setCtxIdx}
        costIdx={costIdx}
        setCostIdx={setCostIdx}
        filtersExpanded={filtersExpanded}
        toggleFilters={toggleFilters}
        anyFilterActive={anyFilterActive}
        tooltipSlotProps={tooltipSlotProps}
      />

      {probeResult && probeResult.value === model && !probeResult.ok && (
        <Tooltip title={friendlyProbeError(probeResult.error)} placement="bottom-start" enterDelay={400}>
          <Box
            onClick={(e) => e.stopPropagation()}
            sx={{
              mx: 1, my: 0.5,
              px: 1, height: 26,
              display: 'flex', alignItems: 'center', gap: 0.5,
              borderRadius: '6px',
              bgcolor: 'rgba(239, 68, 68, 0.08)',
              border: '1px solid rgba(239, 68, 68, 0.18)',
              color: '#ef4444',
              fontSize: '0.6875rem',
              flexShrink: 0,
              overflow: 'hidden',
            }}
          >
            <Box component="span" sx={{ fontWeight: 700, flexShrink: 0 }}>Heads up</Box>
            <Box component="span" sx={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              opacity: 0.85,
            }}>
              · {friendlyProbeError(probeResult.error)}
            </Box>
          </Box>
        </Tooltip>
      )}

      <ModelPickerList
        c={c}
        model={model}
        onModelChange={onModelChange}
        onProviderChange={onProviderChange}
        pushRecentModel={pushRecentModel}
        pushRecentSearch={pushRecentSearch}
        modelSearch={modelSearch}
        showRecents={showRecents}
        collapsedGroups={collapsedGroups}
        toggleGroupCollapse={toggleGroupCollapse}
        recentMaterialised={recentMaterialised}
        filteredModelGroups={filteredModelGroups}
        setModelAnchor={setModelAnchor}
        anyFilterActive={anyFilterActive}
        pendingKinds={pendingKinds}
        pendingPayloadEstimate={pendingPayloadEstimate}
        buildModelTooltip={buildModelTooltip}
        tooltipSlotProps={tooltipSlotProps}
      />

      <ModelPickerFooter c={c} pickerSummary={pickerSummary} tooltipSlotProps={tooltipSlotProps} />
    </Menu>
  );
};
