import React, { RefObject } from 'react';
import Box from '@mui/material/Box';
import { useElementSelection } from '@/app/components/editor/ElementSelectionContext';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { ContextRing } from './ContextRing';
import { ModeControl } from './ModeControl';
import { ModelPickerMenu } from '../model-picker/ModelPickerMenu';
import { ThinkingLevelControl } from './ThinkingLevelControl';
import { ToolbarActions } from './ToolbarActions';
import { ModelPickerState } from '../hooks/useModelPicker';

type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'auto';

interface ModeConf { label: string; icon: React.ReactNode; color: string }

interface Props {
  c: ClaudeTokens;
  modeConf: ModeConf;
  modesArr: Array<{ id: string; name: string; icon: string; color: string }>;
  mode: string;
  onModeChange: (mode: string) => void;
  iconMap: Record<string, React.ReactNode>;
  modeAnchor: HTMLElement | null;
  setModeAnchor: (el: HTMLElement | null) => void;
  modelAnchor: HTMLElement | null;
  setModelAnchor: (el: HTMLElement | null) => void;
  thinkingAnchor: HTMLElement | null;
  setThinkingAnchor: (el: HTMLElement | null) => void;
  allModelFlat: Array<any>;
  model: string;
  onModelChange: (model: string) => void;
  onProviderChange?: (provider: string) => void;
  picker: ModelPickerState;
  pendingKinds: Set<string>;
  pendingPayloadEstimate: number;
  thinkingLevel: ThinkingLevel;
  onThinkingLevelChange?: (level: ThinkingLevel) => void;
  contextEstimate?: { used: number; limit: number };
  elementSelection: ReturnType<typeof useElementSelection>;
  autoRunMode?: boolean;
  ownerId: string;
  sessionId?: string;
  generalFileInputRef: RefObject<HTMLInputElement>;
  addImageFiles: (files: FileList | File[]) => void;
  uploadAndAttachFiles: (files: File[]) => void;
  hasContent: boolean;
  disabled?: boolean;
  isRunning?: boolean;
  onStop?: () => void;
  handleSend: () => void;
}

export const ChatInputToolbar: React.FC<Props> = (p) => {
  const {
    c, modeConf, modesArr, mode, onModeChange, iconMap,
    modeAnchor, setModeAnchor, modelAnchor, setModelAnchor, thinkingAnchor, setThinkingAnchor,
    allModelFlat, model, onModelChange, onProviderChange, picker, pendingKinds, pendingPayloadEstimate,
    thinkingLevel, onThinkingLevelChange, contextEstimate, elementSelection, autoRunMode,
    ownerId, sessionId, generalFileInputRef, addImageFiles, uploadAndAttachFiles,
    hasContent, disabled, isRunning, onStop, handleSend,
  } = p;

  const menuPaperProps = {
    sx: {
      bgcolor: c.bg.surface,
      border: `1px solid ${c.border.subtle}`,
      borderRadius: '10px',
      minWidth: 180,
      maxWidth: 380,
      maxHeight: 400,
      boxShadow: c.shadow.lg,
      '& .MuiMenuItem-root': {
        fontSize: '0.8rem',
        color: c.text.secondary,
        py: 0.75,
        px: 1.5,
        '&:hover': { bgcolor: c.bg.secondary },
      },
    },
  };

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.25,
        px: 1,
        pb: 0.75,
        pt: 0,
      }}
    >
      <ModeControl
        c={c}
        menuPaperProps={menuPaperProps}
        modeConf={modeConf}
        modesArr={modesArr}
        mode={mode}
        onModeChange={onModeChange}
        iconMap={iconMap}
        modeAnchor={modeAnchor}
        setModeAnchor={setModeAnchor}
        setModelAnchor={setModelAnchor}
        allModelFlat={allModelFlat}
        model={model}
      />

      <ModelPickerMenu
        c={c}
        menuPaperProps={menuPaperProps}
        modelAnchor={modelAnchor}
        setModelAnchor={setModelAnchor}
        model={model}
        onModelChange={onModelChange}
        onProviderChange={onProviderChange}
        modelSearchRef={picker.modelSearchRef}
        modelSearch={picker.modelSearch}
        setModelSearch={picker.setModelSearch}
        pushRecentModel={picker.pushRecentModel}
        pushRecentSearch={picker.pushRecentSearch}
        capFilters={picker.capFilters}
        setCapFilters={picker.setCapFilters}
        ctxIdx={picker.ctxIdx}
        setCtxIdx={picker.setCtxIdx}
        costIdx={picker.costIdx}
        setCostIdx={picker.setCostIdx}
        filtersExpanded={picker.filtersExpanded}
        toggleFilters={picker.toggleFilters}
        anyFilterActive={picker.anyFilterActive}
        probeResult={picker.probeResult}
        showRecents={picker.showRecents}
        collapsedGroups={picker.collapsedGroups}
        toggleGroupCollapse={picker.toggleGroupCollapse}
        recentMaterialised={picker.recentMaterialised}
        filteredModelGroups={picker.filteredModelGroups}
        pickerSummary={picker.pickerSummary}
        pendingKinds={pendingKinds}
        pendingPayloadEstimate={pendingPayloadEstimate}
      />

      <ThinkingLevelControl
        c={c}
        model={model}
        allModelFlat={allModelFlat}
        thinkingLevel={thinkingLevel}
        onThinkingLevelChange={onThinkingLevelChange}
        thinkingAnchor={thinkingAnchor}
        setThinkingAnchor={setThinkingAnchor}
        menuPaperProps={menuPaperProps}
      />

      <Box sx={{ flex: 1 }} />

      {contextEstimate && (
        <ContextRing
          used={contextEstimate.used}
          limit={contextEstimate.limit}
          accentColor={c.accent.primary}
          trackColor={c.border.subtle}
        />
      )}

      <ToolbarActions
        c={c}
        elementSelection={elementSelection}
        autoRunMode={autoRunMode}
        ownerId={ownerId}
        sessionId={sessionId}
        generalFileInputRef={generalFileInputRef}
        addImageFiles={addImageFiles}
        uploadAndAttachFiles={uploadAndAttachFiles}
        hasContent={hasContent}
        disabled={disabled}
        isRunning={isRunning}
        onStop={onStop}
        handleSend={handleSend}
      />
    </Box>
  );
};
