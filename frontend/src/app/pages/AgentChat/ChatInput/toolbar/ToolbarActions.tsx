import React, { RefObject } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import StopIcon from '@mui/icons-material/Stop';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import AdsClickIcon from '@mui/icons-material/AdsClick';
import LanguageIcon from '@mui/icons-material/Language';
import { useElementSelection } from '@/app/components/editor/ElementSelectionContext';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { ComposerPlusMenu, ActiveTogglePills, PlusMenuItem } from './ComposerPlusMenu';

interface Props {
  c: ClaudeTokens;
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
  webSearchOn?: boolean;
  onToggleWebSearch?: () => void;
}

export const ToolbarActions: React.FC<Props> = ({
  c, elementSelection, autoRunMode, ownerId, sessionId, generalFileInputRef,
  addImageFiles, uploadAndAttachFiles, hasContent, disabled, isRunning, onStop, handleSend,
  webSearchOn, onToggleWebSearch,
}) => {
  // Every composer action collapses into one "+" so the bar reads empty at rest; active toggles
  // (web search, selecting) still surface as a pill so their state stays visible. New capabilities
  // (skills, MCP tools, voice, image) just push another entry onto this list, no new bar icon.
  const isSelecting = !!elementSelection && elementSelection.selectMode && elementSelection.activeOwnerId === ownerId;
  const toggleSelect = (): void => {
    if (!elementSelection) return;
    if (isSelecting) {
      elementSelection.setSelectMode(false);
    } else {
      if (elementSelection.activeOwnerId !== ownerId) elementSelection.clearOwnerElements(ownerId);
      elementSelection.setActiveOwnerId(ownerId);
      elementSelection.setExcludeSelectId(sessionId ?? null);
      elementSelection.setSelectMode(true);
    }
  };
  const plusItems: PlusMenuItem[] = [];
  plusItems.push({
    key: 'attach',
    label: 'Attach file',
    icon: <AttachFileIcon sx={{ fontSize: 17 }} />,
    onSelect: () => generalFileInputRef.current?.click(),
  });
  if (onToggleWebSearch) {
    plusItems.push({
      key: 'web',
      label: 'Web search',
      icon: <LanguageIcon sx={{ fontSize: 17 }} />,
      toggle: true,
      active: !!webSearchOn,
      onSelect: onToggleWebSearch,
    });
  }
  if (elementSelection) {
    plusItems.push({
      key: 'select',
      label: 'Select an element',
      icon: <AdsClickIcon sx={{ fontSize: 17 }} />,
      toggle: true,
      active: isSelecting,
      onSelect: toggleSelect,
    });
  }

  return (
    <>
      <input
        ref={generalFileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (!e.target.files) return;
          const all = Array.from(e.target.files);
          const imgs = all.filter((f) => f.type.startsWith('image/'));
          const rest = all.filter((f) => !f.type.startsWith('image/'));
          if (imgs.length > 0) addImageFiles(imgs);
          if (rest.length > 0) uploadAndAttachFiles(rest);
          e.target.value = '';
        }}
      />
      {!autoRunMode && <ActiveTogglePills c={c} items={plusItems} />}
      {!autoRunMode && <ComposerPlusMenu c={c} items={plusItems} />}
      {!autoRunMode && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {hasContent && (
            <Tooltip title={isRunning ? 'Queue message' : 'Send message'}>
              <IconButton
                size="small"
                onClick={handleSend}
                disabled={disabled}
                data-onboarding="chat-send-button"
                sx={{
                  bgcolor: c.accent.primary,
                  color: c.text.inverse,
                  p: 0.5,
                  width: 26,
                  height: 26,
                  '&:hover': { bgcolor: c.accent.hover },
                  '&.Mui-disabled': { bgcolor: c.bg.secondary, color: c.text.ghost },
                  transition: c.transition,
                }}
              >
                <ArrowUpwardIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          )}
          {isRunning ? (
            <Tooltip title="Stop agent">
              <IconButton
                size="small"
                onClick={onStop}
                sx={{
                  bgcolor: c.status.error,
                  color: c.text.inverse,
                  p: 0.5,
                  width: 26,
                  height: 26,
                  '&:hover': { bgcolor: c.status.error, opacity: 0.85 },
                  transition: c.transition,
                }}
              >
                <StopIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          ) : null}
        </Box>
      )}
    </>
  );
};
