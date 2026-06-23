import React, { RefObject } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import CommandPicker from '@/app/components/editor/CommandPicker';
import { useElementSelection } from '@/app/components/editor/ElementSelectionContext';
import { SelectedElement } from '@/app/components/editor/ElementSelectionContext';
import { ContextPath } from '@/app/components/editor/DirectoryBrowser';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { TriggerState } from '@/app/components/editor/richEditorUtils';
import { AttachedImage, ForcedToolGroup } from '../types';
import type { WorkflowsRunContext } from '@/shared/state/dashboardLayoutSlice';
import { SendBlock } from '../hooks/useContextFiles';
import { ModelPickerState } from '../hooks/useModelPicker';
import { SendBlockBanner } from './SendBlockBanner';
import { AttachmentChips } from './AttachmentChips';
import { EditorSurface } from './EditorSurface';
import { ChatInputToolbar } from '../toolbar/ChatInputToolbar';
import { ChatInputOverlays } from './ChatInputOverlays';

type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'auto';
interface ModeConf { label: string; icon: React.ReactNode; color: string }

interface Props {
  c: ClaudeTokens;
  containerRef: RefObject<HTMLDivElement>;
  editorRef: RefObject<HTMLDivElement>;
  generalFileInputRef: RefObject<HTMLInputElement>;
  embedded?: boolean;
  isDragOver: boolean;
  isUploading: boolean;
  handleDragOver: (e: React.DragEvent) => void;
  handleDragLeave: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent) => void;
  editorPicker: TriggerState;
  setPicker: React.Dispatch<React.SetStateAction<TriggerState>>;
  handlePickerSelect: (item: any) => void;
  sendBlock: SendBlock;
  setSendBlock: (v: SendBlock) => void;
  sessionId?: string;
  images: AttachedImage[];
  setLightboxSrc: (src: string | null) => void;
  removeImage: (idx: number) => void;
  contextPaths: ContextPath[];
  setContextPaths: React.Dispatch<React.SetStateAction<ContextPath[]>>;
  copiedPathIdx: number | null;
  setCopiedPathIdx: React.Dispatch<React.SetStateAction<number | null>>;
  pdfSupported: boolean;
  imageSupported: boolean;
  forcedTools: ForcedToolGroup[];
  setForcedTools: React.Dispatch<React.SetStateAction<ForcedToolGroup[]>>;
  selectedElements: SelectedElement[];
  elementSelection: ReturnType<typeof useElementSelection>;
  ownerId: string;
  disabled?: boolean;
  hasContent: boolean;
  hasAttachments: boolean;
  autoRunMode?: boolean;
  isRunning?: boolean;
  queueLength: number;
  modeConf: ModeConf;
  placeholderOverride?: string;
  runContext?: WorkflowsRunContext;
  onClearRunContext?: () => void;
  handleInput: () => void;
  handleEditorClick: () => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  handlePaste: (e: React.ClipboardEvent) => void;
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
  addImageFiles: (files: FileList | File[]) => void;
  uploadAndAttachFiles: (files: File[]) => void;
  onStop?: () => void;
  handleSend: () => void;
  lightboxSrc: string | null;
  oversizeQueue: Array<{ path: string; name: string; tokens: number }>;
  summarizingPath: string | null;
  summarizingAll: boolean;
  summarizeOversize: (path: string) => void;
  summarizeAllOversize: () => void;
  detachOversize: (path: string) => void;
  detachAllOversize: () => void;
  currentModelCtx: number;
  summarizeError: string | null;
  setSummarizeError: (v: string | null) => void;
}

export const ChatInputView: React.FC<Props> = (p) => {
  const { c } = p;
  return (
    <Box
      ref={p.containerRef}
      onDragOver={p.handleDragOver}
      onDragLeave={p.handleDragLeave}
      onDrop={p.handleDrop}
      sx={{
        position: 'relative',
        ...(p.embedded
          ? {}
          : {
              mx: 1.5,
              mb: 1.5,
              borderRadius: '16px',
              border: p.isDragOver ? `1px solid ${c.accent.primary}` : `1px solid ${c.border.subtle}`,
              bgcolor: c.bg.surface,
              boxShadow: c.shadow.md,
              transition: 'border-color 0.15s',
            }),
      }}
    >
      {p.isDragOver && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            bgcolor: 'rgba(174,86,48,0.04)',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '16px',
            pointerEvents: 'none',
          }}
        >
          <AttachFileIcon sx={{ fontSize: 16, color: c.accent.primary, mr: 0.5 }} />
          <Typography sx={{ color: c.accent.primary, fontSize: '0.85rem', fontWeight: 500 }}>
            Drop files here
          </Typography>
        </Box>
      )}

      {p.isUploading && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            bgcolor: 'rgba(174,86,48,0.04)',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '16px',
            pointerEvents: 'none',
          }}
        >
          <CircularProgress size={14} sx={{ color: c.accent.primary, mr: 1 }} />
          <Typography sx={{ color: c.accent.primary, fontSize: '0.85rem', fontWeight: 500 }}>
            Attaching files…
          </Typography>
        </Box>
      )}

      <CommandPicker
        trigger={p.editorPicker.trigger}
        filter={p.editorPicker.filter}
        onSelect={p.handlePickerSelect}
        onClose={() => p.setPicker((prev) => ({ ...prev, visible: false }))}
        visible={p.editorPicker.visible}
      />

      {p.sendBlock && (
        <SendBlockBanner
          sendBlock={p.sendBlock}
          c={c}
        />
      )}

      {p.runContext && (
        <Box sx={{ display: 'flex', mt: 1, mx: 1.5 }}>
          <Box
            title={p.runContext.metaLabel}
            sx={{
              display: 'inline-flex', alignItems: 'center', gap: 0.625, maxWidth: '100%',
              pl: 0.875, pr: 0.5, py: 0.25, borderRadius: '999px',
              bgcolor: c.bg.secondary, border: `1px solid ${c.border.subtle}`,
            }}
          >
            <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: p.runContext.color, flex: 'none' }} />
            <Typography sx={{ fontSize: '0.7rem', fontWeight: 600, color: c.text.secondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Run attached · {p.runContext.title}
            </Typography>
            <Box
              role="button"
              aria-label="Remove run context"
              onClick={p.onClearRunContext}
              sx={{ width: 15, height: 15, flex: 'none', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: c.text.tertiary, '&:hover': { color: c.text.secondary } }}
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </Box>
          </Box>
        </Box>
      )}

      <AttachmentChips
        c={c}
        images={p.images}
        setLightboxSrc={p.setLightboxSrc}
        removeImage={p.removeImage}
        contextPaths={p.contextPaths}
        setContextPaths={p.setContextPaths}
        copiedPathIdx={p.copiedPathIdx}
        setCopiedPathIdx={p.setCopiedPathIdx}
        pdfSupported={p.pdfSupported}
        imageSupported={p.imageSupported}
        forcedTools={p.forcedTools}
        setForcedTools={p.setForcedTools}
        selectedElements={p.selectedElements}
        elementSelection={p.elementSelection}
        ownerId={p.ownerId}
      />

      <EditorSurface
        c={c}
        editorRef={p.editorRef}
        disabled={p.disabled}
        hasContent={p.hasContent}
        hasAttachments={p.hasAttachments}
        autoRunMode={p.autoRunMode}
        isRunning={p.isRunning}
        queueLength={p.queueLength}
        placeholderLabel={p.placeholderOverride ?? `${p.modeConf.label}, @ for context, / for commands`}
        onInput={p.handleInput}
        onClick={p.handleEditorClick}
        onKeyDown={p.handleKeyDown}
        onPaste={p.handlePaste}
      />

      <ChatInputToolbar
        c={c}
        modeConf={p.modeConf}
        modesArr={p.modesArr}
        mode={p.mode}
        onModeChange={p.onModeChange}
        iconMap={p.iconMap}
        modeAnchor={p.modeAnchor}
        setModeAnchor={p.setModeAnchor}
        modelAnchor={p.modelAnchor}
        setModelAnchor={p.setModelAnchor}
        thinkingAnchor={p.thinkingAnchor}
        setThinkingAnchor={p.setThinkingAnchor}
        allModelFlat={p.allModelFlat}
        model={p.model}
        onModelChange={p.onModelChange}
        onProviderChange={p.onProviderChange}
        picker={p.picker}
        pendingKinds={p.pendingKinds}
        pendingPayloadEstimate={p.pendingPayloadEstimate}
        thinkingLevel={p.thinkingLevel}
        onThinkingLevelChange={p.onThinkingLevelChange}
        contextEstimate={p.contextEstimate}
        elementSelection={p.elementSelection}
        autoRunMode={p.autoRunMode}
        ownerId={p.ownerId}
        sessionId={p.sessionId}
        generalFileInputRef={p.generalFileInputRef}
        addImageFiles={p.addImageFiles}
        uploadAndAttachFiles={p.uploadAndAttachFiles}
        hasContent={p.hasContent}
        disabled={p.disabled}
        isRunning={p.isRunning}
        onStop={p.onStop}
        handleSend={p.handleSend}
      />

      <ChatInputOverlays
        c={c}
        lightboxSrc={p.lightboxSrc}
        setLightboxSrc={p.setLightboxSrc}
        oversizeQueue={p.oversizeQueue}
        summarizingPath={p.summarizingPath}
        summarizingAll={p.summarizingAll}
        summarizeOversize={p.summarizeOversize}
        summarizeAllOversize={p.summarizeAllOversize}
        detachOversize={p.detachOversize}
        detachAllOversize={p.detachAllOversize}
        currentModelCtx={p.currentModelCtx}
        summarizeError={p.summarizeError}
        setSummarizeError={p.setSummarizeError}
      />
    </Box>
  );
};
