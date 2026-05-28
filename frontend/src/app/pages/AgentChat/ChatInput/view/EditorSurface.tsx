import React, { RefObject } from 'react';
import Box from '@mui/material/Box';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';

interface Props {
  c: ClaudeTokens;
  editorRef: RefObject<HTMLDivElement>;
  disabled?: boolean;
  hasContent: boolean;
  hasAttachments: boolean;
  autoRunMode?: boolean;
  isRunning?: boolean;
  queueLength: number;
  placeholderLabel: string;
  onInput: () => void;
  onClick: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onPaste: (e: React.ClipboardEvent) => void;
}

// Windows-Electron: <div contentEditable> mounts hit a Chromium 144 TSF native crash on commit; the textarea ablation the handlers/draft already route for has to land here too or the renderer segfaults.
const IS_WIN_ELECTRON = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows') && navigator.userAgent.includes('Electron');

export const EditorSurface: React.FC<Props> = ({
  c, editorRef, disabled, hasContent, hasAttachments, autoRunMode, isRunning, queueLength,
  placeholderLabel, onInput, onClick, onKeyDown, onPaste,
}) => {
  const placeholderText = disabled
    ? 'Agent is working...'
    : autoRunMode
      ? 'Describe what data to generate…'
      : isRunning
        ? (queueLength > 0 ? `${queueLength} queued, type another or wait…` : 'Agent is working, messages will queue…')
        : placeholderLabel;

  return (
    <Box sx={{ px: 1.5, pt: hasAttachments ? 0.5 : 1.25, pb: 0.25, position: 'relative' }}>
      {IS_WIN_ELECTRON ? (
        <textarea
          ref={editorRef as unknown as RefObject<HTMLTextAreaElement>}
          data-onboarding="chat-input"
          disabled={disabled}
          spellCheck={false}
          onInput={onInput}
          onClick={onClick}
          onKeyDown={onKeyDown as unknown as React.KeyboardEventHandler<HTMLTextAreaElement>}
          onPaste={onPaste as unknown as React.ClipboardEventHandler<HTMLTextAreaElement>}
          rows={1}
          style={{
            width: '100%',
            minHeight: '1.5em',
            maxHeight: 220,
            overflowY: 'auto',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: c.text.primary,
            fontSize: '0.95rem',
            lineHeight: '1.55',
            fontFamily: 'inherit',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
            resize: 'none',
          }}
        />
      ) : (
        <div
          ref={editorRef}
          data-onboarding="chat-input"
          contentEditable={!disabled}
          suppressContentEditableWarning
          spellCheck={false}
          onInput={onInput}
          onClick={onClick}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          style={{
            width: '100%',
            minHeight: '1.5em',
            maxHeight: 220,
            overflowY: 'auto',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: c.text.primary,
            fontSize: '0.95rem',
            lineHeight: '1.55',
            fontFamily: 'inherit',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
          }}
        />
      )}
      {!hasContent && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            padding: `${hasAttachments ? 4 : 10}px 12px`,
            color: c.text.tertiary,
            fontSize: '0.95rem',
            lineHeight: '1.5',
            fontFamily: 'inherit',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          {placeholderText}
        </div>
      )}
    </Box>
  );
};
