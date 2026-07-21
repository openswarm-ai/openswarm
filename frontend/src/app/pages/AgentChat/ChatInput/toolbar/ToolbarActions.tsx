import React, { RefObject } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import MicNoneOutlinedIcon from '@mui/icons-material/MicNoneOutlined';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import StopIcon from '@mui/icons-material/Stop';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import AdsClickIcon from '@mui/icons-material/AdsClick';
import { useElementSelection } from '@/app/components/editor/ElementSelectionContext';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';

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
}

export const ToolbarActions: React.FC<Props> = ({
  c, elementSelection, autoRunMode, ownerId, sessionId, generalFileInputRef,
  addImageFiles, uploadAndAttachFiles, hasContent, disabled, isRunning, onStop, handleSend,
}) => {
  return (
    <>
      {elementSelection && !autoRunMode && (() => {
        const isMySelectMode = elementSelection.selectMode && elementSelection.activeOwnerId === ownerId;
        return (
          <Tooltip title={isMySelectMode ? 'Exit select mode' : 'Select UI element'}>
            <IconButton
              size="small"
              onMouseDown={(e) => e.preventDefault()}
              data-onboarding="element-selection-toggle"
              onClick={() => {
                if (isMySelectMode) {
                  elementSelection.setSelectMode(false);
                } else {
                  if (elementSelection.activeOwnerId !== ownerId) {
                    elementSelection.clearOwnerElements(ownerId);
                  }
                  elementSelection.setActiveOwnerId(ownerId);
                  if (sessionId) {
                    elementSelection.setExcludeSelectId(sessionId);
                  } else {
                    elementSelection.setExcludeSelectId(null);
                  }
                  elementSelection.setSelectMode(true);
                }
              }}
              sx={{
                p: 0.5,
                ...(isMySelectMode
                  ? {
                      bgcolor: '#3b82f6',
                      color: '#fff',
                      '&:hover': { bgcolor: '#2563eb' },
                      boxShadow: '0 0 0 3px rgba(59,130,246,0.18)',
                    }
                  : {
                      color: c.text.tertiary,
                      '&:hover': { color: c.text.secondary, bgcolor: 'rgba(0,0,0,0.04)' },
                    }),
                transition: 'background-color 0.15s, color 0.15s',
              }}
            >
              <AdsClickIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        );
      })()}

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
      <Tooltip title="Attach file">
        <IconButton
          size="small"
          onClick={() => generalFileInputRef.current?.click()}
          sx={{
            color: c.text.tertiary,
            p: 0.5,
            '&:hover': { color: c.text.secondary, bgcolor: 'rgba(0,0,0,0.04)' },
          }}
        >
          <AttachFileIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
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
          ) : !hasContent ? (
            <Tooltip title="Voice input (coming soon)">
              <span>
                <IconButton
                  size="small"
                  disabled
                  sx={{
                    color: c.text.tertiary,
                    p: 0.5,
                    '&.Mui-disabled': { color: c.text.ghost },
                  }}
                >
                  <MicNoneOutlinedIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </span>
            </Tooltip>
          ) : null}
        </Box>
      )}
    </>
  );
};
